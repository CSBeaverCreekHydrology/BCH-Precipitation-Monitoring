# BCH Precipitation Monitoring

Beaver Creek Hydrology's web map of NWS radar-based precipitation estimates. It runs entirely
in the browser: there is no server to maintain, and it works on phones, tablets and computers.
Host it free with **GitHub Pages**.

## Data

| Tab | Product | Resolution | Time step | Period | Source |
|---|---|---|---|---|---|
| **Daily** | Stage IV multisensor QPE (radar + gauges, NWS River Forecast Centers) | 4.76 km | 24 h ending 12:00 UTC | Jan 2016 – today (CONUS, Alaska, Puerto Rico) | `water.noaa.gov/resources/downloads/precip/stageIV` |
| **Hourly** | MRMS QPE: multi-sensor Pass 1/2 or radar-only (NOAA/NSSL) | ~1 km | 1 h | Oct 2020 – latest hour (CONUS) | NOAA Open Data on AWS: `noaa-mrms-pds` |

Both sources allow direct browser access, so the page downloads and decodes the files itself
(GeoTIFF, GRIB1, GRIB2) in a background worker. A range is built from the fewest files possible.
For example, "last 30 days" is a single NWS file, and 72 hours of MRMS is one file.

## Features

- Any date or hour range, with presets: latest day, 3/7/14/30 days, month / water year / year to date, 1–72 h.
- **↻ Refresh** (on the map and by the Load button) re-checks NWS for new or revised data. It rolls
  "last N days" presets forward and redraws the whole map. Optional auto-refresh every 10/30/60 minutes.
- Observed, PRISM normal, departure from normal, and percent of normal (daily data).
- **Time step** (shown for longer ranges): hourly, daily or monthly. It drives the breakdown chart,
  the Breakdown CSV and the step-through / ▶ animation. Stage IV months follow the NWS month-to-date
  convention: the 24-h periods ending 12Z on the 2nd through the 1st of the next month.
- Tap a point for its values and a bar chart over the range (CSV / table). There are no length limits;
  long ranges just take longer the first time (files are cached afterwards).
- **Missing data**: totals use all the data that exists. A value with an asterisk (e.g. `1.23 in*`)
  means some days or hours had no data there. The point card, chart, table and CSVs list which ones.
- **Saved locations**: points show the mapped value in small text above them.
  - **Areas**: draw them, or import a zipped shapefile (any projection) or GeoJSON. Areas show grid-cell averages.
  - **Exports**: tick the checkbox beside each location to include in "Values CSV" and "Breakdown CSV".
- GeoTIFF export of the current view or the full grid, in inches. It opens directly in ArcGIS / Civil 3D.
- Place or address search (Esri World Geocoder).

## Saved locations

- Locations you save are stored **in your browser on that device** (localStorage). They stay
  after closing the page.
- `data/locations.json` holds the **shared** list that everyone sees on every device. To change it,
  open **Backup & share locations → Export locations**, then replace `data/locations.json` in the
  repository with the downloaded file.
- **Import locations** loads a locations file on another device.
- The site is public, so keep personal locations out of `data/locations.json`. Import those from a
  private file on each device instead.

## Publish on GitHub Pages

1. Create a new repository on GitHub, for example `bch-precipitation-monitoring` (Public; a
   private repo needs a paid plan for Pages).
2. Upload **the contents of this folder** (`index.html`, `css/`, `js/`, `data/`, `.nojekyll`,
   `README.md`) to the repository root: **Add file → Upload files**, drag them in, then **Commit**.
   (`.nojekyll` is hidden in Windows Explorer and isn't strictly needed; skip it if it won't upload.)
3. Go to **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**,
   branch **main**, folder **/ (root)**, then **Save**.
4. After about a minute the site is live at
   `https://<your-github-username>.github.io/bch-precipitation-monitoring/`.
   Open it on a phone and use **Add to Home Screen** for an app-like icon.

Or, from a terminal with git installed:

```bash
git init
git add .
git commit -m "BCH Precipitation Monitoring"
git branch -M main
git remote add origin https://github.com/<your-github-username>/bch-precipitation-monitoring.git
git push -u origin main
```

**Updating:** edit or re-upload files and commit. GitHub Pages republishes within a minute or two.
Browsers may keep the old version for up to 10 minutes. After changing any file in `css/` or `js/`,
search-and-replace `?v=2` with the next number (`?v=3`, …) in `index.html` and all `js/*.js`
files. That makes everyone load the new copies together.

## Test locally

Browsers won't run the module worker from a `file://` page, so serve the folder:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## Requirements and notes

- A current browser: Chrome/Edge 103+, Safari 16.4+, or Firefox 113+.
- Hourly MRMS grids are about 100 MB each in memory. Older phones may struggle with long hourly
  ranges; the daily tab is light.
- Estimates are provisional. Recent days can be revised, and **Refresh** picks up re-posted files.
- Long breakdowns download one file per day (Stage IV, ~0.7 MB each) or per hour/day block (MRMS,
  ~1 MB each). A one-year daily breakdown is ~260 MB the first time; the files are cached after that.

Code layout: `js/app.js` (page and map), `js/engine.js` (finding, downloading and summing data),
`js/bins.js` (hourly/daily/monthly periods),
`js/worker.js` (runs the engine off the main thread), `js/decoders.js` (GeoTIFF/GRIB/PNG/tar/zip),
`js/grid.js` (projections, sampling, colors), `js/shapes.js` (shapefile/GeoJSON import).
