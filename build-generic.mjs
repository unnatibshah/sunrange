// Builds generic.json: the "trained elsewhere" error model, pooled over reference cities on every continent.
// This is what a forecaster brings to a new location before it has seen any local data.
// Run: node build-generic.mjs
import { writeFileSync } from 'node:fs';
import { fitErrorModel, BINS, LEVELS } from './model.js';
import { history } from './data.js';

export const REFERENCE = [
  ['Phoenix', 33.45, -112.07], ['Chicago', 41.88, -87.63], ['Miami', 25.76, -80.19], ['Mexico City', 19.43, -99.13],
  ['São Paulo', -23.55, -46.63], ['Santiago', -33.45, -70.67], ['Madrid', 40.42, -3.70], ['London', 51.51, -0.13],
  ['Cairo', 30.04, 31.24], ['Nairobi', -1.29, 36.82], ['Johannesburg', -26.20, 28.05], ['Riyadh', 24.71, 46.68],
  ['Delhi', 28.61, 77.21], ['Beijing', 39.90, 116.40], ['Singapore', 1.35, 103.82], ['Perth', -31.95, 115.86],
];

const out = { built: new Date().toISOString().slice(0, 10), levels: LEVELS, cities: REFERENCE.map(c => c[0]), leads: {} };
for (const lead of [1, 2]) {
  const rows = [];
  for (const [name, lat, lon] of REFERENCE) {
    const h = await history(lat, lon, lead);
    rows.push(...h.rows);
    process.stdout.write(`lead ${lead} ${name}: ${h.rows.length} rows\n`);
  }
  const model = fitErrorModel(rows);
  out.leads[lead] = { n: rows.length, perBin: Object.fromEntries(BINS.map(b => [b, rows.filter(r => r.bin === b).length])), model };
}
writeFileSync('generic.json', JSON.stringify(out));
console.log('wrote generic.json', JSON.stringify(out.leads[1].perBin), JSON.stringify(out.leads[2].perBin));
