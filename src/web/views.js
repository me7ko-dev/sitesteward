// Agency panel pages.
import { html, raw, safeColor, safeImage } from './html.js';
import {
  t, LANGS, langName, formatPct, formatMs, formatDateTime, formatMonth, formatDuration, formatBytes, localeOf,
} from '../i18n.js';

const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

function stateDot(state) {
  return html`<span class="dot ${state === 'up' ? 'up' : state === 'down' ? 'down' : 'unknown'}"></span>`;
}

function daysBadge(lang, days, warnAt, badAt) {
  if (days == null) return html`<span class="muted">—</span>`;
  const cls = days < badAt ? 'bad' : days < warnAt ? 'warn' : 'ok';
  return html`<span class="badge ${cls}">${t(lang, 'panel.daysShort', { n: days })}</span>`;
}

export function layout({ lang, title, body, nav = true, settings, flash, csrf }) {
  const brand = safeColor(settings?.agency?.color, '#4f46e5');
  const logo = safeImage(settings?.agency?.logo);
  return html`<!doctype html>
<html lang="${localeOf(lang).split('-')[0]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · client-uptime</title>
<link rel="stylesheet" href="/static/panel.css">
<style>:root{--brand:${brand}}</style>
</head>
<body>
${nav ? html`<header class="top">
  <a class="brand" href="/">${logo ? html`<img src="${logo}" alt="">` : html`<span class="mark"></span>`}<span>${settings?.agency?.name || 'client-uptime'}</span></a>
  <nav>
    <a href="/">${t(lang, 'panel.nav.dashboard')}</a>
    <a href="/clients/new">${t(lang, 'panel.nav.addClient')}</a>
    <a href="/settings">${t(lang, 'panel.nav.settings')}</a>
    <form method="post" action="/logout" class="inline">${csrfField(csrf)}<button class="link">${t(lang, 'panel.nav.logout')}</button></form>
  </nav>
</header>` : ''}
<main class="wrap">
${flash ? html`<div class="flash ${flash.type || 'ok'}">${flash.text}</div>` : ''}
${body}
</main>
<script src="/static/app.js"></script>
</body>
</html>`.s;
}

export function setupPage({ lang, csrf, error, values = {} }) {
  return html`<div class="auth">
  <h1>${t(lang, 'panel.setup.title')}</h1>
  <p class="muted">${t(lang, 'panel.setup.intro')}</p>
  ${error ? html`<div class="flash bad">${error}</div>` : ''}
  <form method="post" action="/setup" class="card stack">
    ${csrfField(csrf)}
    <label>${t(lang, 'panel.setup.code')}<input name="code" required autocomplete="off" placeholder="XXXX-XXXX"><small>${t(lang, 'panel.setup.codeHelp')}</small></label>
    <label>${t(lang, 'panel.settings.agencyName')}<input name="agency" required maxlength="80" value="${values.agency || ''}"></label>
    <label>${t(lang, 'panel.settings.panelLang')}<select name="lang">${LANGS.map((l) => html`<option value="${l}" ${l === lang ? 'selected' : ''}>${langName(l)}</option>`)}</select></label>
    <label>${t(lang, 'panel.setup.password')}<input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
    <label>${t(lang, 'panel.setup.password2')}<input type="password" name="password2" required minlength="10" autocomplete="new-password"></label>
    <button class="btn">${t(lang, 'panel.setup.submit')}</button>
  </form>
</div>`;
}

export function loginPage({ lang, csrf, error }) {
  return html`<div class="auth">
  <h1>${t(lang, 'panel.login.title')}</h1>
  ${error ? html`<div class="flash bad">${error}</div>` : ''}
  <form method="post" action="/login" class="card stack">
    ${csrfField(csrf)}
    <label>${t(lang, 'panel.login.password')}<input type="password" name="password" required autofocus autocomplete="current-password"></label>
    <button class="btn">${t(lang, 'panel.login.submit')}</button>
  </form>
</div>`;
}

