// Auto-escaping HTML templates: every ${value} is escaped unless wrapped in raw().

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

export const raw = (s) => new Raw(String(s ?? ''));

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += render(vals[i]);
  });
  return new Raw(out);
}

/** Only allow #rgb / #rrggbb colours into CSS. */
export function safeColor(c, fallback = '#4f46e5') {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || '').trim()) ? String(c).trim() : fallback;
}

/** Only allow image data URLs or https URLs as logos. */
export function safeImage(src) {
  const s = String(src || '').trim();
  if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(s)) return s;
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  return '';
}

/** Mix a hex colour with white (amount 0..1) – used for soft brand backgrounds. */
export function tint(hex, amount) {
  let h = safeColor(hex).slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255); const g = mix((n >> 8) & 255); const b = mix(n & 255);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/** Readable text colour (#fff or near-black) on top of a background colour. */
export function onColor(hex) {
  let h = safeColor(hex).slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.6 ? '#111827' : '#ffffff';
}
