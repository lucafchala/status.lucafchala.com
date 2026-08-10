# status.lucafchala.com

> The live status dashboard for the `lucafchala.com` network — checks every first‑party site (and the third‑party services they depend on), shows online / slow / offline with latency, and emails subscribers when something changes.

**Live:** [status.lucafchala.com](https://status.lucafchala.com) · **Stack:** static page + Cloudflare Pages Functions · **Persistence:** Workers KV · **Email:** Resend

Part of the [lucafchala.com ecosystem](https://github.com/lucafchala/lucafchala.com#the-ecosystem). Shared design system and conventions live in the [hub README](https://github.com/lucafchala/lucafchala.com#readme).

---

## What it is

**One sentence:** `status.lucafchala.com` is a static dashboard (`index.html`) backed by a handful of Cloudflare Pages Functions that health‑check the ecosystem's subdomains plus their upstream providers, and let visitors subscribe by email to outage notifications.

**In a paragraph:** The browser loads a single static page that, on load and then every 60 seconds, calls `/api/status`, `/api/third-party-status`, `/api/quota-stats` and `/api/status-history`. The first probes the ten first‑party sites — the nine `*.lucafchala.com` services plus the dashboard itself; the second checks the public status APIs of the providers the network relies on (GitHub, Cloudflare, Anthropic/Claude, Resend, Google); the third reports how much of the Cloudflare free tier is left; the fourth is the 48‑hour transition log, which is what lets a green dashboard still answer *"was this already broken an hour ago?"*. Change detection and alert email run **server-side** inside each fresh `/api/status` sweep. Visitors can subscribe (`/api/subscribe`) and unsubscribe (`/api/unsubscribe`); subscriber emails live in a Cloudflare KV namespace. This is the only repo in the network with real serverless endpoints — everything else is static or a single Worker.

---

## Architecture

```
            ┌────────────────────────── browser (index.html) ──────────────────────────┐
            │  on load + every 60s:  GET /api/status   GET /api/third-party-status       │
            │  subscribe form:       POST /api/subscribe       (unsub link → GET /api/unsubscribe)
            └───────────────────────────────────┬───────────────────────────────────────┘
                                                 │  Cloudflare Pages Functions (/functions/api/*)
                          ┌──────────────────────┼─────────────────────────┐
                          ▼                       ▼                         ▼
                  health-check fetches     Resend API (email)         Workers KV (STATUS_KV)
                  to *.lucafchala.com       api.resend.com            subscribers, last_status,
                  & provider status APIs                              notify_sent:{name}
```

- **Static front end:** `index.html` (inline HTML/CSS/JS) renders the dashboard and persists `theme` in `localStorage`.
- **Serverless back end:** Pages Functions under `functions/api/` (routes derive from file paths). `/api/status` and `/api/third-party-status` are edge-cached for 30 s (`s-maxage`), so concurrent viewers share one upstream sweep per colo.
- **Change detection runs server-side**: each fresh `/api/status` sweep is compared against `last_status` in KV; transitions email the admin + subscribers (Resend batch), throttled to one alert per service per hour via `notify_sent:{name}` keys. Nothing a client sends can trigger or shape an email.
- **Scheduled sweeps (no browser needed):** `detectAndNotify` only runs inside `GET /api/status`, which the dashboard polls on load + every 60 s — so with nobody viewing the page, no sweep and no alert would fire. A GitHub Actions cron (`.github/workflows/monitor.yml`) pings `/api/status` every 10 minutes (with a cache-buster, forcing a fresh sweep) to keep change detection + alerting running around the clock. The cadence is deliberately conservative because **KV writes are an account-wide free-tier resource (1k/day) shared with the fotos site** — and `detectAndNotify` now writes `last_status` only on an actual change, so a steady all-green sweep costs **zero** KV writes. The 1 h-per-service cooldown means the extra ticks never duplicate emails.
- **State (KV):** `subscribers` `[{ email, token, subscribedAt }]`, `last_status` `{name: status}` (services **and** `cota · …` / `TLS · …` rows, so quota crossings alert through the same path), `history` `[{ name, from, to, at, severity, problems }]` (newest‑first, 48 h window, capped at 60 entries), `notify_sent:{name}` cooldown markers (TTL 1 h).
- **Transition log:** written inside the same `changed` branch that updates `last_status`, so it costs **one extra KV write per real transition and nothing in steady state**. It is recorded even when email is unconfigured — the log is a record of what happened, not a side effect of alerting.
- **Free-tier headroom:** `/api/quota-stats` reads the Cloudflare GraphQL Analytics API for KV ops/storage, Workers requests/CPU and D1 rows, plus certificate expiry from the zone's certificate packs. It needs a read‑only API token; without one the panel is **hidden entirely** rather than showing zeros, since "unmonitored" must not look like "fine".

### Endpoints

| Route | Method | Behavior | Needs |
|---|---|---|---|
| `/api/status` | GET | **Functional** health‑checks of the 10 first‑party sites in parallel (GET, 10 s timeout). Each service has a primary availability probe (status code + latency + a content marker proving the right page rendered) plus optional sub‑checks — running server‑side means it can read response bodies cross‑origin, which the browser can't. Returns `{ services: [{ name, url, status, statusCode, rt, checks, problems }], checkedAt }`, where `checks` is `[{ label, status, detail }]` and `problems` is a list of human‑readable failures. A service's status is the **worst** of all its checks. **Base rules:** HTTP ≥ 500 → `down`; 400–499, slow (`rt` > 2500 ms), unexpected/empty content, missing data files, or a failing `/api/healthz` → `degraded`/`down`. Edge-cached 30 s. On fresh sweeps, also runs server-side change detection + alert emails (which list **every** failing check for a changed service, not just the first). | (emails need `RESEND_API_KEY`, `NOTIFY_TO`, `STATUS_KV`) |
| `/api/third-party-status` | GET | Checks provider status pages (GitHub, Cloudflare, Anthropic, Resend, Google Cloud), 8 s timeout, with provider‑specific parsing (e.g. Cloudflare filtered to Brazil PoPs). Edge-cached 30 s. | — |
| `/api/subscribe` | POST | Adds an email to KV (with a UUID token), sends a welcome email via Resend. Returns `{ ok, already }`. | `RESEND_API_KEY`, `NOTIFY_TO`, `NOTIFY_FROM`, `STATUS_KV` |
| `/api/unsubscribe?token=…` | GET | Removes the subscriber matching `token`, returns a small HTML confirmation page. | `STATUS_KV` |
| `/api/status-history` | GET | The 48 h transition log: `{ entries, services, flapping, worstSeverity }`. `services[name].lastIncident` gives severity, start, duration, whether it's resolved and how long ago — the context a live‑only dashboard structurally can't show. `flapping` names services with ≥ 4 transitions in the window, the failure a 60‑second poll hides best. Corrupt KV reads as an empty log, never a 500. Edge-cached 30 s. | `STATUS_KV` |
| `/api/quota-stats` | GET | Cloudflare free‑tier headroom (KV writes/reads/deletes/lists + storage, Workers requests + CPU p99, D1 rows) and TLS certificate expiry per zone. Each dataset is queried separately so one unreadable dataset costs that row only, not the panel; a dataset that fails reports `status: unknown` (never `up`) and is listed in `errors[]`. Warns at 75 % of a limit, critical at 95 %; certificates flag under 30 days. Edge-cached 5 min. Answers `configured: false` when the API token is absent. | `CF_API_TOKEN`, `CF_ACCOUNT_ID` |
| `/api/healthz` | GET | Liveness + config probe: `{ ok, kv, resendKey, notifyTo, subscribers, cloudflareApi }`. The one KV read does double duty — it proves the binding answers *and* reports how many people would actually receive an alert. | — |

### Monitored first‑party services & their functional checks

All probed with GET, following redirects, 10 s timeout, polled every 60 s. Beyond "did it answer", each service is verified for what it's *supposed to do*:

| Service | Functional checks (beyond a 2xx) |
|---|---|
| `lucafchala.com` | homepage renders (content marker) |
| `radio.lucafchala.com` | page renders (content marker) |
| `fotos.lucafchala.com` | **deliberately exhaustive (17 checks)** — gallery renders · **`/api/healthz`** fetched once, mined into four rows: **(1) infra** (KV alive + **latency budget**, `events` count, D1 consent log + **its latency**, PBKDF2 `hashMs`, **daily‑cron heartbeat staleness**), **(2) functional self‑test** (fotos' own `auditSite` over its live data: **broken/missing Google Drive links** on published events = Drive access down, **bad data** like duplicate slugs / invalid status, and **form backends** Turnstile/Resend/`ADMIN_EMAIL` being unset), **(3) deployed configuration** (which optional integrations are wired + the live `termsVersion`), **(4) a deep‑probe of a real event page** — the slug `selftest.sample` nominates — asserting its **Drive‑access gate** and **removal form** both render (sent with the view cookie so it never inflates metrics) · **security headers** on `/termos` (CSP, HSTS, nosniff, frame, referrer, permissions) · `/dashboard` serves the login form · `/manifest.json` is a complete PWA manifest (name, icons, `start_url`, `theme_color`) · `/icon.svg` + `/og-coming-soon.png` serve with the right type · `/sitemap.xml` is valid XML (`<urlset>`) · `/robots.txt` advertises the sitemap · `/.well-known/security.txt` is RFC 9116‑valid and **not expired** · `/.well-known/gpc.json` is `gpc:true` · `/termos` (LGPD) + `/privacidade` render · the **support form's Turnstile widget** renders (form is submittable) · a **negative routing probe** confirms an unknown path still 404s |
| `fotos.lucafchala.com/dashboard` | login form renders |
| `dash.lucafchala.com` | app renders · `/data.json` is valid JSON with a `redirects` array · **data freshness** (see note below) |
| `paste.lucafchala.com` | app renders · `/pastes.json` is valid JSON with a `pastes` array · **data freshness** |
| `url.lucafchala.com` | app renders · `/data.json` is valid JSON with a `redirects` array · **data freshness** |
| `keys.lucafchala.com` | page renders (content marker) |
| `proof.lucafchala.com` | page renders · `/proof-of-ownership.txt` is present and intact |
| `status.lucafchala.com` *(self)* | dashboard renders · own **`/api/healthz`** parsed — flags `STATUS_KV` / `RESEND_API_KEY` / `NOTIFY_TO` missing (the config drift that silently breaks alerting + subscriptions) and reports subscriber reach · **Resend delivery** verified against the live API (key still accepted, sender domain still verified, latency within budget). A *total* outage can't self‑report — the GitHub Actions monitor's non‑200 is the backstop. |

**On data freshness:** age alone is *not* treated as a failure — a URL shortener can legitimately go months without a new redirect, so a staleness threshold would only manufacture alerts. What is flagged is unambiguous breakage: an **empty collection** (a build that published nothing over real data) or a **timestamp in the future** (a clock or publish bug). The age rides along in the detail (`3 itens · atualizado há 2d`) so a pipeline that quietly stopped is still visible at a glance.

**On alert delivery:** the Resend check validates the key against the `/domains` endpoint rather than sending a test message. A real send per sweep would burn the free tier's 100 e‑mails/day and put an alert in the inbox every ten minutes — the opposite of what a monitor should do.

The dashboard shows each service's checks in an expandable panel: a healthy service collapses behind a `N verificações ok` toggle, while any service with a failing check **auto‑expands** so the problem is never hidden. Each service row also carries its **recent‑incident note** (`esteve offline há 3h · durou 1h`), which is the piece a live‑only dashboard structurally can't give you: whether a problem is new or the same one from earlier. fotos gets **intentionally overkill** coverage: 17 functional checks where the service status is the *worst* of all of them, and every failing check is named individually (both in the panel and in the alert email, which now lists **all** of a service's problems, not just the first). Beyond infra liveness, the sweep flags **things that went wrong in the app itself** — a Drive link that broke on a published event, a bad edit that duplicated a slug, a form whose Turnstile/Resend backend is unset, the Drive‑access gate or removal form failing to render — by mining fotos' own `auditSite` self‑test plus a deep‑probe of a real event page. Its `/api/healthz` exposes a deep payload — `{ ok, kv, events, d1, hashMs, kvLatencyMs, d1LatencyMs, cron, selftest, config, colo, … }` — fetched **once** per sweep (under the 10/min healthz rate limit) and dissected into the four rows above. The payload is **KV-frugal** (two reads: `events` + the cron heartbeat; the self‑test reuses the already‑loaded events array) despite its depth, the security-header check targets the static `/termos` page, and the event‑page probe carries the per‑event view cookie — so neither adds a KV read or pollutes view metrics.

---

## Prerequisites

- **Node.js** and **[Wrangler](https://developers.cloudflare.com/workers/wrangler/)** (`npx wrangler`) to run Pages Functions locally and to bind KV/secrets.
- A **Cloudflare** account with:
  - a Pages project connected to this repo, and
  - a **KV namespace** bound as `STATUS_KV`.
- A **[Resend](https://resend.com)** account + API key, with the `NOTIFY_FROM` sender domain verified, for email features.

The dashboard's status checks work with **no** configuration; only the email subscription/alert features require the variables below.

## Configuration

Set as Pages environment variables / secrets (and via `.dev.vars` for local `wrangler pages dev`):

| Name | Type | Required for | Description |
|---|---|---|---|
| `RESEND_API_KEY` | secret | subscribe, notify | Resend API key used to send welcome + alert emails |
| `NOTIFY_TO` | var | subscribe, notify | Admin address that receives every alert |
| `NOTIFY_FROM` | var | subscribe, notify | Sender address (default `status@lucafchala.com`) — its domain must be verified in Resend |
| `STATUS_KV` | KV binding | subscribe, unsubscribe, notify, history | KV namespace storing `subscribers`, `last_status` and the transition log |
| `ALERT_MIN_SEVERITY` | var | *(optional)* alerting | Severity floor for alert emails: `info` (default — alert on everything), `recuperado`, `atencao` (mutes recovery notices), `critico` (only hard outages). Transitions are logged to history regardless. |
| `CF_API_TOKEN` | secret | *(optional)* quotas, certs | Read‑only Cloudflare API token — **Account › Account Analytics : Read**, **Zone › Zone : Read**, **Zone › SSL and Certificates : Read**. Without it `/api/quota-stats` reports `configured: false` and the panel stays hidden. |
| `CF_ACCOUNT_ID` | var | *(optional)* quotas, certs | Cloudflare account ID the analytics + zone queries are scoped to |

If `STATUS_KV` is missing during a subscribe, the function degrades gracefully (it still emails the admin); if Resend is unreachable, the subscription is still accepted.

### Free-tier limits tracked

The tightest one is **1,000 KV writes/day, shared account‑wide with the fotos site** — exhausting it doesn't fail loudly, writes just start erroring, which is why the headroom is on the dashboard at all. Also tracked: KV reads (100k/day), deletes and lists (1k/day each), KV storage (1 GB), Workers/Pages Functions requests (100k/day) with CPU p99, and D1 rows read/written (5M / 100k per day). Daily windows reset at **UTC midnight**, matching how Cloudflare meters them.

**Quota crossings are alerted, not just coloured.** Each quota (and each zone's certificate) is tracked through the *same* pipeline as a service: it enters `last_status`, so crossing 75 % emails at `ATENÇÃO`, crossing 95 % escalates to `CRÍTICO`, and both inherit the per‑name hourly cooldown, the batched email and the transition log. Since the cron already sweeps `/api/status` every 10 minutes, this runs whether or not anyone has the dashboard open — which is the whole point, given the panel is otherwise only true while someone is looking at it.

Quotas are **worsening‑only**: a daily counter falling back to `up` is the UTC‑midnight reset, not a recovery, so it updates the stored state silently instead of emailing "recuperado" every night and filling the 48 h log with clockwork. The next real crossing alerts again.

**Bandwidth is deliberately not tracked** — Cloudflare Pages serves static assets with unlimited bandwidth on the free plan, so there is no quota to report. **Pages builds** (500/month) are also skipped: counting them means paginating every deployment of every project on each sweep, for a limit a personal site never approaches.

Certificate expiry comes from the Cloudflare API rather than the TLS handshake, because a Worker **cannot inspect the peer certificate of its own subrequests** — the certificate‑packs record is both the only first‑party way to see the date and the authoritative one, since it's what Cloudflare renews from.

## Install & run

```bash
git clone https://github.com/lucafchala/status.lucafchala.com.git
cd status.lucafchala.com

# local dev with Functions + bindings
npx wrangler pages dev .            # serves index.html and /api/* functions

# deploy
git push origin main               # Cloudflare Pages builds & deploys automatically
# (or: npx wrangler pages deploy .)
```

Add bindings/secrets in the Cloudflare Pages project settings (or `npx wrangler pages secret put RESEND_API_KEY`).

---

## File structure

```
.
├── index.html                       # Static dashboard: polls /api/*, renders status + latency, theme toggle
├── favicon.svg                      # Status icon (green up-dot on dark bg)
└── functions/
    └── api/
        ├── status.js                # GET  /api/status              — checks 10 first-party sites (incl. the dashboard itself)
        ├── status-history.js        # GET  /api/status-history      — 48h transition log; also owns the log's shape for the writer in status.js
        ├── quota-stats.js           # GET  /api/quota-stats         — Cloudflare free-tier headroom + TLS expiry
        ├── third-party-status.js    # GET  /api/third-party-status  — checks GitHub/Cloudflare/Anthropic/Resend/Google
        ├── subscribe.js             # POST /api/subscribe           — add email to KV + welcome mail
        ├── unsubscribe.js           # GET  /api/unsubscribe?token=…  — remove subscriber
        └── healthz.js               # GET  /api/healthz             — liveness + config probe
```

---

## Design

Uses the shared ecosystem design system — dark `#0d0c0a` / amber `#c08030`, **Cormorant Garamond** + **JetBrains Mono**, light/dark toggle — **extended** with status‑state colors: `--up #4a8c5c`, `--degraded #8c6a20`, `--down #8c3a3a` (dark variant; lighter equivalents under the light theme). Status labels are Portuguese: **online** / **lento** / **offline**. The alert emails reuse the same tokens inline.

➡️ **Canonical tokens, fonts, and components:** [lucafchala.com → Design System](https://github.com/lucafchala/lucafchala.com#design-system).

---

## Status

**In production**, with a few known rough edges tracked in‑repo:

- [ ] subscribe → KV storage error path needs hardening
- [ ] surface status dots on the `dash` page
- [ ] subscribe button layout fix
- [ ] latency trending (p50/p95/p99 over 24 h) — would need a rolling sample store in KV, so it's gated on write budget
- [ ] deeper security‑header validation (parse CSP/HSTS *values*, not just presence)
