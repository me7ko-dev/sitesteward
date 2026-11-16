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
