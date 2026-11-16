// Static asset URLs with a content hash, so browsers never keep an old stylesheet after an update.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const hashes = new Map();

export function asset(name) {
  let h = hashes.get(name);
  if (!h) {
    try { h = crypto.createHash('sha256').update(fs.readFileSync(path.join(STATIC_DIR, name))).digest('hex').slice(0, 10); } catch { h = '0'; }
    hashes.set(name, h);
  }
  return `/static/${name}?v=${h}`;
}
