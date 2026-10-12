// Data engine for BCH Precipitation Monitoring: finds, downloads, decodes and sums NWS
// precipitation grids entirely in the browser (runs inside js/worker.js).
//
//   Stage IV daily (NWS River Forecast Centers, radar + gauges), 24 h ending 12Z, 2016-present
//     water.noaa.gov/resources/downloads/precip/stageIV/YYYY/MM/DD/  (GeoTIFF; NCEP GRIB tarball fallback)
//   MRMS hourly (NOAA/NSSL, ~1 km), October 2020-present, NOAA Open Data on AWS
//     noaa-mrms-pds.s3.amazonaws.com/CONUS/<product>_00.00/YYYYMMDD/

import { readTiff, decodeGrib1, decodeGrib2, inflate, untar, isGzip } from "./decoders.js";
import { Sampler, sameGrid, gridKey } from "./grid.js";

export const S4_BASE = "https://water.noaa.gov/resources/downloads/precip/stageIV";
export const MRMS_BASE = "https://noaa-mrms-pds.s3.amazonaws.com";
export const S4_EARLIEST = "2016-01-01";
export const MRMS_EARLIEST = "2020-10-15T00:00:00Z";
export const REGIONS = {
  conus: { label: "Contiguous US", grid: { kind: "hrap", R: 6371200, x0: -1904912.11073866, y0: -3423783.69569394, dx: 4762.5, dy: 4762.5, width: 1121, height: 881 } },
  ak: { label: "Alaska", grid: { kind: "hrap", R: 6367470, x0: -3288923.2282200567, y0: -1002622.6720475592, dx: 4762.5, dy: 4762.5, width: 460, height: 530 } },
  pr: { label: "Puerto Rico", grid: { kind: "hrap", R: 6367470, x0: 4940902.266009701, y0: -6234583.378461189, dx: 4762.5, dy: 4762.5, width: 205, height: 205 } },
};
export const MRMS_PRODUCTS = {
  ms2: { label: "Multi-sensor Pass 2 (radar + gauges, ~2 h latency)", dir: (h) => `MultiSensor_QPE_${pad(h)}H_Pass2_00.00` },
  ms1: { label: "Multi-sensor Pass 1 (radar + gauges, ~1 h latency)", dir: (h) => `MultiSensor_QPE_${pad(h)}H_Pass1_00.00` },
  radar: { label: "Radar only (fastest, no gauge correction)", dir: (h) => `RadarOnly_QPE_${pad(h)}H_00.00` },
};
const S4_LASTN = [365, 180, 120, 90, 60, 30, 14, 10, 7, 6, 5, 4, 3, 2];
const S4_DAILY_TIF_MAX = 62;          // longer ranges use the ~5x smaller GRIB tarballs (no normals)
export const SERIES_MAX_DAYS = 92;
export const SERIES_MAX_HOURS = 72;
export const MRMS_MAX_HOURS = 744;    // 31 days
const MRMS_WINDOWS = [72, 48, 24, 12, 6, 3, 1];
const DAY = 86400000, HOUR = 3600000;

function pad(n, w = 2) { return String(n).padStart(w, "0"); }
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const ymdSlash = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
export const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseDay = (s) => new Date(`${s}T00:00:00Z`);
const todayUtc = () => parseDay(isoDay(new Date()));
const daysAgo = (d) => Math.round((todayUtc() - d) / DAY);

export class UserError extends Error {}

// ----------------------------------------------------------------- fetching + caching
let refreshMark = 0;                  // recent files fetched before this are re-validated
const CACHE_NAME = "bch-precip-data-v1";
const hasCacheApi = typeof caches !== "undefined";

/** Forget listings and re-check recent (provisional) files on the next fetch. */
export function refresh() {
  refreshMark = Date.now();
  listings.clear();
  latestCache.clear();
  for (const [k, v] of grids) if (v.recent) { gridBytes -= v.bytes; grids.delete(k); }
}

