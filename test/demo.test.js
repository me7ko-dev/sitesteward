import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, all, get } from '../src/db.js';
import { seedDemo } from '../src/demo.js';
import { renderReportPage } from '../src/web/report-view.js';
import { checkPassword } from '../src/auth.js';

test('demo data seeds once and produces a full report', () => {
  const db = openDb(':memory:');
  assert.equal(seedDemo(db), true);
  assert.equal(seedDemo(db), false, 'does not seed twice');
  assert.equal(all(db, 'SELECT * FROM clients').length, 3);
  assert.ok(checkPassword(db, 'demo-password'));
  const r = get(db, "SELECT r.* FROM reports r JOIN clients c ON c.id = r.client_id WHERE c.name = 'Seaside Hotel' ORDER BY period LIMIT 1");
  const html = renderReportPage({ data: JSON.parse(r.data_json), report: r, lang: 'en' });
  assert.match(html, /Seaside Hotel/);
  assert.match(html, /Updated WordPress core/);
  // only fictional, reserved .example domains in demo data
  for (const s of all(db, 'SELECT url FROM sites')) assert.match(s.url, /\.example\//);
});
