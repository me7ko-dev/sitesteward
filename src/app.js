// Wires everything together. Used by the CLI and by the tests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, get } from './db.js';
import { createMonitor } from './monitor.js';
import { createAlerter, realAdapters } from './alerts/index.js';
import { sendMail } from './smtp.js';
import { createHandler } from './web/server.js';
import { runMonthlySchedule, sendReport } from './report.js';
import { renderReportPage } from './web/report-view.js';
import { createPdfEngine } from './pdf.js';
import { isConfigured } from './auth.js';

export function makeSetupCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  return `${pick()}-${pick()}`;
}

/**
 * @param {object} o
 * @param {string} o.dataDir          where the SQLite database lives (':memory:' allowed via dbFile)
 * @param {boolean} [o.dryRun]        never send anything out; alerts/e-mails are only logged
 * @param {object} [o.adapters]       alert adapters (tests pass fakes)
 * @param {Function} [o.mailer]       e-mail sender (tests pass a fake)
 */
export async function createApp({
  dataDir = './client-uptime-data', dbFile, dryRun = false, adapters, mailer, monitorOptions = {},
  trustProxy = false, pdf, log = console, setupCode = makeSetupCode(),
} = {}) {
  let file = dbFile;
  if (!file) {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'client-uptime.db');
  }
  const db = openDb(file);
  const sink = [];
  const dryMailer = async (cfg, msg) => {
    sink.push({ channel: 'mail', msg });
    log.info?.(`[dry-run] e-mail to ${msg.to}: ${msg.subject}`);
  };
  const theMailer = mailer || (dryRun ? dryMailer : sendMail);
  const theAdapters = adapters || (dryRun
    ? Object.fromEntries(['telegram', 'email', 'ntfy', 'webhook'].map((ch) => [ch, {
      async send(cfg, msg) { sink.push({ channel: ch, msg }); log.info?.(`[dry-run] ${ch}: ${msg.title}`); },
    }]))
    : realAdapters({ mailer: theMailer }));
  const alerter = createAlerter({ db, adapters: theAdapters, log });
  const pdfEngine = pdf || await createPdfEngine({ log });

  const sendReportById = (id) => sendReport(db, id, {
    mailer: theMailer,
    pdf: pdfEngine,
    renderHtml: (report) => {
      const client = get(db, 'SELECT lang FROM clients WHERE id = ?', report.client_id);
      return renderReportPage({ data: JSON.parse(report.data_json), report, lang: client.lang });
    },
  });

  const monitor = createMonitor({
    db, alerter, log,
    onTick: (now) => runMonthlySchedule(db, { now, alerter, send: sendReportById, log }),
    ...monitorOptions,
  });
  const handler = createHandler({ db, monitor, alerter, mailer: theMailer, pdf: pdfEngine, setupCode, dryRun, trustProxy, log });
  const server = http.createServer(handler);
  server.headersTimeout = 30000;
  server.requestTimeout = 60000;

  return {
    db, monitor, alerter, server, setupCode, sink,
    needsSetup: () => !isConfigured(db),
    listen(port = 3000, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    async close() {
      monitor.stop();
      await new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      db.close();
    },
  };
}
