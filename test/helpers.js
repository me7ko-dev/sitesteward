// Shared test helpers: a local website to monitor, fakes, and a tiny browser with cookies.
import http from 'node:http';
import { createApp } from '../src/app.js';
import { fakeAdapters } from '../src/alerts/index.js';

/** A local "client website" whose behaviour the test controls. */
export async function startTestSite() {
  const state = { mode: 'ok', title: 'Hotel Example – Rooms', extra: '', delayMs: 0, hits: 0 };
  const server = http.createServer((req, res) => {
    state.hits++;
    const go = () => {
      if (req.url === '/notfound') { res.writeHead(404); res.end('nope'); return; }
      if (state.mode === 'error') { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<h1>Internal error</h1>'); return; }
      if (state.mode === 'hang') return; // never answers
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>${state.title}</title></head><body><h1>Welcome</h1><p>Book your stay.</p>${state.extra}</body></html>`);
    };
    if (state.delayMs) setTimeout(go, state.delayMs); else go();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    state,
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

export const silentLog = { info() {}, warn() {}, error() {}, log() {} };

export const fakeRdap = (result = { status: 'ok', expiresAt: Date.now() + 200 * 86400000, registrar: 'Example Registrar' }) => ({
  calls: [],
  async lookup(domain) { this.calls.push(domain); return typeof result === 'function' ? result(domain) : result; },
});

export const fakeTls = (result = { expiresAt: Date.now() + 80 * 86400000, issuer: 'Test CA', valid: true, error: null }) =>
  async () => (typeof result === 'function' ? result() : result);

/** App on a random port with an in-memory DB and fake alert adapters + fake mailer. */
export async function startApp(opts = {}) {
  const adapters = fakeAdapters();
  const mails = [];
  const app = await createApp({
    dbFile: ':memory:',
    adapters,
    mailer: async (cfg, msg) => { mails.push({ cfg, msg }); },
    log: silentLog,
    pdf: { available: false, async render() { return null; } },
    monitorOptions: { sleep: async () => {}, tlsCheckImpl: fakeTls(), rdap: fakeRdap(), ...(opts.monitorOptions || {}) },
    ...opts.appOptions,
  });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  return { app, base, alerts: adapters.sink, mails, close: () => app.close() };
}

/** Minimal browser: keeps cookies, does not follow redirects automatically. */
export function browser(base) {
  const jar = new Map();
  function store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c) || value === '') jar.delete(name); else jar.set(name, value);
    }
  }
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    jar,
    async get(path, headers = {}) {
      const res = await fetch(base + path, { redirect: 'manual', headers: { cookie: cookieHeader(), ...headers } });
      store(res);
      return { res, status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
    async post(path, fields, headers = {}) {
      const res = await fetch(base + path, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(), ...headers },
        body: new URLSearchParams(fields).toString(),
      });
      store(res);
      return { res, status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
  };
}

export function csrfFrom(html) {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

/** Complete first-run setup and return a logged-in browser. */
export async function setupAndLogin(ctx, { password = 'correct horse battery', agency = 'Northwind Web Studio' } = {}) {
  const b = browser(ctx.base);
  const page = await b.get('/setup');
  const r = await b.post('/setup', { _csrf: csrfFrom(page.text), code: ctx.app.setupCode, agency, lang: 'en', password, password2: password });
  if (r.status !== 303 || r.location !== '/') throw new Error(`setup failed: ${r.status} ${r.text.slice(0, 200)}`);
  const home = await b.get('/');
  b.csrf = csrfFrom(home.text);
  return b;
}
