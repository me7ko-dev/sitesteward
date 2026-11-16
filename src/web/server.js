// HTTP server: agency panel (login, CSRF), public report links and status pages.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run } from '../db.js';
import { getSettings, saveSettings } from '../settings.js';
import {
  isConfigured, setPassword, checkPassword, createSession, getSession, destroySession, destroyAllSessions,
  safeEqual, randomToken, createRateLimiter,
} from '../auth.js';
import { t, hasLang } from '../i18n.js';
import { isValidTimeZone, periodOf, previousPeriod, isPeriod, monthRange } from '../time.js';
import { siteUptime, recentDays } from '../stats.js';
import { daysLeft } from '../monitor.js';
import { generateReport, sendReport, reportUrl, newToken } from '../report.js';
import { parseWordList } from '../checks/content.js';
import { safeColor, safeImage } from './html.js';
import * as V from './views.js';
import { renderReportPage, renderStatusPage } from './report-view.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const STATIC = {
  'panel.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'report.js': 'text/javascript; charset=utf-8',
  'favicon.svg': 'image/svg+xml',
};
const MAX_BODY = 3 * 1024 * 1024;
const MAX_LOGO = 400 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const int = (v, min, max, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const isEmail = (s) => /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(s);
function normalizeUrl(u) {
  let s = str(u, 500);
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const url = new URL(s);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return url.toString();
  } catch { return null; }
}
function cleanLogo(v) {
  const s = str(v, MAX_LOGO * 1.4);
  if (!s) return '';
  const ok = safeImage(s);
  if (!ok) throw new HttpError(400, 'Invalid logo');
  if (ok.length > MAX_LOGO * 1.37) throw new HttpError(400, 'Logo is too large');
  return ok;
}

