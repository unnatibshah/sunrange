import * as M from './model.js';
import { history as pastForecasts, forecast, placeInfo, geocode, pastForecastsPV, era5 } from './data.js';
import { sniff, toHourly, guessUnit, toCSV } from './production.js';
import { simulateRoof } from './simulate.js';
import * as Plan from './plan.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const f = (x, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
const pct = x => `${Math.round(x * 100)}%`;
const G = await (await fetch('generic.json')).json();
const G1 = G.leads[1].model;

const url = new URLSearchParams(location.search);
const state = {
  lat: +url.get('lat') || 39.7555, lon: +url.get('lon') || -105.2211, name: url.get('name') || 'Golden, Colorado',
  sys: { kwp: +url.get('kwp') || 5, tilt: url.has('tilt') ? +url.get('tilt') : null, azimuth: url.has('az') ? +url.get('az') : null, losses: 0.14 },
  tz: 'UTC', fc: null, cal: null, ev: null, token: 0,
  prod: null,      // { name, parsed, hourly: Map(utcHourEnd → kW), summary }
  pv: null,        // calibration against the user's own production
};

// ---------- location ----------
const map = L.map('map', { zoomControl: false, attributionControl: false }).setView([state.lat, state.lon], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);
const pin = L.circleMarker([state.lat, state.lon], { radius: 7, color: '#141414', weight: 2, fillColor: '#e8a317', fillOpacity: 1 }).addTo(map);
map.on('click', e => setPlace(e.latlng.lat, e.latlng.lng, null));

let gt, hits = [];
$('q').addEventListener('input', () => {
  clearTimeout(gt); const q = $('q').value.trim();
  if (q.length < 2) { $('results').hidden = true; return; }
  gt = setTimeout(async () => {
    try { hits = await geocode(q); } catch { hits = []; }
    $('results').innerHTML = hits.map((h, i) => `<button data-i="${i}" class="${i ? '' : 'on'}">${esc(h.name)} <small>${esc(h.detail)}</small></button>`).join('') || '<button disabled><small>No matches</small></button>';
    $('results').hidden = false;
  }, 250);
});
$('q').addEventListener('keydown', e => { if (e.key === 'Enter' && hits[0]) pick(hits[0]); if (e.key === 'Escape') $('results').hidden = true; });
$('results').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) pick(hits[+b.dataset.i]); });
document.addEventListener('click', e => { if (!e.target.closest('.search')) $('results').hidden = true; });
function pick(h) { $('q').value = ''; $('results').hidden = true; setPlace(h.lat, h.lon, [h.name, h.detail].filter(Boolean).join(', ')); }
$('locate').onclick = () => navigator.geolocation?.getCurrentPosition(p => setPlace(p.coords.latitude, p.coords.longitude, 'Your location'), () => status('Location permission was denied.', true));
function setPlace(lat, lon, name) {
  state.lat = +lat.toFixed(4); state.lon = +(((lon + 540) % 360) - 180).toFixed(4); state.name = name || `${f(state.lat, 2)}°, ${f(state.lon, 2)}°`;
  pin.setLatLng([state.lat, state.lon]); map.panTo([state.lat, state.lon]);
  load();
}

// ---------- system ----------
const sysNow = () => {
  const s = state.sys;
  return { kwp: s.kwp, tilt: s.tilt ?? Math.round(Math.min(45, Math.abs(state.lat))), azimuth: s.azimuth ?? (state.lat >= 0 ? 180 : 0), losses: s.losses };
};
function syncSystem() {
  const s = sysNow();
  for (const [id, v] of [['kwp', s.kwp], ['tilt', s.tilt], ['az', s.azimuth], ['loss', Math.round(s.losses * 100)]]) if (document.activeElement !== $(id)) $(id).value = v;
  document.querySelectorAll('#compass button').forEach(b => b.classList.toggle('on', +b.dataset.az === s.azimuth));
  return s;
}
let st;
const onSys = () => { clearTimeout(st); st = setTimeout(async () => { if (state.prod) await calibratePV(); render(); planYields = null; renderPlan(); }, 250); };
$('kwp').oninput = e => { if (+e.target.value > 0) { state.sys.kwp = +e.target.value; onSys(); } };
$('tilt').oninput = e => { if (e.target.value !== '') { state.sys.tilt = Math.max(0, Math.min(90, +e.target.value)); onSys(); } };
$('az').oninput = e => { if (e.target.value !== '') { state.sys.azimuth = ((+e.target.value % 360) + 360) % 360; onSys(); } };
$('loss').oninput = e => { if (e.target.value !== '') { state.sys.losses = Math.max(0, Math.min(0.5, +e.target.value / 100)); onSys(); } };
$('compass').onclick = e => { const b = e.target.closest('button'); if (b) { state.sys.azimuth = +b.dataset.az; onSys(); syncSystem(); } };

function status(msg, err) {
  $('status').hidden = !msg;
  $('status').innerHTML = msg ? (err ? `<span style="color:var(--bad)">${esc(msg)}</span>` : `<span class="spin"></span><span>${esc(msg)}</span>`) : '';
}

