// Monthly client report: data snapshot, storage, e-mail delivery and the monthly schedule.
import crypto from 'node:crypto';
import { all, get, run } from './db.js';
import { getSettings, getKv, setKv } from './settings.js';
import { monthRange, previousPeriod, localParts, daysOfMonth } from './time.js';
import { uptimeData, avgResponse, checkCount, incidentsInRange } from './stats.js';
import { daysLeft } from './monitor.js';
import { t, formatMonth, formatPct, formatMs } from './i18n.js';
import { renderReportEmail } from './web/report-view.js';

export const newToken = () => crypto.randomBytes(24).toString('base64url');

/** Build the frozen data used to render a report. */
export function buildReportData(db, clientId, period, now = Date.now()) {
  const settings = getSettings(db);
  const tz = settings.timezone;
  const client = get(db, 'SELECT * FROM clients WHERE id = ?', clientId);
  if (!client) throw new Error('Client not found');
  const { from, to } = monthRange(period, tz);
  const days = daysOfMonth(period, tz);
  const sites = all(db, 'SELECT * FROM sites WHERE client_id = ? ORDER BY name COLLATE NOCASE', clientId).map((s) => {
    const ud = uptimeData(db, s.id, from, to, now);
    // a paused site that was not monitored at all this month does not belong in the report
    if (!s.enabled && !ud.segments.length) return null;
    const up = ud.range(from, to);
    const { avgMs, samples } = avgResponse(db, s.id, from, to);
    const incidents = incidentsInRange(db, s.id, from, to)
      .filter((i) => i.kind === 'down' || i.kind === 'content' || i.kind === 'ssl')
      .map((i) => ({
        kind: i.kind,
        start: i.started_at,
        end: i.ended_at,
        durationMs: (i.ended_at ?? Math.min(to, now)) - i.started_at,
        reason: i.reason,
        detail: i.kind === 'content' ? i.detail : '',
      }));
    const daily = days.map((d) => (d.from >= now ? null : ud.range(d.from, d.to).pct));
    const securityHits = incidents.filter((i) => i.kind === 'content');
    return {
      id: s.id,
      name: s.name,
      url: s.url,
      uptime: up.pct,
      downMs: up.downMs,
      avgMs,
      samples,
      checks: checkCount(db, s.id, from, to),
      pageBytes: s.last_bytes,
      daily,
      incidents,
      security: {
        checked: samples > 0,
        clean: securityHits.length === 0,
        words: [...new Set(securityHits.flatMap((i) => i.detail.split(',').map((w) => w.trim())).filter(Boolean))].join(', '),
      },
      monitoredMs: up.totalMs,
      ssl: s.url.startsWith('https:')
        ? { expiresAt: s.ssl_expires_at, daysLeft: daysLeft(s.ssl_expires_at, now), issuer: s.ssl_issuer, error: s.ssl_error, checked: s.ssl_checked_at != null }
        : { none: true },
      domain: {
        name: s.domain_name, status: s.domain_status, expiresAt: s.domain_expires_at,
        daysLeft: daysLeft(s.domain_expires_at, now), registrar: s.domain_registrar,
      },
    };
  }).filter(Boolean);
  const withData = sites.filter((s) => s.uptime != null);
  const totalDown = withData.reduce((a, s) => a + s.downMs, 0);
  const avgUptime = withData.length ? withData.reduce((a, s) => a + s.uptime, 0) / withData.length : null;
  const speedSites = sites.filter((s) => s.avgMs != null);
  return {
    version: 1,
    period,
    from,
    to,
    tz,
    generatedAt: now,
    partial: now < to,
    agency: { ...settings.agency },
    client: { name: client.name, logo: client.logo, color: client.color, lang: client.lang },
    summary: {
      uptime: avgUptime,
      downMs: totalDown,
      incidents: sites.reduce((a, s) => a + s.incidents.filter((i) => i.kind === 'down').length, 0),
      avgMs: speedSites.length ? Math.round(speedSites.reduce((a, s) => a + s.avgMs, 0) / speedSites.length) : null,
      secure: sites.every((s) => s.security.clean),
      securityChecked: sites.some((s) => s.security.checked),
    },
    sites,
  };
}

function workLogText(db, clientId, period, tz) {
  const { from, to } = monthRange(period, tz);
  return all(db, 'SELECT text FROM work_log WHERE client_id = ? AND ts >= ? AND ts < ? ORDER BY ts', clientId, from, to)
    .map((r) => r.text).join('\n');
}

