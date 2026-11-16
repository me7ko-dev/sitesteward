import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, get, all, run } from '../src/db.js';
import { createMonitor, thresholdFor, SSL_THRESHOLDS } from '../src/monitor.js';
import { createAlerter, fakeAdapters } from '../src/alerts/index.js';
import { getSettings, saveSettings } from '../src/settings.js';
import { computeUptime, siteUptime } from '../src/stats.js';
import { silentLog, fakeRdap } from './helpers.js';

const MIN = 60000;
const DAY = 86400000;

function setup({ results = [], tls, rdap } = {}) {
  const db = openDb(':memory:');
  const s = getSettings(db);
  s.alerts.webhook = { enabled: true, url: 'https://hooks.example.test/x' };
  s.alerts.telegram = { enabled: true, botToken: 'fake', chatId: '1' };
  saveSettings(db, s);
  run(db, "INSERT INTO clients(name, status_token, created_at) VALUES ('Seaside Hotel', 'tok_tok_tok_tok_tok', 0)");
  run(db, "INSERT INTO sites(client_id, name, url, created_at) VALUES (1, 'Main site', 'https://www.example.com/', 0)");
  const adapters = fakeAdapters();
  const alerter = createAlerter({ db, adapters, log: silentLog });
  let clock = Date.UTC(2026, 9, 1, 0, 0, 0);
  const queue = [...results];
  const calls = [];
  const monitor = createMonitor({
    db, alerter, log: silentLog,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    httpCheckImpl: async (url) => {
      calls.push(url);
      const next = queue.length ? queue.shift() : { ok: true };
      return next.ok
        ? { ok: true, status: 200, responseMs: next.ms ?? 300, bytes: 5000, body: next.body ?? '<title>Seaside Hotel</title>', error: null, errorKind: null }
        : { ok: false, status: next.status ?? null, responseMs: 0, bytes: 0, body: '', error: next.error ?? 'ECONNREFUSED', errorKind: next.kind ?? 'refused' };
    },
    tlsCheckImpl: tls || (async () => ({ expiresAt: clock + 90 * DAY, issuer: 'Test CA', valid: true, error: null })),
    rdap: rdap || fakeRdap({ status: 'ok', expiresAt: clock + 300 * DAY }),
  });
  return {
    db, monitor, sent: adapters.sink, calls,
    advance: (ms) => { clock += ms; },
    now: () => clock,
    push: (...r) => queue.push(...r),
  };
}

test('uptime math: merges overlaps and clips to the range', () => {
  const r = computeUptime(0, 1000, [[100, 200], [150, 300], [900, 1500], [-50, 10]]);
  assert.equal(r.downMs, 200 + 100 + 10);
  assert.equal(r.pct, 69);
  assert.equal(computeUptime(0, 1000, []).pct, 100);
  assert.equal(computeUptime(5, 5, []).pct, null);
});

test('a single failed check that recovers on retry does NOT alert (no false alarms)', async () => {
  const t = setup({ results: [{ ok: false }, { ok: true }] });
  await t.monitor.checkHttp(1);
  assert.equal(t.calls.length, 2, 'retried once');
  assert.equal(get(t.db, 'SELECT state FROM sites').state, 'up');
  assert.equal(all(t.db, "SELECT * FROM incidents WHERE kind = 'down'").length, 0);
  assert.equal(t.sent.length, 0);
});

test('confirmed outage opens one incident, alerts once, closes on recovery with duration', async () => {
  const e500 = { ok: false, error: 'HTTP 500', kind: 'http5xx', status: 500 };
  const t = setup({ results: [{ ok: true }, e500, e500, e500] });
  await t.monitor.checkHttp(1); // up, baseline
  t.advance(5 * MIN);
  await t.monitor.checkHttp(1); // fails 3x (1 + 2 retries)
  assert.equal(get(t.db, 'SELECT state FROM sites').state, 'down');
  const inc = all(t.db, "SELECT * FROM incidents WHERE kind = 'down'");
  assert.equal(inc.length, 1);
  assert.equal(inc[0].reason, 'http5xx');
  assert.equal(inc[0].ended_at, null);
  assert.deepEqual(t.sent.map((s) => s.channel).sort(), ['telegram', 'webhook']);
  assert.match(t.sent[0].msg.title, /DOWN: Main site/);

  // still down: no second alert
  t.push({ ok: false }, { ok: false }, { ok: false });
  t.advance(5 * MIN);
  await t.monitor.checkHttp(1);
  assert.equal(t.sent.length, 2);
  assert.equal(all(t.db, "SELECT * FROM incidents WHERE kind = 'down'").length, 1);

  // recovery
  t.advance(5 * MIN);
  await t.monitor.checkHttp(1);
  const closed = get(t.db, "SELECT * FROM incidents WHERE kind = 'down'");
  assert.ok(closed.ended_at > closed.started_at);
  assert.equal(get(t.db, 'SELECT state FROM sites').state, 'up');
  assert.equal(t.sent.length, 4);
  assert.match(t.sent[2].msg.title, /UP again/);
  // 10 min of check intervals + 2×(2 retries × 20 s) spent confirming = 11 min 20 s
  assert.match(t.sent[2].msg.text, /after 11 min/);
});

