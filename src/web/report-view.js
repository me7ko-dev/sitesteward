// The client-facing pages: monthly report, report e-mail and public status page.
import { html, raw, safeColor, safeImage, tint, onColor } from './html.js';
import {
  t, formatMonth, formatPct, formatMs, formatDate, formatTime, formatDuration, formatBytes, localeOf, formatNumber,
} from '../i18n.js';

const FONT = "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export function uptimeGrade(pct) {
  if (pct == null) return 'none';
  if (pct >= 99.9) return 'excellent';
  if (pct >= 99) return 'good';
  return 'poor';
}

export function speedGrade(ms) {
  if (ms == null) return 'none';
  if (ms < 800) return 'fast';
  if (ms < 2000) return 'ok';
  return 'slow';
}

function barClass(pct) {
  if (pct == null) return 'nodata';
  if (pct >= 99.95) return 'up';
  if (pct >= 99) return 'warn';
  return 'down';
}

function lines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
}

export function incidentSentence(lang, inc, tz) {
  const date = formatDate(lang, inc.start, tz, { day: 'numeric', month: 'long' });
  const time = formatTime(lang, inc.start, tz);
  if (inc.kind === 'down') {
    const reason = t(lang, `reasons.${inc.reason}`) !== `reasons.${inc.reason}` ? t(lang, `reasons.${inc.reason}`) : t(lang, 'reasons.other');
    return t(lang, inc.end ? 'report.incident.down' : 'report.incident.downOngoing', {
      date, time, duration: formatDuration(lang, inc.durationMs), reason,
    });
  }
  if (inc.kind === 'content') return t(lang, 'report.incident.content', { date, words: inc.detail });
  if (inc.kind === 'ssl') return t(lang, 'report.incident.ssl', { date });
  return '';
}

function sslLine(lang, ssl, tz) {
  if (ssl.none) return { cls: 'warn', text: t(lang, 'report.ssl.none') };
  if (!ssl.checked) return { cls: 'muted', text: t(lang, 'report.notChecked') };
  if (ssl.error) return { cls: 'bad', text: t(lang, 'report.ssl.problem') };
  const cls = ssl.daysLeft < 7 ? 'bad' : ssl.daysLeft < 21 ? 'warn' : 'good';
  return {
    cls,
    text: t(lang, 'report.ssl.valid', { date: formatDate(lang, ssl.expiresAt, tz), days: ssl.daysLeft, count: ssl.daysLeft }),
    note: ssl.daysLeft < 21 ? t(lang, 'report.ssl.autoRenew') : '',
  };
}

function domainLine(lang, d, tz) {
  switch (d.status) {
    case 'ok': {
      const cls = d.daysLeft < 14 ? 'bad' : d.daysLeft < 30 ? 'warn' : 'good';
      return { cls, text: t(lang, 'report.domain.valid', { domain: d.name, date: formatDate(lang, d.expiresAt, tz), days: d.daysLeft, count: d.daysLeft }) };
    }
    case 'no-rdap': return { cls: 'muted', text: t(lang, 'report.domain.noRdap', { domain: d.name }) };
    case 'no-expiry': return { cls: 'muted', text: t(lang, 'report.domain.noExpiry', { domain: d.name }) };
    case 'not-found': return { cls: 'warn', text: t(lang, 'report.domain.notFound', { domain: d.name }) };
    case 'error': return { cls: 'muted', text: t(lang, 'report.domain.error', { domain: d.name }) };
    default: return { cls: 'muted', text: t(lang, 'report.notChecked') };
  }
}

function summarySentence(lang, data) {
  const s = data.summary;
  const month = formatMonth(lang, data.period);
  if (s.uptime == null) return t(lang, 'report.summary.noData');
  const parts = [t(lang, `report.summary.uptime.${uptimeGrade(s.uptime)}`, { month, pct: formatPct(lang, s.uptime) })];
  parts.push(s.incidents
    ? t(lang, 'report.summary.incidents', { count: s.incidents, duration: formatDuration(lang, s.downMs) })
    : t(lang, 'report.summary.noIncidents'));
  if (s.avgMs != null) parts.push(t(lang, `report.summary.speed.${speedGrade(s.avgMs)}`, { ms: formatMs(lang, s.avgMs) }));
  parts.push(t(lang, s.secure ? 'report.summary.secure' : 'report.summary.insecure'));
  return parts.join(' ');
}

