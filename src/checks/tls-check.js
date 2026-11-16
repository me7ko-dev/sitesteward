// Reads the TLS certificate of a host (expiry date, issuer, validity).
import tls from 'node:tls';
import net from 'node:net';

/**
 * @returns {Promise<{expiresAt:number|null, issuer:string|null, valid:boolean, error:string|null}>}
 */
export function tlsCheck(host, port = 443, { timeoutMs = 10000, ca } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    // Verification is NOT skipped silently: we only read the certificate (no data is sent)
    // and report `sock.authorized` / `authorizationError` so broken or expired certs are flagged.
    const opts = { host, port, rejectUnauthorized: false, timeout: timeoutMs };
    if (!net.isIP(host)) opts.servername = host;
    if (ca) opts.ca = ca;
    const sock = tls.connect(opts, () => {
      const cert = sock.getPeerCertificate();
      const expiresAt = cert && cert.valid_to ? Date.parse(cert.valid_to) : null;
      const issuer = cert?.issuer ? (cert.issuer.O || cert.issuer.CN || null) : null;
      const authErr = sock.authorized ? null : String(sock.authorizationError || 'UNTRUSTED');
      finish({ expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, issuer, valid: sock.authorized, error: authErr });
      sock.end();
    });
    sock.on('timeout', () => { finish({ expiresAt: null, issuer: null, valid: false, error: 'TIMEOUT' }); sock.destroy(); });
    sock.on('error', (e) => finish({ expiresAt: null, issuer: null, valid: false, error: e.code || e.message }));
  });
}
