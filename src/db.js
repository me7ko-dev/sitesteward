// SQLite storage using Node's built-in `node:sqlite` module (no native add-ons, no external DB).
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = [
  // v1
  `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    csrf       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    logo          TEXT NOT NULL DEFAULT '',
    color         TEXT NOT NULL DEFAULT '#0ea5e9',
    email         TEXT NOT NULL DEFAULT '',
    lang          TEXT NOT NULL DEFAULT 'en',
    auto_send     INTEGER NOT NULL DEFAULT 1,
    status_public INTEGER NOT NULL DEFAULT 0,
    status_token  TEXT NOT NULL,
    notes         TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sites (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id         INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    url               TEXT NOT NULL,
    keyword           TEXT NOT NULL DEFAULT '',
    domain            TEXT NOT NULL DEFAULT '',
    ignore_words      TEXT NOT NULL DEFAULT '',
    interval_min      INTEGER NOT NULL DEFAULT 5,
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_at        INTEGER NOT NULL,
    state             TEXT NOT NULL DEFAULT 'unknown',
    last_check_at     INTEGER,
    last_status       INTEGER,
    last_response_ms  INTEGER,
    last_bytes        INTEGER,
    last_error        TEXT,
    title_baseline    TEXT,
    spam_hits         TEXT NOT NULL DEFAULT '',
    ssl_checked_at    INTEGER,
    ssl_expires_at    INTEGER,
    ssl_issuer        TEXT,
    ssl_error         TEXT,
    ssl_warned_days   INTEGER,
    domain_checked_at INTEGER,
    domain_name       TEXT,
    domain_status     TEXT,
    domain_expires_at INTEGER,
    domain_registrar  TEXT,
    domain_warned_days INTEGER
  );
  CREATE INDEX IF NOT EXISTS sites_client ON sites(client_id);
  CREATE TABLE IF NOT EXISTS checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    ts          INTEGER NOT NULL,
    ok          INTEGER NOT NULL,
    status      INTEGER,
    response_ms INTEGER,
    bytes       INTEGER,
    error       TEXT
  );
  CREATE INDEX IF NOT EXISTS checks_site_ts ON checks(site_id, ts);
  CREATE TABLE IF NOT EXISTS incidents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    reason     TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS incidents_site ON incidents(site_id, started_at);
  CREATE TABLE IF NOT EXISTS work_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    ts        INTEGER NOT NULL,
    text      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS work_log_client ON work_log(client_id, ts);
  CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    period     TEXT NOT NULL,
    token      TEXT NOT NULL UNIQUE,
    work_done  TEXT NOT NULL DEFAULT '',
    next_steps TEXT NOT NULL DEFAULT '',
    data_json  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sent_at    INTEGER,
    sent_to    TEXT,
    UNIQUE(client_id, period)
  );
  CREATE TABLE IF NOT EXISTS alert_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    channel TEXT NOT NULL,
    title   TEXT NOT NULL,
    ok      INTEGER NOT NULL,
    error   TEXT
  );
  `,
  // v2: the check interval at the time of each check, so changing a site's interval later does not
  // distort the "monitored time" of older months (see stats.js coverage()).
  `
  ALTER TABLE checks ADD COLUMN interval_min INTEGER;
  `,
];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < SCHEMA.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(SCHEMA[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Run fn inside a transaction. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Convert null-prototype rows into plain objects. */
export const plain = (row) => (row ? { ...row } : row);
export const all = (db, sql, ...args) => db.prepare(sql).all(...args).map(plain);
export const get = (db, sql, ...args) => plain(db.prepare(sql).get(...args));
export const run = (db, sql, ...args) => db.prepare(sql).run(...args);
