// HTTP(S) availability + homepage content check using the built-in fetch.
import { performance } from 'node:perf_hooks';

export const USER_AGENT = 'Mozilla/5.0 (compatible; sitesteward/0.1; website monitor)';
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Error categories are stable keys that the report translates into plain words.
 * @returns {string}
 */
export function classifyError(err) {
  const code = err?.cause?.code || err?.code || '';
  const name = err?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') return 'reset';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) return 'ssl';
  return 'other';
}

function errorDetail(err) {
  const code = err?.cause?.code || err?.code;
  const msg = err?.cause?.message || err?.message || String(err);
  return code ? `${code}: ${msg}` : msg;
}

/**
 * Check one URL.
 * @returns {Promise<{ok:boolean,status:number|null,responseMs:number,bytes:number,body:string,error:string|null,errorKind:string|null,finalUrl:string}>}
 */
export async function httpCheck(url, { timeoutMs = 15000, keyword = '', fetchImpl = fetch } = {}) {
  const started = performance.now();
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    let bytes = 0;
    const chunks = [];
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes <= MAX_BYTES) chunks.push(value);
        else { await reader.cancel(); break; }
      }
    }
    const responseMs = Math.round(performance.now() - started);
    const type = res.headers.get('content-type') || '';
    const body = /html|text|xml|json/i.test(type) || !type
      ? new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks))
      : '';
    const base = { status: res.status, responseMs, bytes, body, finalUrl: res.url || url };
    if (res.status >= 400) {
      return { ...base, ok: false, errorKind: res.status >= 500 ? 'http5xx' : 'http4xx', error: `HTTP ${res.status}` };
    }
    if (keyword && !body.toLowerCase().includes(keyword.toLowerCase())) {
      return { ...base, ok: false, errorKind: 'keyword', error: `Keyword not found: ${keyword}` };
    }
    return { ...base, ok: true, errorKind: null, error: null };
  } catch (err) {
    return {
      ok: false, status: null, responseMs: Math.round(performance.now() - started), bytes: 0, body: '',
      errorKind: classifyError(err), error: errorDetail(err), finalUrl: url,
    };
  }
}
