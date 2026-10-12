// Grid geometry, sampling, area masks and colour scales (shared by the page and the worker).
//
// Grid descriptors:
//   HRAP (Stage IV):  {kind:"hrap", R, x0, y0, dx, dy, width, height}
//       polar stereographic, true at 60N, lon0 -105, sphere radius R (m);
//       x0/y0 = left/top edge in projected metres, rows run toward the equator.
//   Lat/lon (MRMS):   {kind:"latlon", lon0, lat0, dlon, dlat, width, height}
//       lon0/lat0 = west/north edge in degrees.

const D2R = Math.PI / 180;
const K60 = 1 + Math.sin(60 * D2R);

export function hrapForward(R, lat, lon) {
  const phi = lat * D2R, dl = (lon + 105) * D2R;
  const rho = (R * Math.cos(phi) * K60) / (1 + Math.sin(phi));
  return [rho * Math.sin(dl), -rho * Math.cos(dl)];
}

export function hrapInverse(R, x, y) {
  const rho = Math.hypot(x, y);
  const lon = Math.atan2(x, -y) / D2R - 105;
  const lat = 90 - (2 * Math.atan(rho / (R * K60))) / D2R;
  return [lat, lon];
}

/** Fractional [col, row] of lat/lon on grid g. */
export function colRow(g, lat, lon) {
  if (g.kind === "latlon") return [(lon - g.lon0) / g.dlon, (g.lat0 - lat) / g.dlat];
  const [x, y] = hrapForward(g.R, lat, lon);
  return [(x - g.x0) / g.dx, (g.y0 - y) / g.dy];
}

export function cellIndex(g, lat, lon) {
  const [c, r] = colRow(g, lat, lon);
  const ci = Math.floor(c), ri = Math.floor(r);
  return ci >= 0 && ci < g.width && ri >= 0 && ri < g.height ? ri * g.width + ci : -1;
}

export function cellCenter(g, idx) {
  const r = Math.floor(idx / g.width), c = idx % g.width;
  if (g.kind === "latlon") return [g.lat0 - (r + 0.5) * g.dlat, g.lon0 + (c + 0.5) * g.dlon];
  return hrapInverse(g.R, g.x0 + (c + 0.5) * g.dx, g.y0 - (r + 0.5) * g.dy);
}

/** Lat/lon bounds [[s, w], [n, e]] of the grid (edges sampled; HRAP edges are curved). */
export function gridBounds(g) {
  if (g.kind === "latlon") return [[g.lat0 - g.height * g.dlat, g.lon0], [g.lat0, g.lon0 + g.width * g.dlon]];
  let s = 90, w = 180, n = -90, e = -180;
  const add = (c, r) => {
    const [la, lo] = hrapInverse(g.R, g.x0 + c * g.dx, g.y0 - r * g.dy);
    s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo);
  };
  for (let i = 0; i <= 40; i++) {
    add((g.width * i) / 40, 0); add((g.width * i) / 40, g.height);
    add(0, (g.height * i) / 40); add(g.width, (g.height * i) / 40);
  }
  return [[s, w], [n, e]];
}

export const sameGrid = (a, b) => a && b && a.kind === b.kind && a.width === b.width && a.height === b.height &&
  (a.kind === "latlon" ? Math.abs(a.lon0 - b.lon0) < 1e-6 && Math.abs(a.lat0 - b.lat0) < 1e-6
    : Math.abs(a.x0 - b.x0) < a.dx / 2 && Math.abs(a.y0 - b.y0) < a.dy / 2 && a.R === b.R);

export const gridKey = (g) => g.kind === "latlon"
  ? `ll:${g.lon0.toFixed(4)}:${g.lat0.toFixed(4)}:${g.dlon}:${g.width}x${g.height}`
  : `hrap:${g.R}:${Math.round(g.x0)}:${Math.round(g.y0)}:${g.width}x${g.height}`;

// ----------------------------------------------------------------- polygons
const polysOf = (geom) => (geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates);

/** Area in km^2 on a sphere (holes subtracted). */
export function polygonAreaKm2(geom) {
  const R = 6371.0088;
  let total = 0;
  for (const rings of polysOf(geom)) {
    rings.forEach((ring, k) => {
      let s = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const [l1, p1] = ring[i], [l2, p2] = ring[i + 1];
        s += (l2 - l1) * D2R * (2 + Math.sin(p1 * D2R) + Math.sin(p2 * D2R));
      }
      total += (k === 0 ? 1 : -1) * Math.abs((s * R * R) / 2);
    });
  }
  return Math.abs(total);
}