export function dashboardPage({ lang, clients, totals, tz }) {
  return html`
<div class="pagehead">
  <div><h1>${t(lang, 'panel.dash.title')}</h1><p class="muted">${t(lang, 'panel.dash.subtitle')}</p></div>
  <a class="btn" href="/clients/new">+ ${t(lang, 'panel.nav.addClient')}</a>
</div>
<div class="stats">
  <div class="stat"><span>${t(lang, 'panel.dash.clients')}</span><b>${totals.clients}</b></div>
  <div class="stat"><span>${t(lang, 'panel.dash.sites')}</span><b>${totals.sites}</b></div>
  <div class="stat ${totals.down ? 'bad' : ''}"><span>${t(lang, 'panel.dash.down')}</span><b>${totals.down}</b></div>
  <div class="stat ${totals.expiring ? 'warn' : ''}"><span>${t(lang, 'panel.dash.expiring')}</span><b>${totals.expiring}</b></div>
</div>
${clients.length ? '' : html`<div class="card empty-state"><h2>${t(lang, 'panel.dash.emptyTitle')}</h2><p>${t(lang, 'panel.dash.emptyText')}</p><a class="btn" href="/clients/new">+ ${t(lang, 'panel.nav.addClient')}</a></div>`}
${clients.map((c) => html`<section class="card client">
  <div class="client-head">
    <a href="/clients/${c.id}" class="client-name">${safeImage(c.logo) ? html`<img src="${safeImage(c.logo)}" alt="">` : html`<span class="avatar" style="background:${safeColor(c.color)}">${c.name.slice(0, 1).toUpperCase()}</span>`}${c.name}</a>
    <a class="btn ghost small" href="/clients/${c.id}">${t(lang, 'panel.dash.open')}</a>
  </div>
  ${c.sites.length ? html`<div class="tablewrap"><table>
    <thead><tr><th></th><th>${t(lang, 'panel.site.name')}</th><th>${t(lang, 'panel.dash.response')}</th><th>${t(lang, 'panel.dash.uptime30')}</th><th>SSL</th><th>${t(lang, 'panel.dash.domain')}</th><th>${t(lang, 'panel.dash.lastCheck')}</th></tr></thead>
    <tbody>${c.sites.map((s) => html`<tr>
      <td>${stateDot(s.state)}</td>
      <td><a href="/sites/${s.id}">${s.name}</a><div class="sub">${s.url}</div>${s.spam_hits ? html`<div class="badge bad">${t(lang, 'panel.site.spamFound')}: ${s.spam_hits}</div>` : ''}${s.state === 'down' && s.last_error ? html`<div class="sub bad">${s.last_error}</div>` : ''}</td>
      <td>${formatMs(lang, s.last_response_ms)}</td>
      <td>${formatPct(lang, s.uptime30)}</td>
      <td>${s.ssl_error ? html`<span class="badge bad">${t(lang, 'panel.site.sslError')}</span>` : daysBadge(lang, s.sslDays, 21, 7)}</td>
      <td>${s.domain_status === 'ok' ? daysBadge(lang, s.domainDays, 30, 14) : html`<span class="muted small">${t(lang, `panel.domainStatus.${s.domain_status || 'pending'}`)}</span>`}</td>
      <td class="muted small">${s.last_check_at ? formatDateTime(lang, s.last_check_at, tz) : t(lang, 'panel.dash.pending')}</td>
    </tr>`)}</tbody></table></div>` : html`<p class="muted">${t(lang, 'panel.client.noSites')}</p>`}
</section>`)}`;
}