const REPORT_CSS = `
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#f3f4f6;color:#111827;font:15px/1.55 ${FONT};-webkit-font-smoothing:antialiased}
.page{max-width:880px;margin:0 auto;background:#fff;min-height:100vh;box-shadow:0 1px 30px rgba(17,24,39,.06)}
.toolbar{max-width:880px;margin:0 auto;display:flex;justify-content:flex-end;gap:8px;padding:12px 16px}
.toolbar a,.toolbar button{font:600 13px ${FONT};border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:999px;padding:7px 14px;cursor:pointer;text-decoration:none}
.cover{position:relative;padding:40px 48px 36px;background:linear-gradient(135deg,var(--brand) 0%,var(--brand-2) 100%);color:var(--on-brand);overflow:hidden}
.cover:after{content:"";position:absolute;right:-80px;top:-80px;width:280px;height:280px;border-radius:50%;background:rgba(255,255,255,.08)}
.brandrow{display:flex;justify-content:space-between;align-items:center;gap:16px;position:relative;z-index:1}
.logo{height:44px;max-width:180px;object-fit:contain;background:#fff;border-radius:10px;padding:6px 10px}
.wordmark{font-weight:700;font-size:18px;letter-spacing:-.01em}
.clientmark{display:flex;align-items:center;gap:10px;font-weight:600}
.eyebrow{margin:34px 0 4px;text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:700;opacity:.85;position:relative;z-index:1}
h1{margin:0;font-size:40px;line-height:1.1;letter-spacing:-.02em;position:relative;z-index:1}
.prepared{margin:10px 0 0;opacity:.92;position:relative;z-index:1}
.partial{display:inline-block;margin-top:12px;background:rgba(255,255,255,.18);border-radius:999px;padding:3px 12px;font-size:12px;font-weight:600}
.body{padding:32px 48px 40px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:-58px;position:relative;z-index:2}
.kpi{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px 16px 14px;box-shadow:0 6px 20px rgba(17,24,39,.06)}
.kpi .label{font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.kpi .value{font-size:26px;font-weight:750;letter-spacing:-.02em;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi .hint{font-size:12.5px;margin-top:2px;font-weight:600}
.good{color:#047857}.warn{color:#b45309}.bad{color:#b91c1c}.muted{color:#6b7280}
.lead{font-size:16.5px;line-height:1.6;margin:28px 0 8px;color:#1f2937}
h2{font-size:20px;letter-spacing:-.01em;margin:36px 0 4px}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin:22px 0 8px}
.site{border:1px solid #e5e7eb;border-radius:16px;padding:22px 24px;margin-top:18px;break-inside:avoid}
.site-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.site-head h2{margin:0}
.site-url{color:#6b7280;font-size:13.5px;word-break:break-all}
.pill{display:inline-block;border-radius:999px;padding:3px 11px;font-size:12.5px;font-weight:700;background:var(--soft);color:var(--brand-ink)}
.bars{display:flex;gap:3px;align-items:flex-end;height:38px;margin-top:16px}
.bars span{flex:1;height:100%;border-radius:3px;background:#22c55e}
.bars span.warn{background:#f59e0b}.bars span.down{background:#ef4444}.bars span.nodata{background:#e5e7eb}
.bars-legend{display:flex;justify-content:space-between;font-size:11.5px;color:#9ca3af;margin-top:4px}
.facts{display:grid;grid-template-columns:repeat(2,1fr);gap:10px 28px;margin-top:18px}
.fact{display:flex;gap:10px;align-items:flex-start;font-size:14.5px}
.dot{flex:none;width:9px;height:9px;border-radius:50%;margin-top:7px;background:#9ca3af}
.dot.good{background:#10b981}.dot.warn{background:#f59e0b}.dot.bad{background:#ef4444}
.fact b{display:block;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;font-weight:650}
.note{font-size:12.5px;color:#6b7280}
ul.list{margin:6px 0 0;padding:0;list-style:none}
ul.list li{position:relative;padding:7px 0 7px 26px;border-bottom:1px dashed #eef0f3}
ul.list li:last-child{border-bottom:0}
ul.list li:before{content:"";position:absolute;left:4px;top:15px;width:8px;height:8px;border-radius:2px;background:var(--brand)}
ul.incidents li:before{background:#ef4444;border-radius:50%}
.panel{background:var(--soft);border-radius:16px;padding:20px 24px;margin-top:28px;break-inside:avoid}
.panel h2{margin-top:0;color:var(--brand-ink)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.empty{color:#6b7280;font-style:italic}
footer{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-top:1px solid #e5e7eb;margin-top:36px;padding-top:18px;font-size:13px;color:#6b7280}
footer a{color:inherit}
@media (max-width:720px){.cover{padding:28px 22px}.body{padding:24px 18px 32px}.kpis{grid-template-columns:repeat(2,1fr)}.facts,.two{grid-template-columns:1fr}h1{font-size:30px}}
@page{size:A4;margin:10mm}
@media print{body{background:#fff;font-size:13px}.toolbar{display:none}.page{box-shadow:none;max-width:none}.cover{padding:28px 32px}.body{padding:24px 32px}.kpi{box-shadow:none}h2{break-after:avoid}}
`;

