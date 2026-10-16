// Polygon import for saved areas: zipped shapefile (.shp/.dbf/.prj, any projection via proj4js) or GeoJSON.
import { unzip } from "./decoders.js?v=4";
import { polygonAreaKm2 } from "./grid.js?v=4";

const PROJ4_URL = "https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.11.0/proj4.js";
let proj4Promise = null;
function loadProj4() {
  if (window.proj4) return Promise.resolve(window.proj4);
  proj4Promise = proj4Promise || new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = PROJ4_URL;
    s.onload = () => res(window.proj4);
    s.onerror = () => rej(new Error("Could not load the projection library (proj4js)."));
    document.head.appendChild(s);
  });
  return proj4Promise;
}

const ringArea = (r) => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return a / 2; };
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** ESRI shapefile Polygon / PolygonZ / PolygonM records -> GeoJSON MultiPolygon (or null). */
function readShp(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  let p = 100;
  while (p + 8 <= u8.length) {
    const clen = dv.getInt32(p + 4, false) * 2;
    const rec = p + 8;
    p = rec + clen;
    const type = clen >= 4 ? dv.getInt32(rec, true) : 0;
    if (![5, 15, 25].includes(type)) { out.push(null); continue; }
    const nparts = dv.getInt32(rec + 36, true), npts = dv.getInt32(rec + 40, true);
    const parts = [];
    for (let i = 0; i < nparts; i++) parts.push(dv.getInt32(rec + 44 + 4 * i, true));
    parts.push(npts);
    const xy = rec + 44 + 4 * nparts;
    const rings = [];
    for (let k = 0; k < nparts; k++) {
      const ring = [];
      for (let i = parts[k]; i < parts[k + 1]; i++) ring.push([dv.getFloat64(xy + 16 * i, true), dv.getFloat64(xy + 16 * i + 8, true)]);
      rings.push(ring);
    }
    // outer rings are clockwise (negative signed area); holes counter-clockwise
    const outers = rings.filter((r) => ringArea(r) <= 0).map((r) => [r]);
    for (const r of rings.filter((r) => ringArea(r) > 0)) {
      const host = outers.find((o) => pointInRing(r[0][0], r[0][1], o[0]));
      if (host) host.push(r); else outers.push([r]);
    }
    out.push(outers.length ? { type: "MultiPolygon", coordinates: outers } : null);
  }
  return out;
}

/** One display name per .dbf record, from the first likely name field. */
function readDbfNames(u8) {
  try {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const nrec = dv.getUint32(4, true), hlen = dv.getUint16(8, true), rlen = dv.getUint16(10, true);
    const fields = [];
    for (let off = 32; u8[off] !== 0x0d; off += 32) {
      let name = "";
      for (let i = 0; i < 11 && u8[off + i]; i++) name += String.fromCharCode(u8[off + i]);
      fields.push({ name, type: String.fromCharCode(u8[off + 11]), len: u8[off + 16] });
    }
    const pref = ["NAME", "GNIS_NAME", "HUC_NAME", "LABEL", "TITLE", "ID", "HUC12", "HUC10", "HUC8"];
    const pick = pref.map((p) => fields.find((f) => f.name.toUpperCase() === p)).find(Boolean) || fields.find((f) => f.type === "C");
    if (!pick) return [];
    const start = 1 + fields.slice(0, fields.indexOf(pick)).reduce((a, f) => a + f.len, 0);
    const dec = new TextDecoder("latin1");
    return Array.from({ length: nrec }, (_, i) => dec.decode(u8.subarray(hlen + i * rlen + start, hlen + i * rlen + start + pick.len)).trim() || null);
  } catch (_) {
    return [];
  }
}