export function clientForm({ lang, csrf, client = {}, action }) {
  const c = { color: '#0ea5e9', lang: 'en', auto_send: 1, status_public: 0, ...client };
  return html`<form method="post" action="${action}" class="card stack" data-logo-form>
  ${csrfField(csrf)}
  <div class="grid2">
    <label>${t(lang, 'panel.client.name')}<input name="name" required maxlength="100" value="${c.name || ''}"></label>
    <label>${t(lang, 'panel.client.email')}<input type="email" name="email" maxlength="200" value="${c.email || ''}" placeholder="owner@example.com"><small>${t(lang, 'panel.client.emailHelp')}</small></label>
    <label>${t(lang, 'panel.client.lang')}<select name="lang">${LANGS.map((l) => html`<option value="${l}" ${l === c.lang ? 'selected' : ''}>${langName(l)}</option>`)}</select></label>
    <label>${t(lang, 'panel.client.color')}<input type="color" name="color" value="${safeColor(c.color, '#0ea5e9')}"></label>
  </div>
  <label>${t(lang, 'panel.client.logo')}
    <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" data-logo-input>
    <input type="hidden" name="logo" value="${safeImage(c.logo)}" data-logo-value>
    <small>${t(lang, 'panel.logoHelp')}</small>
    <span class="logo-preview" data-logo-preview>${safeImage(c.logo) ? html`<img src="${safeImage(c.logo)}" alt="">` : ''}</span>
    ${safeImage(c.logo) ? html`<button type="button" class="link" data-logo-clear>${t(lang, 'panel.removeLogo')}</button>` : ''}
  </label>
  <label class="check"><input type="checkbox" name="auto_send" value="1" ${c.auto_send ? 'checked' : ''}> ${t(lang, 'panel.client.autoSend')}</label>
  <label class="check"><input type="checkbox" name="status_public" value="1" ${c.status_public ? 'checked' : ''}> ${t(lang, 'panel.client.statusPublic')}</label>
  <label>${t(lang, 'panel.client.notes')}<textarea name="notes" rows="2" maxlength="2000">${c.notes || ''}</textarea><small>${t(lang, 'panel.client.notesHelp')}</small></label>
  <div><button class="btn">${t(lang, 'panel.save')}</button></div>
</form>`;
}

export function newClientPage({ lang, csrf }) {
  return html`<div class="pagehead"><div><h1>${t(lang, 'panel.client.newTitle')}</h1><p class="muted">${t(lang, 'panel.client.newIntro')}</p></div></div>
${clientForm({ lang, csrf, action: '/clients' })}`;
}

function siteForm({ lang, csrf, site = {}, action, defaultInterval }) {
  const s = { interval_min: defaultInterval, ...site };
  return html`<form method="post" action="${action}" class="stack">
  ${csrfField(csrf)}
  <div class="grid2">
    <label>${t(lang, 'panel.site.name')}<input name="name" required maxlength="100" value="${s.name || ''}" placeholder="${t(lang, 'panel.site.namePh')}"></label>
    <label>${t(lang, 'panel.site.url')}<input name="url" required maxlength="500" value="${s.url || ''}" placeholder="https://www.example.com"></label>
    <label>${t(lang, 'panel.site.interval')}<input type="number" name="interval_min" min="1" max="1440" value="${s.interval_min}"></label>
    <label>${t(lang, 'panel.site.keyword')}<input name="keyword" maxlength="200" value="${s.keyword || ''}"><small>${t(lang, 'panel.site.keywordHelp')}</small></label>
    <label>${t(lang, 'panel.site.domain')}<input name="domain" maxlength="200" value="${s.domain || ''}" placeholder="example.co.uk"><small>${t(lang, 'panel.site.domainHelp')}</small></label>
    <label>${t(lang, 'panel.site.ignore')}<input name="ignore_words" maxlength="500" value="${s.ignore_words || ''}" placeholder="casino"><small>${t(lang, 'panel.site.ignoreHelp')}</small></label>
  </div>
  ${site.id ? html`<label class="check"><input type="checkbox" name="enabled" value="1" ${s.enabled ? 'checked' : ''}> ${t(lang, 'panel.site.enabled')}</label>` : ''}
  <div><button class="btn">${site.id ? t(lang, 'panel.save') : `+ ${t(lang, 'panel.site.add')}`}</button></div>
</form>`;
}

