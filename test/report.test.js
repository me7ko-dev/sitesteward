import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, get, run } from '../src/db.js';
import { getSettings, saveSettings } from '../src/settings.js';
import { buildReportData, generateReport, sendReport, runMonthlySchedule } from '../src/report.js';
import { renderReportPage, renderReportEmail, renderStatusPage } from '../src/web/report-view.js';
import { monthRange, previousPeriod, daysOfMonth } from '../src/time.js';
import { t, catalog, LANGS, formatPct } from '../src/i18n.js';
import { createAlerter, fakeAdapters } from '../src/alerts/index.js';
import { silentLog } from './helpers.js';

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

function seed({ lang = 'en', clientName = 'Seaside Hotel' } = {}) {
  const db = openDb(':memory:');
  const s = getSettings(db);
  s.timezone = 'Europe/Sofia';
  s.publicUrl = 'https://monitor.example.com';
  s.agency = { name: 'Northwind Web Studio', color: '#4f46e5', email: 'hello@example.com', website: 'www.example.com', logo: '' };
  s.smtp = { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p', from: 'Northwind <reports@example.com>' };
  saveSettings(db, s);
  run(db, 'INSERT INTO clients(name, email, lang, status_token, created_at) VALUES (?, ?, ?, ?, 0)', clientName, 'owner@example.com', lang, 'status_token_123456');
  run(db, "INSERT INTO sites(client_id, name, url, created_at, ssl_expires_at, ssl_checked_at, domain_status, domain_name, domain_expires_at, last_bytes) VALUES (1, 'Main site', 'https://www.example.com/', 0, ?, 1, 'ok', 'example.com', ?, 48213)",
    Date.UTC(2027, 0, 20), Date.UTC(2027, 7, 13));
  run(db, "INSERT INTO sites(client_id, name, url, created_at, domain_status, domain_name) VALUES (1, 'Booking', 'https://booking.example.bg/', 0, 'no-rdap', 'example.bg')");
  const { from, to } = monthRange('2026-10', 'Europe/Sofia');
  // checks every hour for the whole month (and the monitor keeps running into the next month)
  for (let ts = from; ts < to + DAY; ts += HOUR) {
    run(db, 'INSERT INTO checks(site_id, ts, ok, status, response_ms, bytes) VALUES (1, ?, 1, 200, 420, 48213)', ts);
    run(db, 'INSERT INTO checks(site_id, ts, ok, status, response_ms, bytes) VALUES (2, ?, 1, 200, 980, 30000)', ts);
  }
  // Site 1: two outages: 45 min on Oct 3 and 15 min on Oct 20
  run(db, "INSERT INTO incidents(site_id, kind, started_at, ended_at, reason) VALUES (1, 'down', ?, ?, 'timeout')", from + 2 * DAY + 14 * HOUR, from + 2 * DAY + 14 * HOUR + 45 * MIN);
  run(db, "INSERT INTO incidents(site_id, kind, started_at, ended_at, reason) VALUES (1, 'down', ?, ?, 'http5xx')", from + 19 * DAY + 9 * HOUR, from + 19 * DAY + 9 * HOUR + 15 * MIN);
  // an incident in another month must not count
  run(db, "INSERT INTO incidents(site_id, kind, started_at, ended_at, reason) VALUES (1, 'down', ?, ?, 'dns')", to + DAY, to + DAY + HOUR);
  run(db, 'INSERT INTO work_log(client_id, ts, text) VALUES (1, ?, ?)', from + 5 * DAY, 'Updated WordPress and 12 plugins');
  run(db, 'INSERT INTO work_log(client_id, ts, text) VALUES (1, ?, ?)', from + 12 * DAY, 'Renewed the SSL certificate');
  run(db, 'INSERT INTO work_log(client_id, ts, text) VALUES (1, ?, ?)', to + DAY, 'Next month work (must not appear)');
  return { db, from, to, now: to + 2 * DAY };
}

test('time: month boundaries respect the agency time zone (DST month)', () => {
  const { from, to } = monthRange('2026-10', 'Europe/Sofia');
  assert.equal(new Date(from).toISOString(), '2026-09-30T21:00:00.000Z'); // UTC+3 (summer)
  assert.equal(new Date(to).toISOString(), '2026-10-31T22:00:00.000Z'); // UTC+2 (winter)
  assert.equal(daysOfMonth('2026-10', 'Europe/Sofia').length, 31);
  assert.equal(daysOfMonth('2028-02', 'UTC').length, 29);
  assert.equal(previousPeriod(Date.UTC(2026, 0, 1, 12), 'UTC'), '2025-12');
});

test('report data: uptime %, outages, speed, work log of that month only', () => {
  const { db, now } = seed();
  const d = buildReportData(db, 1, '2026-10', now);
  const main = d.sites.find((s) => s.name === 'Main site');
  assert.equal(main.downMs, 60 * MIN);
  const total = 31 * DAY + HOUR; // October has one extra hour when DST ends
  assert.ok(Math.abs(main.uptime - ((total - 60 * MIN) / total) * 100) < 1e-9);
  assert.equal(main.incidents.length, 2);
  assert.equal(main.avgMs, 420);
  assert.equal(main.daily.length, 31);
  assert.ok(main.daily[2] < 100 && main.daily[0] === 100);
  assert.equal(d.summary.incidents, 2);
  assert.equal(d.summary.avgMs, 700);
  assert.equal(d.partial, false);
  const report = generateReport(db, 1, '2026-10', now);
  assert.equal(report.work_done, 'Updated WordPress and 12 plugins\nRenewed the SSL certificate');
  assert.ok(report.token.length >= 32);
  // regenerate keeps token and edited notes
  run(db, "UPDATE reports SET work_done = 'Custom notes' WHERE id = ?", report.id);
  const again = generateReport(db, 1, '2026-10', now);
  assert.equal(again.token, report.token);
  assert.equal(again.work_done, 'Custom notes');
});

test('report page (English): plain-language summary, incidents, SSL/domain, honest RDAP note', () => {
  const { db, now } = seed();
  const report = generateReport(db, 1, '2026-10', now);
  run(db, "UPDATE reports SET next_steps = 'Add a cookie banner' WHERE id = 1");
  const r = get(db, 'SELECT * FROM reports WHERE id = 1');
  const html = renderReportPage({ data: JSON.parse(r.data_json), report: r, lang: 'en' });
  assert.match(html, /Website care report/);
  assert.match(html, /October 2026/);
  assert.match(html, /Prepared for <b>Seaside Hotel<\/b> by <b>Northwind Web Studio<\/b>/);
  assert.match(html, /There were 2 outages \(1\sh in total\)/);
  assert.match(html, /the website was unreachable for 45\smin – the server did not answer in time/);
  assert.match(html, /Valid until 20 January 2027/);
  assert.match(html, /example\.com is registered until 13 August 2027/);
  assert.match(html, /does not offer an automatic lookup \(RDAP\)/);
  assert.match(html, /Updated WordPress and 12 plugins/);
  assert.match(html, /Add a cookie banner/);
  assert.match(html, /No signs of hacking/);
  assert.ok(report);
});

test('report page (Bulgarian) uses Bulgarian texts and dates', () => {
  const { db, now } = seed({ lang: 'bg' });
  generateReport(db, 1, '2026-10', now);
  const r = get(db, 'SELECT * FROM reports WHERE id = 1');
  const html = renderReportPage({ data: JSON.parse(r.data_json), report: r, lang: 'bg' });
  assert.match(html, /Отчет за поддръжка на сайта/);
  assert.match(html, /октомври 2026/);
  assert.match(html, /Имаше 2 прекъсвания/);
  assert.match(html, /сървърът не отговори навреме/);
  assert.match(html, /Какво направихме този месец/);
  assert.match(html, /lang="bg"/);
  assert.doesNotMatch(html, /Website care report/);
});

test('report escapes client-provided text (no XSS)', () => {
  const { db, now } = seed({ clientName: '<script>alert(1)</script>' });
  generateReport(db, 1, '2026-10', now);
  run(db, "UPDATE reports SET work_done = '<img src=x onerror=alert(1)>' WHERE id = 1");
  const r = get(db, 'SELECT * FROM reports WHERE id = 1');
  const html = renderReportPage({ data: JSON.parse(r.data_json), report: r, lang: 'en' });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});

test('sending a report uses the client language and marks it sent (fake mailer)', async () => {
  const { db, now } = seed({ lang: 'bg' });
  const report = generateReport(db, 1, '2026-10', now);
  const mails = [];
  await sendReport(db, report.id, { mailer: async (cfg, msg) => mails.push({ cfg, msg }) }, now);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].msg.to, 'owner@example.com');
  assert.match(mails[0].msg.subject, /Northwind Web Studio: отчет за вашия сайт за октомври 2026/);
  assert.match(mails[0].msg.html, new RegExp(`https://monitor.example.com/r/${report.token}`));
  assert.equal(get(db, 'SELECT sent_to FROM reports').sent_to, 'owner@example.com');
  const email = renderReportEmail({ data: JSON.parse(report.data_json), report, link: 'https://x.test/r/abc', lang: 'en' });
  assert.match(email, /Open the full report/);
});

