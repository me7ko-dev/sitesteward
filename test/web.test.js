import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { get, all } from '../src/db.js';
import { startApp, startTestSite, browser, csrfFrom, setupAndLogin } from './helpers.js';
import { getSettings, saveSettings } from '../src/settings.js';

let ctx;
let site;
before(async () => {
  site = await startTestSite();
  ctx = await startApp();
});
after(async () => {
  await ctx.close();
  await site.close();
});

test('first run: everything redirects to /setup, which needs the setup code', async () => {
  const b = browser(ctx.base);
  assert.equal((await b.get('/')).location, '/setup');
  assert.equal((await b.get('/settings')).location, '/setup');
  const page = await b.get('/setup');
  assert.equal(page.status, 200);
  const csrf = csrfFrom(page.text);
  assert.ok(csrf);
  // missing CSRF token
  assert.equal((await b.post('/setup', { code: ctx.app.setupCode, password: 'x'.repeat(12), password2: 'x'.repeat(12) })).status, 403);
  // wrong code
  const wrong = await b.post('/setup', { _csrf: csrf, code: 'AAAA-BBBB', agency: 'A', password: 'x'.repeat(12), password2: 'x'.repeat(12) });
  assert.equal(wrong.status, 400);
  assert.match(wrong.text, /Wrong setup code/);
  // short password
  assert.equal((await b.post('/setup', { _csrf: csrf, code: ctx.app.setupCode, agency: 'A', password: 'short', password2: 'short' })).status, 400);
  assert.equal(ctx.app.needsSetup(), true);
});

test('setup → logged in; setup page is gone afterwards; session cookie is HttpOnly', async () => {
  const b = await setupAndLogin(ctx, { password: 'correct horse battery' });
  assert.equal(ctx.app.needsSetup(), false);
  const home = await b.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Northwind Web Studio/);
  assert.equal((await b.get('/setup')).location, '/');
  assert.ok(b.jar.get('cu_session'));
  // the stored session id is a hash, not the cookie value
  const raw = b.jar.get('cu_session');
  assert.equal(get(ctx.app.db, 'SELECT COUNT(*) AS n FROM sessions WHERE id = ?', raw).n, 0);
  ctx.b = b;
});

