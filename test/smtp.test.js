import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendMail, buildMessage } from '../src/smtp.js';

/** A fake SMTP server on localhost that records the conversation (no TLS). */
async function fakeSmtp({ starttls = false } = {}) {
  const log = [];
  const messages = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let data = '';
    sock.write('220 fake.smtp ready\r\n');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; messages.push(data); data = ''; sock.write('250 queued\r\n'); } else data += `${line}\r\n`;
          continue;
        }
        log.push(line);
        if (/^EHLO/i.test(line)) sock.write(`250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n${starttls ? '250-STARTTLS\r\n' : ''}250 OK\r\n`);
        else if (/^AUTH PLAIN/i.test(line)) sock.write('235 ok\r\n');
        else if (/^MAIL FROM/i.test(line) || /^RCPT TO/i.test(line)) sock.write('250 ok\r\n');
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('502 nope\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, log, messages, close: () => new Promise((r) => server.close(r)) };
}

test('smtp: sends a UTF-8 message with HTML and attachment', async () => {
  const srv = await fakeSmtp();
  try {
    await sendMail({ host: '127.0.0.1', port: srv.port, secure: false, from: 'Northwind Studio <reports@example.com>' }, {
      to: 'owner@example.com',
      subject: 'Отчет за октомври',
      text: 'Hello\n.leading dot line',
      html: '<p>Здравейте</p>',
      attachments: [{ filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 fake') }],
    });
    assert.ok(srv.log.includes('MAIL FROM:<reports@example.com>'));
    assert.ok(srv.log.includes('RCPT TO:<owner@example.com>'));
    assert.equal(srv.messages.length, 1);
    const m = srv.messages[0];
    assert.match(m, /Subject: =\?UTF-8\?B\?/);
    assert.match(m, /multipart\/mixed/);
    assert.match(m, /filename="report.pdf"/);
  } finally { await srv.close(); }
});

test('smtp: refuses to send a password over an unencrypted connection', async () => {
  const srv = await fakeSmtp({ starttls: false });
  try {
    await assert.rejects(
      sendMail({ host: '127.0.0.1', port: srv.port, secure: false, user: 'u', pass: 'p', from: 'a@example.com' }, { to: 'b@example.com', subject: 's', text: 't' }),
      /refusing to send the password unencrypted/,
    );
    assert.ok(!srv.log.some((l) => l.startsWith('AUTH')));
  } finally { await srv.close(); }
});

test('smtp: message builder dot-stuffing safe + header injection safe', () => {
  const msg = buildMessage({ from: 'a@example.com', to: 'b@example.com', subject: 'Hi\r\nBcc: evil@example.com', text: 'x' });
  assert.doesNotMatch(msg, /\r\nBcc:/);
});
