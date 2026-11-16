// Password hashing (scrypt), sessions and a small login rate limiter.
import crypto from 'node:crypto';
import { get, run } from './db.js';
import { getKv, setKv } from './settings.js';

const SESSION_TTL = 30 * 86400000;
const N = 16384; const R = 8; const P = 1; const KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

export const isConfigured = (db) => Boolean(getKv(db, 'auth')?.hash);
export const setPassword = (db, password) => setKv(db, 'auth', { hash: hashPassword(password), changedAt: Date.now() });
export const checkPassword = (db, password) => verifyPassword(password, getKv(db, 'auth')?.hash);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Only a hash of the session token is stored, so a leaked database does not leak live sessions. */
export function createSession(db, now = Date.now()) {
  const token = randomToken();
  const csrf = randomToken();
  run(db, 'INSERT INTO sessions(id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), csrf, now, now + SESSION_TTL);
  return { token, csrf };
}

export function getSession(db, token, now = Date.now()) {
  if (!token) return null;
  const s = get(db, 'SELECT * FROM sessions WHERE id = ? AND expires_at > ?', sha256(token), now);
  return s || null;
}

export function destroySession(db, token) {
  if (token) run(db, 'DELETE FROM sessions WHERE id = ?', sha256(token));
}

export const destroyAllSessions = (db) => run(db, 'DELETE FROM sessions');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

export function createRateLimiter({ max = 10, windowMs = 15 * 60000 } = {}) {
  const hits = new Map();
  return {
    blocked(key, now = Date.now()) {
      const e = hits.get(key);
      if (!e || now - e.start > windowMs) return false;
      return e.count >= max;
    },
    fail(key, now = Date.now()) {
      const e = hits.get(key);
      if (!e || now - e.start > windowMs) hits.set(key, { start: now, count: 1 });
      else e.count++;
      if (hits.size > 10000) hits.clear();
    },
    reset(key) { hits.delete(key); },
  };
}