export function clientPage({ lang, csrf, client, sites, reports, work, statusUrl, defaultInterval, periods, tz }) {
  return html`
<div class="pagehead">
  <div class="client-title">${safeImage(client.logo) ? html`<img src="${safeImage(client.logo)}" alt="">` : html`<span class="avatar big" style="background:${safeColor(client.color)}">${client.name.slice(0, 1).toUpperCase()}</span>`}
    <div><h1>${client.name}</h1><p class="muted">${client.email || t(lang, 'panel.client.noEmail')} · ${langName(client.lang)}</p></div></div>
  ${client.status_public ? html`<a class="btn ghost" href="${statusUrl}" target="_blank" rel="noopener">${t(lang, 'panel.client.statusPage')} ↗</a>` : ''}
</div>

<section class="card">
  <h2>${t(lang, 'panel.client.sites')}</h2>
  ${sites.length ? html`<div class="tablewrap"><table><tbody>${sites.map((s) => html`<tr>
    <td>${stateDot(s.state)}</td><td><a href="/sites/${s.id}">${s.name}</a><div class="sub">${s.url}</div></td>
    <td>${formatMs(lang, s.last_response_ms)}</td><td>${formatPct(lang, s.uptime30)}</td>
    <td class="right"><form method="post" action="/sites/${s.id}/check" class="inline">${csrfField(csrf)}<button class="btn ghost small">${t(lang, 'panel.site.checkNow')}</button></form></td>
  </tr>`)}</tbody></table></div>` : html`<p class="muted">${t(lang, 'panel.client.noSites')}</p>`}
  <details ${sites.length ? '' : 'open'} class="add"><summary>+ ${t(lang, 'panel.site.add')}</summary>
    ${siteForm({ lang, csrf, action: `/clients/${client.id}/sites`, defaultInterval })}
  </details>
</section>

<div class="grid2">
<section class="card">
  <h2>${t(lang, 'panel.reports.title')}</h2>
  <form method="post" action="/clients/${client.id}/reports" class="row">
    ${csrfField(csrf)}
    <select name="period">${periods.map((p) => html`<option value="${p}">${formatMonth(lang, p)}</option>`)}</select>
    <button class="btn">${t(lang, 'panel.reports.generate')}</button>
  </form>
  ${reports.length ? html`<ul class="plain">${reports.map((r) => html`<li><a href="/reports/${r.id}">${formatMonth(lang, r.period)}</a>
    ${r.sent_at ? html`<span class="badge ok">${t(lang, 'panel.reports.sent')}</span>` : html`<span class="badge">${t(lang, 'panel.reports.draft')}</span>`}</li>`)}</ul>` : html`<p class="muted">${t(lang, 'panel.reports.none')}</p>`}
</section>
<section class="card">
  <h2>${t(lang, 'panel.work.title')}</h2>
  <p class="muted small">${t(lang, 'panel.work.help')}</p>
  <form method="post" action="/clients/${client.id}/work" class="row">${csrfField(csrf)}
    <input name="text" required maxlength="500" placeholder="${t(lang, 'panel.work.placeholder')}"><button class="btn">${t(lang, 'panel.work.add')}</button></form>
  ${work.length ? html`<ul class="plain">${work.map((w) => html`<li><span class="muted small">${formatDateTime(lang, w.ts, tz)}</span> ${w.text}
    <form method="post" action="/work/${w.id}/delete" class="inline">${csrfField(csrf)}<button class="link small" data-confirm="${t(lang, 'panel.confirmDelete')}">×</button></form></li>`)}</ul>` : ''}
</section>
</div>

<section class="card">
  <h2>${t(lang, 'panel.client.edit')}</h2>
  ${clientForm({ lang, csrf, client, action: `/clients/${client.id}` })}
  <form method="post" action="/clients/${client.id}/delete" class="danger-zone">${csrfField(csrf)}
    <button class="btn danger" data-confirm="${t(lang, 'panel.confirmDelete')}">${t(lang, 'panel.client.delete')}</button></form>
</section>`;
}

