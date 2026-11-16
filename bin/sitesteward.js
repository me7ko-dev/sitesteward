#!/usr/bin/env node
// sitesteward – monitor client websites and send white-label monthly reports.

// node:sqlite prints an "experimental" warning on some Node versions; hide only that one.
const originalEmit = process.emit;
process.emit = function emit(name, data, ...rest) {
  if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(String(data.message))) return false;
  return originalEmit.call(this, name, data, ...rest);
};

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`sitesteward needs Node.js 22.13 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

import fs from 'node:fs';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
function opt(name, env, def) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return process.env[env] ?? def;
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(version);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`sitesteward – website monitoring with white-label monthly client reports

Usage: npx sitesteward [options]

Options:
  --port <n>       Port to listen on              (env PORT, default 3000)
  --host <addr>    Address to bind                 (env HOST, default 127.0.0.1)
  --data <dir>     Where the database is stored    (env DATA_DIR, default ./sitesteward-data)
  --dry-run        Never send e-mails or alerts; only log them (env DRY_RUN=1)
  --trust-proxy    Trust X-Forwarded-* headers from a reverse proxy (env TRUST_PROXY=1)
  --demo           Start with a fictional agency, clients and 75 days of sample data
                   (no real checks, nothing is sent; data in ./sitesteward-demo)
  -v, --version    Print the version
  -h, --help       Show this help

Docs: https://github.com/me7ko-dev/sitesteward#readme
`);
  process.exit(0);
}

const { createApp } = await import('../src/app.js');

const port = Number(opt('port', 'PORT', '3000'));
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid port: ${opt('port', 'PORT', '3000')}`);
  process.exit(1);
}
const host = opt('host', 'HOST', '127.0.0.1');
const demo = args.includes('--demo');
const dataDir = opt('data', 'DATA_DIR', demo ? './sitesteward-demo' : './sitesteward-data');
const dryRun = demo || args.includes('--dry-run') || process.env.DRY_RUN === '1';
const trustProxy = args.includes('--trust-proxy') || process.env.TRUST_PROXY === '1';

let app;
try {
  app = await createApp({ dataDir, dryRun, trustProxy });
} catch (err) {
  console.error(`Could not open the database in ${dataDir}: ${err.message}`);
  process.exit(1);
}
if (demo) {
  const { seedDemo } = await import('../src/demo.js');
  seedDemo(app.db);
}
try {
  await app.listen(port, host);
} catch (err) {
  console.error(err.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Is sitesteward already running? Use --port to pick another one.`
    : `Could not listen on ${host}:${port}: ${err.message}`);
  await app.close().catch(() => {});
  process.exit(1);
}
if (!demo) app.monitor.start();

// A stray rejected promise must never stop the monitoring of all sites.
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
console.log(`sitesteward ${version} is running → http://${shown}:${port}   (pid ${process.pid})`);
console.log(`Data directory: ${dataDir}${dryRun ? '   [DRY RUN: nothing is sent]' : ''}`);
if (demo) {
  const { DEMO_PASSWORD } = await import('../src/demo.js');
  console.log('DEMO MODE: fictional data, no real checks. Password: ' + DEMO_PASSWORD);
} else if (app.needsSetup()) {
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