/** Label position: centroid of the largest outer ring, as [lat, lon]. */
export function labelPoint(geom) {
  let best = null, bestA = -1;
  for (const rings of polysOf(geom)) {
    const r = rings[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < r.length - 1; i++) {
      const f = r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
      a += f; cx += (r[i][0] + r[i + 1][0]) * f; cy += (r[i][1] + r[i + 1][1]) * f;
    }
    if (a !== 0 && Math.abs(a) > bestA) { bestA = Math.abs(a); best = [cy / (3 * a), cx / (3 * a)]; }
  }
  const p0 = polysOf(geom)[0][0][0];
  return best || [p0[1], p0[0]];
}

/** Indices of grid cells whose centres fall inside geom (scan-line, even-odd, holes honoured).
 *  Polygons smaller than a cell fall back to the cells under the label point and vertices. */
export function areaMask(g, geom) {
  const rings = [];
  let minR = Infinity, maxR = -Infinity;
  for (const poly of polysOf(geom)) {
    for (const ring of poly) {
      const pts = ring.map(([lon, lat]) => colRow(g, lat, lon));
      for (const [, r] of pts) { minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
      rings.push(pts);
    }
  }
  const out = [];
  const r0 = Math.max(0, Math.floor(minR)), r1 = Math.min(g.height - 1, Math.ceil(maxR));
  const xs = [];
  for (let r = r0; r <= r1; r++) {
    const y = r + 0.5;
    xs.length = 0;
    for (const pts of rings) {
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5)), c1 = Math.min(g.width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = c0; c <= c1; c++) out.push(r * g.width + c);
    }
  }
  if (!out.length) {
    const seen = new Set();
    const [la, lo] = labelPoint(geom);
    for (const [lat, lon] of [[la, lo], ...polysOf(geom)[0][0].map(([x, y]) => [y, x])]) {
      const i = cellIndex(g, lat, lon);
      if (i >= 0) seen.add(i);
    }
    out.push(...seen);
  }
  return Int32Array.from(out);
}

export function areaStats(arr, idx) {
  let n = 0, sum = 0, mx = -Infinity, mn = Infinity;
  for (let k = 0; k < idx.length; k++) {
    const v = arr[idx[k]];
    if (Number.isFinite(v)) { n++; sum += v; if (v > mx) mx = v; if (v < mn) mn = v; }
  }
  if (!n) return null;
  return { mean: sum / n, max: mx, min: mn, cells: idx.length, coverage: n / idx.length };
}

/** Reusable point indices + area masks for one grid. */
export class Sampler {
  constructor(g, points = [], areas = []) {
    this.pidx = points.map((p) => cellIndex(g, p.lat, p.lon));
    this.masks = areas.map((geom) => { try { return areaMask(g, geom); } catch (_) { return null; } });
  }
  points(arr) {
    return this.pidx.map((i) => { const v = i >= 0 ? arr[i] : NaN; return Number.isFinite(v) ? v : null; });
  }
  areas(arr, full = true) {
    return this.masks.map((m) => {
      if (!m || !m.length) return null;
      const s = areaStats(arr, m);
      return s ? (full ? s : s.mean) : null;
    });
  }
}

// ----------------------------------------------------------------- colour scales
export const NWS_COLORS = ["#04e9e7", "#019ff4", "#0300f4", "#02fd02", "#01c501", "#008e00", "#fdf802", "#e5bc00",
  "#fd9500", "#fd0000", "#d40000", "#bc0000", "#f800fd", "#9854c6", "#fdfdfd"];
export const PRECIP_SCALES = {
  hourly: [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5],
  daily: [0.01, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10],
  weekly: [0.01, 0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20],
  monthly: [0.1, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30],
  seasonal: [0.1, 1, 2, 4, 6, 8, 10, 15, 20, 25, 30, 40, 50, 60, 80],
};
const DEP_STEPS = { hourly: [0.05, 0.1, 0.25, 0.5, 1, 2], daily: [0.1, 0.25, 0.5, 1, 2, 4], weekly: [0.25, 0.5, 1, 2, 4, 8],
  monthly: [0.5, 1, 2, 4, 8, 12], seasonal: [1, 2, 4, 8, 15, 25] };
const DEP_COLORS = ["#543005", "#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f5f0e6", "#dddddd",
  "#e0f3f1", "#c7eae5", "#80cdc1", "#35978f", "#01665e", "#003c30"];
const PCT_LOWS = [0, 5, 10, 25, 50, 75, 90, 110, 125, 150, 200, 300, 400, 600];
const PCT_COLORS = ["#67001f", "#a50026", "#d73027", "#f46d43", "#fdae61", "#fee090", "#e8e8e8",
  "#c6e9b4", "#7fcdbb", "#41b6c4", "#1d91c0", "#225ea8", "#0c2c84", "#6a1b9a"];