test('monthly schedule: manual mode makes drafts + notifies agency once; auto mode e-mails', async () => {
  const { db } = seed();
  const s = getSettings(db);
  s.alerts.webhook = { enabled: true, url: 'https://hooks.example.test/' };
  saveSettings(db, s);
  const adapters = fakeAdapters();
  const alerter = createAlerter({ db, adapters, log: silentLog });
  const sent = [];
  const send = async (id) => sent.push(id);
  const nov1 = Date.UTC(2026, 10, 1, 8, 0); // 10:00 in Sofia
  const early = Date.UTC(2026, 10, 1, 5, 0); // 07:00 in Sofia – before the hour
  assert.equal((await runMonthlySchedule(db, { now: early, alerter, send })).ran, false);
  const r = await runMonthlySchedule(db, { now: nov1, alerter, send, log: silentLog });
  assert.equal(r.ran, true);
  assert.equal(r.period, '2026-10');
  assert.equal(r.created, 1);
  assert.equal(sent.length, 0, 'manual mode does not e-mail clients');
  assert.equal(adapters.sink.length, 1);
  assert.match(adapters.sink[0].msg.text, /ready as a draft/);
  assert.equal((await runMonthlySchedule(db, { now: nov1 + HOUR, alerter, send })).ran, false, 'only once');

  const { db: db2 } = seed();
  const s2 = getSettings(db2);
  s2.reports.mode = 'auto';
  saveSettings(db2, s2);
  const sent2 = [];
  const r2 = await runMonthlySchedule(db2, { now: nov1, alerter: null, send: async (id) => sent2.push(id), log: silentLog });
  assert.equal(r2.sent, 1);
  assert.equal(sent2.length, 1);
});

