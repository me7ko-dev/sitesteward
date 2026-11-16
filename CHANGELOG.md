# Changelog

All notable changes to sitesteward are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] – 2026-11-17

First stable release.

### Added
- **Honest uptime**: uptime is calculated only over time the site was actually monitored (derived from the stored checks). Days when sitesteward was not running, or the site was paused, show as "no data" in the report instead of a fake 100 %.
- **Pause a website**: unticking "Monitoring enabled" closes its open incidents, stops all checks (also "Check now") and shows a grey "paused" badge. Paused sites without data are left out of the monthly report.
- **Backup download** in Settings: a consistent copy of the live database (`VACUUM INTO`), no need to stop the app.
- **Mobile layout**: on phones the site tables turn into compact cards; tested at 390 px wide.
- `--version` flag; the version is shown at start-up and in the monitor's User-Agent.
- `/healthz` now verifies that the database answers (returns 503 otherwise).
- Deployment examples: `docs/deploy/sitesteward.service` (systemd, hardened) and `docs/deploy/Caddyfile` (HTTPS reverse proxy).
- End-to-end test that runs the real CLI, kills it like a crash and restarts it on the same data.

### Changed
- Monthly reports are **restart-safe**: if sitesteward was not running on the 1st, it catches up during the first 7 days of the month. Only clients that were actually monitored that month get a report. A report that was already sent is never rebuilt or sent twice, and one failing e-mail no longer stops the other clients (the failure is included in your notification).
- SSL check: a network error (timeout, connection refused, DNS) is no longer reported as an SSL incident – the HTTP check already covers availability. It is retried after 30 minutes and the last known certificate data is kept. Certificate problems (expired, untrusted, wrong host name) and failed TLS handshakes are still incidents.
- Panel links to reports and status pages are always absolute (falling back to the panel's own address when no public URL is set), so "Copy" gives a working link.
- Static files are served with a content hash in the URL, so browsers pick up new styles right after an update.
- "Refresh numbers" asks for confirmation when the report was already sent.
- Response times use localised units (`ms`/`s`, `мс`/`с`).
- Graceful shutdown waits (max. 5 s) for running checks before closing the database.

### Fixed
- Numeric HTML entities outside the Unicode range (for example `&#99999999;`) threw a `RangeError` and silently skipped the spam-word and title checks for that page.
- Entity names such as `&constructor;` were decoded via the object prototype.
- Switching a site from `https://` to `http://` left its SSL incident open forever.
- A site deleted while its check was running produced a foreign-key error in the log.
- Changing a site's URL now also resets the SSL/domain warning thresholds.
- Unknown report IDs on POST routes now return 404 instead of silently doing nothing.
- Setup-code guessing is rate-limited like the login.
- A port that is already in use gives a clear message and exit code 1 instead of a stack trace; an unexpected rejected promise is logged instead of stopping all monitoring.
- The Docker health check uses `$PORT` instead of a hard-coded 3000.

## [0.1.0] – 2026-11-16

Initial version: HTTP, SSL, domain (RDAP) and hacked-site checks, alerts (Telegram, e-mail, ntfy, webhook), agency panel with login and CSRF protection, white-label monthly reports in English and Bulgarian with a private link and e-mail delivery, public status pages, demo mode and Docker image.

[1.0.0]: https://github.com/me7ko-dev/sitesteward/compare/176d743...v1.0.0
[0.1.0]: https://github.com/me7ko-dev/sitesteward/commit/176d743
