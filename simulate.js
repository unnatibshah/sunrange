// A simulated inverter export for the "try with sample data" button and the checks: what a real 5 kWp roof
// would have logged, built from ERA5 (what actually happened) plus real-world losses the clean model doesn't know:
// a tree shading the array after 3 pm, dusty panels, an undersized inverter that clips, and meter noise.
import { sunPosition, midpoint, pvPower } from './model.js';

export function simulateRoof(era, lat, lon, sys, tz) {
  let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const hourIn = ms => +new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(ms);
  const out = [];
  era.times.forEach((t, i) => {
    if (era.ghi[i] == null) return;
    const end = Date.parse(t + 'Z'), sun = sunPosition(midpoint(end), lat, lon);
    let kw = pvPower(era.ghi[i], era.temp[i] ?? 20, sun, sys) * 0.93;          // soiling
    const h = hourIn(end - 3600000);
    if (h >= 15) kw *= 0.55;                                                    // afternoon tree shade
    kw = Math.min(kw, 0.8 * sys.kwp) * (1 + 0.03 * (rnd() - 0.5) * 2);          // inverter clipping + meter noise
    out.push([end - 3600000, Math.max(0, kw)]);                                // interval START, kWh for that hour
  });
  return out;
}
