# status.lucafchala.com

> The live status dashboard for the `lucafchala.com` network — checks every first‑party site (and the third‑party services they depend on), shows online / slow / offline with latency, and emails subscribers when something changes.

**Live:** [status.lucafchala.com](https://status.lucafchala.com) · **Stack:** static page + Cloudflare Pages Functions · **Persistence:** Workers KV · **Email:** Resend

Part of the [lucafchala.com ecosystem](https://github.com/lucafchala/lucafchala.com#the-ecosystem). Shared design system and conventions live in the [hub README](https://github.com/lucafchala/lucafchala.com#readme).

---

## What it is

**One sentence:** `status.lucafchala.com` is a static dashboard (`index.html`) backed by a handful of Cloudflare Pages Functions that health‑check the ecosystem's subdomains plus their upstream providers, and let visitors subscribe by email to outage notifications.

**In a paragraph:** The browser loads a single static page that, on load and then every 60 seconds, calls `/api/status` and `/api/third-party-status`. The first probes the nine first‑party `*.lucafchala.com` sites; the second checks the public status APIs of the providers the network relies on (GitHub, Cloudflare, Anthropic/Claude, Resend, Google). When the page detects a service *changing* state, it calls `/api/notify-all`, which emails the admin and every subscriber via Resend. Visitors can subscribe (`/api/subscribe`) and unsubscribe (`/api/unsubscribe`); subscriber emails live in a Cloudflare KV namespace. This is the only repo in the network with real serverless endpoints — everything else is static or a single Worker.

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
- **State (KV):** `subscribers` `[{ email, token, subscribedAt }]`, `last_status` `{name: status}`, `notify_sent:{name}` cooldown markers (TTL 1 h).

### Endpoints

| Route | Method | Behavior | Needs |
|---|---|---|---|
| `/api/status` | GET | **Functional** health‑checks of the 9 first‑party sites in parallel (GET, 10 s timeout). Each service has a primary availability probe (status code + latency + a content marker proving the right page rendered) plus optional sub‑checks — running server‑side means it can read response bodies cross‑origin, which the browser can't. Returns `{ services: [{ name, url, status, statusCode, rt, checks, problems }], checkedAt }`, where `checks` is `[{ label, status, detail }]` and `problems` is a list of human‑readable failures. A service's status is the **worst** of all its checks. **Base rules:** HTTP ≥ 500 → `down`; 400–499, slow (`rt` > 2500 ms), unexpected/empty content, missing data files, or a failing `/api/healthz` → `degraded`/`down`. Edge-cached 30 s. On fresh sweeps, also runs server-side change detection + alert emails (which list **every** failing check for a changed service, not just the first). | (emails need `RESEND_API_KEY`, `NOTIFY_TO`, `STATUS_KV`) |
| `/api/third-party-status` | GET | Checks provider status pages (GitHub, Cloudflare, Anthropic, Resend, Google Cloud), 8 s timeout, with provider‑specific parsing (e.g. Cloudflare filtered to Brazil PoPs). Edge-cached 30 s. | — |
| `/api/subscribe` | POST | Adds an email to KV (with a UUID token), sends a welcome email via Resend. Returns `{ ok, already }`. | `RESEND_API_KEY`, `NOTIFY_TO`, `NOTIFY_FROM`, `STATUS_KV` |
| `/api/unsubscribe?token=…` | GET | Removes the subscriber matching `token`, returns a small HTML confirmation page. | `STATUS_KV` |
| `/api/healthz` | GET | Liveness + config probe: `{ ok, kv, resendKey, notifyTo }` (booleans only). | — |

### Monitored first‑party services & their functional checks

All probed with GET, following redirects, 10 s timeout, polled every 60 s. Beyond "did it answer", each service is verified for what it's *supposed to do*:

| Service | Functional checks (beyond a 2xx) |
|---|---|
| `lucafchala.com` | homepage renders (content marker) |
| `radio.lucafchala.com` | page renders (content marker) |
| `fotos.lucafchala.com` | **deliberately exhaustive (16 checks)** — gallery renders · **`/api/healthz`** fetched once, mined into three rows: **(1) infra** (KV alive + **latency budget**, `events` count, D1 consent log, PBKDF2 `hashMs`, **daily‑cron heartbeat staleness**), **(2) functional self‑test** (fotos' own `auditSite` over its live data: **broken/missing Google Drive links** on published events = Drive access down, **bad data** like duplicate slugs / invalid status, and **form backends** Turnstile/Resend/`ADMIN_EMAIL` being unset), **(3) a deep‑probe of a real event page** — the slug `selftest.sample` nominates — asserting its **Drive‑access gate** and **removal form** both render (sent with the view cookie so it never inflates metrics) · **security headers** on `/termos` (CSP, HSTS, nosniff, frame, referrer, permissions) · `/dashboard` serves the login form · `/manifest.json` is a complete PWA manifest (name, icons, `start_url`, `theme_color`) · `/icon.svg` + `/og-coming-soon.png` serve with the right type · `/sitemap.xml` is valid XML (`<urlset>`) · `/robots.txt` advertises the sitemap · `/.well-known/security.txt` is RFC 9116‑valid and **not expired** · `/.well-known/gpc.json` is `gpc:true` · `/termos` (LGPD) + `/privacidade` render · the **support form's Turnstile widget** renders (form is submittable) · a **negative routing probe** confirms an unknown path still 404s |
| `fotos.lucafchala.com/dashboard` | login form renders |
| `dash.lucafchala.com` | app renders · `/data.json` is valid JSON with a `redirects` array |
| `paste.lucafchala.com` | app renders · `/pastes.json` is valid JSON with a `pastes` array |
| `url.lucafchala.com` | app renders · `/data.json` is valid JSON with a `redirects` array |
| `keys.lucafchala.com` | page renders (content marker) |
| `proof.lucafchala.com` | page renders · `/proof-of-ownership.txt` is present and intact |

The dashboard shows each service's checks in an expandable panel: a healthy service collapses behind a `N verificações ok` toggle, while any service with a failing check **auto‑expands** so the problem is never hidden. fotos gets **intentionally overkill** coverage: 16 functional checks where the service status is the *worst* of all of them, and every failing check is named individually (both in the panel and in the alert email, which now lists **all** of a service's problems, not just the first). Beyond infra liveness, the sweep flags **things that went wrong in the app itself** — a Drive link that broke on a published event, a bad edit that duplicated a slug, a form whose Turnstile/Resend backend is unset, the Drive‑access gate or removal form failing to render — by mining fotos' own `auditSite` self‑test plus a deep‑probe of a real event page. Its `/api/healthz` exposes a deep payload — `{ ok, kv, events, d1, hashMs, kvLatencyMs, d1LatencyMs, cron, selftest, config, colo, … }` — fetched **once** per sweep (under the 10/min healthz rate limit) and dissected into the three rows above. The payload is **KV-frugal** (two reads: `events` + the cron heartbeat; the self‑test reuses the already‑loaded events array) despite its depth, the security-header check targets the static `/termos` page, and the event‑page probe carries the per‑event view cookie — so neither adds a KV read or pollutes view metrics.

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
| `STATUS_KV` | KV binding | subscribe, unsubscribe, notify | KV namespace storing the `subscribers` list |

If `STATUS_KV` is missing during a subscribe, the function degrades gracefully (it still emails the admin); if Resend is unreachable, the subscription is still accepted.

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
        ├── status.js                # GET  /api/status              — checks 9 first-party sites
        ├── third-party-status.js    # GET  /api/third-party-status  — checks GitHub/Cloudflare/Anthropic/Resend/Google
        ├── subscribe.js             # POST /api/subscribe           — add email to KV + welcome mail
        ├── unsubscribe.js           # GET  /api/unsubscribe?token=…  — remove subscriber
        └── notify-all.js            # POST /api/notify-all          — batch-email on status change
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
