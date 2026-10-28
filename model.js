// Sunrange core: solar geometry, a PV model, probabilistic forecasts from a point forecast plus an error model,
// and per-quantile recalibration. Plain ES module with no dependencies, shared by the web app and the Node checks.
//
// Everything works in clear-sky-index space, k = GHI / clear-sky GHI, so errors are comparable across hours,
// seasons and latitudes.

const RAD = Math.PI / 180;
export const LEVELS = Array.from({ length: 19 }, (_, i) => +(0.05 * (i + 1)).toFixed(2)); // 0.05 … 0.95
export const I10 = LEVELS.indexOf(0.1), I50 = LEVELS.indexOf(0.5), I90 = LEVELS.indexOf(0.9);
export const MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];

// ---------- solar geometry (NOAA approximation, ±0.5°) ----------
export function sunPosition(ms, lat, lon) {
  const d = ms / 86400000 + 2440587.5 - 2451545.0;          // days since J2000
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lon) * RAD - ra;
  const phi = lat * RAD;
  const cosZ = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZ)));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) + Math.PI; // from north, clockwise
  const doy = ((ms / 86400000) % 365.25 + 365.25) % 365.25;
  return { cosZ, zen, az, i0: 1361 * (1 + 0.033 * Math.cos(2 * Math.PI * doy / 365.25)) };
}

// Open-Meteo hourly radiation is the mean over the PRECEDING hour, labelled at the hour's end,
// so geometry is evaluated at the interval midpoint (label − 30 min).
export const midpoint = ms => ms - 1800000;
export const clearSkyGHI = cosZ => cosZ > 0 ? 1098 * cosZ * Math.exp(-0.059 / cosZ) : 0;   // Haurwitz
export const daylight = cosZ => cosZ > 0.1;                  // sun above ~6°, where k is meaningful
export const K_MAX = 1.3;

// ---------- PV model ----------
// GHI → plane-of-array (Erbs decomposition + isotropic sky) → DC with a temperature derate → AC after losses.
export function pvPower(ghi, tempC, sun, sys) {
  if (ghi <= 0 || sun.cosZ <= 0.01) return 0;
  const kt = Math.min(1, ghi / (sun.i0 * sun.cosZ));
  const fd = kt <= 0.22 ? 1 - 0.09 * kt : kt <= 0.8 ? 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4 : 0.165;
  const dhi = ghi * fd, dni = (ghi - dhi) / Math.max(sun.cosZ, 0.087);
  const b = sys.tilt * RAD, pa = sys.azimuth * RAD;
  const cosAOI = Math.cos(sun.zen) * Math.cos(b) + Math.sin(sun.zen) * Math.sin(b) * Math.cos(sun.az - pa);
  const poa = Math.max(0, dni * Math.max(0, cosAOI)) + dhi * (1 + Math.cos(b)) / 2 + ghi * 0.2 * (1 - Math.cos(b)) / 2;
  const cell = tempC + poa / 800 * (45 - 20);              // NOCT 45 °C
  const dc = sys.kwp * poa / 1000 * (1 - 0.004 * (cell - 25));
  return Math.max(0, Math.min(dc, sys.kwp) * (1 - sys.losses));
}

// ---------- quantiles ----------
export function quantile(sorted, t) {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * t, lo = Math.floor(h);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (h - lo);
}
const sortNum = a => a.slice().sort((x, y) => x - y);

// Errors depend on the sky: a clear forecast can only go one way, an overcast one mostly the other.
export const BINS = ['overcast', 'mixed', 'clear'];
export const binOf = fc => fc < 0.35 ? 'overcast' : fc < 0.75 ? 'mixed' : 'clear';

// Point forecast in k-space: the mean of the available models.
export function pointK(values, cs) {
  const v = values.filter(x => x != null);
  return v.length ? Math.min(K_MAX, v.reduce((s, x) => s + x, 0) / v.length / cs) : null;
}

// An error model maps each sky bin to the error quantile at every level: k_obs − k_forecast.
export function fitErrorModel(rows, minPerBin = 30) {
  const pooled = sortNum(rows.map(r => r.obs - r.fc));
  const model = {};
  for (const b of BINS) {
    const e = sortNum(rows.filter(r => r.bin === b).map(r => r.obs - r.fc));
    model[b] = LEVELS.map(t => quantile(e.length >= minPerBin ? e : pooled, t));
  }
  return model;
}

