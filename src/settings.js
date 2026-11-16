// Agency settings are stored in the local database (data directory, never committed).
import { get, run } from './db.js';

export const DEFAULT_SPAM_WORDS = [
  'casino', 'viagra', 'cialis', 'kmspico', 'payday loan', 'replica watches',
  'online slots', 'slot gacor', 'togel', 'judi online', 'sportsbook',
  'cheap pills', 'crack download', 'keygen', 'essay writing service',
];

export function defaultSettings() {
  let tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* keep UTC */ }
  return {
    agency: { name: 'My Web Agency', logo: '', color: '#4f46e5', email: '', website: '' },
    panelLang: 'en',
    timezone: tz,
    publicUrl: '',
    defaultIntervalMin: 5,
    retries: 2,
    retryDelaySec: 20,
    timeoutSec: 15,
    reports: { mode: 'manual', hour: 9 },
    spamWords: DEFAULT_SPAM_WORDS.slice(),
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
    alerts: {
      email: { enabled: false, to: '' },
      telegram: { enabled: false, botToken: '', chatId: '' },
      ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', token: '' },
      webhook: { enabled: false, url: '' },
    },
  };
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function getSettings(db) {
  const row = get(db, "SELECT value FROM settings WHERE key = 'config'");
  const saved = row ? JSON.parse(row.value) : {};
  return deepMerge(defaultSettings(), saved);
}

export function saveSettings(db, settings) {
  run(db, "INSERT INTO settings(key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify(settings));
}

export function getKv(db, key) {
  const row = get(db, 'SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : undefined;
}

export function setKv(db, key, value) {
  run(db, 'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value));
}