export function createHandler({ db, monitor, alerter, mailer, pdf = { available: false }, setupCode, dryRun = false, trustProxy = false, log = console }) {
  const limiter = createRateLimiter({ max: 10, windowMs: 15 * 60000 });

  const settings = () => getSettings(db);
  const panelLang = () => settings().panelLang;

  function clientIp(req) {
    if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || '';
  }
  function isHttps(req) {
    if (req.socket.encrypted) return true;
    if (trustProxy && String(req.headers['x-forwarded-proto'] || '').startsWith('https')) return true;
    return settings().publicUrl.startsWith('https://');
  }
  function cookie(req, name, value, { maxAge, httpOnly = true, sameSite = 'Lax' } = {}) {
    let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=${sameSite}`;
    if (httpOnly) c += '; HttpOnly';
    if (maxAge != null) c += `; Max-Age=${maxAge}`;
    if (isHttps(req)) c += '; Secure';
    return c;
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  }
  function redirect(res, to, cookies = []) {
    res.writeHead(303, { location: to, 'set-cookie': cookies });
    res.end();
  }
  function flash(req, type, text) {
    return cookie(req, 'cu_flash', JSON.stringify({ type, text }), { maxAge: 60 });
  }

  function securityHeaders(res, { report = false } = {}) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('content-security-policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'");
    if (report) res.setHeader('x-robots-tag', 'noindex, nofollow');
  }

  function page(req, res, ctx, title, body, status = 200, extraCookies = []) {
    const cookies = [...extraCookies];
    let fl = null;
    const c = parseCookies(req.headers.cookie);
    if (c.cu_flash) {
      try { fl = JSON.parse(c.cu_flash); } catch { /* ignore */ }
      cookies.push(cookie(req, 'cu_flash', '', { maxAge: 0 }));
    }
    const s = settings();
    send(res, status, V.layout({ lang: ctx.lang, title, body, nav: Boolean(ctx.session), settings: s, flash: fl, csrf: ctx.session?.csrf }), {
      'set-cookie': cookies, 'cache-control': 'no-store',
    });
  }

  // ---------- public pages ----------
  async function publicReport(req, res, token, wantPdf) {
    const report = get(db, 'SELECT * FROM reports WHERE token = ?', token);
    if (!report) throw new HttpError(404, 'Not found');
    const client = get(db, 'SELECT * FROM clients WHERE id = ?', report.client_id);
    const data = JSON.parse(report.data_json);
    const htmlDoc = renderReportPage({ data, report, lang: client.lang, pdfAvailable: pdf.available });
    securityHeaders(res, { report: true });
    if (wantPdf) {
      const buf = pdf.available ? await pdf.render(htmlDoc) : null;
      if (!buf) { redirect(res, `/r/${token}`); return; }
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="report-${report.period}.pdf"`, 'cache-control': 'no-store' });
      res.end(buf);
      return;
    }
    send(res, 200, htmlDoc, { 'cache-control': 'no-store' });
  }

  function statusPage(req, res, token) {
    const client = get(db, 'SELECT * FROM clients WHERE status_token = ? AND status_public = 1', token);
    if (!client) throw new HttpError(404, 'Not found');
    const s = settings();
    const now = Date.now();
    const sites = all(db, 'SELECT * FROM sites WHERE client_id = ? AND enabled = 1 ORDER BY name', client.id).map((site) => ({
      name: site.name,
      state: site.state === 'up' || site.state === 'down' ? site.state : 'unknown',
      days: recentDays(db, site.id, 30, now),
      uptime30: siteUptime(db, site.id, now - 30 * 86400000, now, now).pct,
    }));
    securityHeaders(res, { report: true });
    send(res, 200, renderStatusPage({ client, agency: s.agency, sites, lang: client.lang, tz: s.timezone }), { 'cache-control': 'no-store' });
  }

  // ---------- helpers for panel data ----------
  function decorateSite(s, now = Date.now()) {
    return {
      ...s,
      sslDays: daysLeft(s.ssl_expires_at, now),
      domainDays: daysLeft(s.domain_expires_at, now),
      uptime30: siteUptime(db, s.id, now - 30 * 86400000, now, now).pct,
    };
  }
  function getClient(id) {
    const c = get(db, 'SELECT * FROM clients WHERE id = ?', id);
    if (!c) throw new HttpError(404, 'Not found');
    return c;
  }
  function getSite(id) {
    const s = get(db, 'SELECT * FROM sites WHERE id = ?', id);
    if (!s) throw new HttpError(404, 'Not found');
    return s;
  }
  function clientFields(f) {
    const name = str(f.get('name'), 100);
    if (!name) throw new HttpError(400, 'Name is required');
    const email = str(f.get('email'), 200);
    if (email && !isEmail(email)) throw new HttpError(400, t(panelLang(), 'panel.errors.email'));
    const lang = hasLang(f.get('lang')) ? f.get('lang') : 'en';
    return {
      name, email, lang,
      color: safeColor(f.get('color'), '#0ea5e9'),
      logo: cleanLogo(f.get('logo')),
      auto_send: f.get('auto_send') ? 1 : 0,
      status_public: f.get('status_public') ? 1 : 0,
      notes: str(f.get('notes'), 2000),
    };
  }
  function siteFields(f) {
    const url = normalizeUrl(f.get('url'));
    if (!url) throw new HttpError(400, t(panelLang(), 'panel.errors.url'));
    const name = str(f.get('name'), 100) || new URL(url).hostname;
    return {
      name, url,
      keyword: str(f.get('keyword'), 200),
      domain: str(f.get('domain'), 200).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      ignore_words: parseWordList(f.get('ignore_words')).join(', '),
      interval_min: int(f.get('interval_min'), 1, 1440, settings().defaultIntervalMin),
    };
  }
  function recentPeriods(now = Date.now()) {
    const tz = settings().timezone;
    const out = [previousPeriod(now, tz), periodOf(now, tz)];
    let p = out[0];
    for (let i = 0; i < 11; i++) {
      const { from } = monthRange(p, tz);
      p = previousPeriod(from + 3600000, tz);
      out.push(p);
    }
    return out;
  }

  // ---------- routes ----------
  const routes = [];
  const on = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler, ...opts });

  on('GET', '/', (ctx) => {
    const now = Date.now();
    const clients = all(db, 'SELECT * FROM clients ORDER BY name COLLATE NOCASE').map((c) => ({
      ...c, sites: all(db, 'SELECT * FROM sites WHERE client_id = ? ORDER BY name COLLATE NOCASE', c.id).map((s) => decorateSite(s, now)),
    }));
    const sites = clients.flatMap((c) => c.sites);
    const totals = {
      clients: clients.length,
      sites: sites.length,
      down: sites.filter((s) => s.state === 'down').length,
      expiring: sites.filter((s) => (s.sslDays != null && s.sslDays < 21) || (s.domainDays != null && s.domainDays < 30) || s.ssl_error).length,
    };
    return [t(ctx.lang, 'panel.nav.dashboard'), V.dashboardPage({ lang: ctx.lang, clients, totals, tz: settings().timezone })];
  });

  on('GET', '/clients/new', (ctx) => [t(ctx.lang, 'panel.client.newTitle'), V.newClientPage({ lang: ctx.lang, csrf: ctx.session.csrf })]);

  on('POST', '/clients', (ctx) => {
    const c = clientFields(ctx.form);
    const r = run(db, 'INSERT INTO clients(name, email, lang, color, logo, auto_send, status_public, notes, status_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.name, c.email, c.lang, c.color, c.logo, c.auto_send, c.status_public, c.notes, randomToken(18), Date.now());
    return { redirect: `/clients/${r.lastInsertRowid}`, flash: ['ok', t(ctx.lang, 'panel.flash.clientAdded')] };
  });

  on('GET', '/clients/(\\d+)', (ctx, id) => {
    const client = getClient(id);
    const s = settings();
    const sites = all(db, 'SELECT * FROM sites WHERE client_id = ? ORDER BY name COLLATE NOCASE', id).map((x) => decorateSite(x));
    const reports = all(db, 'SELECT id, period, sent_at FROM reports WHERE client_id = ? ORDER BY period DESC', id);
    const work = all(db, 'SELECT * FROM work_log WHERE client_id = ? ORDER BY ts DESC LIMIT 30', id);
    const base = (s.publicUrl || '').replace(/\/+$/, '');
    return [client.name, V.clientPage({
      lang: ctx.lang, csrf: ctx.session.csrf, client, sites, reports, work, tz: s.timezone,
      statusUrl: `${base}/status/${client.status_token}`, defaultInterval: s.defaultIntervalMin, periods: recentPeriods(),
    })];
  });

  on('POST', '/clients/(\\d+)', (ctx, id) => {
    getClient(id);
    const c = clientFields(ctx.form);
    run(db, 'UPDATE clients SET name = ?, email = ?, lang = ?, color = ?, logo = ?, auto_send = ?, status_public = ?, notes = ? WHERE id = ?',
      c.name, c.email, c.lang, c.color, c.logo, c.auto_send, c.status_public, c.notes, id);
    return { redirect: `/clients/${id}`, flash: ['ok', t(ctx.lang, 'panel.flash.saved')] };
  });

  on('POST', '/clients/(\\d+)/delete', (ctx, id) => {
    getClient(id);
    run(db, 'DELETE FROM clients WHERE id = ?', id);
    return { redirect: '/', flash: ['ok', t(ctx.lang, 'panel.flash.deleted')] };
  });

  on('POST', '/clients/(\\d+)/sites', (ctx, id) => {
    getClient(id);
    const s = siteFields(ctx.form);
    const r = run(db, 'INSERT INTO sites(client_id, name, url, keyword, domain, ignore_words, interval_min, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, s.name, s.url, s.keyword, s.domain, s.ignore_words, s.interval_min, Date.now());
    monitor?.checkNow(Number(r.lastInsertRowid)).catch((e) => log.error?.(e));
    return { redirect: `/clients/${id}`, flash: ['ok', t(ctx.lang, 'panel.flash.siteAdded')] };
  });

  on('POST', '/clients/(\\d+)/work', (ctx, id) => {
    getClient(id);
    const text = str(ctx.form.get('text'), 500);
    if (text) run(db, 'INSERT INTO work_log(client_id, ts, text) VALUES (?, ?, ?)', id, Date.now(), text);
    return { redirect: `/clients/${id}` };
  });

  on('POST', '/work/(\\d+)/delete', (ctx, id) => {
    const w = get(db, 'SELECT * FROM work_log WHERE id = ?', id);
    if (!w) throw new HttpError(404, 'Not found');
    run(db, 'DELETE FROM work_log WHERE id = ?', id);
    return { redirect: `/clients/${w.client_id}` };
  });

  on('POST', '/clients/(\\d+)/reports', (ctx, id) => {
    getClient(id);
    const period = ctx.form.get('period');
    if (!isPeriod(period)) throw new HttpError(400, 'Invalid month');
    const report = generateReport(db, Number(id), period);
    return { redirect: `/reports/${report.id}`, flash: ['ok', t(ctx.lang, 'panel.flash.reportReady')] };
  });

  on('GET', '/sites/(\\d+)', (ctx, id) => {
    const site = decorateSite(getSite(id));
    const client = getClient(site.client_id);
    const s = settings();
    const checks = all(db, 'SELECT * FROM checks WHERE site_id = ? ORDER BY ts DESC LIMIT 25', id);
    const incidents = all(db, 'SELECT * FROM incidents WHERE site_id = ? ORDER BY started_at DESC LIMIT 30', id);
    return [site.name, V.sitePage({ lang: ctx.lang, csrf: ctx.session.csrf, site, client, checks, incidents, tz: s.timezone, uptime30: site.uptime30, defaultInterval: s.defaultIntervalMin })];
  });

  on('POST', '/sites/(\\d+)', (ctx, id) => {
    const old = getSite(id);
    const s = siteFields(ctx.form);
    const enabled = ctx.form.get('enabled') ? 1 : 0;
    run(db, 'UPDATE sites SET name = ?, url = ?, keyword = ?, domain = ?, ignore_words = ?, interval_min = ?, enabled = ? WHERE id = ?',
      s.name, s.url, s.keyword, s.domain, s.ignore_words, s.interval_min, enabled, id);
    if (old.url !== s.url || old.domain !== s.domain) {
      run(db, 'UPDATE sites SET title_baseline = NULL, ssl_checked_at = NULL, domain_checked_at = NULL WHERE id = ?', id);
    }
    return { redirect: `/sites/${id}`, flash: ['ok', t(ctx.lang, 'panel.flash.saved')] };
  });

  on('POST', '/sites/(\\d+)/delete', (ctx, id) => {
    const site = getSite(id);
    run(db, 'DELETE FROM sites WHERE id = ?', id);
    return { redirect: `/clients/${site.client_id}`, flash: ['ok', t(ctx.lang, 'panel.flash.deleted')] };
  });

  on('POST', '/sites/(\\d+)/check', async (ctx, id) => {
    getSite(id);
    if (monitor) await monitor.checkNow(Number(id));
    const back = ctx.req.headers.referer && new URL(ctx.req.headers.referer, 'http://x').pathname.startsWith('/clients/') ? new URL(ctx.req.headers.referer, 'http://x').pathname : `/sites/${id}`;
    return { redirect: back, flash: ['ok', t(ctx.lang, 'panel.flash.checked')] };
  });

  on('GET', '/reports/(\\d+)', (ctx, id) => {
    const report = get(db, 'SELECT * FROM reports WHERE id = ?', id);
    if (!report) throw new HttpError(404, 'Not found');
    const client = getClient(report.client_id);
    const s = settings();
    const link = s.publicUrl ? reportUrl(s, report) : `/r/${report.token}`;
    return [t(ctx.lang, 'panel.reports.title'), V.reportPage({
      lang: ctx.lang, csrf: ctx.session.csrf, report, client, link, pdfAvailable: pdf.available, tz: s.timezone,
      canEmail: Boolean(client.email && s.smtp.host && s.smtp.from && s.publicUrl),
    })];
  });

  on('POST', '/reports/(\\d+)', (ctx, id) => {
    run(db, 'UPDATE reports SET work_done = ?, next_steps = ?, updated_at = ? WHERE id = ?',
      str(ctx.form.get('work_done'), 5000), str(ctx.form.get('next_steps'), 5000), Date.now(), id);
    return { redirect: `/reports/${id}`, flash: ['ok', t(ctx.lang, 'panel.flash.saved')] };
  });

  on('POST', '/reports/(\\d+)/regenerate', (ctx, id) => {
    const report = get(db, 'SELECT * FROM reports WHERE id = ?', id);
    if (!report) throw new HttpError(404, 'Not found');
    generateReport(db, report.client_id, report.period);
    return { redirect: `/reports/${id}`, flash: ['ok', t(ctx.lang, 'panel.flash.reportReady')] };
  });

  on('POST', '/reports/(\\d+)/rotate', (ctx, id) => {
    run(db, 'UPDATE reports SET token = ? WHERE id = ?', newToken(), id);
    return { redirect: `/reports/${id}`, flash: ['ok', t(ctx.lang, 'panel.flash.rotated')] };
  });

  on('POST', '/reports/(\\d+)/delete', (ctx, id) => {
    const report = get(db, 'SELECT * FROM reports WHERE id = ?', id);
    if (!report) throw new HttpError(404, 'Not found');
    run(db, 'DELETE FROM reports WHERE id = ?', id);
    return { redirect: `/clients/${report.client_id}`, flash: ['ok', t(ctx.lang, 'panel.flash.deleted')] };
  });

  on('POST', '/reports/(\\d+)/send', async (ctx, id) => {
    try {
      const r = await sendReport(db, Number(id), {
        mailer, pdf,
        renderHtml: (report) => {
          const client = getClient(report.client_id);
          return renderReportPage({ data: JSON.parse(report.data_json), report, lang: client.lang });
        },
      });
      return { redirect: `/reports/${id}`, flash: ['ok', t(ctx.lang, 'panel.flash.sent', { to: r.to })] };
    } catch (err) {
      return { redirect: `/reports/${id}`, flash: ['bad', `${t(ctx.lang, 'panel.flash.sendFailed')}: ${err.message}`] };
    }
  });

  on('GET', '/settings', (ctx) => {
    const alertLog = all(db, 'SELECT * FROM alert_log ORDER BY id DESC LIMIT 10');
    const s = settings();
    return [t(ctx.lang, 'panel.nav.settings'), V.settingsPage({ lang: ctx.lang, csrf: ctx.session.csrf, s, alertLog, tz: s.timezone, pdfAvailable: pdf.available, dryRun })];
  });

  on('POST', '/settings', (ctx) => {
    const f = ctx.form;
    const s = settings();
    const keep = (field, old) => (str(f.get(field), 500) ? str(f.get(field), 500) : old);
    const tz = str(f.get('timezone'), 64) || s.timezone;
    if (!isValidTimeZone(tz)) throw new HttpError(400, t(ctx.lang, 'panel.errors.timezone'));
    const publicUrl = str(f.get('public_url'), 300).replace(/\/+$/, '');
    if (publicUrl && !/^https?:\/\/[^\s/]+/i.test(publicUrl)) throw new HttpError(400, t(ctx.lang, 'panel.errors.url'));
    const webhook = str(f.get('webhook_url'), 500);
    if (webhook && !normalizeUrl(webhook)) throw new HttpError(400, t(ctx.lang, 'panel.errors.url'));
    for (const e of [str(f.get('agency_email'), 200), str(f.get('alert_email'), 200)]) {
      if (e && !isEmail(e)) throw new HttpError(400, t(ctx.lang, 'panel.errors.email'));
    }
    const next = {
      ...s,
      agency: {
        name: str(f.get('agency_name'), 80) || s.agency.name,
        color: safeColor(f.get('agency_color'), s.agency.color),
        email: str(f.get('agency_email'), 200),
        website: str(f.get('agency_website'), 200),
        logo: cleanLogo(f.get('agency_logo')),
      },
      panelLang: hasLang(f.get('panel_lang')) ? f.get('panel_lang') : s.panelLang,
      timezone: tz,
      publicUrl,
      defaultIntervalMin: int(f.get('default_interval'), 1, 1440, s.defaultIntervalMin),
      retries: int(f.get('retries'), 0, 5, s.retries),
      retryDelaySec: int(f.get('retry_delay'), 0, 300, s.retryDelaySec),
      timeoutSec: int(f.get('timeout'), 2, 60, s.timeoutSec),
      spamWords: parseWordList(f.get('spam_words')),
      reports: { mode: f.get('reports_mode') === 'auto' ? 'auto' : 'manual', hour: int(f.get('reports_hour'), 0, 23, s.reports.hour) },
      smtp: {
        host: str(f.get('smtp_host'), 200),
        port: int(f.get('smtp_port'), 1, 65535, 587),
        secure: Boolean(f.get('smtp_secure')),
        user: str(f.get('smtp_user'), 200),
        pass: keep('smtp_pass', s.smtp.pass),
        from: str(f.get('smtp_from'), 200),
      },
      alerts: {
        telegram: { enabled: Boolean(f.get('tg_enabled')), botToken: keep('tg_token', s.alerts.telegram.botToken), chatId: str(f.get('tg_chat'), 100) },
        email: { enabled: Boolean(f.get('email_enabled')), to: str(f.get('alert_email'), 200) },
        ntfy: { enabled: Boolean(f.get('ntfy_enabled')), server: normalizeUrl(f.get('ntfy_server'))?.replace(/\/+$/, '') || 'https://ntfy.sh', topic: str(f.get('ntfy_topic'), 200), token: keep('ntfy_token', s.alerts.ntfy.token) },
        webhook: { enabled: Boolean(f.get('webhook_enabled')), url: webhook },
      },
    };
    saveSettings(db, next);
    return { redirect: '/settings', flash: ['ok', t(next.panelLang, 'panel.flash.saved')] };
  });

  on('POST', '/settings/test-alert', async (ctx) => {
    const ch = ctx.form.get('channel');
    if (!['telegram', 'email', 'ntfy', 'webhook'].includes(ch)) throw new HttpError(400, 'Unknown channel');
    const [r] = await alerter.send({
      type: 'test', severity: 'info', title: t(ctx.lang, 'alerts.testTitle'), text: t(ctx.lang, 'alerts.testText'),
    }, { only: ch });
    return { redirect: '/settings', flash: r?.ok ? ['ok', t(ctx.lang, 'panel.flash.testOk', { channel: ch })] : ['bad', `${ch}: ${r?.error || 'failed'}`] };
  });

  on('POST', '/settings/password', (ctx) => {
    if (!checkPassword(db, ctx.form.get('current'))) throw new HttpError(400, t(ctx.lang, 'panel.errors.wrongPassword'));
    const pw = String(ctx.form.get('password') || '');
    if (pw.length < 10) throw new HttpError(400, t(ctx.lang, 'panel.errors.shortPassword'));
    setPassword(db, pw);
    destroyAllSessions(db);
    return { redirect: '/login', flash: ['ok', t(ctx.lang, 'panel.flash.passwordChanged')] };
  });

  on('POST', '/logout', (ctx) => {
    destroySession(db, ctx.cookies.cu_session);
    return { redirect: '/login', cookies: [cookie(ctx.req, 'cu_session', '', { maxAge: 0 })] };
  });

  // ---------- main handler ----------
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const lang = panelLang();
    securityHeaders(res);
    try {
      if (req.method === 'GET' && p.startsWith('/static/')) {
        const name = p.slice(8);
        if (!Object.hasOwn(STATIC, name)) throw new HttpError(404, 'Not found');
        res.writeHead(200, { 'content-type': STATIC[name], 'cache-control': 'public, max-age=3600' });
        res.end(fs.readFileSync(path.join(STATIC_DIR, name)));
        return;
      }
      if (p === '/favicon.ico') { redirect(res, '/static/favicon.svg'); return; }
      if (p === '/healthz') { send(res, 200, 'ok', { 'content-type': 'text/plain' }); return; }
      let m;
      if (req.method === 'GET' && (m = /^\/r\/([A-Za-z0-9_-]{20,64})(\/pdf)?$/.exec(p))) { await publicReport(req, res, m[1], Boolean(m[2])); return; }
      if (req.method === 'GET' && (m = /^\/status\/([A-Za-z0-9_-]{16,64})$/.exec(p))) { statusPage(req, res, m[1]); return; }

      const cookies = parseCookies(req.headers.cookie);
      if (req.method === 'POST') {
        // Same-origin check on every state-changing request (in addition to CSRF tokens).
        const origin = req.headers.origin;
        if (origin && origin !== 'null') {
          let host = '';
          try { host = new URL(origin).host; } catch { /* invalid */ }
          const expected = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
          if (host !== expected) throw new HttpError(403, 'Cross-origin request blocked');
        }
      }
      const form = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : null;

      // ----- first run: create the password -----
      if (!isConfigured(db)) {
        if (p !== '/setup') { redirect(res, '/setup'); return; }
        const pre = cookies.cu_pre || randomToken(18);
        const preCookie = cookie(req, 'cu_pre', pre, { sameSite: 'Strict' });
        if (req.method === 'POST') {
          if (!safeEqual(form.get('_csrf'), cookies.cu_pre)) throw new HttpError(403, 'Invalid form token, reload the page');
          const chosen = hasLang(form.get('lang')) ? form.get('lang') : lang;
          const err = (key) => page(req, res, { lang: chosen }, t(chosen, 'panel.setup.title'),
            V.setupPage({ lang: chosen, csrf: pre, error: t(chosen, key), values: { agency: form.get('agency') } }), 400, [preCookie]);
          if (!safeEqual(String(form.get('code') || '').trim().toUpperCase(), setupCode)) return err('panel.errors.setupCode');
          const pw = String(form.get('password') || '');
          if (pw.length < 10) return err('panel.errors.shortPassword');
          if (pw !== form.get('password2')) return err('panel.errors.passwordMismatch');
          const s = settings();
          s.agency.name = str(form.get('agency'), 80) || s.agency.name;
          s.panelLang = chosen;
          saveSettings(db, s);
          setPassword(db, pw);
          const sess = createSession(db);
          redirect(res, '/', [cookie(req, 'cu_session', sess.token, { maxAge: 30 * 86400 }), cookie(req, 'cu_pre', '', { maxAge: 0 })]);
          return;
        }
        const qLang = hasLang(url.searchParams.get('lang')) ? url.searchParams.get('lang') : lang;
        page(req, res, { lang: qLang }, t(qLang, 'panel.setup.title'), V.setupPage({ lang: qLang, csrf: pre }), 200, [preCookie]);
        return;
      }
      if (p === '/setup') { redirect(res, '/'); return; }

      // ----- login -----
      if (p === '/login') {
        const pre = cookies.cu_pre || randomToken(18);
        const preCookie = cookie(req, 'cu_pre', pre, { sameSite: 'Strict' });
        if (req.method === 'POST') {
          if (!safeEqual(form.get('_csrf'), cookies.cu_pre)) throw new HttpError(403, 'Invalid form token, reload the page');
          const ip = clientIp(req);
          if (limiter.blocked(ip)) {
            page(req, res, { lang }, t(lang, 'panel.login.title'), V.loginPage({ lang, csrf: pre, error: t(lang, 'panel.errors.tooMany') }), 429, [preCookie]);
            return;
          }
          if (!checkPassword(db, form.get('password'))) {
            limiter.fail(ip);
            page(req, res, { lang }, t(lang, 'panel.login.title'), V.loginPage({ lang, csrf: pre, error: t(lang, 'panel.errors.wrongPassword') }), 401, [preCookie]);
            return;
          }
          limiter.reset(ip);
          destroySession(db, cookies.cu_session);
          const sess = createSession(db);
          redirect(res, '/', [cookie(req, 'cu_session', sess.token, { maxAge: 30 * 86400 }), cookie(req, 'cu_pre', '', { maxAge: 0 })]);
          return;
        }
        page(req, res, { lang }, t(lang, 'panel.login.title'), V.loginPage({ lang, csrf: pre }), 200, [preCookie]);
        return;
      }

      // ----- everything else needs a session -----
      const session = getSession(db, cookies.cu_session);
      if (!session) {
        if (req.method === 'GET') { redirect(res, '/login'); return; }
        throw new HttpError(401, 'Please log in again');
      }
      if (req.method === 'POST' && !safeEqual(form.get('_csrf'), session.csrf)) throw new HttpError(403, 'Invalid form token, reload the page');

      const ctx = { req, res, session, lang, cookies, form };
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const mm = r.re.exec(p);
        if (!mm) continue;
        const out = await r.handler(ctx, ...mm.slice(1).map(Number));
        if (Array.isArray(out)) { page(req, res, ctx, out[0], out[1]); return; }
        const extra = out.cookies || [];
        if (out.flash) extra.push(flash(req, out.flash[0], out.flash[1]));
        redirect(res, out.redirect, extra);
        return;
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error?.(err);
      if (res.headersSent) { res.end(); return; }
      // Validation errors on panel forms: go back with a message instead of a dead-end page.
      const referer = req.headers.referer;
      if (req.method === 'POST' && status === 400 && referer) {
        let back = '/';
        try { back = new URL(referer).pathname; } catch { /* keep / */ }
        redirect(res, back, [flash(req, 'bad', err.message)]);
        return;
      }
      const msg = status === 404 ? V.notFoundPage({ lang }) : V.raw(`<div class="auth"><h1>${status}</h1><p>${String(err.message).replace(/[<>&"]/g, '')}</p><p><a href="/">←</a></p></div>`);
      send(res, status, V.layout({ lang, title: String(status), body: msg, nav: false, settings: settings() }));
    }
  };
}