/** GET url -> Uint8Array, or null when the file does not exist. immutable files go to Cache Storage. */
async function getBytes(url, { immutable = false, revalidate = false } = {}) {
  let cache = null;
  if (immutable && hasCacheApi) {
    try {
      cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch (_) { cache = null; }
  }
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { cache: revalidate ? "no-cache" : "default" });
      if (r.status === 404 || r.status === 403) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (cache) {
        cache.put(url, new Response(buf.slice(0), { headers: { "Content-Type": "application/octet-stream" } }))
          .then(pruneCache).catch(() => {});
      }
      return new Uint8Array(buf);
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
  }
  throw new Error(`Download failed (${last && last.message}): ${url}`);
}

let pruneTick = 0;
async function pruneCache() {
  if (++pruneTick % 25) return;
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - 600))) await cache.delete(k);
}

async function getText(url, opts) {
  const b = await getBytes(url, opts);
  return b ? new TextDecoder().decode(b) : null;
}

/** Run fn over items with limited concurrency, preserving order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// decoded grids, LRU by bytes
const grids = new Map();
let gridBytes = 0;
const GRID_CACHE_BYTES = 320e6;
function cacheGet(key) {
  const v = grids.get(key);
  if (v) { grids.delete(key); grids.set(key, v); }
  return v;
}
function cachePut(key, v, recent) {
  v.bytes = v.obs.byteLength + (v.normal ? v.normal.byteLength : 0);
  v.recent = recent;
  grids.set(key, v);
  gridBytes += v.bytes;
  for (const [k, old] of grids) {
    if (gridBytes <= GRID_CACHE_BYTES || grids.size <= 1) break;
    grids.delete(k); gridBytes -= old.bytes;
  }
  return v;
}
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ----------------------------------------------------------------- Stage IV
const listings = new Map();
const latestCache = new Map();
const s4Dir = (d) => `${S4_BASE}/${ymdSlash(d)}/`;
const s4Recent = (d) => daysAgo(d) <= 5;

async function s4Listing(d) {
  const key = isoDay(d);
  const hit = listings.get(key);
  const ttl = daysAgo(d) <= 20 ? 10 * 60000 : Infinity;
  if (hit && Date.now() - hit.t < ttl) return hit.names;
  const html = await getText(s4Dir(d), { revalidate: daysAgo(d) <= 20 });
  const names = new Set(html ? [...html.matchAll(/href="([^"?/]+)"/g)].map((m) => m[1]) : []);
  listings.set(key, { t: Date.now(), names });
  return names;
}

export async function s4Latest(region) {
  if (latestCache.has(region)) return latestCache.get(region);
  const today = todayUtc();
  for (let back = 0; back < 8; back++) {
    const d = new Date(today - back * DAY);
    if ((await s4Listing(d)).has(`nws_precip_1day_${ymd(d)}_${region}.tif`)) {
      latestCache.set(region, isoDay(d));
      return isoDay(d);
    }
  }
  throw new Error("Could not find recent Stage IV files on water.noaa.gov");
}

async function windowCandidates(d, region) {
  const names = await s4Listing(d);
  const out = S4_LASTN.map((n) => [`nws_precip_last${n}days_${ymd(d)}_${region}.tif`, n]);
  // NWS month / water-year / year-to-date files start with the day ending 12Z on the 2nd
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (d.getUTCDate() >= 2) out.push([`nws_precip_mtd_${ymd(d)}_${region}.tif`, d.getUTCDate() - 1]);
  const wy = new Date(Date.UTC(m >= 9 ? y : y - 1, 9, 2));
  if (d >= wy) out.push([`nws_precip_wytd_${ymd(d)}_${region}.tif`, Math.round((d - wy) / DAY) + 1]);
  const jan = new Date(Date.UTC(y, 0, 2));
  if (d >= jan) out.push([`nws_precip_ytd_${ymd(d)}_${region}.tif`, Math.round((d - jan) / DAY) + 1]);
  return out.filter(([f]) => names.has(f));
}

/** Fewest files covering [start, end] (inclusive end dates): pre-summed windows where published, else days. */
async function s4Plan(start, end, region) {
  const latest = parseDay(await s4Latest(region));
  const parts = [];
  let d = end, rem = Math.round((end - start) / DAY) + 1;
  while (rem > 0) {
    let best = null;
    if ((latest - d) / DAY <= 20) {                // pre-summed windows are only kept ~2 weeks
      for (const [f, n] of await windowCandidates(d, region)) if (n <= rem && (!best || n > best[1])) best = [f, n];
    }
    if (best) { parts.push({ kind: "window", d, n: best[1], fname: best[0] }); d = new Date(d - best[1] * DAY); rem -= best[1]; }
    else { parts.push({ kind: "day", d, n: 1 }); d = new Date(d - DAY); rem -= 1; }
  }
  return parts;
}

