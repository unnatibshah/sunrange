// Checks for model.js (offline) and a live transfer test at cities outside the reference set.
// Run: node check.mjs            (add --offline to skip the network part)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from './model.js';

// Solar noon in Denver on the June solstice: elevation ≈ 90 − 39.74 + 23.44 ≈ 73.7°, sun due south.
const noon = M.sunPosition(Date.parse('2026-06-21T19:00:00Z'), 39.74, -105.17);
assert.ok(Math.abs(90 - noon.zen / (Math.PI / 180) - 73.7) < 1.5, 'solar elevation at Denver noon');
assert.ok(Math.abs(noon.az / (Math.PI / 180) - 180) < 10, 'sun due south at noon');
assert.ok(M.sunPosition(Date.parse('2026-06-21T07:00:00Z'), 39.74, -105.17).cosZ < 0, 'night is night');

// A south-facing 5 kWp array under a clear noon sky makes roughly 3.3–5 kW; no sun, no power.
const sys = { kwp: 5, tilt: 30, azimuth: 180, losses: 0.14 };
const p = M.pvPower(M.clearSkyGHI(noon.cosZ), 25, noon, sys);
assert.ok(p > 3.3 && p < 5, `clear-sky noon PV ${p.toFixed(2)} kW`);
assert.equal(M.pvPower(0, 25, noon, sys), 0);

// Transfer, synthetically: a generic error model from a calm place applied to a place where forecasts run
// high and errors are wider. Local per-quantile recalibration must repair it on later, unseen rows.
const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
const normal = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
const make = (n, bias, sd) => Array.from({ length: n }, (_, i) => {
  const fc = Math.min(1.2, Math.max(0.05, 0.2 + rnd())), obs = Math.min(1.3, Math.max(0, fc + bias + sd * normal()));
  return { t: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString().slice(0, 16), cs: 700, fc, bin: M.binOf(fc), obs };
});
const generic = M.fitErrorModel(make(6000, 0, 0.05));
const local = make(1500, -0.12, 0.15), { fit, test } = M.splitChronological(local);
const r0 = M.reliability(test, generic), r1 = M.reliability(test, generic, M.recalibrate(fit, generic).offsets);
assert.ok(r0.calError > 0.15, `generic should be miscalibrated here (${r0.calError.toFixed(3)})`);
assert.ok(r1.calError < 0.04, `local recalibration should fix it (${r1.calError.toFixed(3)})`);
assert.ok(Math.abs(r1.cover80 - 0.8) < 0.05 && r1.width80 > r0.width80, 'coverage restored by honest, wider intervals');
console.log(`synthetic transfer: calibration error ${r0.calError.toFixed(3)} → ${r1.calError.toFixed(3)}, 80% coverage ${r0.cover80.toFixed(2)} → ${r1.cover80.toFixed(2)}`);

// Production importer: 15-minute watts in US local time; hourly kWh with decimal commas in UTC; DST; daily totals rejected.
const P = await import('./production.js');
let csv = 'Date/Time,Solar Production (W)\n';
for (let i = 0; i < 96 * 3; i++) { const t = new Date(Date.UTC(2026, 6, 1, 0, 15 * i)), h = t.getUTCHours(); csv += `${t.getUTCMonth() + 1}/${t.getUTCDate()}/${t.getUTCFullYear()} ${h % 12 || 12}:${String(t.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'},${h >= 6 && h < 18 ? 2000 : 0}\n`; }
let sn = P.sniff(csv); assert.equal(sn.unit, 'W');
let hr = P.toHourly(sn, { timeCol: 0, valueCol: 1, unit: 'W', tz: 'America/Denver', stampAt: 'start' });
assert.equal(hr.hourly.get('2026-07-01T13:00'), 2); assert.equal(hr.hourly.get('2026-07-01T12:00'), 0);   // 06–07 MDT = 12–13 UTC
sn = P.sniff('time;yield [kWh]\n' + Array.from({ length: 48 }, (_, i) => `2026-07-01T${String(i % 24).padStart(2, '0')}:00:00Z;${i % 24 === 12 ? '3,5' : '0'}`).join('\n'));
hr = P.toHourly(sn, { timeCol: 0, valueCol: 1, unit: 'kWh', tz: 'UTC', stampAt: 'end' });
assert.equal(sn.delim, ';'); assert.equal(hr.hourly.get('2026-07-01T12:00'), 3.5);
assert.equal(P.zonedToUtc([2026, 3, 8, 3, 0], 'America/New_York'), Date.UTC(2026, 2, 8, 7, 0));
assert.throws(() => P.toHourly(P.sniff('day,kwh\n2026-07-01 00:00,10\n2026-07-02 00:00,12\n'.repeat(13)), { timeCol: 0, valueCol: 1, unit: 'kWh', tz: 'UTC', stampAt: 'start' }), /hourly or finer/);
console.log('production importer ok');