// ---------- load weather-side calibration + forecast ----------
async function load() {
  const token = ++state.token;
  $('place').textContent = state.name; $('coords').textContent = `${f(state.lat, 3)}, ${f(state.lon, 3)}`;
  status('Fetching past forecasts and what actually happened…');
  try {
    const [info, h1, h2, fc] = await Promise.all([placeInfo(state.lat, state.lon), pastForecasts(state.lat, state.lon, 1), pastForecasts(state.lat, state.lon, 2), forecast(state.lat, state.lon)]);
    if (token !== state.token) return;
    if (h1.rows.length < 120) throw new Error('not enough daylight in the last weeks to check forecasts (polar night?)');
    state.tz = info.timezone; state.fc = fc; state.cal = {}; state.ev = {};
    for (const lead of [1, 2]) {
      const g = G.leads[lead].model, rows = (lead === 1 ? h1 : h2).rows, s = M.splitChronological(rows), c = M.recalibrate(s.fit, g);
      state.ev[lead] = { fit: s.fit, test: s.test, strength: c.strength, generic: M.reliability(s.test, g), local: M.reliability(s.test, g, c.offsets), unit: 'W/m²' };
      state.cal[lead] = M.recalibrate(rows, g);
    }
    if (state.prod) await calibratePV();
    status(''); render(); planLocation();
  } catch (e) { if (token === state.token) status(`Couldn't load this location: ${e.message}`, true); }
}

// ---------- calibration against the user's own production ----------
let pvCache = null;
async function calibratePV() {
  const sys = sysNow();
  try {
    const key = `${state.lat},${state.lon}`;
    if (!pvCache || pvCache.key !== key) pvCache = { key, data: await pastForecastsPV(state.lat, state.lon, 90) };
    const d = pvCache.data, rows = M.pvIndexRows(d.times, d.ghi, d.temp, state.prod.hourly, state.lat, state.lon, sys);
    if (rows.length < 60) throw new Error(`Only ${rows.length} daylight hours of your data overlap the last 90 days of forecasts. Sunrange needs at least a week of recent data.`);
    const s = M.splitChronological(rows), c = M.recalibrate(s.fit, G1);
    state.pv = {
      rows, perf: M.performanceFactor(rows), recovery: M.recoveryCurve(s.fit, s.test, G1),
      ev: { fit: s.fit, test: s.test, strength: c.strength, generic: M.reliability(s.test, G1), local: M.reliability(s.test, G1, c.offsets), unit: 'kW' },
      deploy: M.recalibrate(rows, G1),
      days: Math.round((Date.parse(rows.at(-1).t + 'Z') - Date.parse(rows[0].t + 'Z')) / 86400000) + 1,
    };
    $('prodMsg').innerHTML = `<div class="okline">Calibrated to <b>${esc(state.prod.name)}</b>: ${state.pv.days} days, ${rows.length} daylight hours.</div>`;
    $('prodState').textContent = 'in use';
  } catch (e) {
    state.pv = null;
    $('prodMsg').innerHTML = `<div class="errline">${esc(e.message)}</div>`; $('prodState').textContent = 'not used';
  }
}

// ---------- import ----------
let pending = null;
$('drop').onclick = () => $('file').click();
$('drop').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') $('file').click(); };
$('file').onchange = async e => { const file = e.target.files[0]; e.target.value = ''; if (file) openFile(file.name, await file.text()); };
['dragenter', 'dragover'].forEach(t => $('drop').addEventListener(t, e => { e.preventDefault(); $('drop').classList.add('over'); }));
['dragleave', 'drop'].forEach(t => $('drop').addEventListener(t, e => { e.preventDefault(); $('drop').classList.remove('over'); }));
$('drop').addEventListener('drop', async e => { const file = e.dataTransfer.files[0]; if (file) openFile(file.name, await file.text()); });

