// Uptime % and incident math. Downtime = confirmed "down" incidents.
// The monitored window starts at the first check, so time before a site was added does not count.
import { all, get } from './db.js';
import { daysOfMonth, monthRange } from './time.js';

const overlap = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/** Pure helper: uptime from a list of down intervals within [from, to). */
export function computeUptime(from, to, downIntervals) {
  const total = to - from;
  if (total <= 0) return { pct: null, downMs: 0, totalMs: 0 };
  // merge overlapping intervals before summing
  const sorted = downIntervals
    .map(([s, e]) => [Math.max(s, from), Math.min(e, to)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let downMs = 0;
  let cur = null;
  for (const iv of sorted) {
    if (!cur) cur = iv.slice();
    else if (iv[0] <= cur[1]) cur[1] = Math.max(cur[1], iv[1]);
    else { downMs += cur[1] - cur[0]; cur = iv.slice(); }
  }
  if (cur) downMs += cur[1] - cur[0];
  return { pct: ((total - downMs) / total) * 100, downMs, totalMs: total };
}

export function firstCheckTs(db, siteId) {
  return get(db, 'SELECT MIN(ts) AS ts FROM checks WHERE site_id = ?', siteId)?.ts ?? null;
}

export function downIncidents(db, siteId, from, to) {
  return all(db, `SELECT * FROM incidents WHERE site_id = ? AND kind = 'down'
    AND started_at < ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at`, siteId, to, from);
}

export function siteUptime(db, siteId, from, to, now = Date.now()) {
  const first = firstCheckTs(db, siteId);
  if (first == null) return { pct: null, downMs: 0, totalMs: 0 };
  const start = Math.max(from, first);
  const end = Math.min(to, now);
  const intervals = downIncidents(db, siteId, start, end).map((i) => [i.started_at, i.ended_at ?? end]);
  return computeUptime(start, end, intervals);
}

export function avgResponse(db, siteId, from, to) {
  const r = get(db, 'SELECT AVG(response_ms) AS avg, COUNT(*) AS n FROM checks WHERE site_id = ? AND ok = 1 AND ts >= ? AND ts < ?', siteId, from, to);
  return { avgMs: r?.avg == null ? null : Math.round(r.avg), samples: r?.n || 0 };
}

export function checkCount(db, siteId, from, to) {
  return get(db, 'SELECT COUNT(*) AS n FROM checks WHERE site_id = ? AND ts >= ? AND ts < ?', siteId, from, to).n;
}

/** Per-day uptime (null = no data that day) for a month. */
export function dailyUptime(db, siteId, period, tz, now = Date.now()) {
  return daysOfMonth(period, tz).map((d) => siteUptime(db, siteId, d.from, d.to, now).pct);
}

/** Per-day uptime for the last N days ending now. */
export function recentDays(db, siteId, days, now = Date.now()) {
  const out = [];
  const DAYMS = 86400000;
  const end = now;
  for (let i = days - 1; i >= 0; i--) {
    const to = end - i * DAYMS;
    out.push(siteUptime(db, siteId, to - DAYMS, to, now).pct);
  }
  return out;
}

export function incidentsInRange(db, siteId, from, to) {
  return all(db, `SELECT * FROM incidents WHERE site_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at >= ?)
    ORDER BY started_at`, siteId, to, from);
}

export { monthRange, overlap };