export function sitePage({ lang, csrf, site, client, checks, incidents, tz, uptime30, defaultInterval }) {
  const kindLabel = (k) => t(lang, `panel.incidentKind.${k}`);
  return html`
<p class="crumbs"><a href="/clients/${client.id}">← ${client.name}</a></p>
<div class="pagehead">
  <div><h1>${stateDot(site.state)} ${site.name}</h1><p class="muted"><a href="${site.url}" target="_blank" rel="noopener noreferrer">${site.url}</a></p></div>
  <form method="post" action="/sites/${site.id}/check">${csrfField(csrf)}<button class="btn">${t(lang, 'panel.site.checkNow')}</button></form>
</div>
<div class="stats">
  <div class="stat"><span>${t(lang, 'panel.dash.uptime30')}</span><b>${formatPct(lang, uptime30)}</b></div>
  <div class="stat"><span>${t(lang, 'panel.dash.response')}</span><b>${formatMs(lang, site.last_response_ms)}</b></div>
  <div class="stat ${site.ssl_error ? 'bad' : ''}"><span>SSL</span><b>${site.ssl_error ? t(lang, 'panel.site.sslError') : site.sslDays != null ? t(lang, 'panel.daysShort', { n: site.sslDays }) : '—'}</b><small>${site.ssl_error || site.ssl_issuer || ''}</small></div>
  <div class="stat"><span>${t(lang, 'panel.dash.domain')}</span><b>${site.domain_status === 'ok' ? t(lang, 'panel.daysShort', { n: site.domainDays }) : '—'}</b><small>${site.domain_name || ''} ${site.domain_status && site.domain_status !== 'ok' ? `· ${t(lang, `panel.domainStatus.${site.domain_status}`)}` : ''}</small></div>
  <div class="stat"><span>${t(lang, 'panel.site.pageSize')}</span><b>${site.last_bytes != null ? formatBytes(lang, site.last_bytes) : '—'}</b></div>
</div>
${site.spam_hits ? html`<div class="flash bad">${t(lang, 'panel.site.spamFound')}: <b>${site.spam_hits}</b> — ${t(lang, 'panel.site.spamHelp')}</div>` : ''}
<div class="grid2">
<section class="card">
  <h2>${t(lang, 'panel.site.incidents')}</h2>
  ${incidents.length ? html`<ul class="plain">${incidents.map((i) => html`<li>
    <span class="badge ${i.kind === 'down' || i.kind === 'content' || i.kind === 'ssl' ? 'bad' : ''}">${kindLabel(i.kind)}</span>
    ${formatDateTime(lang, i.started_at, tz)}
    ${i.kind === 'down' ? html` · ${i.ended_at ? formatDuration(lang, i.ended_at - i.started_at) : html`<b class="bad">${t(lang, 'panel.site.ongoing')}</b>`}` : ''}
    <div class="sub">${i.kind === 'title' ? (() => { try { const d = JSON.parse(i.detail); return `“${d.from}” → “${d.to}”`; } catch { return i.detail; } })() : i.detail}</div>
  </li>`)}</ul>` : html`<p class="muted">${t(lang, 'panel.site.noIncidents')}</p>`}
</section>
<section class="card">
  <h2>${t(lang, 'panel.site.recentChecks')}</h2>
  <div class="tablewrap"><table class="compact"><tbody>${checks.map((c) => html`<tr>
    <td>${stateDot(c.ok ? 'up' : 'down')}</td><td class="small">${formatDateTime(lang, c.ts, tz)}</td>
    <td class="small">${c.status ?? '—'}</td><td class="small">${formatMs(lang, c.response_ms)}</td><td class="small sub">${c.error || ''}</td></tr>`)}</tbody></table></div>
</section>
</div>
<section class="card">
  <h2>${t(lang, 'panel.site.settings')}</h2>
  ${siteForm({ lang, csrf, site, action: `/sites/${site.id}`, defaultInterval })}
  <form method="post" action="/sites/${site.id}/delete" class="danger-zone">${csrfField(csrf)}
    <button class="btn danger" data-confirm="${t(lang, 'panel.confirmDelete')}">${t(lang, 'panel.site.delete')}</button></form>
</section>`;
}