// Quantiles for one hour: point forecast + generic error model + optional local per-quantile offsets.
export function quantilesFor(fc, generic, offsets) {
  const b = binOf(fc);
  return sortNum(LEVELS.map((_, i) => Math.min(K_MAX, Math.max(0, fc + generic[b][i] + (offsets ? offsets[b][i] : 0)))));
}

// Weighted quantile: newer rows count more, because weather regimes drift (a monsoon ends, a season turns).
export function wquantile(pairs, t) {             // pairs: [value, weight]
  const a = pairs.slice().sort((x, y) => x[0] - y[0]), total = a.reduce((s, p) => s + p[1], 0);
  if (!a.length) return NaN;
  let acc = 0;
  for (const [v, w] of a) { acc += w; if (acc >= t * total) return v; }
  return a[a.length - 1][0];
}
export const recencyWeights = (rows, halfLifeDays = 10) => {
  const last = Date.parse(rows.at(-1).t + 'Z');
  return rows.map(r => Math.pow(0.5, (last - Date.parse(r.t + 'Z')) / 86400000 / halfLifeDays));
};

// Local recalibration: per sky bin and per quantile level, shift by the τ-quantile of (observed − generic quantile),
// recency-weighted and scaled by a strength λ (0 = keep generic, 1 = full local correction).
// Each level moves separately, so it can fix bias, width AND skew: the shape, not just the spread.
// Zero model fits: it only reads past forecasts and what actually happened.
export function fitOffsets(rows, generic, strength = 1, minPerBin = 30) {
  const w = recencyWeights(rows), all = rows.map((r, k) => ({ r, w: w[k], q: quantilesFor(r.fc, generic) }));
  const level = (set, i, t) => strength * wquantile(set.map(({ r, w, q }) => [r.obs - q[i], w]), t);
  const pooled = LEVELS.map((t, i) => level(all, i, t)), offsets = {};
  for (const b of BINS) {
    const these = all.filter(({ r }) => r.bin === b);
    offsets[b] = these.length >= minPerBin ? LEVELS.map((t, i) => level(these, i, t)) : pooled;
  }
  return offsets;
}

// Choose the strength with a local backtest INSIDE the fitting window (older part fits, newer part validates),
// so the choice never sees the rows it will be judged on.
export const STRENGTHS = [0, 0.25, 0.5, 0.75, 1];
export function chooseStrength(rows, generic) {
  const { fit, test: val } = splitChronological(rows, 0.7);
  const scored = STRENGTHS.map(s => ({ s, err: reliability(val, generic, s ? fitOffsets(fit, generic, s) : null).calError }));
  return { strength: scored.reduce((a, b) => b.err < a.err - 1e-9 ? b : a).s, scored };
}

// The whole local step: pick a strength on the fitting rows, then refit at that strength on all of them.
export function recalibrate(rows, generic) {
  const { strength, scored } = chooseStrength(rows, generic);
  return { strength, scored, offsets: strength ? fitOffsets(rows, generic, strength) : null };
}

// Reliability on held-out rows: coverage at every level, calibration error (mean |coverage − nominal|),
// the central 80% interval's coverage AND width (any forecast hits any coverage by widening, so never one
// without the other), and a PIT histogram whose shape names the problem.
export function reliability(rows, generic, offsets) {
  const cov = LEVELS.map(() => 0), pit = Array(10).fill(0);
  let inside = 0, width = 0, absErr = 0;
  for (const r of rows) {
    const q = quantilesFor(r.fc, generic, offsets);
    q.forEach((v, i) => { if (r.obs <= v) cov[i]++; });
    if (r.obs >= q[I10] && r.obs <= q[I90]) inside++;
    width += (q[I90] - q[I10]) * r.cs;
    absErr += Math.abs(r.obs - q[I50]) * r.cs;
    pit[Math.min(9, Math.floor(q.filter(v => v < r.obs).length / q.length * 10))]++;
  }
  const n = rows.length || 1, coverage = cov.map(c => c / n);
  return {
    n: rows.length, coverage, pit: pit.map(c => c / n),
    calError: coverage.reduce((s, c, i) => s + Math.abs(c - LEVELS[i]), 0) / LEVELS.length,
    cover80: inside / n, width80: width / n, mae: absErr / n,          // width and MAE in W/m² of GHI
  };
}

