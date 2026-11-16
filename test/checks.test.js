import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { httpCheck } from '../src/checks/http-check.js';
import { extractTitle, findSpamWords, parseWordList } from '../src/checks/content.js';
import { tlsCheck } from '../src/checks/tls-check.js';
import { createRdap, registrableDomain, parseRdap } from '../src/checks/domain-check.js';
import { startTestSite } from './helpers.js';

let site;
before(async () => { site = await startTestSite(); });
after(async () => { await site.close(); });

test('http: healthy page is up, with status, time and size', async () => {
  site.state.mode = 'ok';
  const r = await httpCheck(site.url);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.ok(r.responseMs >= 0);
  assert.ok(r.bytes > 50);
  assert.match(r.body, /Book your stay/);
});

test('http: 500 is down with a clear category', async () => {
  site.state.mode = 'error';
  const r = await httpCheck(site.url);
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.equal(r.errorKind, 'http5xx');
  site.state.mode = 'ok';
});

test('http: 404 is down (http4xx)', async () => {
  const r = await httpCheck(`${site.url}notfound`);
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'http4xx');
});

test('http: keyword must be present', async () => {
  assert.equal((await httpCheck(site.url, { keyword: 'book your STAY' })).ok, true);
  const r = await httpCheck(site.url, { keyword: 'Free parking' });
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'keyword');
});

test('http: timeout is detected', async () => {
  site.state.mode = 'hang';
  const r = await httpCheck(site.url, { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'timeout');
  site.state.mode = 'ok';
});

test('http: connection refused is detected', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  const r = await httpCheck(`http://127.0.0.1:${port}/`, { timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'refused');
});

test('content: title extraction decodes entities', () => {
  assert.equal(extractTitle('<html><title>\n  Hotel &amp; Spa &#8211; Home </title>'), 'Hotel & Spa – Home');
  assert.equal(extractTitle('<p>no title</p>'), '');
});

test('content: spam words are whole-word, case-insensitive and can be ignored', () => {
  const words = ['casino', 'viagra', 'kmspico', 'payday loan'];
  const html = '<div style="display:none"><a href="x">Best CASINO bonus</a> kmspico download</div><p>Casinoroyale hotel</p>';
  assert.deepEqual(findSpamWords(html, words), ['casino', 'kmspico']);
  assert.deepEqual(findSpamWords(html, words, ['casino']), ['kmspico']);
  assert.deepEqual(findSpamWords('<p>Get a Payday \n loan</p>', words), ['payday loan']);
  assert.deepEqual(findSpamWords('<p>Get a paydayloan now</p>', words), []);
  assert.deepEqual(parseWordList('Casino, viagra\n slots ,,'), ['casino', 'viagra', 'slots']);
});

test('domain: registrable domain detection', () => {
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.com.au'), 'example.com.au');
  assert.equal(registrableDomain('blog.example.bg'), 'example.bg');
  assert.equal(registrableDomain('127.0.0.1'), '');
  assert.equal(registrableDomain('localhost'), '');
});

test('domain: RDAP lookup via bootstrap (fake network)', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes('iana.org')) {
      return new Response(JSON.stringify({ services: [[['com', 'net'], ['https://rdap.example-registry.test/']], [['de'], ['https://rdap.denic.test/']]] }));
    }
    if (url.endsWith('/domain/example.com')) {
      return new Response(JSON.stringify({
        events: [{ eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' }, { eventAction: 'expiration', eventDate: '2030-08-13T04:00:00Z' }],
        entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar Inc.']]] }],
      }));
    }
    if (url.endsWith('/domain/beispiel.de')) return new Response(JSON.stringify({ events: [{ eventAction: 'last changed', eventDate: '2024-01-01T00:00:00Z' }] }));
    return new Response('{}', { status: 404 });
  };
  let cached;
  const rdap = createRdap({ fetchImpl: fakeFetch, cache: { get: () => cached, set: (v) => { cached = v; } } });
  const ok = await rdap.lookup('example.com');
  assert.equal(ok.status, 'ok');
  assert.equal(new Date(ok.expiresAt).toISOString(), '2030-08-13T04:00:00.000Z');
  assert.equal(ok.registrar, 'Example Registrar Inc.');
  assert.equal((await rdap.lookup('beispiel.de')).status, 'no-expiry');
  assert.equal((await rdap.lookup('example.bg')).status, 'no-rdap');
  assert.equal((await rdap.lookup('missing.net')).status, 'not-found');
  assert.equal(calls.filter((u) => u.includes('iana.org')).length, 1, 'bootstrap is cached');
  assert.equal(parseRdap({}).status, 'no-expiry');
});

test('tls: reads expiry of a local self-signed certificate', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-tls-'));
  try {
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
        '-days', '30', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    } catch {
      t.skip('openssl not available');
      return;
    }
    const cert = fs.readFileSync(path.join(dir, 'c.pem'));
    const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert }, (q, s) => s.end('ok'));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    const untrusted = await tlsCheck('localhost', port);
    assert.equal(untrusted.valid, false);
    assert.ok(untrusted.error, 'self-signed is reported as an error');
    const days = Math.round((untrusted.expiresAt - Date.now()) / 86400000);
    assert.ok(days >= 29 && days <= 30, `days=${days}`);
    const trusted = await tlsCheck('localhost', port, { ca: cert });
    assert.equal(trusted.valid, true);
    assert.equal(trusted.error, null);
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
