// Planning an installation: how big, how many panels, how much roof, what it costs and when it pays back.
// Sizing and payback follow the approach of my BE project "Powered by Sun" (2022); here every output is a
// range over several real weather years at the exact location instead of one long-term average.
import { sunPosition, midpoint, pvPower } from './model.js';

export const PANELS = {
  mono: { label: 'Monocrystalline', eff: 0.21, watts: 430 },
  poly: { label: 'Polycrystalline', eff: 0.17, watts: 330 },
  thin: { label: 'Thin film', eff: 0.12, watts: 150 },
};
export const ROOF_SPACING = 1.15;                 // walkways, edges and row gaps on top of panel area
export const DEGRADATION = 0.005;                 // output lost per year
export const YEARS = 25;

export const CURRENCIES = {
  INR: { symbol: '₹', tariff: 8, exportRate: 3, costPerKwp: 55000 },
  USD: { symbol: '$', tariff: 0.17, exportRate: 0.08, costPerKwp: 2800 },
  EUR: { symbol: '€', tariff: 0.30, exportRate: 0.08, costPerKwp: 1400 },
  GBP: { symbol: '£', tariff: 0.27, exportRate: 0.15, costPerKwp: 1500 },
};
export const currencyFor = tz => tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta' ? 'INR' : tz === 'Europe/London' ? 'GBP' : /^Europe\//.test(tz) ? 'EUR' : 'USD';

// kWh per installed kWp, per year and per month, from hourly reanalysis. Hourly values are preceding-hour means,
// so geometry is taken at the interval midpoint. Only complete years are kept.
export function specificYield(era, lat, lon, sys) {
  const one = { ...sys, kwp: 1 }, years = {};
  era.times.forEach((t, i) => {
    const g = era.ghi[i]; if (g == null) return;
    const end = Date.parse(t + 'Z'), mid = midpoint(end), d = new Date(mid), y = d.getUTCFullYear(), m = d.getUTCMonth();
    const yr = years[y] ??= { monthly: Array(12).fill(0), hours: 0 };
    yr.monthly[m] += pvPower(g, era.temp[i] ?? 20, sunPosition(mid, lat, lon), one); yr.hours++;
  });
  return Object.entries(years).filter(([, v]) => v.hours >= 8700).map(([y, v]) => ({ year: +y, monthly: v.monthly, annual: v.monthly.reduce((a, b) => a + b, 0) }));
}

const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// opts: { monthlyUse kWh, cover 0–1, tariff, exportRate, costPerKwp, subsidy 0–1, panel, roofM2 (optional), kwp (optional override) }
export function plan(yields, opts) {
  if (!yields.length) throw new Error('No complete weather years for this location.');
  const P = PANELS[opts.panel], m2PerKwp = 1 / P.eff * ROOF_SPACING;           // 1 kWp at 1000 W/m² needs 1/eff m² of panel
  const useMonthly = DAYS.map(d => opts.monthlyUse * d / 30.4375), annualUse = useMonthly.reduce((a, b) => a + b, 0);
  const sorted = yields.map(y => y.annual).sort((a, b) => a - b), medianYield = sorted[Math.floor(sorted.length / 2)];
  let target = Math.max(0.3, annualUse * opts.cover / medianYield), capped = false;
  if (opts.roofM2 > 0 && target * m2PerKwp > opts.roofM2) { target = opts.roofM2 / m2PerKwp; capped = true; }
  const want = opts.kwp ?? target, panels = Math.max(1, Math.round(want * 1000 / P.watts)), kwp = panels * P.watts / 1000;
  const cost = kwp * opts.costPerKwp * (1 - opts.subsidy);
  const scenarios = yields.map(y => {
    const prod = y.monthly.map(v => v * kwp);
    const used = prod.reduce((s, p, m) => s + Math.min(p, useMonthly[m]), 0), exported = prod.reduce((s, p, m) => s + Math.max(0, p - useMonthly[m]), 0);
    const savings = used * opts.tariff + exported * opts.exportRate, flow = [-cost];
    for (let t = 1; t <= YEARS; t++) flow.push(flow[t - 1] + savings * (1 - DEGRADATION) ** (t - 1));
    const k = flow.findIndex(v => v >= 0), payback = k < 0 ? null : k - 1 + (0 - flow[k - 1]) / (flow[k] - flow[k - 1]);
    return { year: y.year, production: used + exported, used, exported, covered: used / annualUse, savings, flow, payback, monthly: prod };
  }).sort((a, b) => a.savings - b.savings);
  const pick = q => scenarios[Math.round((scenarios.length - 1) * q)];
  return {
    kwp, panels, panel: P, roofM2: kwp * m2PerKwp, cost, capped, recommendedKwp: target, annualUse, useMonthly,
    worst: pick(0), median: pick(0.5), best: pick(1), scenarios,
    monthly: Array.from({ length: 12 }, (_, m) => { const v = scenarios.map(s => s.monthly[m]).sort((a, b) => a - b); return { min: v[0], med: v[Math.floor(v.length / 2)], max: v.at(-1), use: useMonthly[m] }; }),
  };
}
