// Alert channels for the agency (not for clients): Telegram, e-mail, ntfy, generic webhook.
// Every adapter has the same shape: send(channelConfig, message, settings) → Promise<void>.
import { sendMail } from '../smtp.js';
import { getSettings } from '../settings.js';
import { run } from '../db.js';

async function postJson(fetchImpl, url, body, headers = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export function realAdapters({ fetchImpl = fetch, mailer = sendMail } = {}) {
  return {
    telegram: {
      async send(cfg, msg) {
        if (!cfg.botToken || !cfg.chatId) throw new Error('Telegram bot token and chat ID are required');
        await postJson(fetchImpl, `https://api.telegram.org/bot${encodeURIComponent(cfg.botToken)}/sendMessage`, {
          chat_id: cfg.chatId,
          text: `${msg.title}\n\n${msg.text}${msg.url ? `\n${msg.url}` : ''}`,
          disable_web_page_preview: true,
        });
      },
    },
    ntfy: {
      async send(cfg, msg) {
        if (!cfg.topic) throw new Error('ntfy topic is required');
        const server = (cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
        const headers = {
          'content-type': 'text/plain; charset=utf-8',
          // HTTP header values must be ASCII; non-ASCII titles go in the body instead.
          Title: /^[\x20-\x7e]*$/.test(msg.title) ? msg.title : 'sitesteward alert',
          Priority: msg.severity === 'critical' ? 'high' : 'default',
          Tags: msg.severity === 'critical' ? 'rotating_light' : (msg.severity === 'ok' ? 'white_check_mark' : 'warning'),
        };
        if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
        if (msg.url) headers.Click = msg.url;
        const body = /^[\x20-\x7e]*$/.test(msg.title) ? msg.text : `${msg.title}\n${msg.text}`;
        const res = await fetchImpl(`${server}/${encodeURIComponent(cfg.topic)}`, {
          method: 'POST', headers, body, signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
    },
    webhook: {
      async send(cfg, msg) {
        if (!cfg.url) throw new Error('Webhook URL is required');
        await postJson(fetchImpl, cfg.url, {
          event: msg.type, severity: msg.severity, title: msg.title, text: msg.text,
          url: msg.url || null, site: msg.site || null, client: msg.client || null, ts: new Date().toISOString(),
        });
      },
    },
    email: {
      async send(cfg, msg, settings) {
        if (!cfg.to) throw new Error('Alert e-mail address is required');
        await mailer(settings.smtp, {
          to: cfg.to,
          subject: msg.title,
          text: `${msg.text}${msg.url ? `\n\n${msg.url}` : ''}`,
        });
      },
    },
  };
}

/** Adapters that never leave the machine: used by tests and by DRY_RUN mode. */
export function fakeAdapters(sink = []) {
  const make = (name) => ({ async send(cfg, msg) { sink.push({ channel: name, cfg, msg }); } });
  return { telegram: make('telegram'), ntfy: make('ntfy'), webhook: make('webhook'), email: make('email'), sink };
}

export function createAlerter({ db, adapters, log = console }) {
  const CHANNELS = ['telegram', 'email', 'ntfy', 'webhook'];

  /**
   * @param {{type:string, severity:'critical'|'warning'|'ok'|'info', title:string, text:string, url?:string, site?:object, client?:object}} msg
   * @param {{only?: string}} opts
   */
  async function send(msg, opts = {}) {
    const settings = getSettings(db);
    const results = [];
    for (const ch of CHANNELS) {
      const cfg = settings.alerts[ch];
      if (opts.only ? opts.only !== ch : !cfg?.enabled) continue;
      const adapter = adapters[ch];
      try {
        await adapter.send(cfg, msg, settings);
        run(db, 'INSERT INTO alert_log(ts, channel, title, ok, error) VALUES (?, ?, ?, 1, NULL)', Date.now(), ch, msg.title);
        results.push({ channel: ch, ok: true });
      } catch (err) {
        const error = err?.message || String(err);
        run(db, 'INSERT INTO alert_log(ts, channel, title, ok, error) VALUES (?, ?, ?, 0, ?)', Date.now(), ch, msg.title, error);
        log.warn?.(`[alert] ${ch} failed: ${error}`);
        results.push({ channel: ch, ok: false, error });
      }
    }
    return results;
  }

  return { send };
}