/** Douglas-Peucker on lon/lat rings (~20 m), keeping rings closed. Imported watersheds can be very dense. */
function simplifyRing(ring, tol = 0.0002) {
  if (ring.length < 200) return ring.map((p) => [p[0], p[1]]);
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j <= i + 1) continue;
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let best = -1, bd = 0;
    for (let k = i + 1; k < j; k++) {
      const d = L === 0 ? Math.hypot(ring[k][0] - ax, ring[k][1] - ay) : Math.abs(dx * (ring[k][1] - ay) - dy * (ring[k][0] - ax)) / L;
      if (d > bd) { bd = d; best = k; }
    }
    if (bd > tol) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  const out = ring.filter((_, k) => keep[k]).map((p) => [p[0], p[1]]);
  return out.length >= 4 ? out : ring.map((p) => [p[0], p[1]]);
}
const simplify = (g) => g.type === "Polygon"
  ? { type: "Polygon", coordinates: g.coordinates.map((r) => simplifyRing(r)) }
  : { type: "MultiPolygon", coordinates: g.coordinates.map((poly) => poly.map((r) => simplifyRing(r))) };

const mapCoords = (g, fn) => g.type === "Polygon"
  ? { type: "Polygon", coordinates: g.coordinates.map((r) => r.map(fn)) }
  : { type: "MultiPolygon", coordinates: g.coordinates.map((poly) => poly.map((r) => r.map(fn))) };

/** files: File[] chosen by the user. Returns [{id, name, geometry, area_km2}]. */
export async function importAreas(files) {
  const blobs = new Map();
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) for (const e of await unzip(data)) blobs.set(e.name, e.data);
    else blobs.set(f.name, data);
  }
  const feats = [];
  for (const [name, data] of blobs) {
    if (!/\.(geo)?json$/i.test(name)) continue;
    const doc = JSON.parse(new TextDecoder().decode(data).replace(/^﻿/, ""));
    const items = doc.type === "FeatureCollection" ? doc.features : [doc.type === "Feature" ? doc : { type: "Feature", geometry: doc, properties: {} }];
    items.forEach((ft, i) => {
      const g = ft && ft.geometry;
      if (!g || !["Polygon", "MultiPolygon"].includes(g.type)) return;
      const props = ft.properties || {};
      const key = Object.keys(props).find((k) => /^(name|label|title|huc_name)$/i.test(k));
      feats.push([key ? String(props[key]) : `${name.replace(/\.[^.]+$/, "").split("/").pop()} ${i + 1}`, g]);
    });
  }
  for (const [name, data] of blobs) {
    if (!/\.shp$/i.test(name)) continue;
    const stem = name.slice(0, -4).toLowerCase();
    const find = (ext) => [...blobs].find(([k]) => k.toLowerCase() === stem + ext);
    const prj = find(".prj"), dbf = find(".dbf");
    const geoms = readShp(data);
    const names = dbf ? readDbfNames(dbf[1]) : [];
    let tx = null;
    if (prj) {
      const wkt = new TextDecoder("latin1").decode(prj[1]);
      if (!/^\s*GEOGCS/i.test(wkt)) {
        const proj4 = await loadProj4();
        const conv = proj4(wkt, "EPSG:4326");
        tx = (pt) => conv.forward([pt[0], pt[1]]);
      }
    }
    geoms.forEach((g, i) => {
      if (!g) return;
      if (!tx) {
        const big = g.coordinates.some((poly) => poly.some((r) => r.some(([x, y]) => Math.abs(x) > 360 || Math.abs(y) > 90)));
        if (big) throw new Error(`${name.split("/").pop()} has no .prj file, so its coordinates can't be placed on the map. Zip the whole shapefile (.shp, .shx, .dbf, .prj).`);
      }
      feats.push([names[i] || `${stem.split("/").pop()} ${i + 1}`, tx ? mapCoords(g, tx) : g]);
    });
  }
  if (!feats.length) throw new Error("No polygons found. Use a zipped shapefile (.shp + .prj + .dbf) or a GeoJSON file.");
  if (feats.length > 200) throw new Error(`${feats.length} polygons found – import at most 200 at a time.`);
  return feats.map(([name, g]) => {
    const geometry = simplify(g);
    return { id: Math.random().toString(36).slice(2, 12), name: name.slice(0, 80), geometry, area_km2: polygonAreaKm2(geometry) };
  });
}
