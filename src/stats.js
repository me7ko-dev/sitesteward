// Uptime % and incident math.
//
// Downtime = confirmed "down" incidents. Uptime is measured only over the time the site was
// actually being monitored: the "coverage" is derived from the stored checks. Time before a site
// was added, while it was paused, or while sitesteward itself was not running (gaps between checks
// longer than the tolerance below) is neither counted as up nor as down – so a report never shows
// 100 % for days nobody was watching.
import { all, get } from './db.js';
import { monthRange } from './time.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const overlap = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/** Gaps between two checks up to this long still count as monitored (restarts, retries, slow ticks). */
export function coverageTolerance(intervalMin) {
  return Math.max(3 * Math.max(1, Number(intervalMin) || 5) * MIN, 2 * HOUR);
}

/** Merge overlapping [start, end) intervals after clipping them to [from, to). */
export function mergeIntervals(intervals, from = -Infinity, to = Infinity) {
  const sorted = intervals
    .map(([s, e]) => [Math.max(s, from), Math.min(e, to)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push(iv.slice());
  }
  return out;
}

/** Pure helper: uptime from a list of down intervals within [from, to). */
export function computeUptime(from, to, downIntervals) {
  return uptimeOver([[from, to]], downIntervals);
}

/** Pure helper: uptime over a set of monitored segments. */
export function uptimeOver(segments, downIntervals) {
  const segs = mergeIntervals(segments);
  const totalMs = segs.reduce((a, [s, e]) => a + (e - s), 0);
  if (totalMs <= 0) return { pct: null, downMs: 0, totalMs: 0 };
  const downs = mergeIntervals(downIntervals);
  let downMs = 0;
  for (const [s, e] of segs) for (const [ds, de] of downs) downMs += overlap(s, e, ds, de);
  return { pct: ((totalMs - downMs) / totalMs) * 100, downMs, totalMs };
}

/** Pure helper: monitored segments from sorted check timestamps. */
export function segmentsFromChecks(timestamps, intervalMin, from, to) {
  const tol = coverageTolerance(intervalMin);
  const iv = Math.max(1, Number(intervalMin) || 5) * MIN;
  const segs = [];
  let start = null;
  let prev = null;
  for (const ts of timestamps) {
    if (prev == null || ts - prev > tol) {
      if (prev != null) segs.push([start, prev + iv]);
      start = ts;
    }
    prev = ts;
  }
  if (prev != null) segs.push([start, prev + iv]);
  return mergeIntervals(segs, from, to);
}

/**
 * Monitored segments of a site within [from, to), computed in SQL so only gap boundaries are read.
 * @returns {Array<[number, number]>}
 */
export function coverage(db, siteId, from, to) {
  const site = get(db, 'SELECT interval_min FROM sites WHERE id = ?', siteId);
  if (!site || to <= from) return [];
  const tol = coverageTolerance(site.interval_min);
  const iv = Math.max(1, site.interval_min || 5) * MIN;
  const rows = all(db, `WITH c AS (
      SELECT ts, LAG(ts) OVER w AS prev, LEAD(ts) OVER w AS next
      FROM checks WHERE site_id = ? AND ts >= ? AND ts < ?
      WINDOW w AS (ORDER BY ts)
    )
    SELECT ts, prev, next FROM c WHERE prev IS NULL OR next IS NULL OR ts - prev > ? OR next - ts > ? ORDER BY ts`,
  // look a little beyond both ends so continuity across the range boundaries is not lost
  siteId, from - tol, to + tol, tol, tol);
  const segs = [];
  let start = null;
  for (const r of rows) {
    if (r.prev == null || r.ts - r.prev > tol) start = r.ts;
    if (r.next == null || r.next - r.ts > tol) { segs.push([start, r.ts + iv]); start = null; }
  }
  return mergeIntervals(segs, from, to);
}

export function firstCheckTs(db, siteId) {
  return get(db, 'SELECT MIN(ts) AS ts FROM checks WHERE site_id = ?', siteId)?.ts ?? null;
}

export function downIncidents(db, siteId, from, to) {
  return all(db, `SELECT * FROM incidents WHERE site_id = ? AND kind = 'down'
    AND started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at`, siteId, to, from);
}

/** Everything needed to compute uptime for any sub-range of [from, to). */
export function uptimeData(db, siteId, from, to, now = Date.now()) {
  const end = Math.min(to, now);
  const segments = coverage(db, siteId, from, end);
  const downs = downIncidents(db, siteId, from, end).map((i) => [i.started_at, i.ended_at ?? end]);
  return {
    segments,
    downs,
    /** uptime for [a, b) ⊆ [from, to) */
    range(a, b) {
      const lo = Math.max(a, from);
      const hi = Math.min(b, end);
      if (hi <= lo) return { pct: null, downMs: 0, totalMs: 0 };
      return uptimeOver(mergeIntervals(segments, lo, hi), mergeIntervals(downs, lo, hi));
    },
  };
}

export function siteUptime(db, siteId, from, to, now = Date.now()) {
  return uptimeData(db, siteId, from, to, now).range(from, to);
}

export function avgResponse(db, siteId, from, to) {
  const r = get(db, 'SELECT AVG(response_ms) AS avg, COUNT(*) AS n FROM checks WHERE site_id = ? AND ok = 1 AND ts >= ? AND ts < ?', siteId, from, to);
  return { avgMs: r?.avg == null ? null : Math.round(r.avg), samples: r?.n || 0 };
}

export function checkCount(db, siteId, from, to) {
  return get(db, 'SELECT COUNT(*) AS n FROM checks WHERE site_id = ? AND ts >= ? AND ts < ?', siteId, from, to).n;
}

/** Per-day uptime (null = not monitored that day) for a list of {from, to} days. */
export function dailyUptime(db, siteId, days, now = Date.now()) {
  if (!days.length) return [];
  const data = uptimeData(db, siteId, days[0].from, days[days.length - 1].to, now);
  return days.map((d) => data.range(d.from, d.to).pct);
}

/** Per-day uptime for the last N days ending now (rolling 24 h windows), plus the total. */
export function recentDays(db, siteId, days, now = Date.now()) {
  const from = now - days * DAY;
  const data = uptimeData(db, siteId, from, now, now);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const to = now - i * DAY;
    out.push(data.range(to - DAY, to).pct);
  }
  return out;
}

export function incidentsInRange(db, siteId, from, to) {
  return all(db, `SELECT * FROM incidents WHERE site_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at >= ?)
    ORDER BY started_at`, siteId, to, from);
}

export { monthRange, overlap };