test('uptime % for a site with one 30-minute outage in a day', async () => {
  const t = setup();
  const start = t.now();
  run(t.db, 'INSERT INTO checks(site_id, ts, ok) VALUES (1, ?, 1)', start);
  run(t.db, "INSERT INTO incidents(site_id, kind, started_at, ended_at) VALUES (1, 'down', ?, ?)", start + 2 * 3600000, start + 2 * 3600000 + 30 * MIN);
  const u = siteUptime(t.db, 1, start, start + DAY, start + DAY);
  assert.equal(u.downMs, 30 * MIN);
  assert.ok(Math.abs(u.pct - (100 - (30 / 1440) * 100)) < 1e-9);
  // ongoing incident counts until "now"
  run(t.db, "INSERT INTO incidents(site_id, kind, started_at) VALUES (1, 'down', ?)", start + DAY - 60 * MIN);
  const u2 = siteUptime(t.db, 1, start, start + DAY, start + DAY);
  assert.equal(u2.downMs, 90 * MIN);
});

test('hack signals: spam words alert once and clear; title change alerts', async () => {
  const t = setup({
    results: [
      { ok: true, body: '<title>Seaside Hotel</title>' },
      { ok: true, body: '<title>Seaside Hotel</title><div style="display:none">cheap viagra casino</div>' },
      { ok: true, body: '<title>Seaside Hotel</title><div style="display:none">cheap viagra casino</div>' },
      { ok: true, body: '<title>Hacked by someone</title>' },
    ],
  });
  await t.monitor.checkHttp(1);
  assert.equal(t.sent.length, 0);
  await t.monitor.checkHttp(1);
  assert.equal(get(t.db, 'SELECT spam_hits FROM sites').spam_hits, 'casino, viagra');
  assert.equal(t.sent.length, 2);
  assert.match(t.sent[0].msg.title, /Possible hack/);
  await t.monitor.checkHttp(1);
  assert.equal(t.sent.length, 2, 'no repeat alert while still present');
  await t.monitor.checkHttp(1);
  assert.equal(get(t.db, "SELECT ended_at FROM incidents WHERE kind = 'content'").ended_at != null, true);
  const titleAlerts = t.sent.filter((s) => s.msg.type === 'title');
  assert.equal(titleAlerts.length, 2);
  assert.match(titleAlerts[0].msg.text, /Hacked by someone/);
});

test('ignored spam words do not alert', async () => {
  const t = setup({ results: [{ ok: true, body: '<p>Next to the Grand Casino</p>' }] });
  run(t.db, "UPDATE sites SET ignore_words = 'casino'");
  await t.monitor.checkHttp(1);
  assert.equal(t.sent.length, 0);
});

test('SSL: expiry warnings at thresholds, once each; invalid cert is an incident', async () => {
  let expiresAt = Date.UTC(2026, 9, 1) + 20 * DAY + 3600000;
  let error = null;
  const t = setup({ tls: async () => ({ expiresAt, issuer: 'Test CA', valid: !error, error }) });
  assert.equal(thresholdFor(20, SSL_THRESHOLDS), 21);
  assert.equal(thresholdFor(2, SSL_THRESHOLDS), 3);
  assert.equal(thresholdFor(40, SSL_THRESHOLDS), null);
  await t.monitor.checkSsl(1);
  assert.equal(t.sent.length, 2); // telegram + webhook
  assert.match(t.sent[0].msg.text, /20 days/);
  await t.monitor.checkSsl(1);
  assert.equal(t.sent.length, 2, 'same threshold does not repeat');
  t.advance(8 * DAY);
  await t.monitor.checkSsl(1);
  assert.equal(t.sent.length, 4, '14-day threshold');
  // renewed
  expiresAt = t.now() + 90 * DAY;
  await t.monitor.checkSsl(1);
  assert.equal(get(t.db, 'SELECT ssl_warned_days FROM sites').ssl_warned_days, null);
  // broken
  error = 'CERT_HAS_EXPIRED';
  await t.monitor.checkSsl(1);
  assert.equal(all(t.db, "SELECT * FROM incidents WHERE kind = 'ssl' AND ended_at IS NULL").length, 1);
  assert.match(t.sent.at(-1).msg.title, /SSL problem/);
});

test('domain: warns before expiry; TLDs without RDAP are stored honestly', async () => {
  const t = setup({ rdap: fakeRdap((d) => (d === 'example.com' ? { status: 'ok', expiresAt: Date.UTC(2026, 9, 1) + 10 * DAY } : { status: 'no-rdap' })) });
  await t.monitor.checkDomain(1);
  const s = get(t.db, 'SELECT * FROM sites');
  assert.equal(s.domain_name, 'example.com');
  assert.equal(s.domain_status, 'ok');
  assert.equal(s.domain_warned_days, 14);
  assert.match(t.sent[0].msg.title, /Domain expires soon/);
  run(t.db, "UPDATE sites SET url = 'https://hotel.example.bg/', domain_checked_at = NULL");
  await t.monitor.checkDomain(1);
  assert.equal(get(t.db, 'SELECT domain_status FROM sites').domain_status, 'no-rdap');
});

test('tick() schedules checks by interval', async () => {
  const t = setup();
  await t.monitor.tick();
  assert.equal(t.calls.length, 1);
  await t.monitor.tick();
  assert.equal(t.calls.length, 1, 'not due yet');
  t.advance(5 * MIN);
  await t.monitor.tick();
  assert.equal(t.calls.length, 2);
});
