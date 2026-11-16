// `client-uptime --demo`: a fictional agency with fictional clients and 75 days of synthetic history,
// so you can click around and see a full monthly report without waiting a month.
// Demo mode never runs real checks and never sends anything.
import { all, run, tx } from './db.js';
import { getSettings, saveSettings } from './settings.js';
import { setPassword } from './auth.js';
import { randomToken } from './auth.js';
import { generateReport } from './report.js';
import { previousPeriod, periodOf } from './time.js';

export const DEMO_PASSWORD = 'demo-password';
const MIN = 60000;
const DAY = 86400000;

const svg = (body) => `data:image/svg+xml;base64,${Buffer.from(body).toString('base64')}`;
const AGENCY_LOGO = svg('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="56" viewBox="0 0 220 56"><rect x="2" y="8" width="40" height="40" rx="11" fill="#4f46e5"/><path d="M12 32l7-10 7 7 7-11" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><text x="52" y="36" font-family="Arial,Helvetica,sans-serif" font-size="21" font-weight="700" fill="#1e1b4b">Northwind</text><text x="160" y="36" font-family="Arial,Helvetica,sans-serif" font-size="21" fill="#6366f1">web</text></svg>');
const HOTEL_LOGO = svg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="56" viewBox="0 0 200 56"><circle cx="24" cy="28" r="18" fill="#0ea5e9"/><path d="M8 33c6-5 10-5 16 0s10 5 16 0" fill="none" stroke="#fff" stroke-width="3"/><circle cx="24" cy="21" r="5" fill="#fde68a"/><text x="50" y="35" font-family="Georgia,serif" font-size="20" font-weight="700" fill="#0c4a6e">Seaside Hotel</text></svg>');
const LODGE_LOGO = svg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="56" viewBox="0 0 200 56"><path d="M24 8l16 30H8z" fill="#15803d"/><rect x="21" y="38" width="6" height="8" fill="#78350f"/><text x="48" y="35" font-family="Georgia,serif" font-size="20" font-weight="700" fill="#14532d">Pine Lodge</text></svg>');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export function seedDemo(db, now = Date.now()) {
  if (all(db, 'SELECT id FROM clients LIMIT 1').length) return false;
  const s = getSettings(db);
  s.agency = { name: 'Northwind Web Studio', logo: AGENCY_LOGO, color: '#4f46e5', email: 'hello@northwind.example', website: 'www.northwind.example' };
  s.publicUrl = '';
  saveSettings(db, s);
  setPassword(db, DEMO_PASSWORD);

  const clients = [
    { name: 'Seaside Hotel', email: 'manager@seaside-hotel.example', lang: 'en', color: '#0ea5e9', logo: HOTEL_LOGO, sites: [
      { name: 'Main website', url: 'https://www.seaside-hotel.example/', ms: 380, bytes: 61234, outages: [[9, 14 * 60 + 5, 23, 'timeout'], [27, 3 * 60 + 40, 7, 'http5xx']], ssl: 64, dom: 212 },
      { name: 'Booking engine', url: 'https://book.seaside-hotel.example/', ms: 690, bytes: 88410, outages: [], ssl: 64, dom: 212 },
    ] },
    { name: 'Pine Lodge Guesthouse', email: 'stay@pine-lodge.example', lang: 'bg', color: '#15803d', logo: LODGE_LOGO, sites: [
      { name: 'Pine Lodge', url: 'https://www.pine-lodge.example/', ms: 1250, bytes: 214500, outages: [[15, 22 * 60 + 10, 95, 'dns']], ssl: 12, dom: 24 },
    ] },
    { name: 'Lumière Bakery', email: '', lang: 'en', color: '#b45309', logo: '', sites: [
      { name: 'Website', url: 'https://lumiere-bakery.example/', ms: 240, bytes: 31877, outages: [], ssl: 80, dom: 340, down: true },
    ] },
  ];
  const work = {
    'Seaside Hotel': ['Updated WordPress core and 14 plugins', 'Added the new winter room prices', 'Compressed homepage images (-38% page weight)', 'Tested the booking form on iPhone and Android'],
    'Pine Lodge Guesthouse': ['Обновихме галерията със снимки на стаите', 'Поправихме формата за контакт', 'Направихме резервно копие на сайта'],
  };

  const rand = rng(42);
  const start = now - 75 * DAY;
  tx(db, () => {
    for (const c of clients) {
      const cid = Number(run(db, 'INSERT INTO clients(name, email, lang, color, logo, auto_send, status_public, status_token, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)',
        c.name, c.email, c.lang, c.color, c.logo, randomToken(18), start).lastInsertRowid);
      for (const st of c.sites) {
        const host = new URL(st.url).hostname.split('.').slice(-2).join('.');
        const sid = Number(run(db, `INSERT INTO sites(client_id, name, url, interval_min, created_at, state, last_check_at, last_status, last_response_ms, last_bytes,
          title_baseline, ssl_checked_at, ssl_expires_at, ssl_issuer, domain_checked_at, domain_name, domain_status, domain_expires_at, domain_registrar)
          VALUES (?, ?, ?, 5, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Let''s Encrypt', ?, ?, 'ok', ?, 'Example Registrar')`,
        cid, st.name, st.url, start, st.down ? 'down' : 'up', now, st.down ? 503 : 200, st.ms, st.bytes, st.name,
        now, now + st.ssl * DAY + 3 * 3600000, now, host, now + st.dom * DAY + 5 * 3600000).lastInsertRowid);
        if (st.down) run(db, 'UPDATE sites SET last_error = ? WHERE id = ?', 'HTTP 503', sid);
        const outages = st.outages.map(([daysAgo, minuteOfDay, mins, reason]) => {
          const begin = Math.floor((now - daysAgo * DAY) / DAY) * DAY + minuteOfDay * MIN;
          return [begin, begin + mins * MIN, reason];
        });
        if (st.down) outages.push([now - 17 * MIN, null, 'http5xx']);
        for (const [a, b, reason] of outages) {
          run(db, "INSERT INTO incidents(site_id, kind, started_at, ended_at, reason, detail) VALUES (?, 'down', ?, ?, ?, '')", sid, a, b, reason);
        }
        const ins = db.prepare('INSERT INTO checks(site_id, ts, ok, status, response_ms, bytes, error) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (let ts = start; ts <= now; ts += 5 * MIN) {
          const down = outages.some(([a, b]) => ts >= a && ts < (b ?? Infinity));
          const ms = Math.round(st.ms * (0.7 + rand() * 0.6) + (rand() < 0.02 ? st.ms * 2 : 0));
          ins.run(sid, ts, down ? 0 : 1, down ? 503 : 200, down ? null : ms, down ? 0 : st.bytes, down ? 'HTTP 503' : null);
        }
      }
      for (const [i, text] of (work[c.name] || []).entries()) {
        const prev = previousPeriod(now, s.timezone);
        const day = 4 + i * 6;
        const ts = Date.parse(`${prev}-${String(day).padStart(2, '0')}T10:00:00Z`);
        run(db, 'INSERT INTO work_log(client_id, ts, text) VALUES (?, ?, ?)', cid, ts, text);
      }
    }
  });
  const prev = previousPeriod(now, s.timezone);
  for (const c of all(db, 'SELECT id, name FROM clients')) {
    const r = generateReport(db, c.id, prev, now);
    const next = c.name === 'Seaside Hotel'
      ? 'Move the booking engine to faster hosting\nAdd a cookie consent banner'
      : c.name === 'Pine Lodge Guesthouse' ? 'Подновяване на домейна (изтича до месец)\nПо-бърз хостинг – сайтът е бавен' : '';
    run(db, 'UPDATE reports SET next_steps = ? WHERE id = ?', next, r.id);
  }
  generateReport(db, all(db, 'SELECT id FROM clients ORDER BY id LIMIT 1')[0].id, periodOf(now, s.timezone), now);
  return true;
}
