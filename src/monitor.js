// The scheduler that runs checks, opens/closes incidents and sends alerts to the agency.
import { all, get, run } from './db.js';
import { getSettings, getKv, setKv } from './settings.js';
import { httpCheck } from './checks/http-check.js';
import { tlsCheck } from './checks/tls-check.js';
import { createRdap, registrableDomain } from './checks/domain-check.js';
import { extractTitle, findSpamWords, parseWordList } from './checks/content.js';
import { t, formatDuration } from './i18n.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
export const SSL_THRESHOLDS = [21, 14, 7, 3, 1];
export const DOMAIN_THRESHOLDS = [30, 14, 7, 1];
const SSL_EVERY = 6 * HOUR;
const DOMAIN_EVERY = 24 * HOUR;

/** Smallest threshold that `days` has reached, or null. */
export function thresholdFor(days, thresholds) {
  let hit = null;
  for (const th of thresholds) if (days <= th) hit = hit == null ? th : Math.min(hit, th);
  return hit;
}

export const daysLeft = (expiresAt, now) => (expiresAt == null ? null : Math.floor((expiresAt - now) / DAY));

export function createMonitor({
  db,
  alerter,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  httpCheckImpl = httpCheck,
  tlsCheckImpl = tlsCheck,
  rdap,
  log = console,
  tickMs = 15000,
  concurrency = 6,
  onTick,
} = {}) {
  const rdapClient = rdap || createRdap({
    cache: { get: () => getKv(db, 'rdapBootstrap'), set: (v) => setKv(db, 'rdapBootstrap', v) },
  });
  const running = new Set();
  let active = 0;
  let timer = null;
  let lastMaintenance = 0;

  const lang = () => getSettings(db).panelLang;
  const tr = (key, vars) => t(lang(), key, vars);
  const siteRow = (id) => get(db, 'SELECT s.*, c.name AS client_name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = ?', id);
  const openIncident = (siteId, kind) => get(db, 'SELECT * FROM incidents WHERE site_id = ? AND kind = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', siteId, kind);
  const panelUrl = (site) => {
    const base = getSettings(db).publicUrl;
    return base ? `${base.replace(/\/+$/, '')}/sites/${site.id}` : undefined;
  };

  async function alert(site, type, severity, titleKey, textKey, vars = {}) {
    const v = { site: site.name, url: site.url, client: site.client_name, ...vars };
    try {
      await alerter.send({
        type, severity, title: tr(titleKey, v), text: tr(textKey, v), url: panelUrl(site),
        site: { id: site.id, name: site.name, url: site.url }, client: { name: site.client_name },
      });
    } catch (err) {
      log.warn?.(`[alert] ${err.message}`);
    }
  }

  async function checkHttp(siteId) {
    const site = siteRow(siteId);
    if (!site) return null;
    const s = getSettings(db);
    const opts = { timeoutMs: s.timeoutSec * 1000, keyword: site.keyword };
    const firstAttemptAt = now();
    let r = await httpCheckImpl(site.url, opts);
    for (let i = 0; !r.ok && i < s.retries; i++) {
      await sleep(s.retryDelaySec * 1000);
      r = await httpCheckImpl(site.url, opts);
    }
    const ts = now();
    run(db, 'INSERT INTO checks(site_id, ts, ok, status, response_ms, bytes, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
      site.id, ts, r.ok ? 1 : 0, r.status, r.responseMs, r.bytes, r.error);
    run(db, `UPDATE sites SET last_check_at = ?, last_status = ?, last_response_ms = ?, last_bytes = ?, last_error = ?, state = ? WHERE id = ?`,
      ts, r.status, r.responseMs, r.ok ? r.bytes : site.last_bytes, r.error, r.ok ? 'up' : 'down', site.id);

    if (!r.ok && site.state !== 'down') {
      run(db, "INSERT INTO incidents(site_id, kind, started_at, reason, detail) VALUES (?, 'down', ?, ?, ?)",
        site.id, firstAttemptAt, r.errorKind || 'other', r.error || '');
      await alert(site, 'down', 'critical', 'alerts.downTitle', 'alerts.downText', { error: r.error || r.errorKind });
    } else if (r.ok && site.state === 'down') {
      const inc = openIncident(site.id, 'down');
      if (inc) {
        run(db, 'UPDATE incidents SET ended_at = ? WHERE id = ?', ts, inc.id);
        await alert(site, 'up', 'ok', 'alerts.upTitle', 'alerts.upText', { duration: formatDuration(lang(), ts - inc.started_at) });
      }
    }
    if (r.ok) await analyzeContent(site, r.body, ts, s);
    return r;
  }

  async function analyzeContent(site, body, ts, s) {
    const hits = findSpamWords(body, s.spamWords, parseWordList(site.ignore_words));
    const open = openIncident(site.id, 'content');
    run(db, 'UPDATE sites SET spam_hits = ? WHERE id = ?', hits.join(', '), site.id);
    if (hits.length && !open) {
      run(db, "INSERT INTO incidents(site_id, kind, started_at, reason, detail) VALUES (?, 'content', ?, 'spam', ?)", site.id, ts, hits.join(', '));
      await alert(site, 'content', 'critical', 'alerts.spamTitle', 'alerts.spamText', { words: hits.join(', ') });
    } else if (!hits.length && open) {
      run(db, 'UPDATE incidents SET ended_at = ? WHERE id = ?', ts, open.id);
    }
    const title = extractTitle(body);
    if (!title) return;
    if (site.title_baseline == null) {
      run(db, 'UPDATE sites SET title_baseline = ? WHERE id = ?', title, site.id);
    } else if (title !== site.title_baseline) {
      run(db, "INSERT INTO incidents(site_id, kind, started_at, ended_at, reason, detail) VALUES (?, 'title', ?, ?, 'title', ?)",
        site.id, ts, ts, JSON.stringify({ from: site.title_baseline, to: title }));
      run(db, 'UPDATE sites SET title_baseline = ? WHERE id = ?', title, site.id);
      await alert(site, 'title', 'warning', 'alerts.titleTitle', 'alerts.titleText', { from: site.title_baseline, to: title });
    }
  }

  async function checkSsl(siteId) {
    const site = siteRow(siteId);
    if (!site) return null;
    let u;
    try { u = new URL(site.url); } catch { return null; }
    if (u.protocol !== 'https:') {
      run(db, 'UPDATE sites SET ssl_checked_at = ?, ssl_expires_at = NULL, ssl_error = NULL WHERE id = ?', now(), site.id);
      return null;
    }
    const r = await tlsCheckImpl(u.hostname, Number(u.port) || 443);
    const ts = now();
    run(db, 'UPDATE sites SET ssl_checked_at = ?, ssl_expires_at = ?, ssl_issuer = ?, ssl_error = ? WHERE id = ?',
      ts, r.expiresAt, r.issuer, r.error, site.id);
    const open = openIncident(site.id, 'ssl');
    const days = daysLeft(r.expiresAt, ts);
    if (r.error) {
      if (!open) {
        run(db, "INSERT INTO incidents(site_id, kind, started_at, reason, detail) VALUES (?, 'ssl', ?, 'ssl', ?)", site.id, ts, r.error);
        await alert(site, 'ssl', 'critical', 'alerts.sslBadTitle', 'alerts.sslBadText', { error: r.error });
      }
      return r;
    }
    if (open) run(db, 'UPDATE incidents SET ended_at = ? WHERE id = ?', ts, open.id);
    const th = days == null ? null : thresholdFor(days, SSL_THRESHOLDS);
    if (th == null) {
      if (site.ssl_warned_days != null) run(db, 'UPDATE sites SET ssl_warned_days = NULL WHERE id = ?', site.id);
    } else if (site.ssl_warned_days == null || th < site.ssl_warned_days) {
      run(db, 'UPDATE sites SET ssl_warned_days = ? WHERE id = ?', th, site.id);
      await alert(site, 'ssl', 'warning', 'alerts.sslSoonTitle', 'alerts.sslSoonText', { days, count: days });
    }
    return r;
  }

  async function checkDomain(siteId) {
    const site = siteRow(siteId);
    if (!site) return null;
    let host = '';
    try { host = new URL(site.url).hostname; } catch { /* invalid URL */ }
    const domain = (site.domain || registrableDomain(host)).toLowerCase();
    if (!domain) {
      run(db, "UPDATE sites SET domain_checked_at = ?, domain_status = 'no-domain' WHERE id = ?", now(), site.id);
      return null;
    }
    const r = await rdapClient.lookup(domain);
    const ts = now();
    if (r.status === 'error' && site.domain_status === 'ok') {
      // keep the last good expiry date on a temporary RDAP error; retry sooner
      run(db, 'UPDATE sites SET domain_checked_at = ? WHERE id = ?', ts - DOMAIN_EVERY + HOUR, site.id);
      return r;
    }
    run(db, 'UPDATE sites SET domain_checked_at = ?, domain_name = ?, domain_status = ?, domain_expires_at = ?, domain_registrar = ? WHERE id = ?',
      ts, domain, r.status, r.expiresAt ?? null, r.registrar ?? null, site.id);
    if (r.status !== 'ok') return r;
    const days = daysLeft(r.expiresAt, ts);
    const th = thresholdFor(days, DOMAIN_THRESHOLDS);
    if (th == null) {
      if (site.domain_warned_days != null) run(db, 'UPDATE sites SET domain_warned_days = NULL WHERE id = ?', site.id);
    } else if (site.domain_warned_days == null || th < site.domain_warned_days) {
      run(db, 'UPDATE sites SET domain_warned_days = ? WHERE id = ?', th, site.id);
      await alert(site, 'domain', days < 0 ? 'critical' : 'warning', 'alerts.domainSoonTitle', 'alerts.domainSoonText', { domain, days, count: days });
    }
    return r;
  }

  function launch(key, fn) {
    if (running.has(key) || active >= concurrency) return null;
    running.add(key);
    active++;
    return (async () => {
      try { return await fn(); } catch (err) { log.error?.(`[monitor] ${key}: ${err.stack || err}`); return null; } finally { running.delete(key); active--; }
    })();
  }

  function maintenance() {
    const ts = now();
    if (ts - lastMaintenance < HOUR) return;
    lastMaintenance = ts;
    run(db, 'DELETE FROM checks WHERE ts < ?', ts - 400 * DAY);
    run(db, 'DELETE FROM sessions WHERE expires_at < ?', ts);
    run(db, 'DELETE FROM alert_log WHERE ts < ?', ts - 90 * DAY);
  }

  async function tick() {
    const ts = now();
    const sites = all(db, 'SELECT id, url, interval_min, last_check_at, ssl_checked_at, domain_checked_at FROM sites WHERE enabled = 1');
    const jobs = [];
    for (const s of sites) {
      if (s.last_check_at == null || ts - s.last_check_at >= s.interval_min * 60000 - 2000) jobs.push(launch(`http:${s.id}`, () => checkHttp(s.id)));
      if (s.ssl_checked_at == null || ts - s.ssl_checked_at >= SSL_EVERY) jobs.push(launch(`ssl:${s.id}`, () => checkSsl(s.id)));
      if (s.domain_checked_at == null || ts - s.domain_checked_at >= DOMAIN_EVERY) jobs.push(launch(`dom:${s.id}`, () => checkDomain(s.id)));
    }
    try { maintenance(); } catch (err) { log.error?.(`[maintenance] ${err.message}`); }
    if (onTick) {
      try { await onTick(ts); } catch (err) { log.error?.(`[scheduler] ${err.stack || err}`); }
    }
    await Promise.all(jobs.filter(Boolean));
  }

  /** Check one site right now (all three checks). */
  async function checkNow(siteId) {
    return {
      http: await checkHttp(siteId),
      ssl: await checkSsl(siteId),
      domain: await checkDomain(siteId),
    };
  }

  function start() {
    if (timer) return;
    const loop = () => { tick().catch((e) => log.error?.(e)); };
    loop();
    timer = setInterval(loop, tickMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop, checkHttp, checkSsl, checkDomain, checkNow };
}