export function reportPage({ lang, csrf, report, client, link, pdfAvailable, canEmail, tz }) {
  return html`
<p class="crumbs"><a href="/clients/${client.id}">← ${client.name}</a></p>
<div class="pagehead">
  <div><h1>${t(lang, 'panel.reports.one', { month: formatMonth(lang, report.period) })}</h1>
  <p class="muted">${report.sent_at ? t(lang, 'panel.reports.sentOn', { date: formatDateTime(lang, report.sent_at, tz), to: report.sent_to }) : t(lang, 'panel.reports.notSent')}</p></div>
  <a class="btn ghost" href="${link}" target="_blank" rel="noopener">${t(lang, 'panel.reports.preview')} ↗</a>
</div>
<section class="card">
  <h2>${t(lang, 'panel.reports.link')}</h2>
  <div class="row"><input readonly value="${link}" data-copy-source><button type="button" class="btn ghost" data-copy>${t(lang, 'panel.copy')}</button></div>
  <p class="muted small">${t(lang, 'panel.reports.linkHelp')}${pdfAvailable ? '' : ` ${t(lang, 'panel.reports.pdfHelp')}`}</p>
</section>
<form method="post" action="/reports/${report.id}" class="card stack">
  ${csrfField(csrf)}
  <label>${t(lang, 'panel.reports.work')}<textarea name="work_done" rows="7" maxlength="5000" placeholder="${t(lang, 'panel.reports.workPh')}">${report.work_done}</textarea><small>${t(lang, 'panel.reports.workHelp')}</small></label>
  <label>${t(lang, 'panel.reports.next')}<textarea name="next_steps" rows="4" maxlength="5000" placeholder="${t(lang, 'panel.reports.nextPh')}">${report.next_steps}</textarea></label>
  <div class="row"><button class="btn">${t(lang, 'panel.save')}</button></div>
</form>
<div class="row wrap-row">
  <form method="post" action="/reports/${report.id}/regenerate">${csrfField(csrf)}<button class="btn ghost">${t(lang, 'panel.reports.refresh')}</button></form>
  <form method="post" action="/reports/${report.id}/send">${csrfField(csrf)}<button class="btn" ${canEmail ? '' : 'disabled'} data-confirm="${t(lang, 'panel.reports.confirmSend', { to: client.email })}">✉ ${t(lang, report.sent_at ? 'panel.reports.resend' : 'panel.reports.send')}</button></form>
  <form method="post" action="/reports/${report.id}/rotate">${csrfField(csrf)}<button class="btn ghost" data-confirm="${t(lang, 'panel.reports.confirmRotate')}">${t(lang, 'panel.reports.rotate')}</button></form>
  <form method="post" action="/reports/${report.id}/delete">${csrfField(csrf)}<button class="btn danger" data-confirm="${t(lang, 'panel.confirmDelete')}">${t(lang, 'panel.delete')}</button></form>
</div>
${canEmail ? '' : html`<p class="muted small">${t(lang, 'panel.reports.cannotEmail')}</p>`}`;
}