// Wilson score interval for a proportion: a coverage gap counts only when it's outside sampling noise.
export function wilson(p, n, z = 1.96) {
  if (!n) return [0, 1];
  const d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// Backtest rows: past forecasts (one series per model) against observed GHI, daylight hours only.
export function backtestRows(times, modelSeries, truth, lat, lon) {
  const rows = [];
  times.forEach((t, h) => {
    if (truth[h] == null) return;
    const sun = sunPosition(midpoint(Date.parse(t + 'Z')), lat, lon);
    if (!daylight(sun.cosZ)) return;
    const cs = clearSkyGHI(sun.cosZ), fc = pointK(modelSeries.map(m => m[h]), cs);
    if (fc == null) return;
    rows.push({ t, cs, fc, bin: binOf(fc), obs: Math.min(K_MAX, truth[h] / cs) });
  });
  return rows;
}

// Older part fits, newer part evaluates: calibrate on the past, get judged on what came after.
export function splitChronological(rows, fitShare = 2 / 3) {
  const cut = Math.floor(rows.length * fitShare);
  return { fit: rows.slice(0, cut), test: rows.slice(cut) };
}

// Turn k-quantiles for one future hour into power quantiles (PV output is monotone in GHI for a fixed hour).
export function powerQuantiles(qK, cs, tempC, sun, sys) {
  return qK.map(k => pvPower(k * cs, tempC, sun, sys));
}

// ---------- calibrating to the user's own panels ----------
// Same machinery, but in "clear-sky power index" space: measured kW / what this exact system would make under a
// clear sky. Forecast errors, shading, soiling and clipping all show up as offsets the recalibration can learn.
export function pvIndexRows(times, ghiSeries, tempSeries, production, lat, lon, sys) {
  const rows = [];
  times.forEach((t, h) => {
    const obs = production.get(t); if (obs == null) return;
    const sun = sunPosition(midpoint(Date.parse(t + 'Z')), lat, lon);
    if (!daylight(sun.cosZ)) return;
    const temp = mean(tempSeries.map(m => m[h])) ?? 20, cs = pvPower(clearSkyGHI(sun.cosZ), temp, sun, sys);
    if (cs < 0.05 * sys.kwp) return;
    const ghi = mean(ghiSeries.map(m => m[h])); if (ghi == null) return;
    const fc = Math.min(K_MAX, pvPower(ghi, temp, sun, sys) / cs);
    rows.push({ t, cs, fc, bin: binOf(fc), obs: Math.min(K_MAX, Math.max(0, obs / cs)) });
  });
  return rows;
}
const mean = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

// How much this system actually makes compared with the model, on hours forecast as clear: catches shading,
// soiling, a wrong size or tilt setting. 1.0 = exactly as modelled.
export function performanceFactor(rows) {
  const r = rows.filter(x => x.bin === 'clear' && x.fc > 0.3).map(x => x.obs / x.fc).sort((a, b) => a - b);
  return r.length >= 10 ? quantile(r, 0.5) : null;
}

// Recovery curve: how good the ranges get with N days of the user's own history (the most recent N days
// before the evaluation weeks, which is what anyone starting today would have).
export const BUDGETS = [0, 1, 3, 7, 14, 30, 60];
export function recoveryCurve(fit, test, generic) {
  if (!fit.length) return [];
  const end = Date.parse(fit.at(-1).t + 'Z'), span = (end - Date.parse(fit[0].t + 'Z')) / 86400000;
  return BUDGETS.filter(d => d <= Math.ceil(span) + 1).map(days => {
    const sub = days ? fit.filter(r => end - Date.parse(r.t + 'Z') < days * 86400000) : [];
    const offsets = sub.length >= 20 ? recalibrate(sub, generic).offsets : null;
    return { days, n: sub.length, calError: reliability(test, generic, offsets).calError };
  });
}
