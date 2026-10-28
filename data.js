// Open-Meteo fetchers (free, no key, CORS-enabled). Everything is requested in UTC.
import { MODELS, backtestRows } from './model.js';

const day = ms => new Date(ms).toISOString().slice(0, 10);
async function get(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.reason || `HTTP ${r.status} from ${new URL(url).host}`);
  return j;
}

// Past forecasts issued `lead` days ahead (1 = day-ahead) for each model, plus what actually happened (ERA5).
// Truth stops 6 days before today: the newest reanalysis days are still being filled in.
export async function history(lat, lon, lead = 1, days = 60) {
  const vars = MODELS.map(() => `shortwave_radiation_previous_day${lead}`).filter((v, i, a) => a.indexOf(v) === i).join(',');
  const prev = await get(`https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${vars}&models=${MODELS.join(',')}&past_days=${days}&forecast_days=1&timezone=GMT`);
  const times = prev.hourly.time, end = day(Date.now() - 6 * 86400000);
  const arc = await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&start_date=${times[0].slice(0, 10)}&end_date=${end}&timezone=GMT`);
  const truthBy = new Map(arc.hourly.time.map((t, i) => [t, arc.hourly.shortwave_radiation[i]]));
  const series = MODELS.map(m => prev.hourly[`shortwave_radiation_previous_day${lead}_${m}`] || []);
  const truth = times.map(t => truthBy.get(t) ?? null);
  return { times, rows: backtestRows(times, series, truth, lat, lon), truthEnd: end, elevation: prev.elevation };
}

// Next 72 hours from the same three models, plus temperature for the cell-temperature derate.
export async function forecast(lat, lon) {
  const f = await get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation,temperature_2m,cloud_cover&models=${MODELS.join(',')}&forecast_days=4&timezone=GMT`);
  const H = f.hourly, pick = v => MODELS.map(m => H[`${v}_${m}`] || []);
  return { times: H.time, ghi: pick('shortwave_radiation'), temp: pick('temperature_2m'), cloud: pick('cloud_cover') };
}

export async function placeInfo(lat, lon) {
  const t = await get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=auto&forecast_days=1`);
  return { timezone: t.timezone, elevation: t.elevation };
}

export async function geocode(q) {
  const j = await get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en`);
  return (j.results || []).map(r => ({ name: r.name, detail: [r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude }));
}

// Past day-ahead forecasts with temperature, for calibrating against the user's own production (up to ~90 days back).
export async function pastForecastsPV(lat, lon, days = 90) {
  const vars = 'shortwave_radiation_previous_day1,temperature_2m_previous_day1';
  const p = await get(`https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${vars}&models=${MODELS.join(',')}&past_days=${days}&forecast_days=1&timezone=GMT`);
  const pick = v => MODELS.map(m => p.hourly[`${v}_${m}`] || []);
  return { times: p.hourly.time, ghi: pick('shortwave_radiation_previous_day1'), temp: pick('temperature_2m_previous_day1') };
}

// ERA5 (what actually happened), for building the simulated sample export.
export async function era5(lat, lon, start, end) {
  const a = await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation,temperature_2m&start_date=${start}&end_date=${end}&timezone=GMT`);
  return { times: a.hourly.time, ghi: a.hourly.shortwave_radiation, temp: a.hourly.temperature_2m };
}