function gridFromTiff(t, region) {
  const g = { kind: "hrap", R: REGIONS[region].grid.R, x0: t.tiepoint[3], y0: t.tiepoint[4], dx: t.pixelScale[0], dy: t.pixelScale[1], width: t.width, height: t.height };
  // snap to the canonical regional grid when it is the same layout (GRIB georef differs by < 1 cell)
  return sameGrid(g, REGIONS[region].grid) ? REGIONS[region].grid : g;
}

function cleanNeg(a) { for (let i = 0; i < a.length; i++) if (!(a[i] >= 0)) a[i] = NaN; return a; }

async function s4Tif(d, fname, region) {
  const key = `s4tif:${fname}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return once(key, async () => {
    const recent = s4Recent(d);
    const bytes = await getBytes(s4Dir(d) + fname, { immutable: !recent, revalidate: recent && refreshMark > 0 });
    if (!bytes) return null;
    const t = await readTiff(bytes, [0, 1]);
    return cachePut(key, { grid: gridFromTiff(t, region), obs: cleanNeg(t.bands[0]), normal: cleanNeg(t.bands[1]), src: "tif" }, recent);
  });
}

async function s4Tar(d, region) {
  const key = `s4tar:${isoDay(d)}:${region}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return once(key, async () => {
    const recent = s4Recent(d);
    const bytes = await getBytes(`${s4Dir(d)}ncep_stage_iv_source_files_${ymd(d)}.tar`, { immutable: !recent, revalidate: recent && refreshMark > 0 });
    if (!bytes) return null;
    const member = untar(bytes).find((f) => new RegExp(`(^|/)${region}_\\d{8}_24h\\.grb2?(\\.gz)?$`).test(f.name));
    if (!member) return null;
    let raw = member.data;
    if (isGzip(raw)) raw = await inflate(raw, "gzip");
    const g = raw[7] === 2 ? await decodeGrib2(raw) : decodeGrib1(raw);
    const ref = REGIONS[region].grid;
    if (g.nx !== ref.width || g.ny !== ref.height) return null;
    const obs = g.values;
    for (let i = 0; i < obs.length; i++) obs[i] = obs[i] >= 0 && obs[i] < 9000 ? obs[i] / 25.4 : NaN;   // mm -> in
    return cachePut(key, { grid: ref, obs, normal: null, src: "grib" }, recent);
  });
}

async function s4Day(d, region, preferTif) {
  const tif = `nws_precip_1day_${ymd(d)}_${region}.tif`;
  const order = preferTif || cacheGet(`s4tif:${tif}`) ? ["tif", "tar"] : ["tar", "tif"];
  for (const k of order) {
    try {
      const g = k === "tif" ? await s4Tif(d, tif, region) : await s4Tar(d, region);
      if (g) return g;
    } catch (e) {
      if (k === order[1]) throw e;
    }
  }
  return null;
}

