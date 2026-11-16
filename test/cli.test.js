// End-to-end: the real CLI process, a real data directory, a restart in the middle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { browser, csrfFrom, startTestSite } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sitesteward.js');

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

function startCli(args) {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI did not start:\n${out}`)), 15000);
    const onData = () => {
      if (/is running/.test(out)) { clearTimeout(timer); setTimeout(() => resolve(), 100); }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`CLI exited with ${code}:\n${out}`)); });
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return { child, ready, exited, output: () => out };
}

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('CLI: --version and --help', async () => {
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const v = spawn(process.execPath, [BIN, '--version']);
  let out = '';
  v.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => v.on('exit', r));
  assert.equal(out.trim(), version);
});

test('CLI end-to-end: setup, add a site, outage detected, restart keeps everything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitesteward-e2e-'));
  const site = await startTestSite();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let cli = startCli(['--port', String(port), '--data', dir, '--dry-run']);
  try {
    await cli.ready;
    const code = /setup code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(cli.output())?.[1];
    assert.ok(code, 'setup code is printed');

    const b = browser(base);
    const setupPage = await b.get('/setup');
    const done = await b.post('/setup', { _csrf: csrfFrom(setupPage.text), code: code.toLowerCase(), agency: 'E2E Studio', lang: 'en', password: 'e2e-password-123', password2: 'e2e-password-123' });
    assert.equal(done.status, 303);
    let home = await b.get('/');
    const csrf = csrfFrom(home.text);
    const client = await b.post('/clients', { _csrf: csrf, name: 'E2E Client', email: 'client@example.com', lang: 'en', color: '#0ea5e9' });
    await b.post(`${client.location}/sites`, { _csrf: csrf, name: 'Local site', url: site.url, interval_min: '1' });

    // the first check runs right away
    await waitFor(async () => /Local site[\s\S]*?\d+ ms/.test((await b.get('/')).text));

    // fast settings so the outage is confirmed quickly
    const settingsPage = await b.get('/settings');
    const form = Object.fromEntries([...settingsPage.text.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    await b.post('/settings', { ...form, _csrf: csrf, retries: '0', retry_delay: '0', timeout: '2', webhook_enabled: '1', webhook_url: 'https://hooks.example.test/e2e' });

    site.state.mode = 'error';
    const sitePath = /href="(\/sites\/\d+)"/.exec(home.text)?.[1] || /href="(\/sites\/\d+)"/.exec((await b.get('/')).text)[1];
    await b.post(`${sitePath}/check`, { _csrf: csrf });
    home = await b.get('/');
    assert.match(home.text, /Down now<\/span><b>1<\/b>/);
    assert.match(cli.output(), /\[dry-run\] webhook: 🔴 DOWN: Local site/);

    // restart: hard kill (like a crash or power loss), then start again on the same data
    cli.child.kill('SIGKILL');
    await cli.exited;
    cli = startCli(['--port', String(port), '--data', dir, '--dry-run']);
    await cli.ready;
    assert.doesNotMatch(cli.output(), /setup code/, 'no new setup after restart');
    const b2 = browser(base);
    const login = await b2.get('/login');
    assert.equal((await b2.post('/login', { _csrf: csrfFrom(login.text), password: 'e2e-password-123' })).status, 303);
    const after = await b2.get('/');
    assert.match(after.text, /E2E Client/);
    assert.match(after.text, /Down now<\/span><b>1<\/b>/, 'the outage survived the restart');

    // recovery after the restart closes the incident and alerts once
    site.state.mode = 'ok';
    await b2.post(`${sitePath}/check`, { _csrf: csrfFrom(after.text) });
    assert.match((await b2.get('/')).text, /Down now<\/span><b>0<\/b>/);
    assert.match(cli.output(), /\[dry-run\] webhook: ✅ UP again: Local site/);
    const page = await b2.get(sitePath);
    assert.doesNotMatch(page.text, /ongoing/);

    // port already in use → clear message, exit code 1
    const dup = startCli(['--port', String(port), '--data', dir]);
    await assert.rejects(dup.ready, /already in use/);
  } finally {
    cli.child.kill();
    await cli.exited;
    await site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