function openFile(name, text) {
  $('prodMsg').innerHTML = '';
  if (text.length > 30e6) { $('prodMsg').innerHTML = '<div class="errline">That file is over 30 MB. Export a shorter period (the last 90 days is enough).</div>'; return; }
  try {
    const p = sniff(text);
    if (p.timeCol < 0 || p.valueCol < 0) throw new Error('Couldn\'t find a time column and a numeric value column.');
    pending = { name, parsed: p };
    const opts = p.header.map((h, i) => `<option value="${i}">${esc(h)}</option>`).join('');
    $('timeCol').innerHTML = opts; $('timeCol').value = p.timeCol;
    $('valCol').innerHTML = p.numericCols.map(i => `<option value="${i}">${esc(p.header[i])}</option>`).join(''); $('valCol').value = p.valueCol;
    $('unitSel').value = p.unit; $('tzSel').value = 'local'; $('stampSel').value = 'start';
    $('mapping').hidden = false; previewMapping();
  } catch (e) { $('prodMsg').innerHTML = `<div class="errline">${esc(e.message)}</div>`; }
}
const mappingOpts = () => ({ timeCol: +$('timeCol').value, valueCol: +$('valCol').value, unit: $('unitSel').value, tz: $('tzSel').value === 'UTC' ? 'UTC' : state.tz, stampAt: $('stampSel').value });
function previewMapping() {
  try {
    const r = toHourly(pending.parsed, mappingOpts());
    $('preview').textContent = `${r.hours} h · ${r.first.slice(0, 10)}→${r.last.slice(0, 10)} · peak ${f(r.peak, 2)} kW`;
    $('apply').disabled = false;
    const sys = sysNow();
    if (r.peak > sys.kwp * 1.6) $('preview').textContent += ' · peak is above system size: check units';
  } catch (e) { $('preview').textContent = e.message; $('apply').disabled = true; }
}
['timeCol', 'valCol', 'unitSel', 'tzSel', 'stampSel'].forEach(id => $(id).onchange = () => { if (id === 'valCol') $('unitSel').value = guessUnit(pending.parsed.header[+$('valCol').value]); previewMapping(); });
$('apply').onclick = async () => {
  const r = toHourly(pending.parsed, mappingOpts());
  state.prod = { name: pending.name, hourly: r.hourly, summary: r };
  $('mapping').hidden = true; status('Calibrating to your panels…'); await new Promise(x => setTimeout(x, 0));
  await calibratePV(); status(''); render();
  $('trustPnl').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// Simulated export: what a real roof here would have logged (shading, soiling, clipping), as a CSV to feed the same importer.
let simCSV = null;
$('simulate').onclick = async () => {
  if (!state.fc) return;
  status('Building a simulated inverter export from what the weather actually did…');
  try {
    const end = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10), start = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const sim = simulateRoof(await era5(state.lat, state.lon, start, end), state.lat, state.lon, sysNow(), state.tz);
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: state.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    simCSV = toCSV([['Date/Time', 'Energy (kWh)'], ...sim.map(([ms, kwh]) => [fmt.format(ms), kwh.toFixed(3)])]);
    $('dlSample').hidden = false; status('');
    openFile('simulated export (shaded after 3 pm, dusty, clipping inverter)', simCSV);
  } catch (e) { status(`Couldn't build the simulated export: ${e.message}`, true); }
};
$('dlSample').onclick = () => download('sunrange-simulated-export.csv', simCSV);
function download(name, text) { const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

// ---------- forecast → hourly power quantiles ----------
const fmtL = (ms, o) => new Intl.DateTimeFormat('en-US', { timeZone: state.tz, ...o }).format(ms);
const dayL = ms => new Intl.DateTimeFormat('en-CA', { timeZone: state.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const avg = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; };

function hourly(sys) {
  const { times, ghi, temp, cloud } = state.fc, now = Date.now(), out = [];
  times.forEach((t, h) => {
    const end = Date.parse(t + 'Z'); if (end <= now - 3600000 || end > now + 75 * 3600000) return;
    const sun = M.sunPosition(M.midpoint(end), state.lat, state.lon), csG = M.clearSkyGHI(sun.cosZ), tempC = avg(temp.map(m => m[h]));
    const g = avg(ghi.map(m => m[h])); let q = M.LEVELS.map(() => 0);
    if (sun.cosZ > 0.01 && csG > 0) {
      if (!M.daylight(sun.cosZ)) q = M.LEVELS.map(() => M.pvPower(g, tempC, sun, sys));
      else if (state.pv) {                                   // calibrated to the user's own output
        const csP = M.pvPower(csG, tempC, sun, sys);
        if (csP > 0) q = M.quantilesFor(Math.min(M.K_MAX, M.pvPower(g, tempC, sun, sys) / csP), G1, state.pv.deploy.offsets).map(k => k * csP);
      } else {
        const lead = end - now < 48 * 3600000 ? 1 : 2;
        q = M.powerQuantiles(M.quantilesFor(Math.min(M.K_MAX, g / csG), G.leads[lead].model, state.cal[lead].offsets), csG, tempC, sun, sys);
      }
    }
    out.push({ end, mid: M.midpoint(end), q, cloud: avg(cloud.map(m => m[h])), day: dayL(M.midpoint(end)), sun: sun.cosZ > 0.1 });
  });
  return out;
}

// ---------- render ----------
function render() {
  const sys = syncSystem();
  const q = new URLSearchParams({ lat: state.lat, lon: state.lon, name: state.name, kwp: sys.kwp });
  if (state.sys.tilt != null) q.set('tilt', sys.tilt);
  if (state.sys.azimuth != null) q.set('az', sys.azimuth);
  if (new URLSearchParams(location.search).get('view') === 'plan') q.set('view', 'plan');
  history.replaceState(null, '', '?' + q);
  if (!state.fc || !state.cal) return;
  const H = hourly(sys);
  $('meta').textContent = `${f(state.lat, 3)}, ${f(state.lon, 3)} · ${state.tz} · ${sys.kwp} kWp, ${sys.tilt}° tilt, ${sys.azimuth}° azimuth`;
  $('calBadge').className = `badge ${state.pv ? 'p' : 'w'}`;
  $('calBadge').textContent = state.pv ? 'Calibrated to your panels' : 'Calibrated to weather (ERA5)';
  $('export').disabled = false; state.lastH = H;
  renderDays(H); renderChart(H, sys); renderWindows(H); renderTrust();
}

function renderDays(H) {
  const today = dayL(Date.now()), tomorrow = dayL(Date.now() + 864e5), kwh = (d, k) => H.filter(h => h.day === d).reduce((s, h) => s + h.q[k], 0);
  const days = [...new Set(H.map(h => h.day))].filter(d => d !== today || kwh(d, M.I90) > 0.1).slice(0, 3);
  $('daysPnl').hidden = false;
  $('days').innerHTML = days.map(d => {
    const e = M.LEVELS.map((_, k) => kwh(d, k)), [p10, p50, p90] = [e[M.I10], e[M.I50], e[M.I90]], mx = Math.max(...days.map(x => kwh(x, M.I90)), 0.01);
    const cc = avg(H.filter(h => h.day === d && h.sun).map(h => h.cloud)), noon = Date.parse(d + 'T12:00:00Z');
    const sky = cc < 25 ? 'clear' : cc < 60 ? 'partly cloudy' : cc < 85 ? 'mostly cloudy' : 'overcast';
    const name = d === today ? 'Today' + (H.filter(h => h.day === d).length < 20 ? ', rest of' : '') : d === tomorrow ? 'Tomorrow' : new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(noon);
    return `<tr><td class="day">${name}<small>${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(noon)}</small></td>
      <td>${f(p10)}</td><td class="p50">${f(p50)}</td><td>${f(p90)}</td>
      <td><div class="rb"><i style="left:${p10 / mx * 100}%;width:${(p90 - p10) / mx * 100}%"></i><b style="left:${p50 / mx * 100}%"></b></div></td>
      <td class="sky">${sky}, ${Math.round(cc)}% cloud</td></tr>`;
  }).join('');
}

function renderChart(H, sys) {
  $('chartPnl').hidden = false;
  const W = 960, Ht = 290, P = { l: 46, r: 10, t: 14, b: 40 }, n = H.length, cw = (W - P.l - P.r) / n;
  const ymax = Math.max(0.5, ...H.map(h => h.q[M.I90])) * 1.1;
  const x = i => P.l + (i + 0.5) * cw, y = v => Ht - P.b - v / ymax * (Ht - P.t - P.b);
  const I25 = M.LEVELS.indexOf(0.25), I75 = M.LEVELS.indexOf(0.75);
  const band = (lo, hi) => H.map((h, i) => `${x(i)},${y(h.q[hi])}`).join(' ') + ' ' + H.map((h, i) => `${x(i)},${y(h.q[lo])}`).reverse().join(' ');
  const night = H.map((h, i) => h.sun ? '' : `<rect x="${x(i) - cw / 2}" y="${P.t}" width="${cw + .5}" height="${Ht - P.t - P.b}" fill="#f0f0ea"/>`).join('');
  const grid = [0, .25, .5, .75, 1].map(fr => fr * ymax).map(v => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e4e4dc"/><text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#9a9a92" font-family="IBM Plex Mono">${f(v)}</text>`).join('');
  const days = H.map((h, i) => i && h.day !== H[i - 1].day ? `<line x1="${x(i) - cw / 2}" x2="${x(i) - cw / 2}" y1="${P.t}" y2="${Ht - P.b + 26}" stroke="#141414" stroke-width=".8"/><text x="${x(i) - cw / 2 + 5}" y="${Ht - P.b + 30}" font-size="11.5" font-weight="600" fill="#141414">${fmtL(h.mid, { weekday: 'short', month: 'short', day: 'numeric' })}</text>` : '').join('');
  const hrs = H.map((h, i) => { const hr = +fmtL(h.mid, { hour: 'numeric', hourCycle: 'h23' }); return hr % 6 === 0 ? `<text x="${x(i)}" y="${Ht - P.b + 14}" text-anchor="middle" font-size="10.5" fill="#9a9a92" font-family="IBM Plex Mono">${String(hr).padStart(2, '0')}</text>` : ''; }).join('');
  const ni = H.findIndex(h => h.end > Date.now());
  $('svg').setAttribute('viewBox', `0 0 ${W} ${Ht}`);
  $('svg').innerHTML = `${night}${grid}${days}${hrs}
    <polygon points="${band(M.I10, M.I90)}" fill="#f6dc9c"/><polygon points="${band(I25, I75)}" fill="#e8a317"/>
    <polyline points="${H.map((h, i) => `${x(i)},${y(h.q[M.I50])}`).join(' ')}" fill="none" stroke="#141414" stroke-width="1.8"/>
    ${ni >= 0 ? `<line x1="${x(ni) - cw / 2}" x2="${x(ni) - cw / 2}" y1="${P.t}" y2="${Ht - P.b}" stroke="#c2410c" stroke-width="1.4" stroke-dasharray="3 3"/><text x="${x(ni) - cw / 2 + 4}" y="${P.t + 10}" font-size="10.5" fill="#c2410c" font-family="IBM Plex Mono">NOW</text>` : ''}
    <text x="${P.l}" y="${P.t - 3}" font-size="10.5" fill="#9a9a92" font-family="IBM Plex Mono">kW</text>
    <line id="hov" y1="${P.t}" y2="${Ht - P.b}" stroke="#141414" stroke-opacity=".35" visibility="hidden"/>
    <rect id="hit" x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${Ht - P.t - P.b}" fill="transparent"/>`;
  $('chartNote').textContent = `times in ${state.tz}`;
  $('hit').onmousemove = e => {
    const r = $('svg').getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width * W - P.l) / cw))), h = H[i];
    $('hov').setAttribute('x1', x(i)); $('hov').setAttribute('x2', x(i)); $('hov').setAttribute('visibility', 'visible');
    $('tip').innerHTML = `${fmtL(h.end - 3600000, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}–${fmtL(h.end, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}<br>P10 ${f(h.q[M.I10], 2)} · P50 ${f(h.q[M.I50], 2)} · P90 ${f(h.q[M.I90], 2)} kW`;
    $('tip').style.left = `${x(i) / W * r.width}px`; $('tip').style.top = `${y(h.q[M.I90]) / Ht * r.height}px`; $('tip').style.opacity = 1;
  };
  $('hit').onmouseleave = () => { $('tip').style.opacity = 0; $('hov').setAttribute('visibility', 'hidden'); };
}

