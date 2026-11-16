// Minimal SMTP client (implicit TLS on 465, STARTTLS on 587/25, AUTH PLAIN/LOGIN).
// Zero dependencies; enough for sending reports and alerts through any normal mail provider.
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

class Conn {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.buf = '';
    this.waiter = null;
    this.attach(socket);
  }

  attach(socket) {
    if (this.socket) this.socket.removeAllListeners('data').removeAllListeners('error');
    this.socket = socket;
    socket.on('data', (d) => { this.buf += d.toString('utf8'); this.pump(); });
    socket.on('error', (e) => { if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(e); } else this.lastError = e; });
  }

  pump() {
    if (!this.waiter) return;
    const lines = this.buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const text = lines.slice(0, i + 1).join('\n');
        this.buf = lines.slice(i + 1).join('\r\n');
        const w = this.waiter; this.waiter = null;
        clearTimeout(w.timer);
        w.resolve({ code: parseInt(lines[i].slice(0, 3), 10), text });
        return;
      }
    }
  }

  read() {
    if (this.lastError) return Promise.reject(this.lastError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('SMTP timeout')); }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
      this.pump();
    });
  }

  async cmd(line, expect) {
    this.socket.write(`${line}\r\n`);
    const res = await this.read();
    const ok = Array.isArray(expect) ? expect.includes(res.code) : res.code === expect;
    if (!ok) {
      const shown = line.startsWith('AUTH') ? 'AUTH ***' : line.split(' ')[0];
      throw new Error(`SMTP ${shown} failed: ${res.text}`);
    }
    return res;
  }
}

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    const opts = { host: cfg.host, port: Number(cfg.port) || (cfg.secure ? 465 : 587) };
    const sock = cfg.secure
      ? tls.connect({ ...opts, servername: net.isIP(cfg.host) ? undefined : cfg.host }, () => resolve(sock))
      : net.connect(opts, () => resolve(sock));
    sock.once('error', onErr);
    sock.setTimeout(cfg.timeoutMs || 20000, () => { sock.destroy(new Error('SMTP connect timeout')); });
  });
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function wrap76(s) { return s.replace(/.{1,76}/g, '$&\r\n').trimEnd(); }
function encodeHeader(s) { return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`; }
export function addressOf(s) { const m = /<([^>]+)>/.exec(s); return (m ? m[1] : s).trim(); }
function cleanHeader(s) { return String(s).replace(/[\r\n]+/g, ' '); }

function formatFrom(from) {
  const m = /^(.*)<([^>]+)>\s*$/.exec(from);
  if (!m) return from.trim();
  const name = m[1].trim().replace(/^"|"$/g, '');
  return name ? `${encodeHeader(name)} <${m[2].trim()}>` : `<${m[2].trim()}>`;
}

export function buildMessage({ from, to, subject, text, html, attachments = [] }) {
  const boundary = `=_cu_${crypto.randomBytes(12).toString('hex')}`;
  const alt = `=_cu_alt_${crypto.randomBytes(12).toString('hex')}`;
  const recipients = (Array.isArray(to) ? to : [to]).map(cleanHeader).join(', ');
  const domain = addressOf(from).split('@')[1] || 'localhost';
  const headers = [
    `From: ${formatFrom(cleanHeader(from))}`,
    `To: ${recipients}`,
    `Subject: ${encodeHeader(cleanHeader(subject))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(text || '')),
    ...(html ? [`--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(html))] : []),
    `--${alt}--`,
  ];
  let body;
  if (attachments.length) {
    body = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
      `--${boundary}`, ...altPart,
      ...attachments.flatMap((a) => [
        `--${boundary}`,
        `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${cleanHeader(a.filename)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${cleanHeader(a.filename)}"`, '',
        wrap76(Buffer.from(a.content).toString('base64')),
      ]),
      `--${boundary}--`,
    ];
  } else {
    body = altPart;
  }
  return `${headers.join('\r\n')}\r\n${body.join('\r\n')}\r\n`;
}

/**
 * @param {{host:string,port:number,secure:boolean,user?:string,pass?:string,from:string,timeoutMs?:number,allowInsecure?:boolean}} cfg
 */
export async function sendMail(cfg, msg) {
  if (!cfg.host || !cfg.from) throw new Error('SMTP is not configured (host and from are required)');
  const timeoutMs = cfg.timeoutMs || 20000;
  const socket = await connect(cfg);
  const c = new Conn(socket, timeoutMs);
  try {
    const greet = await c.read();
    if (greet.code !== 220) throw new Error(`SMTP greeting: ${greet.text}`);
    const helo = `EHLO ${os.hostname().replace(/[^a-zA-Z0-9.-]/g, '') || 'localhost'}`;
    let ehlo = await c.cmd(helo, 250);
    if (!cfg.secure && /STARTTLS/i.test(ehlo.text)) {
      await c.cmd('STARTTLS', 220);
      const secured = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: c.socket, servername: net.isIP(cfg.host) ? undefined : cfg.host }, () => resolve(s));
        s.once('error', reject);
      });
      c.attach(secured);
      ehlo = await c.cmd(helo, 250);
    } else if (!cfg.secure && cfg.user && !cfg.allowInsecure) {
      throw new Error('SMTP server does not offer STARTTLS; refusing to send the password unencrypted');
    }
    if (cfg.user) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) {
        await c.cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass || ''}`)}`, 235);
      } else {
        await c.cmd('AUTH LOGIN', 334);
        await c.cmd(b64(cfg.user), 334);
        await c.cmd(b64(cfg.pass || ''), 235);
      }
    }
    const rcpts = (Array.isArray(msg.to) ? msg.to : String(msg.to).split(',')).map((s) => s.trim()).filter(Boolean);
    if (!rcpts.length) throw new Error('No recipients');
    await c.cmd(`MAIL FROM:<${addressOf(cfg.from)}>`, 250);
    for (const r of rcpts) await c.cmd(`RCPT TO:<${addressOf(r)}>`, [250, 251]);
    await c.cmd('DATA', 354);
    const data = buildMessage({ ...msg, from: cfg.from, to: rcpts })
      .split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
    c.socket.write(data);
    await c.cmd('.', 250);
    try { await c.cmd('QUIT', 221); } catch { /* ignore */ }
  } finally {
    c.socket.destroy();
  }
}