test('security headers are set', async () => {
  const r = await browser(ctx.base).get('/login');
  assert.match(r.res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(r.res.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.res.headers.get('referrer-policy'), 'no-referrer');
  const setCookie = r.res.headers.getSetCookie().join('\n');
  assert.match(setCookie, /cu_pre=.*HttpOnly/);
});

test('login: wrong password fails, rate limit kicks in, right password works', async () => {
  const b = browser(ctx.base);
  assert.equal((await b.get('/')).location, '/login');
  const page = await b.get('/login');
  const csrf = csrfFrom(page.text);
  const bad = await b.post('/login', { _csrf: csrf, password: 'nope nope nope' });
  assert.equal(bad.status, 401);
  const good = await b.post('/login', { _csrf: csrf, password: 'correct horse battery' });
  assert.equal(good.status, 303);
  assert.equal((await b.get('/')).status, 200);
  // logout
  const home = await b.get('/');
  await b.post('/logout', { _csrf: csrfFrom(home.text) });
  assert.equal((await b.get('/')).location, '/login');

  const attacker = browser(ctx.base);
  const p2 = await attacker.get('/login');
  const c2 = csrfFrom(p2.text);
  let last;
  for (let i = 0; i < 11; i++) last = await attacker.post('/login', { _csrf: c2, password: `guess-${i}-xxxxxx` });
  assert.equal(last.status, 429);
});

test('CSRF: POST without the session token is rejected; cross-origin POST is blocked', async () => {
  const b = ctx.b;
  const noToken = await b.post('/clients', { name: 'Evil' });
  assert.equal(noToken.status, 403);
  const cross = await b.post('/clients', { _csrf: b.csrf, name: 'Evil' }, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal(all(ctx.app.db, "SELECT * FROM clients WHERE name = 'Evil'").length, 0);
});

test('create client + site through the panel; checks run; report + public link work', async () => {
  const b = ctx.b;
  const created = await b.post('/clients', { _csrf: b.csrf, name: 'Seaside Hotel', email: 'owner@example.com', lang: 'bg', color: '#0ea5e9', auto_send: '1' });
  assert.equal(created.status, 303);
  const clientPath = created.location;
  const added = await b.post(`${clientPath}/sites`, { _csrf: b.csrf, name: 'Main site', url: site.url, interval_min: '5' });
  assert.equal(added.status, 303);
  const siteRow = get(ctx.app.db, 'SELECT * FROM sites');
  // run a check explicitly (the background check may still be running)
  const chk = await b.post(`/sites/${siteRow.id}/check`, { _csrf: b.csrf });
  assert.equal(chk.status, 303);
  const after = get(ctx.app.db, 'SELECT * FROM sites');
  assert.equal(after.state, 'up');
  assert.equal(after.title_baseline, 'Hotel Example – Rooms');

  const sitePage = await b.get(`/sites/${siteRow.id}`);
  assert.equal(sitePage.status, 200);
  assert.match(sitePage.text, /Recent checks/);

  // invalid URL → back with message
  const badUrl = await b.post(`${clientPath}/sites`, { _csrf: b.csrf, name: 'x', url: 'ftp://nope' }, { referer: `${ctx.base}${clientPath}` });
  assert.equal(badUrl.status, 303);

  const period = new Date().toISOString().slice(0, 7);
  const rep = await b.post(`${clientPath}/reports`, { _csrf: b.csrf, period });
  assert.equal(rep.status, 303);
  const reportRow = get(ctx.app.db, 'SELECT * FROM reports');
  const pub = await browser(ctx.base).get(`/r/${reportRow.token}`);
  assert.equal(pub.status, 200);
  assert.match(pub.text, /Отчет за поддръжка на сайта/);
  assert.equal(pub.res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await browser(ctx.base).get('/r/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status, 404);

  // rotate link: old token stops working
  await b.post(`/reports/${reportRow.id}/rotate`, { _csrf: b.csrf });
  assert.equal((await browser(ctx.base).get(`/r/${reportRow.token}`)).status, 404);

  // status page only when enabled
  const client = get(ctx.app.db, 'SELECT * FROM clients');
  assert.equal((await browser(ctx.base).get(`/status/${client.status_token}`)).status, 404);
  await b.post(clientPath, { _csrf: b.csrf, name: 'Seaside Hotel', email: 'owner@example.com', lang: 'bg', color: '#0ea5e9', status_public: '1' });
  const st = await browser(ctx.base).get(`/status/${client.status_token}`);
  assert.equal(st.status, 200);
  assert.match(st.text, /Всички сайтове работят/);
});

test('send report by e-mail goes to the fake mailer; test alert goes to the fake adapter', async () => {
  const b = ctx.b;
  const s = getSettings(ctx.app.db);
  s.publicUrl = ctx.base;
  s.smtp = { ...s.smtp, host: 'smtp.example.com', from: 'Northwind <reports@example.com>' };
  s.alerts.webhook = { enabled: true, url: 'https://hooks.example.test/x' };
  saveSettings(ctx.app.db, s);
  const report = get(ctx.app.db, 'SELECT * FROM reports');
  const r = await b.post(`/reports/${report.id}/send`, { _csrf: b.csrf });
  assert.equal(r.status, 303);
  assert.equal(ctx.mails.length, 1);
  assert.equal(ctx.mails[0].msg.to, 'owner@example.com');
  assert.ok(get(ctx.app.db, 'SELECT sent_at FROM reports').sent_at);

  const before = ctx.alerts.length;
  await b.post('/settings/test-alert', { _csrf: b.csrf, channel: 'webhook' });
  assert.equal(ctx.alerts.length, before + 1);
  assert.equal(ctx.alerts.at(-1).channel, 'webhook');
  assert.match(ctx.alerts.at(-1).msg.title, /test alert/);
});

test('settings: secrets are not echoed back into the page', async () => {
  const b = ctx.b;
  const s = getSettings(ctx.app.db);
  s.smtp.pass = 'super-secret-smtp-pass';
  s.alerts.telegram.botToken = '123456:SECRET-BOT-TOKEN';
  saveSettings(ctx.app.db, s);
  const page = await b.get('/settings');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /super-secret-smtp-pass/);
  assert.doesNotMatch(page.text, /SECRET-BOT-TOKEN/);
  // saving the form with empty secret fields keeps the old secrets
  const form = Object.fromEntries([...page.text.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  form.agency_name = 'Northwind Web Studio';
  const saved = await b.post('/settings', { ...form, _csrf: b.csrf });
  assert.equal(saved.status, 303);
  const after = getSettings(ctx.app.db);
  assert.equal(after.smtp.pass, 'super-secret-smtp-pass');
  assert.equal(after.alerts.telegram.botToken, '123456:SECRET-BOT-TOKEN');
});

test('pausing a site closes its open incidents and hides "check now"; resuming starts fresh', async () => {
  const b = ctx.b;
  const s = get(ctx.app.db, 'SELECT * FROM sites');
  site.state.mode = 'error';
  await b.post(`/sites/${s.id}/check`, { _csrf: b.csrf });
  site.state.mode = 'ok';
  assert.equal(get(ctx.app.db, 'SELECT state FROM sites').state, 'down');
  assert.equal(all(ctx.app.db, "SELECT * FROM incidents WHERE kind = 'down' AND ended_at IS NULL").length, 1);
  const form = { _csrf: b.csrf, name: s.name, url: s.url, interval_min: '5' }; // no "enabled" = paused
  assert.equal((await b.post(`/sites/${s.id}`, form)).status, 303);
  assert.equal(get(ctx.app.db, 'SELECT state FROM sites').state, 'paused');
  assert.equal(all(ctx.app.db, 'SELECT * FROM incidents WHERE ended_at IS NULL').length, 0);
  const page = await b.get(`/sites/${s.id}`);
  assert.match(page.text, /Monitoring is paused/);
  assert.doesNotMatch(page.text, /action="\/sites\/\d+\/check"/);
  const home = await b.get('/');
  assert.match(home.text, /<span class="badge">paused<\/span>/);
  await b.post(`/sites/${s.id}`, { ...form, enabled: '1' });
  assert.equal(get(ctx.app.db, 'SELECT state FROM sites').state, 'unknown');
});

test('backup: logged-in users can download a consistent copy of the database', async () => {
  const r = await fetch(`${ctx.base}/settings/backup`, { headers: { cookie: `cu_session=${ctx.b.jar.get('cu_session')}` } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="sitesteward-backup-\d{4}-\d{2}-\d{2}\.db"/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  // and it is a working database with our data in it
  const { openDb } = await import('../src/db.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(os.tmpdir(), `ss-backup-test-${process.pid}.db`);
  fs.writeFileSync(file, buf);
  const copy = openDb(file);
  assert.equal(get(copy, 'SELECT name FROM clients').name, 'Seaside Hotel');
  copy.close();
  fs.rmSync(file, { force: true });
  for (const ext of ['-wal', '-shm']) fs.rmSync(file + ext, { force: true });
  // not without a session
  assert.equal((await browser(ctx.base).get('/settings/backup')).location, '/login');
});

test('unknown report ids give 404 instead of a silent no-op', async () => {
  const b = ctx.b;
  assert.equal((await b.post('/reports/9999', { _csrf: b.csrf, work_done: 'x' })).status, 404);
  assert.equal((await b.post('/reports/9999/rotate', { _csrf: b.csrf })).status, 404);
  assert.equal((await b.get('/reports/9999')).status, 404);
});

test('setup code guessing is rate-limited', async () => {
  const fresh = await startApp();
  try {
    const b = browser(fresh.base);
    const page = await b.get('/setup');
    const csrf = csrfFrom(page.text);
    let last;
    for (let i = 0; i < 11; i++) last = await b.post('/setup', { _csrf: csrf, code: `AAAA-${String(i).padStart(4, 'B')}`, agency: 'A', password: 'x'.repeat(12), password2: 'x'.repeat(12) });
    assert.match(last.text, /Too many attempts/);
    // even the right code is refused while blocked
    const right = await b.post('/setup', { _csrf: csrf, code: fresh.app.setupCode, agency: 'A', password: 'x'.repeat(12), password2: 'x'.repeat(12) });
    assert.equal(right.status, 400);
    assert.equal(fresh.app.needsSetup(), true);
  } finally {
    await fresh.close();
  }
});

test('agency logo is served as an image for e-mails; e-mail shows it (raster only)', async () => {
  const { emailLogoUrl } = await import('../src/report.js');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const s = getSettings(ctx.app.db);
  s.agency.logo = png;
  s.publicUrl = 'https://monitor.example.com/';
  saveSettings(ctx.app.db, s);
  const r = await fetch(`${ctx.base}/brand/logo`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
  assert.match(emailLogoUrl(s), /^https:\/\/monitor\.example\.com\/brand\/logo\?v=[0-9a-f]{10}$/);
  // SVG is not shown by most mail clients → name instead of a broken image
  assert.equal(emailLogoUrl({ ...s, agency: { ...s.agency, logo: 'data:image/svg+xml;base64,PHN2Zy8+' } }), '');
  assert.equal(emailLogoUrl({ ...s, agency: { ...s.agency, logo: 'https://cdn.example.com/logo.png' } }), 'https://cdn.example.com/logo.png');
  assert.equal(emailLogoUrl({ ...s, publicUrl: '' }), '');
  const before = ctx.mails.length;
  const report = get(ctx.app.db, 'SELECT * FROM reports');
  await ctx.b.post(`/reports/${report.id}/send`, { _csrf: ctx.b.csrf });
  assert.equal(ctx.mails.length, before + 1);
  assert.match(ctx.mails.at(-1).msg.html, /<img src="https:\/\/monitor\.example\.com\/brand\/logo\?v=/);
  assert.match(ctx.mails.at(-1).msg.html, /<meta charset="utf-8">/);
  s.agency.logo = '';
  saveSettings(ctx.app.db, s);
  assert.equal((await fetch(`${ctx.base}/brand/logo`)).status, 404);
});