export function renderReportPage({ data, report, lang, pdfAvailable = false }) {
  const tz = data.tz;
  const brand = safeColor(data.agency.color, '#4f46e5');
  const brand2 = safeColor(data.client.color, brand);
  const agencyLogo = safeImage(data.agency.logo);
  const clientLogo = safeImage(data.client.logo);
  const month = formatMonth(lang, data.period);
  const s = data.summary;
  const work = lines(report.work_done);
  const next = lines(report.next_steps);
  const downText = s.incidents ? t(lang, 'report.kpi.downtime', { duration: formatDuration(lang, s.downMs) }) : t(lang, 'report.kpi.noDowntime');
  const style = `:root{--brand:${brand};--brand-2:${brand2};--on-brand:${onColor(brand)};--soft:${tint(brand, 0.92)};--brand-ink:${brand}}`;

  const siteBlock = (site) => {
    const ssl = sslLine(lang, site.ssl, tz);
    const dom = domainLine(lang, site.domain, tz);
    const daysCount = site.daily.length;
    const down = site.incidents;
    return html`
    <section class="site">
      <div class="site-head">
        <div><h2>${site.name}</h2><div class="site-url">${site.url}</div></div>
        <span class="pill">${t(lang, 'report.kpi.uptime')}: ${formatPct(lang, site.uptime)}</span>
      </div>
      <div class="bars" role="img" aria-label="${t(lang, 'report.dailyUptime')}">
        ${site.daily.map((p, i) => html`<span class="${barClass(p)}" title="${i + 1}: ${p == null ? t(lang, 'report.noData') : formatPct(lang, p)}"></span>`)}
      </div>
      <div class="bars-legend"><span>1</span><span>${t(lang, 'report.dailyUptime')}</span><span>${daysCount}</span></div>
      <div class="facts">
        <div class="fact"><span class="dot ${uptimeGrade(site.uptime) === 'poor' ? 'bad' : uptimeGrade(site.uptime) === 'none' ? '' : 'good'}"></span><div><b>${t(lang, 'report.kpi.uptime')}</b>${formatPct(lang, site.uptime)}${site.downMs ? html` <span class="note">(${t(lang, 'report.kpi.downtime', { duration: formatDuration(lang, site.downMs) })})</span>` : ''}</div></div>
        <div class="fact"><span class="dot ${speedGrade(site.avgMs) === 'slow' ? 'warn' : speedGrade(site.avgMs) === 'none' ? '' : 'good'}"></span><div><b>${t(lang, 'report.avgResponse')}</b>${formatMs(lang, site.avgMs)} ${site.avgMs != null ? html`<span class="note">· ${t(lang, `report.speed.${speedGrade(site.avgMs)}`)}</span>` : ''}</div></div>
        <div class="fact"><span class="dot ${ssl.cls}"></span><div><b>${t(lang, 'report.sslTitle')}</b>${ssl.text}${ssl.note ? html`<div class="note">${ssl.note}</div>` : ''}</div></div>
        <div class="fact"><span class="dot ${dom.cls}"></span><div><b>${t(lang, 'report.domainTitle')}</b>${dom.text}</div></div>
        <div class="fact"><span class="dot ${site.security.clean ? 'good' : 'bad'}"></span><div><b>${t(lang, 'report.securityTitle')}</b>${!site.security.checked ? t(lang, 'report.notChecked') : site.security.clean ? t(lang, 'report.security.clean') : t(lang, 'report.security.found', { words: site.security.words })}</div></div>
        <div class="fact"><span class="dot"></span><div><b>${t(lang, 'report.pageSize')}</b>${site.pageBytes != null ? formatBytes(lang, site.pageBytes) : '—'} <span class="note">· ${t(lang, 'report.checksDone', { count: site.checks, n: formatNumber(lang, site.checks) })}</span></div></div>
      </div>
      <h3>${t(lang, 'report.incidentsTitle')}</h3>
      ${down.length
        ? html`<ul class="list incidents">${down.map((i) => html`<li>${incidentSentence(lang, i, tz)}</li>`)}</ul>`
        : html`<p class="empty">${t(lang, 'report.noIncidents')}</p>`}
    </section>`;
  };

  return html`<!doctype html>
<html lang="${localeOf(lang).split('-')[0]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${t(lang, 'report.docTitle', { client: data.client.name, month })}</title>
<style>${raw(REPORT_CSS)}${raw(style)}</style>
</head>
<body>
<div class="toolbar">
  ${pdfAvailable ? html`<a href="/r/${report.token}/pdf">${t(lang, 'report.downloadPdf')}</a>` : ''}
  <button type="button" data-print>${t(lang, pdfAvailable ? 'report.print' : 'report.savePdf')}</button>
</div>
<main class="page">
  <header class="cover">
    <div class="brandrow">
      ${agencyLogo ? html`<img class="logo" src="${agencyLogo}" alt="${data.agency.name}">` : html`<span class="wordmark">${data.agency.name}</span>`}
      <span class="clientmark">${clientLogo ? html`<img class="logo" src="${clientLogo}" alt="${data.client.name}">` : data.client.name}</span>
    </div>
    <p class="eyebrow">${t(lang, 'report.eyebrow')}</p>
    <h1>${month}</h1>
    <p class="prepared">${raw(t(lang, 'report.prepared', { client: html`<b>${data.client.name}</b>`.s, agency: html`<b>${data.agency.name}</b>`.s }))}</p>
    ${data.partial ? html`<span class="partial">${t(lang, 'report.partial', { date: formatDate(lang, data.generatedAt, tz) })}</span>` : ''}
  </header>
  <div class="body">
    <div class="kpis">
      <div class="kpi"><div class="label">${t(lang, 'report.kpi.uptime')}</div><div class="value">${formatPct(lang, s.uptime)}</div><div class="hint ${uptimeGrade(s.uptime) === 'poor' ? 'bad' : 'good'}">${t(lang, `report.grade.${uptimeGrade(s.uptime)}`)}</div></div>
      <div class="kpi"><div class="label">${t(lang, 'report.kpi.speed')}</div><div class="value">${formatMs(lang, s.avgMs)}</div><div class="hint ${speedGrade(s.avgMs) === 'slow' ? 'warn' : 'good'}">${t(lang, `report.speed.${speedGrade(s.avgMs)}`)}</div></div>
      <div class="kpi"><div class="label">${t(lang, 'report.kpi.incidents')}</div><div class="value">${s.incidents}</div><div class="hint ${s.incidents ? 'warn' : 'good'}">${downText}</div></div>
      <div class="kpi"><div class="label">${t(lang, 'report.kpi.security')}</div><div class="value ${s.secure ? 'good' : 'bad'}">${s.secure ? '✓' : '!'}</div><div class="hint ${s.secure ? 'good' : 'bad'}">${t(lang, s.secure ? 'report.security.cleanShort' : 'report.security.foundShort')}</div></div>
    </div>
    <p class="lead">${summarySentence(lang, data)}</p>

    ${data.sites.map(siteBlock)}

    <div class="two">
      <section class="panel">
        <h2>${t(lang, 'report.workTitle')}</h2>
        ${work.length ? html`<ul class="list">${work.map((w) => html`<li>${w}</li>`)}</ul>` : html`<p class="empty">${t(lang, 'report.workEmpty')}</p>`}
      </section>
      <section class="panel">
        <h2>${t(lang, 'report.nextTitle')}</h2>
        ${next.length ? html`<ul class="list">${next.map((w) => html`<li>${w}</li>`)}</ul>` : html`<p class="empty">${t(lang, 'report.nextEmpty')}</p>`}
      </section>
    </div>

    <footer>
      <span>${t(lang, 'report.footer', { agency: data.agency.name })}${data.agency.email ? html` · <a href="mailto:${data.agency.email}">${data.agency.email}</a>` : ''}${data.agency.website ? html` · <a href="${/^https?:\/\//.test(data.agency.website) ? data.agency.website : `https://${data.agency.website}`}">${data.agency.website.replace(/^https?:\/\//, '')}</a>` : ''}</span>
      <span>${t(lang, 'report.generated', { date: formatDate(lang, data.generatedAt, tz) })}</span>
    </footer>
  </div>
</main>
<script src="/static/report.js"></script>
</body>
</html>`.s;
}

/** E-mail body: table layout + inline styles so it renders in common mail clients. */
export function renderReportEmail({ data, report, link, lang }) {
  const brand = safeColor(data.agency.color, '#4f46e5');
  const on = onColor(brand);
  const s = data.summary;
  const month = formatMonth(lang, data.period);
  const cell = (label, value) => html`<td style="padding:14px 10px;text-align:center;border:1px solid #e5e7eb;border-radius:10px;">
    <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">${label}</div>
    <div style="font-size:22px;font-weight:700;color:#111827;margin-top:4px;">${value}</div></td>`;
  return html`<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;">
<tr><td style="background:${brand};color:${on};padding:28px 32px;">
  <div style="font-size:14px;font-weight:bold;opacity:.9;">${data.agency.name}</div>
  <div style="font-size:26px;font-weight:bold;margin-top:14px;">${t(lang, 'report.eyebrow')}</div>
  <div style="font-size:16px;margin-top:4px;">${month} · ${data.client.name}</div>
</td></tr>
<tr><td style="padding:24px 32px 8px;font-size:15px;line-height:1.6;">
  <p style="margin:0 0 12px;">${t(lang, 'email.hello', { client: data.client.name })}</p>
  <p style="margin:0 0 12px;">${summarySentence(lang, data)}</p>
</td></tr>
<tr><td style="padding:0 22px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="8"><tr>
    ${cell(t(lang, 'report.kpi.uptime'), formatPct(lang, s.uptime))}
    ${cell(t(lang, 'report.kpi.speed'), formatMs(lang, s.avgMs))}
    ${cell(t(lang, 'report.kpi.incidents'), String(s.incidents))}
  </tr></table>
</td></tr>
<tr><td align="center" style="padding:20px 32px 28px;">
  <a href="${link}" style="display:inline-block;background:${brand};color:${on};text-decoration:none;font-weight:bold;padding:12px 26px;border-radius:999px;">${t(lang, 'email.open')}</a>
</td></tr>
<tr><td style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
  ${t(lang, 'report.footer', { agency: data.agency.name })}${data.agency.email ? ` · ${data.agency.email}` : ''}
</td></tr>
</table></td></tr></table></body></html>`.s;
}

/** Public status page for one client (optional, enabled per client). */
export function renderStatusPage({ client, agency, sites, lang, tz }) {
  const brand = safeColor(client.color, safeColor(agency.color));
  const logo = safeImage(client.logo);
  const allUp = sites.every((s) => s.state !== 'down');
  return html`<!doctype html>
<html lang="${localeOf(lang).split('-')[0]}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60"><meta name="robots" content="noindex">
<title>${t(lang, 'status.title', { client: client.name })}</title>
<style>${raw(`*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#111827;font:15px/1.5 ${FONT}}
.wrap{max-width:760px;margin:0 auto;padding:32px 16px}
.head{display:flex;align-items:center;gap:14px;margin-bottom:22px}.head img{height:42px;max-width:160px;object-fit:contain}
.head h1{font-size:22px;margin:0}
.banner{border-radius:14px;padding:18px 20px;font-weight:700;font-size:17px;color:#fff;background:${allUp ? '#10b981' : '#ef4444'}}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px 20px;margin-top:14px}
.row{display:flex;justify-content:space-between;gap:10px;align-items:center}
.state{font-weight:700;font-size:13px;border-radius:999px;padding:3px 10px}.state.up{background:#d1fae5;color:#065f46}.state.down{background:#fee2e2;color:#991b1b}.state.unknown{background:#f3f4f6;color:#4b5563}
.bars{display:flex;gap:2px;height:30px;margin-top:12px}.bars span{flex:1;border-radius:2px;background:#22c55e}.bars span.warn{background:#f59e0b}.bars span.down{background:#ef4444}.bars span.nodata{background:#e5e7eb}
.meta{display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin-top:6px}
footer{margin-top:26px;font-size:12.5px;color:#6b7280;text-align:center}
.accent{height:4px;background:${brand};border-radius:4px;margin-bottom:22px}`)}</style></head>
<body><div class="wrap">
<div class="accent"></div>
<div class="head">${logo ? html`<img src="${logo}" alt="">` : ''}<h1>${t(lang, 'status.title', { client: client.name })}</h1></div>
<div class="banner">${t(lang, allUp ? 'status.allUp' : 'status.someDown')}</div>
${sites.map((s) => html`<div class="card">
  <div class="row"><strong>${s.name}</strong><span class="state ${s.state}">${t(lang, `status.state.${s.state}`)}</span></div>
  <div class="bars">${s.days.map((p) => html`<span class="${barClass(p)}" title="${p == null ? t(lang, 'report.noData') : formatPct(lang, p)}"></span>`)}</div>
  <div class="meta"><span>${t(lang, 'status.daysAgo', { count: s.days.length })}</span><span>${formatPct(lang, s.uptime30)} ${t(lang, 'status.uptime')}</span><span>${t(lang, 'status.today')}</span></div>
</div>`)}
<footer>${t(lang, 'status.updated', { time: formatTime(lang, Date.now(), tz) })} · ${t(lang, 'status.by', { agency: agency.name })}</footer>
</div></body></html>`.s;
}
