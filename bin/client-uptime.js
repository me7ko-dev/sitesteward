#!/usr/bin/env node
// client-uptime – monitor client websites and send white-label monthly reports.

// node:sqlite prints an "experimental" warning on some Node versions; hide only that one.
const originalEmit = process.emit;
process.emit = function emit(name, data, ...rest) {
  if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(String(data.message))) return false;
  return originalEmit.call(this, name, data, ...rest);
};

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`client-uptime needs Node.js 22.13 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

const args = process.argv.slice(2);
function opt(name, env, def) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return process.env[env] ?? def;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`client-uptime – website monitoring with white-label monthly client reports

Usage: npx client-uptime [options]

Options:
  --port <n>       Port to listen on              (env PORT, default 3000)
  --host <addr>    Address to bind                 (env HOST, default 127.0.0.1)
  --data <dir>     Where the database is stored    (env DATA_DIR, default ./client-uptime-data)
  --dry-run        Never send e-mails or alerts; only log them (env DRY_RUN=1)
  --trust-proxy    Trust X-Forwarded-* headers from a reverse proxy (env TRUST_PROXY=1)
  -h, --help       Show this help
`);
  process.exit(0);
}

const { createApp } = await import('../src/app.js');

const port = Number(opt('port', 'PORT', '3000'));
const host = opt('host', 'HOST', '127.0.0.1');
const dataDir = opt('data', 'DATA_DIR', './client-uptime-data');
const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === '1';
const trustProxy = args.includes('--trust-proxy') || process.env.TRUST_PROXY === '1';

const app = await createApp({ dataDir, dryRun, trustProxy });
await app.listen(port, host);
app.monitor.start();

const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
console.log(`client-uptime is running → http://${shown}:${port}   (pid ${process.pid})`);
console.log(`Data directory: ${dataDir}${dryRun ? '   [DRY RUN: nothing is sent]' : ''}`);
if (app.needsSetup()) {
  console.log('');
  console.log(`First run: open http://${shown}:${port}/setup and enter this setup code: ${app.setupCode}`);
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('Stopping…');
  try { await app.close(); } finally { process.exit(0); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