export function settingsPage({ lang, csrf, s, alertLog, tz, pdfAvailable, dryRun }) {
  const secret = (name, has) => html`<input type="password" name="${name}" autocomplete="off" placeholder="${has ? t(lang, 'panel.settings.keepSecret') : ''}">`;
  const a = s.alerts;
  return html`
<div class="pagehead"><div><h1>${t(lang, 'panel.nav.settings')}</h1></div></div>
${dryRun ? html`<div class="flash warn">${t(lang, 'panel.settings.dryRun')}</div>` : ''}
<form method="post" action="/settings" class="stack" data-logo-form>
${csrfField(csrf)}
<section class="card stack">
  <h2>${t(lang, 'panel.settings.agency')}</h2>
  <div class="grid2">
    <label>${t(lang, 'panel.settings.agencyName')}<input name="agency_name" required maxlength="80" value="${s.agency.name}"></label>
    <label>${t(lang, 'panel.settings.agencyColor')}<input type="color" name="agency_color" value="${safeColor(s.agency.color)}"></label>
    <label>${t(lang, 'panel.settings.agencyEmail')}<input type="email" name="agency_email" maxlength="200" value="${s.agency.email}"></label>
    <label>${t(lang, 'panel.settings.agencyWebsite')}<input name="agency_website" maxlength="200" value="${s.agency.website}" placeholder="www.example.com"></label>
  </div>
  <label>${t(lang, 'panel.settings.agencyLogo')}
    <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" data-logo-input>
    <input type="hidden" name="agency_logo" value="${safeImage(s.agency.logo)}" data-logo-value>
    <small>${t(lang, 'panel.logoHelp')}</small>
    <span class="logo-preview" data-logo-preview>${safeImage(s.agency.logo) ? html`<img src="${safeImage(s.agency.logo)}" alt="">` : ''}</span>
    ${safeImage(s.agency.logo) ? html`<button type="button" class="link" data-logo-clear>${t(lang, 'panel.removeLogo')}</button>` : ''}
  </label>
</section>
<section class="card stack">
  <h2>${t(lang, 'panel.settings.general')}</h2>
  <div class="grid2">
    <label>${t(lang, 'panel.settings.panelLang')}<select name="panel_lang">${LANGS.map((l) => html`<option value="${l}" ${l === s.panelLang ? 'selected' : ''}>${langName(l)}</option>`)}</select></label>
    <label>${t(lang, 'panel.settings.timezone')}<input name="timezone" value="${s.timezone}" placeholder="Europe/London"><small>${t(lang, 'panel.settings.timezoneHelp')}</small></label>
    <label>${t(lang, 'panel.settings.publicUrl')}<input name="public_url" value="${s.publicUrl}" placeholder="https://monitor.example.com"><small>${t(lang, 'panel.settings.publicUrlHelp')}</small></label>
    <label>${t(lang, 'panel.settings.interval')}<input type="number" name="default_interval" min="1" max="1440" value="${s.defaultIntervalMin}"></label>
    <label>${t(lang, 'panel.settings.retries')}<input type="number" name="retries" min="0" max="5" value="${s.retries}"><small>${t(lang, 'panel.settings.retriesHelp')}</small></label>
    <label>${t(lang, 'panel.settings.retryDelay')}<input type="number" name="retry_delay" min="0" max="300" value="${s.retryDelaySec}"></label>
    <label>${t(lang, 'panel.settings.timeout')}<input type="number" name="timeout" min="2" max="60" value="${s.timeoutSec}"></label>
  </div>
  <label>${t(lang, 'panel.settings.spamWords')}<textarea name="spam_words" rows="3">${s.spamWords.join(', ')}</textarea><small>${t(lang, 'panel.settings.spamHelp')}</small></label>
</section>
<section class="card stack">
  <h2>${t(lang, 'panel.settings.reports')}</h2>
  <label class="check"><input type="radio" name="reports_mode" value="manual" ${s.reports.mode !== 'auto' ? 'checked' : ''}> ${t(lang, 'panel.settings.modeManual')}</label>
  <label class="check"><input type="radio" name="reports_mode" value="auto" ${s.reports.mode === 'auto' ? 'checked' : ''}> ${t(lang, 'panel.settings.modeAuto')}</label>
  <label>${t(lang, 'panel.settings.reportHour')}<input type="number" name="reports_hour" min="0" max="23" value="${s.reports.hour}"></label>
  <p class="muted small">${pdfAvailable ? t(lang, 'panel.settings.pdfOn') : t(lang, 'panel.settings.pdfOff')}</p>
</section>
<section class="card stack">
  <h2>${t(lang, 'panel.settings.smtp')}</h2>
  <p class="muted small">${t(lang, 'panel.settings.smtpHelp')}</p>
  <div class="grid2">
    <label>${t(lang, 'panel.settings.smtpHost')}<input name="smtp_host" value="${s.smtp.host}" placeholder="smtp.example.com"></label>
    <label>${t(lang, 'panel.settings.smtpPort')}<input type="number" name="smtp_port" value="${s.smtp.port}"></label>
    <label>${t(lang, 'panel.settings.smtpUser')}<input name="smtp_user" value="${s.smtp.user}" autocomplete="off"></label>
    <label>${t(lang, 'panel.settings.smtpPass')}${secret('smtp_pass', !!s.smtp.pass)}</label>
    <label>${t(lang, 'panel.settings.smtpFrom')}<input name="smtp_from" value="${s.smtp.from}" placeholder="Agency Name &lt;reports@example.com&gt;"></label>
  </div>
  <label class="check"><input type="checkbox" name="smtp_secure" value="1" ${s.smtp.secure ? 'checked' : ''}> ${t(lang, 'panel.settings.smtpSecure')}</label>
</section>
<section class="card stack">
  <h2>${t(lang, 'panel.settings.alerts')}</h2>
  <p class="muted small">${t(lang, 'panel.settings.alertsHelp')}</p>
  <fieldset><legend><label class="check"><input type="checkbox" name="tg_enabled" value="1" ${a.telegram.enabled ? 'checked' : ''}> Telegram</label></legend>
    <div class="grid2"><label>${t(lang, 'panel.settings.tgToken')}${secret('tg_token', !!a.telegram.botToken)}</label><label>${t(lang, 'panel.settings.tgChat')}<input name="tg_chat" value="${a.telegram.chatId}"></label></div></fieldset>
  <fieldset><legend><label class="check"><input type="checkbox" name="email_enabled" value="1" ${a.email.enabled ? 'checked' : ''}> ${t(lang, 'panel.settings.emailAlerts')}</label></legend>
    <label>${t(lang, 'panel.settings.alertEmail')}<input type="email" name="alert_email" value="${a.email.to}"></label></fieldset>
  <fieldset><legend><label class="check"><input type="checkbox" name="ntfy_enabled" value="1" ${a.ntfy.enabled ? 'checked' : ''}> ntfy</label></legend>
    <div class="grid2"><label>${t(lang, 'panel.settings.ntfyServer')}<input name="ntfy_server" value="${a.ntfy.server}"></label><label>${t(lang, 'panel.settings.ntfyTopic')}<input name="ntfy_topic" value="${a.ntfy.topic}"></label>
    <label>${t(lang, 'panel.settings.ntfyToken')}${secret('ntfy_token', !!a.ntfy.token)}</label></div></fieldset>
  <fieldset><legend><label class="check"><input type="checkbox" name="webhook_enabled" value="1" ${a.webhook.enabled ? 'checked' : ''}> Webhook</label></legend>
    <label>${t(lang, 'panel.settings.webhookUrl')}<input name="webhook_url" value="${a.webhook.url}" placeholder="https://"></label></fieldset>
</section>
<div><button class="btn">${t(lang, 'panel.save')}</button></div>
</form>

<section class="card">
  <h2>${t(lang, 'panel.settings.test')}</h2>
  <div class="row wrap-row">
    ${['telegram', 'email', 'ntfy', 'webhook'].map((ch) => html`<form method="post" action="/settings/test-alert" class="inline">${csrfField(csrf)}<input type="hidden" name="channel" value="${ch}"><button class="btn ghost small">${t(lang, 'panel.settings.testChannel', { channel: ch })}</button></form>`)}
  </div>
  ${alertLog.length ? html`<div class="tablewrap"><table class="compact"><tbody>${alertLog.map((l) => html`<tr><td>${stateDot(l.ok ? 'up' : 'down')}</td><td class="small">${formatDateTime(lang, l.ts, tz)}</td><td class="small">${l.channel}</td><td class="small">${l.title}</td><td class="small bad">${l.error || ''}</td></tr>`)}</tbody></table></div>` : ''}
</section>

<section class="card">
  <h2>${t(lang, 'panel.settings.password')}</h2>
  <form method="post" action="/settings/password" class="stack">${csrfField(csrf)}
    <div class="grid2"><label>${t(lang, 'panel.settings.currentPassword')}<input type="password" name="current" required autocomplete="current-password"></label>
    <label>${t(lang, 'panel.settings.newPassword')}<input type="password" name="password" required minlength="10" autocomplete="new-password"></label></div>
    <div><button class="btn">${t(lang, 'panel.settings.changePassword')}</button></div></form>
</section>`;
}

export function notFoundPage({ lang }) {
  return html`<div class="auth"><h1>404</h1><p class="muted">${t(lang, 'panel.notFound')}</p><p><a href="/">←</a></p></div>`;
}

export { raw };
