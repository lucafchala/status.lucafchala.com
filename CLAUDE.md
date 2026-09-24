# CLAUDE.md — status.lucafchala.com

The ecosystem's status page: a static page plus Cloudflare Pages Functions that sweep every `*.lucafchala.com` service, keep history, and email alerts. It's the only repo in the ecosystem with real server code. Read `README.md` (long, but it's the spec) before changing the sweep or the alert path. Code comments are in Portuguese; keep new ones in the same language and tone (explain *why*, not what).

## Map

| File | Role |
|---|---|
| `index.html`, `app.js`, `app.css`, `tema.js` | Page. `tema.js` is sync in `<head>` (theme/lang before paint, `window.lfPrefs`); `app.js` does everything else |
| `functions/api/status.js` | `SERVICES` (what's checked, the markers), the sweep (`varrer`), change detection and alerts (`detectAndNotify` → `sendAlerts`) |
| `functions/api/painel.js` | Everything the page reads, in one call |
| `functions/api/retrato.js` | D1 snapshot, global sweep lock, bars |
| `functions/api/subscribe.js` / `confirm.js` / `unsubscribe.js` | Double opt-in sign-up, confirmation, RFC 8058 unsubscribe |
| `functions/api/third-party-status.js`, `quota-stats.js`, `status-history.js`, `latency-trends.js`, `healthz.js` | The other sections |
| `agendador/` | Cron Worker that requests a sweep every 10 min |
| `scripts/vigia.mjs` + `.github/workflows/monitor.yml` | Watchdog outside Cloudflare |
| `tests/*.test.mjs` | `node --test tests/*.test.mjs` — no package.json, no deps |

## Rules

- **Markers are contracts.** Each entry in `SERVICES` has a `marker` that must appear on that site (`Luca`, `Painel`, `Paste`, `url.lucafchala.com`, `Chaves`, `subs`, `Luca Ferriani Chala` in proof's `.txt`, …). The other repos' CLAUDE.md files tell their authors not to remove them; don't change them here without changing the site. This page's own marker is `monitoramento de serviços`, kept in the static footer outside `data-i18n` (CI checks it).
- **CSP is strict:** `script-src 'self'; style-src 'self'; font-src 'self'`, no third-party origin (`tests/pagina.test.mjs`). No inline `<script>`, no `on*=`, no `style=` (including in HTML built by `app.js` — set widths with CSSOM). Events go through `data-action` + one delegated listener. Every `<script>` has `data-cfasync="false"`.
- **KV writes are the scarce resource** (1k/day, shared account-wide with fotos). Steady state must cost zero writes: `last_status` only on a real change, `alert_pending` only on a failed send, latency at most every ~30 min. `tests/monitor.test.mjs` counts writes.
- **Alerts:**
  - cooldown key `notify_sent:{name}:{to}`;
  - the cooldown is written only after Resend accepts the batch;
  - batches of ≤ 100;
  - `cota ·` / `TLS ·` rows go only to `NOTIFY_TO`;
  - never let a client request shape an email.
- **Public endpoints don't leak internals.** No binding names or subscriber counts in `/api/status`, `/api/healthz` (detail only with `X-Status-Token` = `STATUS_ADMIN_TOKEN`) or `/api/subscribe` errors. Raw upstream errors go to `console.error`.
- **Unknown is not up.** Anything unread (a third-party page that 403s, a quota dataset that failed, a cert the token can't see) is `unknown`, not green and not red.
- **GET never mutates.** Confirm and unsubscribe show a button on GET; the POST acts.
- **i18n:** page chrome strings live in `S.pt` / `S.en` (`t(key, …)`), static markup uses `data-i18n` / `data-i18n-attr` with the PT text in the HTML and EN in `HTML_EN`. Server-provided text stays PT.
- **Prefs:** `lf_theme` / `lf_lang` cookies on `.lucafchala.com`, shared with every sibling site.

## Checks

Run `node --test tests/*.test.mjs` and the steps in `.github/workflows/checks.yml` before pushing. For UI changes, also load the page in a real browser under the `_headers` CSP: a CSP violation only shows up there.