test('status page renders and escapes', () => {
  const html = renderStatusPage({
    client: { name: 'Seaside <Hotel>', color: '#0ea5e9', logo: '' },
    agency: { name: 'Northwind', color: '#4f46e5' },
    sites: [{ name: 'Main', state: 'up', days: [100, 99.5, null], uptime30: 99.8 }],
    lang: 'en', tz: 'UTC',
  });
  assert.match(html, /All websites are online/);
  assert.match(html, /Seaside &lt;Hotel&gt;/);
});

test('i18n: every English key exists in every other language', () => {
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !('one' in v) ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
  const en = keys(catalog('en'));
  for (const lang of LANGS) {
    const have = new Set(keys(catalog(lang)));
    const missing = en.filter((k) => !have.has(k));
    assert.deepEqual(missing, [], `${lang} is missing keys`);
  }
  assert.equal(t('en', 'report.checksDone', { count: 1, n: 1 }), '1 check');
  assert.equal(t('bg', 'report.checksDone', { count: 5, n: 5 }), '5 проверки');
  assert.equal(formatPct('en', 99.996), '99.99%');
  assert.equal(formatPct('en', 100), '100%');
});

test('monthly schedule catches up after downtime on the 1st, but only in the first week', async () => {
  const { db } = seed();
  const sent = [];
  const nov3 = Date.UTC(2026, 10, 3, 6, 0);
  const r = await runMonthlySchedule(db, { now: nov3, alerter: null, send: async (id) => sent.push(id), log: silentLog });
  assert.equal(r.ran, true, 'sitesteward was off on the 1st: reports are still created on the 3rd');
  assert.equal(r.period, '2026-10');

  const { db: db2 } = seed();
  const nov9 = Date.UTC(2026, 10, 9, 6, 0);
  assert.equal((await runMonthlySchedule(db2, { now: nov9, alerter: null, send: async () => {}, log: silentLog })).ran, false);
});

