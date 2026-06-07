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
            │  on state change:      POST /api/notify-all                                │
            │  subscribe form:       POST /api/subscribe       (unsub link → GET /api/unsubscribe)
            └───────────────────────────────────┬───────────────────────────────────────┘
                                                 │  Cloudflare Pages Functions (/functions/api/*)
                          ┌──────────────────────┼─────────────────────────┐
                          ▼                       ▼                         ▼
                  health-check fetches     Resend API (email)         Workers KV (STATUS_KV)
                  to *.lucafchala.com       api.resend.com            key "subscribers"
                  & provider status APIs
```

- **Static front end:** `index.html` (inline HTML/CSS/JS) renders the dashboard, persists `theme` in `localStorage`, compares previous vs. current status to detect transitions, and throttles notifications (≈1 hour per service per change).
- **Serverless back end:** five Pages Functions under `functions/api/` (routes derive from file paths).
- **State:** a single KV key, `subscribers`, holding `[{ email, token, subscribedAt }]`.

### Endpoints

| Route | Method | Behavior | Needs |
|---|---|---|---|
| `/api/status` | GET | Health‑checks the 9 first‑party sites in parallel (GET, 10 s timeout). Returns `{ services: [{ name, url, status, statusCode, rt }], checkedAt }`. **Rules:** HTTP ≥ 500 → `down`; 400–499 → `degraded`; `rt` > 2500 ms → `degraded`; else `up`. | — |
| `/api/third-party-status` | GET | Checks provider status pages (GitHub, Cloudflare, Anthropic, Resend, Google Cloud), 8 s timeout, with provider‑specific parsing (e.g. Cloudflare filtered to Brazil PoPs). | — |
| `/api/subscribe` | POST | Adds an email to KV (with a UUID token), sends a welcome email via Resend. Returns `{ ok, already }`. | `RESEND_API_KEY`, `NOTIFY_TO`, `NOTIFY_FROM`, `STATUS_KV` |
| `/api/unsubscribe?token=…` | GET | Removes the subscriber matching `token`, returns a small HTML confirmation page. | `STATUS_KV` |
| `/api/notify-all` | POST | Sent by the page on a detected status change. Emails the admin + all subscribers (Resend batch), each with an unsubscribe link. | `RESEND_API_KEY`, `NOTIFY_TO`, `NOTIFY_FROM`, `STATUS_KV` |

### Monitored first‑party services

`lucafchala.com`, `radio.lucafchala.com`, `fotos.lucafchala.com`, `fotos.lucafchala.com/dashboard`, `dash.lucafchala.com`, `now.lucafchala.com`, `paste.lucafchala.com`, `weblog.lucafchala.com`, `url.lucafchala.com` — GET, following redirects, 10 s timeout, polled every 60 s.

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