function renderWindows(H) {
  const today = dayL(Date.now()), now = Date.now(), out = [];
  for (const d of [...new Set(H.map(h => h.day))].slice(0, 3)) {
    const hs = H.filter(h => h.day === d && h.end > now); let best = null;
    for (let i = 0; i + 3 <= hs.length; i++) {
      const w = hs.slice(i, i + 3), p10 = w.reduce((s, h) => s + h.q[M.I10], 0), p50 = w.reduce((s, h) => s + h.q[M.I50], 0);
      if (!best || p10 > best.p10 + 1e-9) best = { w, p10, p50 };
    }
    if (!best || best.p50 < 0.05) continue;
    const t = o => fmtL(o, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    out.push(`<div><div class="d">${d === today ? 'Today' : fmtL(best.w[0].mid, { weekday: 'long' })}</div><div class="w num">${t(best.w[0].end - 3600000)}–${t(best.w[2].end)}</div><div class="s">≥ ${f(best.p10)} kWh at 90% confidence · ${f(best.p50)} kWh typical</div></div>`);
  }
  $('winPnl').hidden = !out.length; $('wins').innerHTML = out.join('');
}

function renderTrust() {
  const ev = state.pv ? state.pv.ev : state.ev[1], g = ev.generic, l = ev.local, n = ev.test.length, u = ev.unit;
  const days = Math.max(1, Math.round(n / ((ev.fit.length + n) / ((Date.parse(ev.test.at(-1).t + 'Z') - Date.parse(ev.fit[0].t + 'Z')) / 864e5))));
  const [gl, gh] = M.wilson(g.cover80, n), [ll, lh] = M.wilson(l.cover80, n);
  const describe = (r, lo, hi) => {
    const below = r.coverage[M.I50];
    const bias = below < 0.4 ? `ran <b>low</b> (real output beat the median ${pct(1 - below)} of the time)` : below > 0.6 ? `ran <b>high</b> (real output fell short of the median ${pct(below)} of the time)` : 'were <b>centred</b>';
    const width = hi < 0.8 ? `the 80% range was <b>too narrow</b> (caught ${pct(r.cover80)})` : lo > 0.8 ? `the 80% range was <b>wider than needed</b> (caught ${pct(r.cover80)})` : `the 80% range caught <b>${pct(r.cover80)}</b>, as promised`;
    return `${bias}, and ${width}`;
  };
  const grade = e => e < 0.05 ? 'well calibrated' : e < 0.1 ? 'reasonably calibrated' : 'still noticeably off';
  const improved = l.calError < g.calError - 0.005, worse = l.calError > g.calError + 0.005, fin = ev.strength ? l : g;
  const subject = state.pv ? 'against your measured output' : 'against ERA5 reanalysis';
  let cls = fin.calError < 0.05 ? 'good' : fin.calError < 0.1 ? 'meh' : 'bad', text = `Uncalibrated, forecasts here ${describe(g, gl, gh)}. `;
  if (ev.strength === 0) text += `Local recalibration didn't help in the backtest, so the generic ranges are kept (${grade(g.calError)}).`;
  else if (improved) text += `Calibrated to this location and scored on weeks it never saw, they ${describe(l, ll, lh)}: <b>${grade(l.calError)}</b>.`;
  else if (worse) { cls = 'bad'; text += 'Calibrating on older weeks <b>made the newest weeks worse</b>, which usually means the weather regime shifted (a monsoon ending, a season turning). Treat the ranges with caution.'; }
  else text += `Calibrating changed little on weeks it hadn't seen (${grade(l.calError)}).`;
  if (!state.pv) text += ' <i>Import your inverter data for a check against your actual panels.</i>';
  $('trustPnl').hidden = false; $('verdict').className = `verdict ${cls}`; $('verdict').innerHTML = text;
  $('trustNote').textContent = `Day-ahead forecasts ${subject} · newest ~${days} days, ${n} daylight hours held out`;
  const row = (k, a, b, note) => `<tr><td>${k}<div style="font:12px 'IBM Plex Sans';color:var(--mute)">${note}</div></td><td>${a}</td><td><b>${b}</b></td></tr>`;
  $('metrics').innerHTML = `<thead><tr><th>Metric</th><th>Generic</th><th>Calibrated</th></tr></thead><tbody>`
    + row('Calibration error', f(g.calError, 3), f(l.calError, 3), 'Mean gap between promised and observed probabilities. Lower is better.')
    + row('80% range coverage', `${pct(g.cover80)} <span style="color:var(--faint)">[${pct(gl)}–${pct(gh)}]</span>`, `${pct(l.cover80)} <span style="color:var(--faint)">[${pct(ll)}–${pct(lh)}]</span>`, 'Should be about 80%. Brackets: 95% Wilson interval.')
    + row('80% range width', `${f(g.width80, u === 'kW' ? 2 : 0)} ${u}`, `${f(l.width80, u === 'kW' ? 2 : 0)} ${u}`, 'Narrower is only better if coverage holds.')
    + row('Median error', `${f(g.mae, u === 'kW' ? 2 : 0)} ${u}`, `${f(l.mae, u === 'kW' ? 2 : 0)} ${u}`, 'Mean absolute error of the P50.')
    + row('Correction strength', '0', f(ev.strength, 2), 'Picked on older weeks only. 0 keeps generic, 1 is fully local.') + '</tbody>';
  const pf = state.pv?.perf;
  $('insight').hidden = !pf;
  if (pf) $('insight').innerHTML = pf < 0.95 ? `On hours forecast as clear, your system made <b>${pct(pf)}</b> of what the model expects for ${sysNow().kwp} kWp at this tilt and azimuth. Something costs you about ${pct(1 - pf)}: shading, soiling, an inverter limit, or the system settings above. The calibrated forecast already accounts for it.`
    : pf > 1.1 ? `On clear hours your system made <b>${pct(pf)}</b> of the model's expectation: the size or losses above are probably set too conservatively.`
    : `On clear hours your system made <b>${pct(pf)}</b> of the model's expectation: it performs about as specified.`;
  drawRel(g, l); drawPit(g, l); drawRecovery();
}

const AX = 'font-size="10" fill="#9a9a92" font-family="IBM Plex Mono"';
function drawRel(g, l) {
  const S = 190, ox = 52, oy = 210, X = v => ox + v * S, Y = v => oy - v * S;
  const pts = (r, c) => `<polyline points="${r.coverage.map((v, i) => `${X(M.LEVELS[i])},${Y(v)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="1.6"/>` + r.coverage.map((v, i) => `<rect x="${X(M.LEVELS[i]) - 2.5}" y="${Y(v) - 2.5}" width="5" height="5" fill="${c}"/>`).join('');
  $('rel').innerHTML = `<rect x="${ox}" y="${oy - S}" width="${S}" height="${S}" fill="#fff" stroke="#dcdcd4"/><line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="#c7c7bd" stroke-dasharray="3 3"/>
    ${[0, .5, 1].map(v => `<text x="${X(v)}" y="${oy + 14}" text-anchor="middle" ${AX}>${v}</text><text x="${ox - 6}" y="${Y(v) + 3}" text-anchor="end" ${AX}>${v}</text>`).join('')}
    <text x="${ox + S / 2}" y="${oy + 30}" text-anchor="middle" font-size="11" fill="#5e5e58">promised</text><text x="16" y="${oy - S / 2}" text-anchor="middle" font-size="11" fill="#5e5e58" transform="rotate(-90 16 ${oy - S / 2})">observed</text>
    ${pts(g, '#9a9a92')}${pts(l, '#c2410c')}
    <g font-size="10.5" font-family="IBM Plex Mono"><rect x="${ox + 6}" y="${oy - S + 6}" width="8" height="8" fill="#9a9a92"/><text x="${ox + 18}" y="${oy - S + 14}" fill="#5e5e58">generic</text><rect x="${ox + 76}" y="${oy - S + 6}" width="8" height="8" fill="#c2410c"/><text x="${ox + 88}" y="${oy - S + 14}" fill="#5e5e58">calibrated</text></g>`;
}
function drawPit(g, l) {
  const ox = 30, oy = 210, w = 24, mx = Math.max(...g.pit, ...l.pit, .2), Y = v => v / mx * 170;
  $('pit').innerHTML = `<line x1="${ox}" x2="${ox + 240}" y1="${oy - Y(.1)}" y2="${oy - Y(.1)}" stroke="#c2410c" stroke-dasharray="3 3"/><text x="${ox + 244}" y="${oy - Y(.1) + 3}" ${AX}>ideal</text>`
    + g.pit.map((v, i) => `<rect x="${ox + i * w + 2}" y="${oy - Y(v)}" width="${w - 4}" height="${Y(v)}" fill="none" stroke="#9a9a92"/>`).join('')
    + l.pit.map((v, i) => `<rect x="${ox + i * w + 6}" y="${oy - Y(v)}" width="${w - 12}" height="${Y(v)}" fill="#e8a317"/>`).join('')
    + `<line x1="${ox}" x2="${ox + 240}" y1="${oy}" y2="${oy}" stroke="#141414"/><text x="${ox}" y="${oy + 14}" ${AX}>low</text><text x="${ox + 240}" y="${oy + 14}" text-anchor="end" ${AX}>high</text>
    <g font-size="10.5" font-family="IBM Plex Mono"><rect x="${ox}" y="8" width="9" height="9" fill="none" stroke="#9a9a92"/><text x="${ox + 13}" y="16" fill="#5e5e58">generic</text><rect x="${ox + 72}" y="8" width="9" height="9" fill="#e8a317"/><text x="${ox + 85}" y="16" fill="#5e5e58">calibrated</text></g>`;
}
function drawRecovery() {
  const rc = state.pv?.recovery || [];
  $('recFig').hidden = rc.length < 3; if (rc.length < 3) return;
  const ox = 46, oy = 200, Wd = 230, Hh = 170, mx = Math.max(...rc.map(r => r.calError), 0.1) * 1.1;
  const X = i => ox + i / (rc.length - 1) * Wd, Y = v => oy - v / mx * Hh;
  const GOOD = 0.07, ok = rc.find(r => r.calError < GOOD);
  $('rec').innerHTML = `<rect x="${ox}" y="${oy - Hh}" width="${Wd}" height="${Hh}" fill="#fff" stroke="#dcdcd4"/>
    <rect x="${ox}" y="${Y(GOOD)}" width="${Wd}" height="${oy - Y(GOOD)}" fill="#eef5ec"/><text x="${ox + 4}" y="${oy - 5}" font-size="10" fill="#2f7d32" font-family="IBM Plex Mono">good (&lt; ${GOOD})</text>
    <polyline points="${rc.map((r, i) => `${X(i)},${Y(r.calError)}`).join(' ')}" fill="none" stroke="#141414" stroke-width="1.6"/>
    ${rc.map((r, i) => `<rect x="${X(i) - 3}" y="${Y(r.calError) - 3}" width="6" height="6" fill="${ok && r.days === ok.days ? '#c2410c' : '#141414'}"/><text x="${X(i)}" y="${oy + 14}" text-anchor="middle" ${AX}>${r.days}</text>`).join('')}
    <text x="${ox + Wd / 2}" y="${oy + 30}" text-anchor="middle" font-size="11" fill="#5e5e58">days of your data</text>
    <text x="${ox - 6}" y="${Y(mx / 1.1) + 3}" text-anchor="end" ${AX}>${f(mx / 1.1, 2)}</text><text x="${ox - 6}" y="${oy + 3}" text-anchor="end" ${AX}>0</text>
    ${ok ? `<text x="${X(rc.indexOf(ok))}" y="${Y(ok.calError) - 12}" text-anchor="end" font-size="10.5" fill="#c2410c" font-family="IBM Plex Mono">${ok.days} days</text>` : ''}`;
}

$('export').onclick = () => {
  const H = state.lastH; if (!H) return;
  const t = ms => new Intl.DateTimeFormat('sv-SE', { timeZone: state.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  const idx = [0.1, 0.25, 0.5, 0.75, 0.9].map(v => M.LEVELS.indexOf(v));
  download(`sunrange-${state.name.split(',')[0].toLowerCase().replace(/\W+/g, '-')}.csv`, toCSV([
    [`# Sunrange forecast for ${state.name} (${state.lat}, ${state.lon}), ${sysNow().kwp} kWp, calibrated to ${state.pv ? 'measured output' : 'ERA5'}, times ${state.tz}`],
    ['hour_start', 'hour_end', 'p10_kw', 'p25_kw', 'p50_kw', 'p75_kw', 'p90_kw'],
    ...H.map(h => [t(h.end - 3600000), t(h.end), ...idx.map(i => h.q[i].toFixed(3))])]));
};