test('monthly schedule: only monitored clients, never re-sends, one failure does not stop the others', async () => {
  const { db } = seed();
  // a client added after the month ended (no checks in October) gets no empty report
  run(db, "INSERT INTO clients(name, email, lang, status_token, created_at) VALUES ('New Client', 'new@example.com', 'en', 'status_token_new_1234', 0)");
  run(db, "INSERT INTO sites(client_id, name, url, created_at) VALUES (2, 'New', 'https://new.example.com/', 0)");
  // a third client whose e-mail fails
  run(db, "INSERT INTO clients(name, email, lang, status_token, created_at) VALUES ('Broken Mail', 'broken@example.com', 'en', 'status_token_brk_1234', 0)");
  run(db, "INSERT INTO sites(client_id, name, url, created_at) VALUES (3, 'Broken', 'https://broken.example.com/', 0)");
  const { from } = monthRange('2026-10', 'Europe/Sofia');
  run(db, 'INSERT INTO checks(site_id, ts, ok) VALUES (4, ?, 1)', from + 10 * DAY);
  const s = getSettings(db);
  s.reports.mode = 'auto';
  s.alerts.webhook = { enabled: true, url: 'https://hooks.example.test/' };
  saveSettings(db, s);
  const adapters = fakeAdapters();
  const alerter = createAlerter({ db, adapters, log: silentLog });
  const sent = [];
  const send = async (id) => {
    const rep = get(db, 'SELECT * FROM reports WHERE id = ?', id);
    if (rep.client_id === 3) throw new Error('mailbox unavailable');
    run(db, 'UPDATE reports SET sent_at = 1 WHERE id = ?', id);
    sent.push(id);
  };
  // Seaside Hotel was already sent manually before the schedule ran
  const pre = generateReport(db, 1, '2026-10', Date.UTC(2026, 10, 1, 6));
  run(db, "UPDATE reports SET sent_at = 123, data_json = '{\"frozen\":true}' WHERE id = ?", pre.id);
  const r = await runMonthlySchedule(db, { now: Date.UTC(2026, 10, 1, 8), alerter, send, log: silentLog });
  assert.equal(r.ran, true);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM reports WHERE client_id = 2').n, 0, 'no report for a client without data');
  assert.equal(get(db, 'SELECT data_json FROM reports WHERE id = ?', pre.id).data_json, '{"frozen":true}', 'a sent report is not rebuilt');
  assert.deepEqual(sent, [], 'nothing was re-sent; the failing one did not throw');
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /Broken Mail: mailbox unavailable/);
  assert.match(adapters.sink[0].msg.text, /mailbox unavailable/);
  assert.equal(adapters.sink[0].msg.severity, 'warning');
});

test('report: paused site without data is left out; unmonitored days are "no data"', () => {
  const { db, now, from } = seed();
  run(db, "INSERT INTO sites(client_id, name, url, created_at, enabled) VALUES (1, 'Old paused site', 'https://old.example.com/', 0, 0)");
  // a site added on Oct 20: the days before are "no data", not 100 %
  run(db, "INSERT INTO sites(client_id, name, url, created_at) VALUES (1, 'Late site', 'https://late.example.com/', 0)");
  const late = get(db, "SELECT id FROM sites WHERE name = 'Late site'").id;
  for (let ts = from + 19 * DAY; ts < from + 33 * DAY; ts += 5 * MIN) run(db, 'INSERT INTO checks(site_id, ts, ok, response_ms) VALUES (?, ?, 1, 300)', late, ts);
  const d = buildReportData(db, 1, '2026-10', now);
  assert.deepEqual(d.sites.map((s) => s.name), ['Booking', 'Late site', 'Main site']);
  const l = d.sites.find((s) => s.name === 'Late site');
  assert.equal(l.daily[0], null);
  assert.equal(l.daily[18], null);
  assert.equal(l.daily[20], 100);
  assert.equal(l.uptime, 100);
});
