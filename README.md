# Sunrange: solar forecasts with honest ranges

**[Open Sunrange →](https://unnatibshah.github.io/sunrange/)**

Are probabilistic solar forecasts reliable at a location the forecaster has never seen, and can cheap local recalibration fix them? Sunrange turns that question into a tool anyone can use.

Pick a place and a PV system. Sunrange:

1. **Forecasts** the next 3 days of PV power from three NWP models (ECMWF IFS, NOAA GFS, DWD ICON) via Open-Meteo, converted to panel output with solar geometry, Erbs decomposition, an isotropic-sky transposition for the chosen tilt and azimuth, and a NOCT temperature derate.
2. **Turns the point forecast into a range** (19 quantiles, shown as P10–P90 and P25–P75) with a *generic* error model in clear-sky-index space, conditioned on sky state, pooled over 16 reference cities on six continents (`generic.json`). This is the "trained elsewhere" forecaster.
3. **Checks it at the chosen location**: ~7 weeks of past day-ahead (and two-day-ahead) forecasts from the Open-Meteo previous-runs archive are scored against ERA5. Reliability diagram, PIT histogram, calibration error, and 80% interval coverage *always next to its width*, with Wilson intervals.
4. **Recalibrates locally** with per-quantile offsets per sky bin (shape-capable: fixes bias, width and skew), recency-weighted, at a strength chosen by a backtest *inside* the fitting window. The newest weeks are only used to judge the result, never to fit or choose. Zero model fits.
5. **Calibrates to your own panels** (the main point): import an inverter or meter CSV (hourly or finer, last 90 days; any common date format, W/kW/Wh/kWh, local time or UTC). The same per-quantile recalibration then runs against your measured output instead of ERA5, so it learns your roof's shading, soiling and clipping. It reports how much of the modelled output your system really makes on clear hours, and a **days-of-data curve**: how good the ranges get with your most recent N days. No data? "Try a simulated export" builds one from what the weather actually did, with afternoon shade, dust and a clipping inverter.
6. **Plans and exports**: daily kWh ranges, the most *reliable* 3-hour window each day for heavy loads (maximises P10, not P50), and a CSV of hourly P10/P25/P50/P75/P90.

Everything runs in the browser; Open-Meteo needs no key.

## Run

```bash
python3 -m http.server 8000      # http://localhost:8000
node check.mjs                   # model checks + live transfer test at 8 held-out cities (--offline to skip network)
node build-generic.mjs           # rebuild generic.json from the 16 reference cities
```

## Files

| file | what |
|---|---|
| `model.js` | solar geometry, PV model, quantiles, error model, per-quantile recalibration, reliability metrics (no dependencies; shared by the app and the checks) |
| `data.js` | Open-Meteo fetchers: forecast, previous runs, ERA5 archive, geocoding |
| `app.js`, `index.html` | the UI (Leaflet map, hand-drawn SVG charts) |
| `generic.json` | pooled error model, lead 1 and lead 2, built by `build-generic.mjs` |
| `production.js` | inverter/meter CSV importer: delimiter, header, date formats, units, time zones, interval start/end, resampling to hourly |
| `simulate.js` | a simulated inverter export (shade, soiling, clipping, noise) built from ERA5 |
| `check.mjs` | geometry and PV sanity checks, a synthetic transfer test, importer tests, a simulated-roof calibration test, and a live held-out-city test |

## What the checks show (October 2026)

Calibrated to its own output, a simulated 5 kWp roof (shaded after 3 pm, 7% soiling, inverter clipping at 80%) went from calibration error 0.238 to 0.054 on held-out weeks, the 80% range from catching 68% to 78%, and the median error from 0.37 to 0.31 kW. About 14 days of its own data were enough.

Against ERA5 alone (no user data), at 8 cities outside the reference set:

Local recalibration lowered calibration error at 6 of 8 held-out cities. It made Mumbai worse: the monsoon ended inside the window, so offsets fitted on older weeks no longer matched the newer ones. The app detects and says this instead of hiding it.

## Honest limits

- Without imported data, truth is ERA5 reanalysis, which smooths local cloud ramps and knows nothing about a specific roof. Importing your own data is what makes it a check against reality.
- The simulated-roof result is a simulation; real exports are messier (outages, curtailment, clock drift).
- Past ensemble members aren't archived, so the range comes from an error model around the multi-model mean rather than from ensemble spread.
- Daily kWh ranges add hourly quantiles, which assumes a cloudy day is cloudy all day (perfect within-day dependence).
- Seven weeks is short; a season change inside it can make local correction backfire (see Mumbai).

---

Built by [Unnati Shah](https://unnatibshah.github.io/).