syncSystem();
load();

// ---------- plan an installation ----------
let view = url.get('view') === 'plan' ? 'plan' : 'forecast', planEra = null, planYields = null, planKey = '', curTouched = false, sizeOverride = null;
const P$ = id => $(id);
function setView(v) {
  view = v;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $('forecastView').hidden = v !== 'forecast'; $('planView').hidden = v !== 'plan';
  $('calBadge').style.visibility = v === 'forecast' ? 'visible' : 'hidden';
  const u = new URL(location); v === 'plan' ? u.searchParams.set('view', 'plan') : u.searchParams.delete('view'); history.replaceState(null, '', u);
  if (v === 'plan') renderPlan();
}
document.querySelector('.tabs').onclick = e => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); };

function setCurrency(code) {
  const c = Plan.CURRENCIES[code]; P$('pCur').value = code;
  P$('pTariff').value = c.tariff; P$('pExport').value = c.exportRate; P$('pCost').value = c.costPerKwp;
  document.querySelectorAll('.cu').forEach(el => el.textContent = el.textContent.replace(/^[^/]*/, c.symbol));
}
P$('pCur').onchange = () => { curTouched = true; setCurrency(P$('pCur').value); renderPlan(); };

async function planLocation() {
  if (!curTouched) setCurrency(Plan.currencyFor(state.tz));
  const key = `${state.lat},${state.lon}`;
  if (planKey === key && planEra) return renderPlan();
  planKey = key; planEra = null; planYields = null; sizeOverride = null;
  try { const year = new Date().getUTCFullYear() - 1; planEra = await era5(state.lat, state.lon, `${year - 4}-01-01`, `${year}-12-31`); }
  catch (e) { P$('planOut').hidden = false; P$('kpis').innerHTML = `<div class="kpi">Couldn't load past weather: ${esc(e.message)}</div>`; return; }
  if (planKey === key) renderPlan();
}