export async function computeStage4(p, progress) {
  if (!REGIONS[p.region]) throw new UserError("Unknown region");
  const start = parseDay(p.start), end = parseDay(p.end);
  const latest = parseDay(await s4Latest(p.region));
  if (start > end) throw new UserError("First day is after last day.");
  if (start < parseDay(S4_EARLIEST)) throw new UserError("The Stage IV archive starts Jan 1, 2016.");
  if (end > latest) throw new UserError(`Latest available day is ${isoDay(latest)}.`);
  const ndays = Math.round((end - start) / DAY) + 1;
  progress({ done: 0, total: 1, message: "Planning downloads…" });
  const parts = await s4Plan(start, end, p.region);
  const preferTif = ndays <= S4_DAILY_TIF_MAX;
  let done = 0;
  const loaded = await pool(parts, 6, async (part) => {
    let g = null;
    try { g = part.kind === "window" ? await s4Tif(part.d, part.fname, p.region) : await s4Day(part.d, p.region, preferTif); }
    catch (e) { g = null; part.error = e.message; }
    done++;
    progress({ done, total: parts.length, message: `Downloaded ${done} of ${parts.length} file(s)` });
    return g;
  });
  const ref = loaded.find((g) => g && g.normal) || loaded.find((g) => g);
  if (!ref) throw new UserError("No Stage IV data was found for that range.");
  const N = ref.obs.length;
  const obs = new Float32Array(N), normal = new Float32Array(N);
  let hasNormals = true;
  const missing = [];
  loaded.forEach((g, i) => {
    const part = parts[i];
    if (!g || !sameGrid(g.grid, ref.grid)) {
      for (let k = 0; k < part.n; k++) missing.push(new Date(part.d - k * DAY));
      return;
    }
    for (let k = 0; k < N; k++) obs[k] += g.obs[k];
    if (g.normal) for (let k = 0; k < N; k++) normal[k] += g.normal[k];
    else hasNormals = false;
  });
  const warnings = [];
  if (missing.length) {
    missing.sort((a, b) => a - b);
    const fmt = (x) => x.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
    warnings.push(`${missing.length} day(s) missing from the NWS archive and excluded: ${missing.slice(0, 6).map(fmt).join(", ")}${missing.length > 6 ? ` (+${missing.length - 6} more)` : ""}`);
  }
  if (!hasNormals) warnings.push("Normals are unavailable for part of this range (archive GRIB files), so departure and % of normal are off.");
  const fmtD = (x) => x.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "2-digit", year: "numeric" });
  return {
    meta: {
      source: "stage4", region: p.region, product: `Stage IV multisensor QPE – ${REGIONS[p.region].label}`,
      label: `${ndays === 1 ? fmtD(end) : `${fmtD(start)} – ${fmtD(end)}`} (${ndays} day${ndays > 1 ? "s" : ""})`,
      start: p.start, end: p.end, start_utc: new Date(+start - DAY + 12 * HOUR).toISOString(), end_utc: new Date(+end + 12 * HOUR).toISOString(),
      n_steps: ndays, step: "day", has_normals: hasNormals, resolution: "4.76 km HRAP grid", warnings,
      files: parts.map((pt, i) => `${pt.fname || `1day (${loaded[i] ? loaded[i].src : "missing"})`} @ ${isoDay(pt.d)}`),
      computed_utc: new Date().toISOString(),
    },
    grid: ref.grid, obs, normal: hasNormals ? normal : null,
  };
}

export async function stage4Series(meta, points, areas, progress) {
  const start = parseDay(meta.start), end = parseDay(meta.end);
  const n = Math.round((end - start) / DAY) + 1;
  if (n > SERIES_MAX_DAYS) throw new UserError(`Daily breakdown is limited to ${SERIES_MAX_DAYS} days.`);
  const days = Array.from({ length: n }, (_, i) => new Date(+start + i * DAY));
  const samplers = new Map();
  let done = 0;
  const rows = await pool(days, 6, async (d) => {
    let g = null;
    try { g = await s4Day(d, meta.region, n <= S4_DAILY_TIF_MAX); } catch (_) { g = null; }
    progress && progress({ done: ++done, total: n, message: `Reading day ${done} of ${n}` });
    if (!g) return null;
    const key = gridKey(g.grid);
    if (!samplers.has(key)) samplers.set(key, new Sampler(g.grid, points, areas));
    const s = samplers.get(key);
    return [s.points(g.obs), s.areas(g.obs, false)];
  });
  return seriesResult("day", days.map((d) => ({ t: isoDay(d), end_utc: `${isoDay(d)}T12:00:00Z` })), rows, points.length, areas.length);
}

function seriesResult(step, times, rows, nPts, nAreas) {
  return {
    step, times,
    points: Array.from({ length: nPts }, (_, k) => rows.map((r) => (r ? r[0][k] : null))),
    areas: Array.from({ length: nAreas }, (_, k) => rows.map((r) => (r ? r[1][k] : null))),
  };
}