export const VAR_LABELS = { obs: "Observed precipitation", normal: "Normal (PRISM)", departure: "Departure from normal", pct: "Percent of normal" };

export function legendFor(v, scale) {
  let lows, cols, unit = "in";
  if (v === "obs" || v === "normal") { lows = PRECIP_SCALES[scale]; cols = NWS_COLORS; }
  else if (v === "departure") { const s = DEP_STEPS[scale]; lows = [-Infinity, ...s.slice().reverse().map((x) => -x), ...s]; cols = DEP_COLORS; }
  else { lows = [-Infinity, ...PCT_LOWS.slice(1)]; cols = PCT_COLORS; unit = "%"; }
  const items = cols.map((color, i) => ({ lo: lows[i] === -Infinity ? null : lows[i], hi: i + 1 < lows.length ? lows[i + 1] : null, color }));
  // packed RGBA for little-endian ImageData (0xAABBGGRR)
  const packed = new Uint32Array(cols.map((c) => (255 << 24 | parseInt(c.slice(5, 7), 16) << 16 | parseInt(c.slice(3, 5), 16) << 8 | parseInt(c.slice(1, 3), 16)) >>> 0));
  return { lows: Float64Array.from(lows), packed, transparentBelow: v === "obs" || v === "normal", unit, title: VAR_LABELS[v], items };
}

export function colorOf(lg, v) {
  if (!Number.isFinite(v)) return 0;
  const lows = lg.lows;
  if (v < lows[0]) return lg.transparentBelow ? 0 : lg.packed[0];
  let lo = 0, hi = lows.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lows[m] <= v) lo = m; else hi = m - 1; }
  return lg.packed[lo];
}

function percentile(arr, q, filter) {
  const vals = [];
  const step = Math.max(1, Math.floor(arr.length / 400000));       // subsample big grids
  for (let i = 0; i < arr.length; i += step) { const v = arr[i]; if (filter(v)) vals.push(v); }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(q * vals.length))];
}

export function autoScale(obs) {
  const p = percentile(obs, 0.999, (v) => v > 0);
  if (p == null) return "daily";
  for (const [name, stops] of Object.entries(PRECIP_SCALES)) if (p <= stops[stops.length - 1] * 0.9) return name;
  return "seasonal";
}

export function autoDepScale(obs, normal) {
  const dep = new Float32Array(obs.length);
  for (let i = 0; i < obs.length; i++) dep[i] = Math.abs(obs[i] - normal[i]);
  const p = percentile(dep, 0.99, Number.isFinite);
  if (p == null) return "daily";
  for (const [name, s] of Object.entries(DEP_STEPS)) if (p <= s[s.length - 1] * 1.2) return name;
  return "seasonal";
}

// ----------------------------------------------------------------- GeoTIFF georeferencing
const HRAP_KEYS = [1, 1, 0, 20, 1024, 0, 1, 1, 1025, 0, 1, 1, 1026, 34737, 15, 0, 2048, 0, 1, 32767, 2049, 34737, 84, 15,
  2050, 0, 1, 32767, 2054, 0, 1, 9102, 2056, 0, 1, 32767, 2057, 34736, 1, 5, 2058, 34736, 1, 6, 2061, 34736, 1, 7,
  3072, 0, 1, 32767, 3074, 0, 1, 32767, 3075, 0, 1, 15, 3076, 0, 1, 9001, 3081, 34736, 1, 0, 3082, 34736, 1, 3,
  3083, 34736, 1, 4, 3092, 34736, 1, 2, 3095, 34736, 1, 1];
const HRAP_ASCII = "NOAA_HRAP_Grid|GCS Name = GCS_NOAA_HRAP|Datum = D_NOAA_HRAP|Ellipsoid = Sphere|Primem = Greenwich||";

/** GeoTIFF tags for a (sub)grid whose top-left cell is (c0, r0). */
export function geoTagsFor(g, c0 = 0, r0 = 0) {
  if (g.kind === "latlon") {
    return {
      pixelScale: [g.dlon, g.dlat, 0], tiepoint: [0, 0, 0, g.lon0 + c0 * g.dlon, g.lat0 - r0 * g.dlat, 0],
      geoKeys: [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326],
    };
  }
  return {
    pixelScale: [g.dx, g.dy, 0], tiepoint: [0, 0, 0, g.x0 + c0 * g.dx, g.y0 - r0 * g.dy, 0],
    geoKeys: HRAP_KEYS, geoDoubles: [60, -105, 1, 0, 0, g.R, g.R, 0], geoAscii: HRAP_ASCII,
  };
}
