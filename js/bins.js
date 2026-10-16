// Time bins for breakdowns and time steps (shared by the page and the worker).
// Stage IV dates are the end dates of 24-h periods ending 12Z. A Stage IV "month" follows the NWS
// month-to-date convention: days ending 12Z on the 2nd through the 1st of the next month.
// MRMS days/months use the viewer's local time zone.

const DAY = 86400000, HOUR = 3600000;
const pad = (n) => String(n).padStart(2, "0");
export const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseDay = (s) => new Date(`${s}T00:00:00Z`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const fmtDay = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
export const fmtLocal = (d) => d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export const INTERVAL_LABELS = { hour: "Hourly", day: "Daily", month: "Monthly" };

/** Intervals offered for a result (more than one -> the page shows a selector). */
export function intervalsFor(meta) {
  if (meta.source === "stage4") return meta.n_steps > 31 ? ["day", "month"] : ["day"];
  const out = ["hour"];
  if (meta.n_steps > 24) out.push("day");
  if (meta.n_steps > 24 * 31) out.push("month");
  return out;
}

export function defaultInterval(meta) {
  if (meta.prefer_interval && intervalsFor(meta).includes(meta.prefer_interval)) return meta.prefer_interval;
  if (meta.source === "stage4") return meta.n_steps > 92 ? "month" : "day";
  return meta.n_steps <= 72 ? "hour" : meta.n_steps <= 24 * 92 ? "day" : "month";
}

/** Split a result's range into bins: [{label, start, end, start_utc, end_utc, partial}].
 *  Stage IV start/end are ISO dates (inclusive end dates); MRMS start/end are ISO instants. */
export function makeBins(meta, interval) {
  if (meta.source === "stage4") {
    const s = parseDay(meta.start), e = parseDay(meta.end);
    const day = (d) => ({ label: fmtDay(d), start: isoDay(d), end: isoDay(d), start_utc: new Date(+d - 12 * HOUR).toISOString(), end_utc: new Date(+d + 12 * HOUR).toISOString(), partial: false });
    if (interval === "total") return [{ ...day(s), label: meta.label, end: isoDay(e), end_utc: new Date(+e + 12 * HOUR).toISOString() }];
    if (interval === "day") {
      const out = [];
      for (let d = s; d <= e; d = new Date(+d + DAY)) out.push(day(d));
      return out;
    }
    const groups = [];
    for (let d = s; d <= e; d = new Date(+d + DAY)) {
      const m = new Date(+d - DAY);                       // the day ending 12Z on the 1st belongs to the previous month
      const key = `${m.getUTCFullYear()}-${m.getUTCMonth()}`;
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.end = d;
      else groups.push({ key, y: m.getUTCFullYear(), mo: m.getUTCMonth(), start: d, end: d });
    }
    return groups.map((g) => {
      const fullStart = new Date(Date.UTC(g.y, g.mo, 2)), fullEnd = new Date(Date.UTC(g.y, g.mo + 1, 1));
      return {
        label: `${MONTHS[g.mo]} ${g.y}`, start: isoDay(g.start), end: isoDay(g.end),
        start_utc: new Date(+g.start - 12 * HOUR).toISOString(), end_utc: new Date(+g.end + 12 * HOUR).toISOString(),
        partial: +g.start !== +fullStart || +g.end !== +fullEnd,
      };
    });
  }
  const t0 = new Date(meta.start_utc), t1 = new Date(meta.end_utc);
  const bin = (a, b, label, partial) => ({ label, start: a.toISOString(), end: b.toISOString(), start_utc: a.toISOString(), end_utc: b.toISOString(), partial });
  if (interval === "total") return [bin(t0, t1, meta.label, false)];
  if (interval === "hour") {
    const out = [];
    for (let t = +t0 + HOUR; t <= +t1; t += HOUR) out.push(bin(new Date(t - HOUR), new Date(t), `Hour ending ${fmtLocal(new Date(t))}`, false));
    return out;
  }
  const next = (d) => (interval === "day" ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) : new Date(d.getFullYear(), d.getMonth() + 1, 1));
  const startOf = (d) => (interval === "day" ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : new Date(d.getFullYear(), d.getMonth(), 1));
  const out = [];
  for (let cur = t0; cur < t1;) {
    const nb = next(cur), end = nb < t1 ? nb : t1;
    const label = interval === "day"
      ? cur.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : `${MONTHS[cur.getMonth()]} ${cur.getFullYear()}`;
    out.push(bin(cur, end, label, +cur !== +startOf(cur) || +end !== +nb));
    cur = end;
  }
  return out;
}