// ----------------------------------------------------------------- MRMS
const mrmsKey = (product, h, t) => {
  const dir = MRMS_PRODUCTS[product].dir(h);
  return `CONUS/${dir}/${ymd(t)}/MRMS_${dir}_${ymd(t)}-${pad(t.getUTCHours())}0000.grib2.gz`;
};

export async function mrmsLatest(product) {
  const key = `mrms:${product}`;
  if (latestCache.has(key)) return latestCache.get(key);
  const dir = MRMS_PRODUCTS[product].dir(1);
  for (let back = 0; back < 3; back++) {
    const d = new Date(+todayUtc() - back * DAY);
    const xml = await getText(`${MRMS_BASE}/?list-type=2&prefix=CONUS/${dir}/${ymd(d)}/`, { revalidate: true });
    const keys = xml ? [...xml.matchAll(/<Key>[^<]*_(\d{8})-(\d{2})0000\.grib2\.gz<\/Key>/g)] : [];
    if (keys.length) {
      const [, day, hh] = keys[keys.length - 1];
      const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T${hh}:00:00.000Z`;
      latestCache.set(key, iso);
      return iso;
    }
  }
  throw new Error("Could not list MRMS files on NOAA Open Data (AWS)");
}

/** Plan [t0, t1] (hours) with the fewest files from `windows` (shortest path over hour offsets). */
function mrmsPlan(t0, t1, windows) {
  const n = Math.round((t1 - t0) / HOUR);
  const best = new Array(n + 1).fill(null);
  best[0] = [0, -1, 0];
  for (let i = 1; i <= n; i++) {
    for (const w of windows) {
      if (w <= i && best[i - w] && (!best[i] || best[i - w][0] + 1 < best[i][0])) best[i] = [best[i - w][0] + 1, i - w, w];
    }
  }
  const parts = [];
  for (let i = n; i > 0; i = best[i][1]) parts.push({ t: new Date(+t0 + i * HOUR), w: best[i][2] });
  return parts;
}

async function mrmsGrid(product, w, t) {
  const key = `mrms:${mrmsKey(product, w, t)}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return once(key, async () => {
    const bytes = await getBytes(`${MRMS_BASE}/${mrmsKey(product, w, t)}`, { immutable: true });
    if (!bytes) return null;
    const g = await decodeGrib2(await inflate(bytes, "gzip"));
    const v = g.values;
    for (let i = 0; i < v.length; i++) v[i] = v[i] >= 0 ? v[i] / 25.4 : NaN;     // mm -> in; -3 = no radar coverage
    const lon1 = g.lon1 > 180 ? g.lon1 - 360 : g.lon1;
    const grid = { kind: "latlon", lon0: lon1 - g.dx / 2, lat0: g.lat1 + g.dy / 2, dlon: g.dx, dlat: g.dy, width: g.nx, height: g.ny };
    return cachePut(key, { grid, obs: v, normal: null, src: "grib2" }, false);
  });
}

export async function computeMrms(p, progress) {
  if (!MRMS_PRODUCTS[p.product]) throw new UserError("Unknown MRMS product");
  const t0 = new Date(Math.round(Date.parse(p.start) / HOUR) * HOUR), t1 = new Date(Math.round(Date.parse(p.end) / HOUR) * HOUR);
  const hours = Math.round((t1 - t0) / HOUR);
  if (hours < 1) throw new UserError("End must be at least one hour after start.");
  if (hours > MRMS_MAX_HOURS) throw new UserError(`Hourly (MRMS) ranges are limited to ${MRMS_MAX_HOURS / 24} days; use the daily archive for longer periods.`);
  if (t0 < new Date(MRMS_EARLIEST)) throw new UserError("The MRMS archive on NOAA Open Data starts Oct 15, 2020; use the daily archive for older dates.");
  const latest = new Date(await mrmsLatest(p.product));
  if (t1 > latest) throw new UserError(`Latest available hour ends ${latest.toISOString().slice(0, 16).replace("T", " ")} UTC.`);
  const parts = mrmsPlan(t0, t1, MRMS_WINDOWS);
  let sum = null, grid = null, done = 0, total = parts.length;
  const used = [], missingHours = [];
  // sequential: each MRMS grid is ~100 MB in memory
  const addPart = async (t, w) => {
    const g = await mrmsGrid(p.product, w, t);
    done++;
    progress({ done, total, message: `Downloaded ${done} of ${total} file(s)` });
    if (!g) {
      if (w === 1) { missingHours.push(t); return; }
      const sub = mrmsPlan(new Date(+t - w * HOUR), t, MRMS_WINDOWS.filter((x) => x < w));
      total += sub.length;
      for (const s of sub) await addPart(s.t, s.w);
      return;
    }
    if (!sum) { sum = new Float32Array(g.obs.length); grid = g.grid; }
    const o = g.obs;
    for (let i = 0; i < o.length; i++) sum[i] += o[i];
    used.push(`${MRMS_PRODUCTS[p.product].dir(w)} ending ${t.toISOString().slice(0, 13).replace("T", " ")}Z`);
  };
  for (const part of parts) await addPart(part.t, part.w);
  if (!sum) throw new UserError("No MRMS data was found for that range.");
  const warnings = missingHours.length ? [`${missingHours.length} hour(s) missing from the MRMS archive and counted as zero.`] : [];
  const z = (d) => d.toISOString().slice(5, 16).replace("T", " ");
  return {
    meta: {
      source: "mrms", product: `MRMS ${MRMS_PRODUCTS[p.product].label}`, product_key: p.product,
      label: `${z(t0)} – ${z(t1)} UTC (${hours} h)`, start_utc: t0.toISOString(), end_utc: t1.toISOString(),
      n_steps: hours, step: "hour", has_normals: false, resolution: "0.01° (~1 km) grid", warnings, files: used,
      computed_utc: new Date().toISOString(),
    },
    grid, obs: sum, normal: null,
  };
}

export async function mrmsSeries(meta, points, areas, progress) {
  const t0 = new Date(meta.start_utc);
  const n = meta.n_steps;
  if (n > SERIES_MAX_HOURS) throw new UserError(`Hourly breakdown is limited to ${SERIES_MAX_HOURS} hours.`);
  const hours = Array.from({ length: n }, (_, i) => new Date(+t0 + (i + 1) * HOUR));
  let sampler = null, done = 0;
  const rows = [];
  for (const t of hours) {               // sequential to bound memory
    let g = null;
    try { g = await mrmsGrid(meta.product_key, 1, t); } catch (_) { g = null; }
    progress && progress({ done: ++done, total: n, message: `Reading hour ${done} of ${n}` });
    if (!g) { rows.push(null); continue; }
    if (!sampler) sampler = new Sampler(g.grid, points, areas);
    rows.push([sampler.points(g.obs), sampler.areas(g.obs, false)]);
  }
  return seriesResult("hour", hours.map((t) => ({ t: t.toISOString(), end_utc: t.toISOString() })), rows, points.length, areas.length);
}

// ----------------------------------------------------------------- public API (called through the worker)
export const api = {
  config: async () => ({
    regions: Object.fromEntries(Object.entries(REGIONS).map(([k, v]) => [k, v.label])),
    mrms_products: Object.fromEntries(Object.entries(MRMS_PRODUCTS).map(([k, v]) => [k, v.label])),
    s4_earliest: S4_EARLIEST, mrms_earliest: MRMS_EARLIEST, series_max_days: SERIES_MAX_DAYS,
    series_max_hours: SERIES_MAX_HOURS, mrms_max_hours: MRMS_MAX_HOURS,
  }),
  refresh: async () => { refresh(); return true; },
  s4Latest: (region) => s4Latest(region),
  mrmsLatest: (product) => mrmsLatest(product),
  accumulate: (p, progress) => (p.source === "stage4" ? computeStage4(p, progress) : computeMrms(p, progress)),
  series: (meta, points, areas, progress) =>
    (meta.source === "stage4" ? stage4Series(meta, points, areas, progress) : mrmsSeries(meta, points, areas, progress)),
};
