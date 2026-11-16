// Time-zone helpers built on Intl (no dependencies).

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  try { dtf(tz); return true; } catch { return false; }
}

/** Calendar parts of an instant in a time zone. month is 1-12. */
export function localParts(ms, tz) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(new Date(ms))) p[type] = value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

/** Offset (ms) of the zone from UTC at the given instant. */
export function tzOffsetMs(tz, ms) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of local midnight y-m-d (month0 is 0-11, may overflow like Date.UTC). */
export function zonedMidnight(year, month0, day, tz) {
  const guess = Date.UTC(year, month0, day);
  let t = guess - tzOffsetMs(tz, guess);
  const off2 = tzOffsetMs(tz, t);
  t = guess - off2;
  return t;
}

/** 'YYYY-MM' → { from, to } as UTC ms, local month boundaries in tz. */
export function monthRange(period, tz) {
  const [y, m] = period.split('-').map(Number);
  return { from: zonedMidnight(y, m - 1, 1, tz), to: zonedMidnight(y, m, 1, tz) };
}

export function isPeriod(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function periodOf(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function previousPeriod(ms, tz) {
  const p = localParts(ms, tz);
  const y = p.month === 1 ? p.year - 1 : p.year;
  const m = p.month === 1 ? 12 : p.month - 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Local day boundaries for every day in a month. */
export function daysOfMonth(period, tz) {
  const [y, m] = period.split('-').map(Number);
  const days = [];
  for (let d = 1; ; d++) {
    const from = zonedMidnight(y, m - 1, d, tz);
    const p = localParts(from, tz);
    if (p.month !== m) break;
    days.push({ day: d, from, to: zonedMidnight(y, m - 1, d + 1, tz) });
  }
  return days;
}

export const DAY = 86400000;