function planOpts() {
  const roof = +P$('pRoof').value || 0;
  return { monthlyUse: Math.max(1, +P$('pUse').value || 0), cover: Math.max(0.1, (+P$('pCover').value || 100) / 100), tariff: +P$('pTariff').value || 0,
    exportRate: +P$('pExport').value || 0, costPerKwp: +P$('pCost').value || 0, subsidy: Math.min(0.9, Math.max(0, (+P$('pSub').value || 0) / 100)),
    panel: P$('pPanel').value, roofM2: P$('pRoofU').value === 'ft2' ? roof * 0.092903 : roof, kwp: sizeOverride ?? undefined };
}

const money = (v, sym) => `${sym}${Math.round(v).toLocaleString('en-US')}`;
function renderPlan() {
  if (view !== 'plan' || !planEra) return;
  const sys = sysNow();
  planYields ??= Plan.specificYield(planEra, state.lat, state.lon, sys);
  let r; try { r = Plan.plan(planYields, planOpts()); } catch (e) { P$('planOut').hidden = false; P$('kpis').innerHTML = `<div class="kpi">${esc(e.message)}</div>`; return; }
  const sym = Plan.CURRENCIES[P$('pCur').value].symbol, ys = planYields.map(y => y.year), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pb = s => s.payback == null ? '> 25 yrs' : `${f(s.payback, 1)} yrs`;
  const kpi = (k, v, rng) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="r">${rng || '&nbsp;'}</div></div>`;
  P$('planOut').hidden = P$('monthPnl').hidden = P$('cashPnl').hidden = false;
  P$('kpis').innerHTML = kpi('System size', `${f(r.kwp, 2)} kWp`, sizeOverride ? `recommended ${f(r.recommendedKwp, 2)} kWp` : r.capped ? 'limited by roof space' : 'to cover your target')
    + kpi('Panels', `${r.panels} × ${r.panel.watts} W`, r.panel.label)
    + kpi('Roof area', `${f(r.roofM2, 1)} m²`, `${Math.round(r.roofM2 / 0.092903)} ft²`)
    + kpi('Cost', money(r.cost, sym), +P$('pSub').value ? `after ${P$('pSub').value}% subsidy` : 'before subsidies')
    + kpi('Yearly output', `${Math.round(r.median.production).toLocaleString('en-US')} kWh`, `${Math.round(r.worst.production).toLocaleString('en-US')}–${Math.round(r.best.production).toLocaleString('en-US')} across ${y0}–${y1}`)
    + kpi('Use covered', pct(r.median.covered), `${pct(r.worst.covered)}–${pct(r.best.covered)}`)
    + kpi('Yearly savings', money(r.median.savings, sym), `${money(r.worst.savings, sym)}–${money(r.best.savings, sym)}`)
    + kpi('Payback', pb(r.median), `${pb(r.best)} to ${pb(r.worst)}`)
    + kpi('25-year net', money(r.median.flow.at(-1), sym), `${money(r.worst.flow.at(-1), sym)}–${money(r.best.flow.at(-1), sym)}`);
  P$('planNote').textContent = `${sys.tilt}° tilt, ${sys.azimuth}° azimuth, ${Math.round(sys.losses * 100)}% losses (change in System)`;
  const slider = P$('pSize'); slider.max = Math.max(20, Math.ceil(r.recommendedKwp * 2)); if (document.activeElement !== slider) slider.value = r.kwp; P$('pSizeV').textContent = `${f(r.kwp, 2)} kWp`;
  const exp = r.median.exported / r.median.production;
  P$('planAssume').innerHTML = `Each kWp here made <b>${Math.round(Math.min(...planYields.map(y => y.annual)))}–${Math.round(Math.max(...planYields.map(y => y.annual)))} kWh</b> a year over ${y0}–${y1}, with this tilt and direction. `
    + `In a median year about <b>${pct(exp)}</b> of the output is exported at ${sym}${P$('pExport').value}/kWh, the rest replaces grid power at ${sym}${P$('pTariff').value}/kWh. `
    + (exp > 0.3 ? 'With that much export, a smaller system or a battery may pay back faster: try the slider. ' : '')
    + 'Excludes batteries, maintenance, financing and price changes.';
  drawMonths(r); drawCash(r, sym);
}
['pUse', 'pCover', 'pTariff', 'pExport', 'pCost', 'pSub', 'pRoof'].forEach(id => P$(id).addEventListener('input', () => { sizeOverride = null; renderPlan(); }));
['pPanel', 'pRoofU'].forEach(id => P$(id).addEventListener('change', () => { sizeOverride = null; renderPlan(); }));
P$('pSize').oninput = e => { sizeOverride = +e.target.value; renderPlan(); };
P$('pReset').onclick = () => { sizeOverride = null; renderPlan(); };
P$('pUseIt').onclick = () => { const r = Plan.plan(planYields, planOpts()); state.sys.kwp = +r.kwp.toFixed(2); syncSystem(); setView('forecast'); if (state.prod) calibratePV().then(render); else render(); };

function drawMonths(r) {
  const W = 960, H = 260, P = { l: 52, r: 10, t: 14, b: 30 }, mx = Math.max(...r.monthly.map(m => Math.max(m.max, m.use))) * 1.1, cw = (W - P.l - P.r) / 12;
  const y = v => H - P.b - v / mx * (H - P.t - P.b), names = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  const grid = [0, .5, 1].map(fr => fr * mx).map(v => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e4e4dc"/><text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#9a9a92" font-family="IBM Plex Mono">${Math.round(v)}</text>`).join('');
  const bars = r.monthly.map((m, i) => { const cx = P.l + cw * (i + .5); return `<rect x="${cx - cw * .3}" y="${y(m.med)}" width="${cw * .6}" height="${H - P.b - y(m.med)}" fill="#e8a317"/><line x1="${cx}" x2="${cx}" y1="${y(m.max)}" y2="${y(m.min)}" stroke="#141414"/><line x1="${cx - 5}" x2="${cx + 5}" y1="${y(m.max)}" y2="${y(m.max)}" stroke="#141414"/><line x1="${cx - 5}" x2="${cx + 5}" y1="${y(m.min)}" y2="${y(m.min)}" stroke="#141414"/><text x="${cx}" y="${H - P.b + 16}" text-anchor="middle" font-size="11" fill="#5e5e58" font-family="IBM Plex Mono">${names[i]}</text>`; }).join('');
  const use = `<polyline points="${r.monthly.map((m, i) => `${P.l + cw * (i + .5)},${y(m.use)}`).join(' ')}" fill="none" stroke="#c2410c" stroke-width="2"/>`;
  P$('monthSvg').setAttribute('viewBox', `0 0 ${W} ${H}`);
  P$('monthSvg').innerHTML = `${grid}${bars}${use}<text x="${P.l}" y="${P.t - 2}" font-size="10.5" fill="#9a9a92" font-family="IBM Plex Mono">kWh</text>`;
}
function drawCash(r, sym) {
  const W = 960, H = 260, P = { l: 78, r: 34, t: 14, b: 30 }, all = [r.worst, r.median, r.best].flatMap(s => s.flow);
  const lo = Math.min(...all), hi = Math.max(...all, 0), x = t => P.l + t / Plan.YEARS * (W - P.l - P.r), y = v => H - P.b - (v - lo) / (hi - lo || 1) * (H - P.t - P.b);
  const line = (s, c, w) => `<polyline points="${s.flow.map((v, t) => `${x(t)},${y(v)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
  const ticks = [0, 5, 10, 15, 20, 25].map(t => `<text x="${x(t)}" y="${H - P.b + 16}" text-anchor="middle" font-size="11" fill="#5e5e58" font-family="IBM Plex Mono">yr ${t}</text>`).join('');
  const be = r.median.payback != null ? `<line x1="${x(r.median.payback)}" x2="${x(r.median.payback)}" y1="${P.t}" y2="${H - P.b}" stroke="#141414" stroke-dasharray="3 3"/><text x="${x(r.median.payback) + 5}" y="${P.t + 11}" font-size="11" font-family="IBM Plex Mono" fill="#141414">break-even ${f(r.median.payback, 1)} yrs</text>` : '';
  P$('cashSvg').setAttribute('viewBox', `0 0 ${W} ${H}`);
  P$('cashSvg').innerHTML = `<line x1="${P.l}" x2="${W - P.r}" y1="${y(0)}" y2="${y(0)}" stroke="#141414"/>
    <text x="${P.l - 6}" y="${y(0) + 4}" text-anchor="end" font-size="11" fill="#5e5e58" font-family="IBM Plex Mono">${sym}0</text><text x="${P.l - 6}" y="${y(hi) + 4}" text-anchor="end" font-size="11" fill="#9a9a92" font-family="IBM Plex Mono">${money(hi, sym)}</text><text x="${P.l - 6}" y="${y(lo) + 4}" text-anchor="end" font-size="11" fill="#9a9a92" font-family="IBM Plex Mono">${money(lo, sym)}</text>
    ${ticks}${line(r.best, '#2f7d32', 1.5)}${line(r.worst, '#b42318', 1.5)}${line(r.median, '#141414', 2.2)}${be}`;
}
setView(view);
