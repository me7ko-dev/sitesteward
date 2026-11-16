// Domain expiry via RDAP (free, standard, no API keys).
// The IANA bootstrap file tells us which RDAP server is responsible for each TLD.
// Some TLDs have no RDAP server, and some registries do not publish the expiry date;
// in those cases we say so honestly instead of guessing.

export const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL = 7 * 86400000;

// Common second-level labels under country-code TLDs (example.co.uk, example.com.au, ...).
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'nic', 'ltd', 'plc', 'sch', 'nom', 'info', 'biz']);

/** Best-effort registrable domain from a hostname. Use the per-site override for unusual cases. */
export function registrableDomain(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || /^[\d.]+$/.test(host) || host.includes(':') || host === 'localhost') return '';
  const labels = host.split('.');
  if (labels.length < 2) return '';
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(sld)) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

/**
 * @param {{fetchImpl?: typeof fetch, cache?: {get():any,set(v:any):void}, now?: () => number, timeoutMs?: number}} opts
 */
export function createRdap({ fetchImpl = fetch, cache, now = () => Date.now(), timeoutMs = 15000 } = {}) {
  let memo = null;

  async function bootstrap() {
    if (memo && now() - memo.fetchedAt < BOOTSTRAP_TTL) return memo.map;
    const cached = cache?.get();
    if (cached && now() - cached.fetchedAt < BOOTSTRAP_TTL) { memo = cached; return memo.map; }
    const res = await fetchImpl(IANA_BOOTSTRAP, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`RDAP bootstrap HTTP ${res.status}`);
    const json = await res.json();
    const map = {};
    for (const [tlds, urls] of json.services || []) {
      const url = urls.find((u) => u.startsWith('https://')) || urls[0];
      for (const tld of tlds) map[tld.toLowerCase()] = url.endsWith('/') ? url : `${url}/`;
    }
    memo = { fetchedAt: now(), map };
    cache?.set(memo);
    return map;
  }

  /**
   * @returns {Promise<{status:'ok'|'no-rdap'|'no-expiry'|'not-found'|'error', expiresAt?:number, registrar?:string, error?:string}>}
   */
  async function lookup(domain) {
    try {
      const tld = domain.split('.').pop().toLowerCase();
      const map = await bootstrap();
      const base = map[tld];
      if (!base) return { status: 'no-rdap' };
      const res = await fetchImpl(`${base}domain/${encodeURIComponent(domain)}`, {
        headers: { accept: 'application/rdap+json, application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return { status: 'not-found' };
      if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };
      const data = await res.json();
      return parseRdap(data);
    } catch (err) {
      return { status: 'error', error: err?.message || String(err) };
    }
  }

  return { lookup, bootstrap };
}

export function parseRdap(data) {
  const ev = (data.events || []).find((e) => /expiration/i.test(e.eventAction || ''));
  let registrar;
  for (const ent of data.entities || []) {
    if ((ent.roles || []).includes('registrar')) {
      const fn = (ent.vcardArray?.[1] || []).find((x) => x[0] === 'fn');
      registrar = fn?.[3] || ent.handle;
    }
  }
  const expiresAt = ev ? Date.parse(ev.eventDate) : NaN;
  if (!Number.isFinite(expiresAt)) return { status: 'no-expiry', registrar };
  return { status: 'ok', expiresAt, registrar };
}
