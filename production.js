// Reads an inverter / meter export (CSV) into hourly mean kW keyed by the UTC hour END label, which is how
// Open-Meteo labels its hourly values. Handles common shapes: ISO or US/EU dates, epoch seconds, power (W/kW)
// or energy per interval (Wh/kWh), any interval length, timestamps in local time or UTC.

export function sniff(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const delim = [',', ';', '\t'].map(d => [d, lines.slice(0, 5).reduce((n, l) => n + l.split(d).length, 0)]).sort((a, b) => b[1] - a[1])[0][0];
  const split = l => l.split(delim).map(c => c.trim().replace(/^"|"$/g, ''));
  const first = split(lines[0]), hasHeader = first.some(c => c && isNaN(num(c)) && !parseStamp(c));
  const header = hasHeader ? first : first.map((_, i) => `column ${i + 1}`);
  const rows = (hasHeader ? lines.slice(1) : lines).map(split);
  const timeCol = header.findIndex((_, i) => rows.slice(0, 20).filter(r => parseStamp(r[i] || '')).length >= Math.min(10, rows.length) * 0.8);
  const numericCols = header.map((_, i) => i).filter(i => i !== timeCol && rows.slice(0, 50).filter(r => !isNaN(num(r[i] ?? ''))).length >= Math.min(30, rows.length) * 0.8);
  const prefer = numericCols.find(i => /pv|solar|produc|generat|yield|energy|power|kwh|kw\b|wh\b|output/i.test(header[i])) ?? numericCols[0];
  return { delim, header, rows, timeCol, valueCol: prefer ?? -1, numericCols, unit: guessUnit(header[prefer] || '') };
}

export function guessUnit(h) {
  h = h.toLowerCase();
  return /kwh/.test(h) ? 'kWh' : /\bwh\b|\(wh\)|_wh|\[wh\]/.test(h) ? 'Wh' : /kw/.test(h) ? 'kW' : /\bw\b|\(w\)|_w\b|\[w\]|watt/.test(h) ? 'W' : 'kWh';
}

export const num = s => {
  s = String(s).trim();
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');      // 1.234,5
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');                                  // 12,5
  else s = s.replace(/,/g, '');                                                              // 1,234.5
  return s === '' ? NaN : Number(s);
};

// → [y, mo, d, h, mi] wall-clock parts, or {epoch} for unix seconds/ms, or null.
export function parseStamp(s) {
  s = String(s).trim();
  if (/^\d{10}(\.\d+)?$/.test(s)) return { epoch: Number(s) * 1000 };
  if (/^\d{13}$/.test(s)) return { epoch: Number(s) };
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const parts = [+m[1], +m[2], +m[3], +m[4], +m[5]];
    if (m[6]) { const o = m[6].toUpperCase() === 'Z' ? 0 : (m[6][0] === '-' ? -1 : 1) * (+m[6].slice(1, 3) * 60 + +m[6].slice(-2)); return { epoch: Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]) - o * 60000 }; }
    return parts;
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (m) {
    let [a, b, y, h, mi] = [+m[1], +m[2], +m[3], +m[4], +m[5]];
    if (m[6]) h = (h % 12) + (/pm/i.test(m[6]) ? 12 : 0);
    const [mo, d] = a > 12 ? [b, a] : [a, b];          // day-first when unambiguous, else US month-first
    return [y, mo, d, h, mi];
  }
  return null;
}

// Wall-clock time in an IANA zone → UTC ms (two passes handle DST edges).
export function zonedToUtc([y, mo, d, h, mi], tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = ms => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ms).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms;
  };
  const first = guess - off(guess);
  return guess - off(first);
}

// opts: { timeCol, valueCol, unit: 'kW'|'W'|'kWh'|'Wh', tz: IANA zone or 'UTC', stampAt: 'start'|'end' }
export function toHourly(parsed, opts) {
  const pts = [];
  for (const r of parsed.rows) {
    const st = parseStamp(r[opts.timeCol] ?? ''), v = num(r[opts.valueCol] ?? '');
    if (!st || !isFinite(v)) continue;
    const ms = st.epoch ?? (opts.tz === 'UTC' ? Date.UTC(st[0], st[1] - 1, st[2], st[3], st[4]) : zonedToUtc(st, opts.tz));
    pts.push([ms, v]);
  }
  if (pts.length < 24) throw new Error(`Only ${pts.length} usable rows. Check the time and value columns.`);
  pts.sort((a, b) => a[0] - b[0]);
  const gaps = pts.slice(1).map((p, i) => p[0] - pts[i][0]).filter(g => g > 0).sort((a, b) => a - b);
  const step = gaps[Math.floor(gaps.length / 2)];
  if (!step || step > 3600000 * 1.01) throw new Error('Rows need to be hourly or finer (daily totals can\'t calibrate an hourly forecast).');
  const energy = opts.unit === 'kWh' || opts.unit === 'Wh', scale = opts.unit === 'W' || opts.unit === 'Wh' ? 1 / 1000 : 1;
  const sums = new Map(), cover = new Map();
  for (const [ms, v] of pts) {
    const start = opts.stampAt === 'end' ? ms - step : ms;                       // interval start, UTC
    const kwh = energy ? v * scale : v * scale * step / 3600000;
    const label = new Date(Math.floor(start / 3600000) * 3600000 + 3600000).toISOString().slice(0, 16);   // hour END
    sums.set(label, (sums.get(label) || 0) + kwh); cover.set(label, (cover.get(label) || 0) + step);
  }
  const hourly = new Map();
  for (const [t, kwh] of sums) if (cover.get(t) >= 0.75 * 3600000) hourly.set(t, Math.max(0, kwh / (cover.get(t) / 3600000)));  // mean kW
  const times = [...hourly.keys()].sort();
  return { hourly, step, first: times[0], last: times.at(-1), hours: hourly.size, peak: Math.max(...hourly.values()) };
}

export const toCSV = rows => rows.map(r => r.map(c => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n');