/** Create (or refresh the data of) the report for a client + month. Keeps work notes and token. */
export function generateReport(db, clientId, period, now = Date.now()) {
  const data = buildReportData(db, clientId, period, now);
  const existing = get(db, 'SELECT * FROM reports WHERE client_id = ? AND period = ?', clientId, period);
  if (existing) {
    const work = existing.work_done || workLogText(db, clientId, period, data.tz);
    run(db, 'UPDATE reports SET data_json = ?, updated_at = ?, work_done = ? WHERE id = ?', JSON.stringify(data), now, work, existing.id);
    return get(db, 'SELECT * FROM reports WHERE id = ?', existing.id);
  }
  const res = run(db, 'INSERT INTO reports(client_id, period, token, work_done, next_steps, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    clientId, period, newToken(), workLogText(db, clientId, period, data.tz), '', JSON.stringify(data), now, now);
  return get(db, 'SELECT * FROM reports WHERE id = ?', Number(res.lastInsertRowid));
}

/**
 * Logo URL for e-mails. Mail clients block data: images and most do not show SVG, so only a raster
 * logo (served from /brand/logo) or an https:// logo is used; otherwise the agency name is shown.
 */
export function emailLogoUrl(settings) {
  const logo = String(settings.agency.logo || '');
  const base = (settings.publicUrl || '').replace(/\/+$/, '');
  if (/^https:\/\//i.test(logo) && !/\.svg(\?|#|$)/i.test(logo)) return logo;
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.exec(logo);
  if (!m || !base) return '';
  return `${base}/brand/logo?v=${crypto.createHash('sha256').update(logo).digest('hex').slice(0, 10)}`;
}

export function reportUrl(settings, report) {
  const base = (settings.publicUrl || '').replace(/\/+$/, '');
  return `${base}/r/${report.token}`;
}

/**
 * E-mail the report to the client (HTML summary + link, PDF attached when a PDF engine is available).
 * @param {{mailer: Function, pdf?: {render(html:string):Promise<Buffer|null>}}} deps
 */
export async function sendReport(db, reportId, { mailer, pdf, renderHtml }, now = Date.now()) {
  const report = get(db, 'SELECT * FROM reports WHERE id = ?', reportId);
  if (!report) throw new Error('Report not found');
  const client = get(db, 'SELECT * FROM clients WHERE id = ?', report.client_id);
  if (!client.email) throw new Error('The client has no report e-mail address');
  const settings = getSettings(db);
  if (!settings.publicUrl) throw new Error('Set the public URL in Settings first, so the link in the e-mail works');
  const data = JSON.parse(report.data_json);
  const lang = client.lang;
  const link = reportUrl(settings, report);
  const subject = t(lang, 'email.subject', { agency: settings.agency.name, month: formatMonth(lang, report.period) });
  const html = renderReportEmail({ data, report, link, lang, logoUrl: emailLogoUrl(settings) });
  const text = [
    t(lang, 'email.hello', { client: client.name }),
    '',
    t(lang, 'email.intro', { month: formatMonth(lang, report.period) }),
    `${t(lang, 'report.kpi.uptime')}: ${formatPct(lang, data.summary.uptime)}`,
    `${t(lang, 'report.kpi.speed')}: ${formatMs(lang, data.summary.avgMs)}`,
    `${t(lang, 'report.kpi.incidents')}: ${data.summary.incidents}`,
    '',
    `${t(lang, 'email.open')}: ${link}`,
    '',
    settings.agency.name,
  ].join('\n');
  const attachments = [];
  if (pdf && renderHtml) {
    const buf = await pdf.render(renderHtml(report));
    if (buf) attachments.push({ filename: `report-${report.period}.pdf`, contentType: 'application/pdf', content: buf });
  }
  await mailer(settings.smtp, { to: client.email, subject, text, html, attachments });
  run(db, 'UPDATE reports SET sent_at = ?, sent_to = ? WHERE id = ?', now, client.email, report.id);
  return { to: client.email, attachments: attachments.length };
}

/** Reports are created on the 1st; if sitesteward was not running then, it catches up during the first week. */
export const CATCH_UP_DAYS = 7;
const scheduleLocks = new WeakSet();

/**
 * Called every scheduler tick. From the 1st of the month (after the configured hour, agency time zone):
 * - "manual" mode: create draft reports for last month and notify the agency once.
 * - "auto" mode: create and e-mail them.
 * Only clients whose sites were actually monitored last month get a report. Safe to call repeatedly
 * and after a crash/restart: reports that were already sent are never rebuilt or sent twice.
 */
export async function runMonthlySchedule(db, { now, alerter, send, log = console }) {
  const settings = getSettings(db);
  const tz = settings.timezone;
  const p = localParts(now, tz);
  if (p.day > CATCH_UP_DAYS || (p.day === 1 && p.hour < Number(settings.reports.hour ?? 9))) return { ran: false };
  const period = previousPeriod(now, tz);
  if (getKv(db, 'scheduleDone') === period || scheduleLocks.has(db)) return { ran: false };
  scheduleLocks.add(db);
  try {
    const { from, to } = monthRange(period, tz);
    const clients = all(db, `SELECT c.* FROM clients c WHERE EXISTS (
      SELECT 1 FROM sites s JOIN checks k ON k.site_id = s.id WHERE s.client_id = c.id AND k.ts >= ? AND k.ts < ?)
      ORDER BY c.name COLLATE NOCASE`, from, to);
    let created = 0;
    let sent = 0;
    const failures = [];
    for (const c of clients) {
      try {
        const existing = get(db, 'SELECT * FROM reports WHERE client_id = ? AND period = ?', c.id, period);
        const report = existing?.sent_at ? existing : generateReport(db, c.id, period, now);
        created++;
        if (settings.reports.mode === 'auto' && c.auto_send && c.email && !report.sent_at) {
          await send(report.id);
          sent++;
        }
      } catch (err) {
        failures.push(`${c.name}: ${err.message}`);
        log.warn?.(`[report] ${c.name}: ${err.message}`);
      }
    }
    setKv(db, 'scheduleDone', period);
    const lang = settings.panelLang;
    if (alerter && (created || failures.length)) {
      try {
        await alerter.send({
          type: 'reports', severity: failures.length ? 'warning' : 'info',
          title: t(lang, 'alerts.reportsTitle', { month: formatMonth(lang, period) }),
          text: t(lang, settings.reports.mode === 'auto' ? 'alerts.reportsSent' : 'alerts.reportsDraft', { created, sent, count: created })
            + (failures.length ? `\n${failures.join('\n')}` : ''),
        });
      } catch (err) {
        log.warn?.(`[report] notification failed: ${err.message}`);
      }
    }
    return { ran: true, period, created, sent, failures };
  } finally {
    scheduleLocks.delete(db);
  }
}
