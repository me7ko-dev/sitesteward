// Simple "was this site hacked?" signals from the homepage HTML.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

// Out-of-range numeric entities (&#99999999;) must not throw: String.fromCodePoint would
// raise a RangeError and break the content analysis for that page.
const codePoint = (n) => String.fromCodePoint(Number.isInteger(n) && n > 0 && n <= 0x10ffff ? n : 0xfffd);

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (Object.hasOwn(ENTITIES, k)) return ENTITIES[k];
    if (k.startsWith('#x')) return codePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return codePoint(parseInt(k.slice(1), 10));
    return m;
  });
}

export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  if (!m) return '';
  return decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function parseWordList(text) {
  return String(text || '')
    .split(/[\n,]/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Find spam words in the raw HTML (hidden injected links count too).
 * Whole-word, case-insensitive. Words in `ignore` are skipped.
 */
export function findSpamWords(html, words, ignore = []) {
  const text = decodeEntities(String(html || '')).toLowerCase();
  const skip = new Set(ignore.map((w) => w.toLowerCase()));
  const hits = [];
  for (const w of words) {
    const word = w.toLowerCase().trim();
    if (!word || skip.has(word)) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(word).replace(/\s+/g, '\\s+')}(?=$|[^\\p{L}\\p{N}])`, 'u');
    if (re.test(text)) hits.push(word);
  }
  return hits;
}
