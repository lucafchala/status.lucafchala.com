# status.lucafchala.com

> The live status dashboard for the `lucafchala.com` network — checks every first‑party site (and the third‑party services they depend on), shows online / slow / offline with latency, and emails subscribers when something changes.

**Live:** [status.lucafchala.com](https://status.lucafchala.com) · **Stack:** static page + Cloudflare Pages Functions · **Persistence:** Workers KV + D1 (optional, `STATUS_DB`) · **Email:** Resend

Part of the [lucafchala.com ecosystem](https://github.com/lucafchala/lucafchala.com#the-ecosystem). Shared design system and conventions live in the [hub README](https://github.com/lucafchala/lucafchala.com#readme).

---

## What it is

**One sentence:** `status.lucafchala.com` is a static dashboard (`index.html`) backed by a handful of Cloudflare Pages Functions that health‑check the ecosystem's subdomains plus their upstream providers, and let visitors subscribe by email to outage notifications.

**In a paragraph:** The browser loads a single static page that makes **two** calls per refresh — `/api/status` and `/api/painel` (which bundles what used to be four calls: `/api/third-party-status`, `/api/quota-stats`, `/api/status-history` and `/api/latency-trends`, all still available on their own). It refreshes when the next scheduled sweep should have landed (every 2–10 min, not every 60 s), **pauses while the tab is hidden**, backs off on errors, and shows the age of the data it is displaying. The first probes thirteen first‑party services — the twelve `*.lucafchala.com` services and the dashboard itself; the second checks the public status APIs of the providers the network relies on (GitHub, Cloudflare, Anthropic/Claude, Resend, Google); the third reports how much of the Cloudflare free tier is left; the fourth is the 48‑hour transition log, which is what lets a green dashboard still answer *"was this already broken an hour ago?"*; the fifth is the 48‑hour response‑time trend, which answers the one before that — *"is this getting slower?"* — while everything is still green. Change detection and alert email run **server-side** inside each fresh `/api/status` sweep. Visitors can subscribe (`/api/subscribe`) and unsubscribe (`/api/unsubscribe`); subscriber emails live in a Cloudflare KV namespace. This is the only repo in the network with real serverless endpoints — everything else is static or a single Worker.

---

## Architecture

```
            ┌────────────────────────── browser (index.html) ──────────────────────────┐
            │  on load + every 2–10 min (paused when hidden): GET /api/status, /api/painel│
            │  subscribe form:       POST /api/subscribe       (unsub link → GET /api/unsubscribe shows,
            │                                                          POST performs — RFC 8058 one-click)
            └───────────────────────────────────┬───────────────────────────────────────┘
                                                 │  Cloudflare Pages Functions (/functions/api/*)
                          ┌──────────────────────┼─────────────────────────┐
                          ▼                       ▼                         ▼
                  health-check fetches     Resend API (email)         Workers KV (STATUS_KV)
                  to *.lucafchala.com       api.resend.com            subscribers, last_status,
                  & provider status APIs                              notify_sent:{name}
```

- **Static front end:** `index.html` (markup only) + `app.css` + `app.js` + `tema.js` (the theme, applied synchronously in `<head>` so the page doesn't flash) render the dashboard and persist `theme` in `localStorage`. **No inline script, no inline style, no `on…` attribute, no third-party resource** — clicks go through one delegated listener keyed by `data-action` — so the CSP in `_headers` is `script-src 'self'; style-src 'self'; font-src 'self'` with no `'unsafe-inline'`. `tests/pagina.test.mjs` pins the files to that; a real browser is the actual check (an inline handler brought back shows up as "Refused to execute inline event handler" and a dead button).
- **Fonts from our own origin:** Cormorant Garamond and JetBrains Mono as variable WOFF2 (Latin subset, ~117 KB for all three files) in `fonts/`, with a content hash in the file name, served `immutable`, the two faces used above the fold preloaded, `font-display: swap`. Google Fonts is gone from the page and the CSP — every visit used to hand the visitor's IP to Google, which fotos already stopped doing for the same reason (LGPD). Licenses (OFL) sit next to the files.
- **Serverless back end:** Pages Functions under `functions/api/` (routes derive from file paths). `/api/status` is edge-cached for 30 s (`s-maxage`), so concurrent viewers share one upstream sweep per colo; `/api/painel` for 60 s and `/api/third-party-status` for 2 min, both under a **fixed** cache key so a random query string can't bust the cache and fan out requests to the providers.
- **Polling cost:** the page used to call five endpoints every 60 s whether or not anyone was looking — one forgotten tab was ~7,200 Pages Function invocations and ~24k requests on the fotos Worker a day. Now: two calls, timed to the scheduler (≤ 144 refreshes/day for a tab that stays visible), zero while hidden, exponential backoff (2 → 4 → … → 30 min) when the server doesn't answer. A failed refresh keeps the last known state on screen and says it's stale, instead of painting every service "offline".
- **Shared snapshot (D1, optional):** with the `STATUS_DB` binding, every sweep is written to D1 (`functions/api/retrato.js`) and **visitors read the last snapshot instead of sweeping** — a sweep costs ~38 subrequests and 17 requests on the fotos Worker, so without this the monitor's cost grew with its audience. Only a request that says who it is (`?source=cloudflare-cron`, `?source=gha-cron`, `?varrer`) sweeps, and only through a **global lock in D1** (an atomic conditional `UPDATE`): at most one sweep every 4 min for the whole account, however many requests arrive — no shared secret needed. If the snapshot is older than 20 min (scheduler late or dead), the next visitor's request can sweep once, through the same lock, so the page corrects itself without the cost scaling with visitors. The same rows feed the 48 h latency series (one sample per sweep, zero KV writes), 24 h/48 h uptime, and a per‑service **daily aggregate for 90‑day history bars**. The schema creates itself on first use; the owner only creates the database and binds it. **Without `STATUS_DB` nothing changes:** visitors sweep as before (30 s edge cache + per‑isolate floor), latency stays in KV, and history bars are rebuilt at zero cost from the 48 h transition log (48 hourly bars). A D1 error falls back to that same path — never a 500.
- **Change detection runs server-side**: each fresh `/api/status` sweep is compared against `last_status` in KV; transitions email the admin + subscribers (Resend batch), throttled to one alert per service per hour via `notify_sent:{name}` keys. Nothing a client sends can trigger or shape an email.
- **Scheduled sweeps (no browser needed):** `detectAndNotify` only runs inside a sweep, so with nobody viewing the page someone else has to ask for one. That is the **scheduler** (`agendador/`): a Worker with nothing but a Cloudflare **Cron Trigger every 10 minutes**, which requests `/api/status?source=cloudflare-cron` (custom domain first, the `pages.dev` address if a zone rule ever blocks it). It replaces the GitHub Actions cron as the thing that sweeps, because **GitHub does not honour a 10‑minute schedule**: in September 2026 it fired 5–8 times a day (median gap 3 h 20, worst 7 h — issue #38), so an incident could take hours to reach the inbox, and GitHub silently disables schedules in public repos after 60 days without a commit. The Worker has no route and no `workers.dev` URL. It must be deployed once by the owner (see `agendador/wrangler.toml`); until then, nothing changes.
- **Who watches the watcher:** `.github/workflows/monitor.yml` became the **watchdog** (`scripts/vigia.mjs`). It lives outside Cloudflare on purpose — the only observer that survives an account-level problem. It reads `/api/retrato` (age only, sweeps nothing) and: with the scheduler on time, does **nothing**; with the scheduler's last sweep older than 30 min, requests a rescue sweep **and fails the job** — GitHub emails the owner when a scheduled workflow fails, and that email is the alarm's alarm; with no scheduler deployed yet (or no `STATUS_DB`), it *is* the scheduler, as it always was. Each run also re‑enables its own workflow through the API, the commit‑free keep‑alive against the 60‑day rule (best effort; the Cloudflare scheduler has no such limit). The 1 h-per-service alert cooldown means an extra sweep never duplicates emails. KV writes stay low because `detectAndNotify` writes `last_status` only on an actual change — a steady all-green sweep costs **zero** KV writes.
- **State (KV):** `subscribers` `[{ email, token, subscribedAt }]`, `last_status` `{name: status}` (services **and** `cota · …` / `TLS · …` rows, so quota crossings alert through the same path), `history` `[{ name, from, to, at, severity, problems }]` (newest‑first, 48 h window, capped at 60 entries), `notify_sent:{name}` cooldown markers (TTL 1 h).
- **Transition log:** written inside the same `changed` branch that updates `last_status`, so it costs **one extra KV write per real transition and nothing in steady state**. It is recorded even when email is unconfigured — the log is a record of what happened, not a side effect of alerting.
- **Free-tier headroom:** `/api/quota-stats` reads the Cloudflare GraphQL Analytics API for KV ops/storage, Workers requests/CPU and D1 rows, plus certificate expiry from the zone's certificate packs. It needs a read‑only API token; without one the panel is **hidden entirely** rather than showing zeros, since "unmonitored" must not look like "fine".

### Endpoints

| Route | Method | Behavior | Needs |
|---|---|---|---|
| `/api/status` | GET | **Functional** health‑checks of the 13 first‑party services in parallel (GET, 10 s timeout). Each service has a primary availability probe (status code + latency + a content marker proving the right page rendered) plus optional sub‑checks — running server‑side means it can read response bodies cross‑origin, which the browser can't. Returns `{ services: [{ name, url, status, statusCode, rt, checks, problems }], checkedAt }`, where `checks` is `[{ label, status, detail }]` and `problems` is a list of human‑readable failures. A service's status is the **worst** of all its checks. **Base rules:** HTTP ≥ 500 → `down`; 400–499, slow (`rt` > 2500 ms), unexpected/empty content, missing data files, or a failing `/api/healthz` → `degraded`/`down`. Edge-cached 30 s. On fresh sweeps, also runs server-side change detection + alert emails (which list **every** failing check for a changed service, not just the first). | (emails need `RESEND_API_KEY`, `NOTIFY_TO`, `STATUS_KV`) |
| `/api/third-party-status` | GET | Checks provider status pages (GitHub, Cloudflare, Anthropic, Resend, Google Cloud), 8 s timeout, with provider‑specific parsing (e.g. Cloudflare filtered to Brazil PoPs). Edge-cached 2 min under a fixed key. | — |
| `/api/painel` | GET | Everything the page reads, in one call: `{ status, terceiros, cotas, historico, latencia, barras, uptime, retratoCompartilhado, geradoEm }`. With `STATUS_DB`, `status` is the shared snapshot **read** (never swept here), `barras` are 90 daily bars and `uptime` is per sweep from D1 — one call per refresh. Without it, `status` is `null` (the page calls `/api/status`), and `barras` (48 hourly) and `uptime` are rebuilt from the transition log. Bars are normalized to one shape (`periodos[]` + per service `[{ estado, pct }]`; `estado: null` = no data, never green by omission) — each section is what the standalone endpoint returns, and a section that fails becomes `{ erro }` without taking the others down. The sweep stays out on purpose: the subrequest ceiling (50/invocation on the free plan) is per invocation, and a sweep (~38) plus providers (~6) plus the Cloudflare API (~6) would hit it with a cold cache. Edge-cached 60 s. | (sections as below) |
| `/api/subscribe` | POST | Adds an email to KV (with a UUID token), sends a welcome email via Resend. Returns `{ ok, already }`. **The only public endpoint that writes KV *and* makes a third party send mail to an address the caller chooses** — so it is gated: same‑site check (`Sec-Fetch-Site`, inforjável por script), a per‑IP throttle held in isolate memory, and a hard cap of 2000 subscribers. Errors never name a missing binding and never echo Resend's raw response body; both go to the log instead. | `RESEND_API_KEY`, `NOTIFY_TO`, `NOTIFY_FROM`, `STATUS_KV` |
| `/api/unsubscribe?token=…` | GET / POST | **GET only shows a confirmation page — it changes nothing.** GET is defined as safe (RFC 9110 §9.2.1), and the infrastructure this link travels through acts on that: corporate mail scanners, link previews and browser prefetch all open every URL in a message, and each of them used to unsubscribe the reader before they had read it. The **POST** performs the removal, which is also the shape RFC 8058 specifies for the mail client's native unsubscribe button — so one click still does it, it just can't be triggered by anyone but the person. Repeating the POST is success, not an error. | `STATUS_KV` |
| `/api/status-history` | GET | The 48 h transition log: `{ entries, services, flapping, worstSeverity }`. `services[name].lastIncident` gives severity, start, duration, whether it's resolved and how long ago — the context a live‑only dashboard structurally can't show. `flapping` names services with ≥ 4 transitions in the window, the failure a 60‑second poll hides best. Corrupt KV reads as an empty log, never a 500. Edge-cached 30 s. | `STATUS_KV` |
| `/api/quota-stats` | GET | Cloudflare free‑tier headroom (KV writes/reads/deletes/lists + storage, Workers requests + CPU p99, D1 rows) and TLS certificate expiry per zone. Each dataset is queried separately so one unreadable dataset costs that row only, not the panel; a dataset that fails reports `status: unknown` (never `up`) and is listed in `errors[]`. A certificate the token can't read (missing **SSL and Certificates : Read** scope) is also `unknown` with the reason — not `degraded`, which would invent a certificate problem — and stays out of change detection. Warns at 75 % of a limit, critical at 95 %; certificates flag under 30 days. Edge-cached 5 min. Answers `configured: false` when the API token is absent. | `CF_API_TOKEN`, `CF_ACCOUNT_ID` |
| `/api/latency-trends` | GET | Response‑time trend per service over 48 h: `{ services, worsening, entries, samples }`. `services[name]` carries `p50/p95/p99`, `min/max` and a `trend` comparing the recent half of the window against the older half. Answers the question a live dashboard structurally can't — not *"is it slow?"* but *"is it **getting** slow?"* — since a service that drifts from 300 ms to 1800 ms is still green and still the earliest warning available. Measures nothing new: `rt` is already taken every sweep and was simply discarded. Written at most **once every ~30 min** (~48 KV writes/day, never more than 50, ~5 % of the free‑tier quota), decided by the **age of the newest sample** rather than by the wall clock — a clock window both missed samples when the cron ran late (3 samples in 48 h in production) and wrote several per window with the dashboard open. Corrupt KV reads as an empty series, never a 500. Edge-cached 2 min. | `STATUS_KV` |
| `/api/retrato` | GET | Age of the shared snapshot only: `{ configurado, em, origem, idadeMs, atrasado, ttlMs, agendador: { ultimaEm, idadeMs } }` (`no-store`) — `agendador` is the scheduler's own last sweep, so the watchdog can tell "the scheduler stopped" from "visitors kept the snapshot fresh". What an outside watchdog polls to learn the scheduler died, without sweeping or downloading the snapshot. `configurado: false` without `STATUS_DB`. | `STATUS_DB` |
| `/api/healthz` | GET | Liveness + config probe: `{ ok, kv, resendKey, notifyTo, subscribers, cloudflareApi }`. The one KV read does double duty — it proves the binding answers *and* reports how many people would actually receive an alert. | — |

### Monitored first‑party services & their functional checks

All probed with GET, following redirects, 10 s timeout, on every sweep (each cron tick, plus visitor polls that miss the edge cache). Beyond "did it answer", each service is verified for what it's *supposed to do*:

| Service | Functional checks (beyond a 2xx) |
|---|---|
| `lucafchala.com` | homepage renders (content marker) |
| `radio.lucafchala.com` | page renders (content marker) |
| `fotos.lucafchala.com` | **deliberately exhaustive (19 checks: the availability probe + 18) and the only service held to a tighter latency SLA** (1500 ms vs. the shared 2500 ms budget — see `FOTOS_DEGRADED_MS`) — gallery **shell** renders (homepage content marker) *and* the gallery actually **painted event cards** (a separate check for `data-title="` on real card markup — catches an empty grid rendering behind a healthy shell, which the shell marker alone can't) · **`/api/healthz`** fetched once, mined into four rows: **(1) infra** (KV alive + **latency budget**, `events` count — flagged if it hits **zero**, an unambiguous data‑loss/misconfigured‑binding signal — D1 consent log + **its latency**, **daily‑cron heartbeat staleness** — no hash timing: fotos dropped `hashMs` because the Workers clock is frozen during synchronous work and the number was always 0), **(2) functional self‑test** (fotos' own `auditSite` over its live data: **broken/missing Google Drive links** on published events = Drive access down, **bad data** like duplicate slugs / invalid status, and **form backends** Turnstile/Resend/`ADMIN_EMAIL` being unset), **(3) deployed configuration** (which optional integrations are wired + the live `termsVersion`), **(4) a deep‑probe of a real event page** — the slug `selftest.sample` nominates — asserting its **Drive‑access gate**, **removal form**, and **`og:title` share‑preview tag** (protects the WhatsApp/Instagram link‑preview experience) all render (sent with the view cookie so it never inflates metrics) · **security headers on `/termos`, parsed at the VALUE level, not just presence** — the literal CSP directives, the HSTS `max-age` + `includeSubDomains`, the exact `X-Frame-Options`/`Referrer-Policy`/`Permissions-Policy` values against what `html()` in `src/index.js` actually deploys, so a header that's present but quietly weakened is caught, not just one that's missing · `/dashboard` serves the login form · `/manifest.json` is a complete PWA manifest (name, icons, `start_url`, `theme_color`) · `/icon.svg` + `/og-coming-soon.png` serve with the right type · `/sitemap.xml` is valid XML (`<urlset>`) · `/robots.txt` advertises the sitemap · `/.well-known/security.txt` is RFC 9116‑valid and **not expired** · `/.well-known/gpc.json` is `gpc:true` · `/termos` (LGPD) + `/privacidade` render · the **support form's Turnstile widget** renders (form is submittable) · a **negative routing probe** confirms an unknown path still 404s |
| `fotos.lucafchala.com/dashboard` | login form renders |
| `dash.lucafchala.com` | app renders · `/data.json` is valid JSON with a `redirects` array · **data freshness** (see note below) |
| `paste.lucafchala.com` | app renders · `/pastes.json` is valid JSON with a `pastes` array · **data freshness** |
| `url.lucafchala.com` | app renders · `/data.json` is valid JSON with a `redirects` array · **data freshness** |
| `keys.lucafchala.com` | page renders (content marker) |
| `proof.lucafchala.com` | page renders · `/proof-of-ownership.txt` is present and intact |
| `rg.lucafchala.com` | page renders (content marker on the PIN gate — everything past the gate needs the PIN, so there's no deeper functional check to add) |
| `pays.lucafchala.com` | page renders (content marker) — static, client‑side‑only (`localStorage`), no API of its own |
| `treino.lucafchala.com` | page renders (content marker) — static single‑page tool, no backend |
| `status.lucafchala.com` *(self)* | dashboard renders · own **`/api/healthz`** parsed — flags `STATUS_KV` / `RESEND_API_KEY` / `NOTIFY_TO` missing (the config drift that silently breaks alerting + subscriptions) and reports subscriber reach · **Resend delivery** verified against the live API (key still accepted, sender domain still verified, latency within budget). A *total* outage can't self‑report — the GitHub Actions monitor's non‑200 is the backstop. |

**The fotos healthz contract:** every field this dashboard reads from fotos' `/api/healthz` is written in one place — [`docs/healthz-contrato.json`](https://github.com/lucafchala/fotos/blob/main/docs/healthz-contrato.json) in the fotos repo (field types, allowed values, fields removed on purpose, and an example payload), with `contrato: N` in the payload itself. fotos' test pins its real healthz to that file in both directions; here, `tests/contrato.test.mjs` downloads it (on every push, PR and **weekly** — fotos can change it without touching this repo) and runs the fotos parsers over the example wrapped in a `Proxy` that **discovers every field they read**, failing if one isn't in the contract (a hand-written list would be a third copy to drift, the way the README kept `hashMs` for months). A payload with a contract number this dashboard doesn't know turns the "configuração implantada" row **degraded** — an unknown meaning is not "ok". The same row shows the deployed fotos version (`versao.tag`, the commit's short SHA, from Cloudflare's version metadata), and with `STATUS_DB` each sweep stores it, so `/api/painel` lists the deploys in the 48 h window (`implantacoes`) for the timeline.

**What a sweep costs fotos, and why it's 5 requests, not 17:** the probes of things that live in fotos' Worker **bundle** — static pages (`/termos`, `/privacidade`, `/suporte`), manifest, icons, `robots.txt`, `gpc.json`, `security.txt`, the 404 route, `/dashboard` and the security-header values — only change with a deploy, and every fotos deploy already runs its own 52-check smoke. So they run when the **deployed version** (`versao.id` in fotos' healthz) changes or every 3 h (`ESTATICAS_TTL_MS`); in between, the row is the previous sweep's, with the time it was really checked (`verificadoEm`). A row that was failing is re-checked every sweep, so recovery shows at once; with no known version, nothing is reused. The previous sweep comes from the D1 snapshot, or from the isolate's last sweep without it. Deep probes (`/api/healthz`, the event page) go to **`fotos.lucafchala.workers.dev`** — the same Worker without the zone's WAF/bot rules — while the availability probe, headers and pages stay on the custom domain, which is what visitors hit. A new row, **`domínio próprio × workers.dev`**, says *where* a failure is: custom domain 403/429 with the Worker healthy is the zone blocking (not the site); no answer on the domain with the Worker healthy is route/DNS/TLS; both failing is the site. Dash, Paste and URL fetch their data file **once** for both of their rows. Net: fotos requests per sweep 17 → 5 (17 on the first sweep after a deploy), subrequests per sweep ~38 → ≤ 24 — counted in `tests/custo.test.mjs`.

**On data freshness:** age alone is *not* treated as a failure — a URL shortener can legitimately go months without a new redirect, so a staleness threshold would only manufacture alerts. What is flagged is unambiguous breakage: an **empty collection** (a build that published nothing over real data) or a **timestamp in the future** (a clock or publish bug). The age rides along in the detail (`3 itens · atualizado há 2d`) so a pipeline that quietly stopped is still visible at a glance.

**On alert delivery:** the Resend check validates the key against the `/domains` endpoint rather than sending a test message. A real send per sweep would burn the free tier's 100 e‑mails/day and put an alert in the inbox every ten minutes — the opposite of what a monitor should do.

The dashboard shows each service's checks in an expandable panel: a healthy service collapses behind a `N verificações ok` toggle, while any service with a failing check **auto‑expands** so the problem is never hidden. Each service row also carries its **recent‑incident note** (`esteve offline há 3h · durou 1h`), which is the piece a live‑only dashboard structurally can't give you: whether a problem is new or the same one from earlier. fotos gets **intentionally overkill** coverage: 18 functional checks on top of the availability probe where the service status is the *worst* of all of them, and every failing check is named individually (both in the panel and in the alert email, which now lists **all** of a service's problems, not just the first). It's also the only service with its own tighter latency budget (`FOTOS_DEGRADED_MS` = 1500 ms vs. everyone else's shared 2500 ms) — proportional to being the most‑used service in the suite, "up" for fotos means noticeably faster than "up" for anything else. Beyond infra liveness, the sweep flags **things that went wrong in the app itself** — a Drive link that broke on a published event, a bad edit that duplicated a slug, a form whose Turnstile/Resend backend is unset, the Drive‑access gate/removal form/share‑preview tag failing to render, a gallery shell that loads but paints zero event cards, a healthz reporting zero events — by mining fotos' own `auditSite` self‑test, a deep‑probe of a real event page, and a content‑depth check of the homepage itself. Its `/api/healthz` exposes a deep payload — `{ ok, kv, events, d1, kvLatencyMs, d1LatencyMs, cron, selftest, config, termsVersion, colo, … }` — fetched **once** per sweep (fotos doesn't rate-limit it; one fetch is simply one less request on fotos per row) and dissected into the four rows above. A 429 from it is reported as **degraded**: fotos never sends one, so it means a layer in front of the Worker is blocking. The payload is **KV-frugal** (two reads: `events` + the cron heartbeat; the self‑test reuses the already‑loaded events array) despite its depth; the security‑header check parses real directive *values* (not just presence) against the policy `html()` deploys in `src/index.js`; and the event‑page probe carries the per‑event view cookie — so none of this adds a KV read or pollutes view metrics.

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
| `STATUS_DB` | D1 binding | *(optional)* shared snapshot, bars, uptime | D1 database for the shared snapshot and the per-sweep series (`functions/api/retrato.js` creates the tables on first use). Without it, visitors sweep as before and bars come from the transition log. ~16 rows written per sweep (≈2.3k/day at a 10‑min scheduler, ~2 % of the free tier's 100k) |
| `ALERT_MIN_SEVERITY` | var | *(optional)* alerting | Severity floor for alert emails: `info` (default — alert on everything), `recuperado`, `atencao` (mutes recovery notices), `critico` (only hard outages). Transitions are logged to history regardless. |
| `CF_API_TOKEN` | secret | *(optional)* quotas, certs | Read‑only Cloudflare API token — **Account › Account Analytics : Read**, **Zone › Zone : Read**, **Zone › SSL and Certificates : Read**. Without it `/api/quota-stats` reports `configured: false` and the panel stays hidden. |
| `CF_ACCOUNT_ID` | var | *(optional)* quotas, certs | Cloudflare account ID the analytics + zone queries are scoped to |

If `STATUS_KV` is missing during a subscribe, the function degrades gracefully (it still emails the admin); if Resend is unreachable, the subscription is still accepted.

### Free-tier limits tracked

The tightest one is **1,000 KV writes/day, shared account‑wide with the fotos site** — exhausting it doesn't fail loudly, writes just start erroring, which is why the headroom is on the dashboard at all. Also tracked: KV reads (100k/day), deletes and lists (1k/day each), KV storage (1 GB), Workers/Pages Functions requests (100k/day) with CPU p99, and D1 rows read/written (5M / 100k per day). Daily windows reset at **UTC midnight**, matching how Cloudflare meters them.

**Quota crossings are alerted, not just coloured.** Each quota (and each zone's certificate) is tracked through the *same* pipeline as a service: it enters `last_status`, so crossing 75 % emails at `ATENÇÃO`, crossing 95 % escalates to `CRÍTICO`, and both inherit the per‑name hourly cooldown, the batched email and the transition log. Since the scheduler sweeps `/api/status` every 10 minutes, this runs whether or not anyone has the dashboard open — which is the whole point, given the panel is otherwise only true while someone is looking at it.

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

```bash
# tests — executor embutido do Node, sem dependência nenhuma
node --test tests/*.test.mjs
```

Add bindings/secrets in the Cloudflare Pages project settings (or `npx wrangler pages secret put RESEND_API_KEY`).

---

## File structure

```
.
├── index.html                       # Static dashboard markup (no inline script/style — strict CSP)
├── app.js / app.css / tema.js       # The dashboard's script, styles, and the pre-paint theme
├── cancelar.css                     # Styles of the unsubscribe page (a Function; same strict CSP)
├── fonts/                           # Self-hosted variable WOFF2 (content-hashed names) + OFL licenses
├── agendador/                       # The scheduler: a Worker with only a Cron Trigger (*/10) that requests a sweep
│   ├── index.js                     #   entry — exports only the handler (workerd rejects any other export)
│   ├── varrer.js                    #   the request, with pages.dev fallback
│   └── wrangler.toml                #   deployed once by the owner (Workers Builds with root dir `agendador`, or `npx wrangler deploy`)
├── scripts/vigia.mjs                # The watchdog run by .github/workflows/monitor.yml
├── favicon.svg                      # Status icon (green up-dot on dark bg)
└── functions/
    └── api/
        ├── status.js                # GET  /api/status              — checks 13 first-party services (incl. dashboard)
        ├── painel.js                # GET  /api/painel              — everything the page reads, in one call
        ├── retrato.js               # GET  /api/retrato             — snapshot age; owns the D1 schema, the global sweep lock and the bars
        ├── status-history.js        # GET  /api/status-history      — 48h transition log; also owns the log's shape for the writer in status.js
        ├── quota-stats.js           # GET  /api/quota-stats         — Cloudflare free-tier headroom + TLS expiry
        ├── latency-trends.js        # GET  /api/latency-trends      — 48h response-time percentiles + trend; owns the series' shape for the writer in status.js
        ├── third-party-status.js    # GET  /api/third-party-status  — checks GitHub/Cloudflare/Anthropic/Resend/Google
        ├── subscribe.js             # POST /api/subscribe           — add email to KV + welcome mail (same-site + per-IP throttle + cap)
        ├── unsubscribe.js           # GET  shows the confirmation, POST performs it (RFC 9110 §9.2.1 / RFC 8058)
        └── healthz.js               # GET  /api/healthz             — liveness + config probe
└── tests/
    ├── functions.test.mjs           # node --test — the controls that fail silently, asserted
    ├── monitor.test.mjs             # how the sweep reads what it probes, and what it costs in KV writes
    ├── painel.test.mjs              # /api/painel: subrequest budget, isolated sections, fixed cache key
    ├── retrato.test.mjs             # shared snapshot: visitors read, the lock bounds sweeps, bars never green by omission
    ├── agendador.test.mjs           # scheduler + watchdog: every branch of "is the alarm alive?"
    ├── contrato.test.mjs            # what status.js reads from fotos' healthz vs. the contract fotos publishes
    ├── custo.test.mjs               # what one sweep costs, counted request by request
    ├── pagina.test.mjs              # the static page and the unsubscribe page vs. the strict CSP
    └── d1.mjs                       # D1 over real SQLite (node:sqlite) for the tests
```

---

## Design

Uses the shared ecosystem design system — dark `#0d0c0a` / amber `#c08030`, **Cormorant Garamond** + **JetBrains Mono** (self-hosted, see above), light/dark toggle — **extended** with status‑state colors: `--up #4a8c5c`, `--degraded #8c6a20`, `--down #8c3a3a` (dark variant; lighter equivalents under the light theme). Status labels are Portuguese: **online** / **lento** / **offline**. The alert emails reuse the same tokens inline.

➡️ **Canonical tokens, fonts, and components:** [lucafchala.com → Design System](https://github.com/lucafchala/lucafchala.com#design-system).

---

## Status

**In production**, with a few known rough edges tracked in‑repo:

- [ ] subscribe → KV storage error path needs hardening
- [ ] surface status dots on the `dash` page
- [ ] subscribe button layout fix
- [ ] latency trending (p50/p95/p99 over 24 h) — would need a rolling sample store in KV, so it's gated on write budget
- [ ] deeper security‑header validation (parse CSP/HSTS *values*, not just presence) — done for fotos (its highest‑priority sub‑check parses real directive values against the deployed policy); still presence‑only for the other services

No external/third‑party monitor is used — by design. This dashboard shares
infrastructure with everything it checks, so it is a single point of failure
for an account‑wide outage; that trade‑off is accepted in exchange for
keeping monitoring entirely first‑party (see `fotos/TODO.md` → *Decidido não
fazer*). fotos.lucafchala.com gets deliberately disproportionate depth to
compensate, on the theory that the most‑used service in the suite should be
the hardest one to break silently.
