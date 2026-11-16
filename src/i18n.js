// Tiny i18n: one JSON file per language in /locales. Add a language by copying en.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'locales');
const catalogs = {};
for (const f of fs.readdirSync(DIR)) {
  if (f.endsWith('.json')) catalogs[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
}

export const LANGS = Object.keys(catalogs).sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
export const langName = (lang) => catalogs[lang]?._meta?.name || lang;
export const localeOf = (lang) => catalogs[lang]?._meta?.locale || 'en-US';
export const hasLang = (lang) => Object.hasOwn(catalogs, lang);
export const catalog = (lang) => catalogs[lang];

function lookup(lang, key) {
  let node = catalogs[lang];
  for (const part of key.split('.')) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}

/** t('en', 'report.title', {month: 'May'}). Objects with one/other are plural forms (vars.count). */
export function t(lang, key, vars = {}) {
  let v = lookup(lang, key);
  if (v === undefined) v = lookup('en', key);
  if (v === undefined) return key;
  if (typeof v === 'object') {
    const rule = new Intl.PluralRules(localeOf(lang)).select(Number(vars.count ?? 0));
    v = v[rule] ?? v.other;
  }
  return String(v).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

export const translator = (lang) => (key, vars) => t(lang, key, vars);

export function formatDate(lang, ms, tz, opts = { dateStyle: 'long' }) {
  if (ms == null) return '';
  return new Intl.DateTimeFormat(localeOf(lang), { timeZone: tz, ...opts }).format(new Date(ms));
}

export function formatDateTime(lang, ms, tz) {
  return formatDate(lang, ms, tz, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatTime(lang, ms, tz) {
  return formatDate(lang, ms, tz, { timeStyle: 'short' });
}

export function formatMonth(lang, period) {
  const [y, m] = period.split('-').map(Number);
  return new Intl.DateTimeFormat(localeOf(lang), { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, 15)));
}

export function formatDuration(lang, ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 1) return t(lang, 'units.lessThanMinute');
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = [];
  if (d) parts.push(t(lang, 'units.d', { n: d }));
  if (h) parts.push(t(lang, 'units.h', { n: h }));
  if (m && !d) parts.push(t(lang, 'units.min', { n: m }));
  return parts.join(' ');
}

export function formatNumber(lang, n, digits = 0) {
  return new Intl.NumberFormat(localeOf(lang), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

export function formatBytes(lang, bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(lang, bytes / 1024, 0)} KB`;
  return `${formatNumber(lang, bytes / 1024 / 1024, 1)} MB`;
}

export function formatMs(lang, ms) {
  if (ms == null) return '—';
  if (ms < 1000) return t(lang, 'units.ms', { n: formatNumber(lang, ms) });
  return t(lang, 'units.s', { n: formatNumber(lang, ms / 1000, 2) });
}

/** Uptime % that never rounds 99.996 with real downtime up to "100". */
export function formatPct(lang, pct) {
  if (pct == null) return '—';
  let v = Math.floor(pct * 100) / 100;
  if (pct >= 100) v = 100;
  return `${formatNumber(lang, v, v === 100 ? 0 : 2)}%`;
}