// Planning: sizing to whole panels, roof cap, month-by-month self-use vs export, payback.
const Pl = await import('./plan.js');
const flat = [{ year: 2024, monthly: Array(12).fill(125), annual: 1500 }];                    // 1500 kWh per kWp per year
const base = { monthlyUse: 250, cover: 1, tariff: 10, exportRate: 4, costPerKwp: 50000, subsidy: 0, panel: 'mono', roofM2: 0 };
let pl = Pl.plan(flat, base);
assert.equal(pl.panels, Math.round((250 * 365.25 / 30.4375) / 1500 * 1000 / 430), 'size to the use, rounded to whole panels');
assert.ok(Math.abs(pl.median.covered - pl.kwp * 1500 / (250 * 12)) < 0.02 || pl.median.covered <= 1, 'coverage follows size');
pl = Pl.plan(flat, { ...base, roofM2: 5 });
assert.ok(pl.capped && pl.roofM2 <= 5 * 1.25, 'roof space caps the size');
pl = Pl.plan(flat, { ...base, kwp: 4, monthlyUse: 1e6 });                                            // everything self-used
assert.ok(Math.abs(pl.median.payback - pl.cost / pl.median.savings) < 0.2, 'payback ≈ cost / yearly savings when nothing is exported');
assert.ok(Pl.plan(flat, { ...base, kwp: 6, exportRate: 0 }).median.savings < Pl.plan(flat, { ...base, kwp: 6 }).median.savings, 'exports are worth something');
console.log('planner ok');

if (!process.argv.includes('--offline')) {
  // A simulated roof (shading after 3 pm, soiling, clipping) calibrated from its own output.
  const { pastForecastsPV, era5 } = await import('./data.js'), { simulateRoof } = await import('./simulate.js');
  const [la, lo] = [39.7555, -105.2211], sy = { kwp: 5, tilt: 40, azimuth: 180, losses: 0.14 }, pf = await pastForecastsPV(la, lo, 90);
  const er = await era5(la, lo, pf.times[0].slice(0, 10), new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10));
  const prod = new Map(simulateRoof(er, la, lo, sy, 'America/Denver').map(([s, kw]) => [new Date(s + 3600000).toISOString().slice(0, 16), kw]));
  const rows = M.pvIndexRows(pf.times, pf.ghi, pf.temp, prod, la, lo, sy), sp = M.splitChronological(rows), G1 = JSON.parse(readFileSync(new URL('./generic.json', import.meta.url))).leads[1].model;
  const a = M.reliability(sp.test, G1), b = M.reliability(sp.test, G1, M.recalibrate(sp.fit, G1).offsets);
  assert.ok(b.calError < a.calError / 2, 'calibrating to a real roof should at least halve the calibration error');
  console.log(`simulated roof: calErr ${a.calError.toFixed(3)} → ${b.calError.toFixed(3)}, median miss ${a.mae.toFixed(2)} → ${b.mae.toFixed(2)} kW, days-of-data ${M.recoveryCurve(sp.fit, sp.test, G1).map(r => `${r.days}d ${r.calError.toFixed(3)}`).join(' · ')}`);

  const { history } = await import('./data.js');
  const G = JSON.parse(readFileSync(new URL('./generic.json', import.meta.url)));
  const places = [['Denver', 39.74, -105.17], ['Seattle', 47.61, -122.33], ['Mumbai', 19.07, 72.88], ['Lisbon', 38.72, -9.14],
                  ['Hamburg', 53.55, 9.99], ['Lagos', 6.52, 3.38], ['Sydney', -33.87, 151.21], ['Tokyo', 35.68, 139.69]];
  let better = 0, same = 0;
  for (const [name, lat, lon] of places) {
    const h = await history(lat, lon, 1), s = M.splitChronological(h.rows), g = G.leads[1].model;
    const rc = M.recalibrate(s.fit, g), a = M.reliability(s.test, g), b = M.reliability(s.test, g, rc.offsets);
    better += b.calError < a.calError - 1e-9; same += Math.abs(b.calError - a.calError) < 1e-9;
    console.log(`${name.padEnd(8)} λ=${rc.strength.toFixed(2)} fit ${String(s.fit.length).padStart(3)} · test ${String(s.test.length).padStart(3)}   calErr ${a.calError.toFixed(3)} → ${b.calError.toFixed(3)}   80% cov ${a.cover80.toFixed(2)} → ${b.cover80.toFixed(2)}   width ${a.width80.toFixed(0)} → ${b.width80.toFixed(0)} W/m²   MAE ${a.mae.toFixed(0)} W/m²`);
  }
  console.log(`recalibration improved calibration at ${better}/${places.length} held-out cities, left ${same} unchanged`);
}
console.log('ok');
