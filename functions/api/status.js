// First-party health checks. Runs server-side (Pages Function) so it can read
// real status codes AND response bodies cross-origin — something the browser
// can't, since none of these subdomains send CORS headers. That lets us verify
// each service actually *works* (renders its page, serves its data, passes its
// own /api/healthz) instead of only confirming "the server answered".
//
// Each service has a primary availability probe (status code + latency + a
// content marker proving the right page rendered) plus optional functional
// sub-checks. A service's overall status is the worst of all its checks, and
// every failing check is reported in `problems` so the dashboard can show
// exactly what broke.

const TIMEOUT_MS  = 10000;
const DEGRADED_MS = 2500;
// fotos hashes the login password with PBKDF2 on the request path; the deploy
// smoke test fails the build above this, so the dashboard flags it as degraded.
const HASH_BUDGET_MS = 200;
// A KV read from inside the worker that takes longer than this is a warning —
// every page render reads KV, so sustained latency here is felt site-wide.
const KV_LATENCY_BUDGET_MS = 400;
// RFC 9116 security.txt should never be within two weeks of its Expires — a
// scanner would flag it, so we flag it first.
const SECTXT_SOON_MS = 14 * 86400_000;

const RANK = { up: 0, degraded: 1, down: 2 };
function worst(a, b) { return RANK[a] >= RANK[b] ? a : b; }

function fetchSvc(url, opts = {}) {
  return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), ...opts });
}

function netDetail(e) {
  return e && e.name === 'TimeoutError' ? 'timeout' : 'sem resposta';
}

// Primary probe: status code + latency, plus an optional content marker so a
// 200 that returns a blank page, a parked placeholder, or a Cloudflare error
// interstitial is caught as degraded instead of passing as "up".
async function probePrimary(url, marker) {
  const start = Date.now();
  try {
    const res = await fetchSvc(url);
    const rt = Date.now() - start;
    const code = res.status;
    if (code >= 500) { res.body?.cancel(); return { status: 'down', statusCode: code, rt, detail: `HTTP ${code}` }; }
    if (code >= 400) { res.body?.cancel(); return { status: 'degraded', statusCode: code, rt, detail: `HTTP ${code}` }; }
    const text = await res.text();
    if (rt > DEGRADED_MS)                 return { status: 'degraded', statusCode: code, rt, detail: `resposta lenta (${rt}ms)` };
    if (text.length < 200)                return { status: 'degraded', statusCode: code, rt, detail: 'resposta vazia' };
    if (marker && !text.includes(marker)) return { status: 'degraded', statusCode: code, rt, detail: 'conteúdo esperado ausente' };
    return { status: 'up', statusCode: code, rt, detail: '' };
  } catch (e) {
    return { status: 'down', statusCode: null, rt: Date.now() - start, detail: netDetail(e) };
  }
}

// A page sub-check: 2xx + (optionally) the right content. 5xx → down, 4xx or a
// missing marker → degraded.
async function checkContent(label, url, { marker, contentType } = {}) {
  try {
    const res = await fetchSvc(url);
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status}` }; }
    if (res.status >= 400) { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status}` }; }
    const ct = res.headers.get('content-type') || '';
    if (contentType && !ct.includes(contentType)) {
      res.body?.cancel();
      return { label, status: 'degraded', detail: `tipo inesperado (${ct.split(';')[0] || 'desconhecido'})` };
    }
    const text = await res.text();
    if (text.length < 50)                 return { label, status: 'degraded', detail: 'resposta vazia' };
    if (marker && !text.includes(marker)) return { label, status: 'degraded', detail: 'conteúdo esperado ausente' };
    return { label, status: 'up', detail: '' };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// A data-file sub-check: must be valid JSON and pass the validator. This is the
// "functional" part for the static sites — it proves the JSON the page renders
// from is present and well-formed, not just that index.html loads.
async function checkJson(label, url, validate) {
  try {
    const res = await fetchSvc(url, { headers: { Accept: 'application/json' } });
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status}` }; }
    if (!res.ok)           { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status}` }; }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { label, status: 'degraded', detail: 'JSON inválido' }; }
    const problem = validate ? validate(json) : null;
    if (problem) return { label, status: problem.status || 'degraded', detail: problem.detail };
    return { label, status: 'up', detail: '' };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// fotos exposes a deep /api/healthz: { ok, kv, events, d1, hashMs, kvLatencyMs,
// cron, selftest, config, colo, … }. We fetch it ONCE per sweep (it's rate-
// limited to 10/min/IP) and derive THREE dashboard rows from that single
// response: infra health, the functional self-test, and a deep-probe of a real
// event page. Fields absent on an older healthz payload are simply skipped, so
// this stays correct even when the two repos deploy independently.
function fetchHealthz(url) {
  return fetchSvc(url, { headers: { Accept: 'application/json' } }).then(async (res) => {
    // healthz is rate-limited; a 429 from our own sweep isn't an outage.
    if (res.status === 429) { res.body?.cancel(); return { rateLimited: true }; }
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; }
    catch { return { status: res.status, parseError: true }; }
  }).catch((e) => ({ netError: netDetail(e) }));
}

// Row 1 — pure infrastructure: KV binding/latency, D1, login hashing, the
// daily-cron heartbeat. (Form/config problems live in the self-test row.)
function healthInfra(label, h) {
  if (h.rateLimited) return { label, status: 'up', detail: 'rate-limited (ignorado)' };
  if (h.netError)    return { label, status: 'down', detail: h.netError };
  if (h.parseError)  return { label, status: 'down', detail: 'healthz sem JSON' };
  const j = h.json;
  if (j.kv === false || j.ok === false) return { label, status: 'down', detail: 'KV indisponível' };
  if (h.status >= 500)                  return { label, status: 'down', detail: `HTTP ${h.status}` };

  const issues = [];
  if (j.d1 === 'down')                                          issues.push('D1 (consentimento) indisponível');
  if (typeof j.hashMs === 'number' && j.hashMs > HASH_BUDGET_MS) issues.push(`hashing lento (${j.hashMs}ms)`);
  if (typeof j.kvLatencyMs === 'number' && j.kvLatencyMs > KV_LATENCY_BUDGET_MS) issues.push(`KV lento (${j.kvLatencyMs}ms)`);
  if (j.cron && j.cron.stale === true)                          issues.push(`cron parado (${j.cron.ageHours}h sem rodar)`);
  if (issues.length) return { label, status: 'degraded', detail: issues.join(' · ') };

  const bits = [];
  if (typeof j.events === 'number') bits.push(`${j.events} eventos`);
  if (typeof j.hashMs === 'number') bits.push(`hash ${j.hashMs}ms`);
  if (typeof j.kvLatencyMs === 'number') bits.push(`KV ${j.kvLatencyMs}ms`);
  if (j.colo) bits.push(j.colo);
  return { label, status: 'up', detail: bits.join(' · ') };
}

// Row 2 — the functional self-test fotos runs over its own data: broken/missing
// Drive links on live events, bad data (dup slugs, invalid status), and form
// backends (Turnstile/Resend/ADMIN_EMAIL) that are unset. This is what flags
// "something we changed went wrong" rather than just a hard 500.
function healthSelftest(label, h) {
  if (h.rateLimited) return { label, status: 'up', detail: 'rate-limited (ignorado)' };
  // If healthz is unreachable/unparseable, the infra row already owns that
  // outage — don't double-count it here.
  if (h.netError || h.parseError || !h.json) return { label, status: 'up', detail: '—' };
  const st = h.json.selftest;
  if (!st) return { label, status: 'up', detail: 'autoteste indisponível (healthz antigo)' };
  if (Array.isArray(st.problems) && st.problems.length)
    return { label, status: 'degraded', detail: st.problems.join(' · ') };
  const bits = [];
  if (st.drive && typeof st.drive.ok === 'number') bits.push(`Drive ok (${st.drive.ok})`);
  bits.push('forms ok');
  return { label, status: 'up', detail: bits.join(' · ') };
}

// Row 3 — deep-probe a real event page (the healthy slug fotos nominates): the
// Drive-access gate and the removal form must both render. Sends the per-event
// view cookie so this monitoring hit never inflates the view counter.
async function checkEventPage(label, h, base) {
  const slug = h && h.json && h.json.selftest && h.json.selftest.sample;
  if (!slug) return { label, status: 'up', detail: 'sem evento p/ testar' };
  try {
    const res = await fetchSvc(base + '/' + encodeURIComponent(slug), { headers: { Cookie: `fv_${slug}=1` } });
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status} em /${slug}` }; }
    if (res.status >= 400) { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status} em /${slug}` }; }
    const text = await res.text();
    const missing = [];
    if (!text.includes('drive-turnstile')) missing.push('gate do Drive');
    if (!text.includes('rem-turnstile'))   missing.push('form de remoção');
    if (missing.length) return { label, status: 'degraded', detail: `/${slug}: faltando ${missing.join(' + ')}` };
    return { label, status: 'up', detail: `/${slug} ok` };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// Security-header probe: confirm the response still carries the hardening headers
// the worker sets (CSP, HSTS, nosniff, frame/embedding protection, …). A header
// silently dropped is a real regression — degraded, naming exactly what's gone.
async function checkHeaders(label, url, required) {
  try {
    const res = await fetchSvc(url);
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status}` }; }
    res.body?.cancel();
    const missing = required.filter((h) => !res.headers.get(h));
    if (missing.length) return { label, status: 'degraded', detail: `faltando: ${missing.join(', ')}` };
    return { label, status: 'up', detail: `${required.length} cabeçalhos ok` };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// Valid-XML sub-check: right content-type, the XML declaration, and a required
// root element — proves sitemap.xml is actually a sitemap, not an error page
// served with a 200.
async function checkXml(label, url, { rootTag } = {}) {
  try {
    const res = await fetchSvc(url);
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status}` }; }
    if (res.status >= 400) { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status}` }; }
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!ct.includes('xml'))                 return { label, status: 'degraded', detail: `tipo inesperado (${ct.split(';')[0] || 'desconhecido'})` };
    if (!text.includes('<?xml'))             return { label, status: 'degraded', detail: 'declaração XML ausente' };
    if (rootTag && !text.includes(rootTag))  return { label, status: 'degraded', detail: `elemento ${rootTag}…> ausente` };
    return { label, status: 'up', detail: '' };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// RFC 9116 security.txt: must declare a Contact and an Expires still in the
// future. An expired (or near-expired) file is a compliance regression — catch
// it before an external scanner does.
async function checkSecurityTxt(label, url) {
  try {
    const res = await fetchSvc(url);
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status}` }; }
    if (res.status >= 400) { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status}` }; }
    const text = await res.text();
    if (!/^Contact:/im.test(text)) return { label, status: 'degraded', detail: 'sem campo Contact' };
    const m = text.match(/^Expires:\s*(.+)$/im);
    if (!m) return { label, status: 'degraded', detail: 'sem campo Expires' };
    const exp = new Date(m[1].trim()).getTime();
    if (!Number.isFinite(exp))    return { label, status: 'degraded', detail: 'Expires inválido' };
    const left = exp - Date.now();
    if (left < 0)                 return { label, status: 'degraded', detail: 'expirado' };
    if (left < SECTXT_SOON_MS)    return { label, status: 'degraded', detail: `expira em ${Math.ceil(left / 86400_000)}d` };
    return { label, status: 'up', detail: `válido +${Math.floor(left / 86400_000)}d` };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// Negative probe: a path that must NOT exist should answer 404. A 200 means the
// router/catch-all broke (a soft-404 served as 200, or every slug resolving).
async function checkStatusCode(label, url, expected) {
  try {
    const res = await fetchSvc(url);
    res.body?.cancel();
    if (res.status === expected) return { label, status: 'up', detail: `HTTP ${res.status}` };
    if (res.status >= 500)       return { label, status: 'down', detail: `HTTP ${res.status}` };
    return { label, status: 'degraded', detail: `HTTP ${res.status} (esperado ${expected})` };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

export const SERVICES = [
  {
    name: 'lucafchala.com', url: 'https://lucafchala.com', marker: 'Luca',
  },
  {
    name: 'Rádio', url: 'https://radio.lucafchala.com', marker: 'Radio',
  },
  {
    // fotos gets deliberately exhaustive coverage: every public route, every
    // data file, the deep healthz, the security headers, the RFC 9116 contact,
    // the PWA contract, and a negative routing probe. The service's status is
    // the worst of all of them, and every failure is named — so nothing breaks
    // on fotos without showing up here first.
    name: 'Fotos', url: 'https://fotos.lucafchala.com', marker: 'fotos',
    checks: (b) => {
      // One healthz fetch, three derived rows (infra + self-test + event-page
      // deep-probe) — keeps us under the 10/min healthz rate limit.
      const health = fetchHealthz(b + '/api/healthz');
      return [
        health.then((h) => healthInfra('saúde · KV/D1/hash/cron', h)),
        health.then((h) => healthSelftest('autoteste · dados/forms/Drive', h)),
        health.then((h) => checkEventPage('página de evento (Drive + remoção)', h, b)),
        // Headers are set by the shared html() helper on every HTML response, so we
        // assert them against the *static* /termos page (no KV read on fotos' side)
        // instead of the homepage, which would trigger a second events read.
        checkHeaders('cabeçalhos de segurança', b + '/termos', [
          'content-security-policy', 'strict-transport-security', 'x-content-type-options',
          'x-frame-options', 'referrer-policy', 'permissions-policy',
        ]),
        checkContent('painel /dashboard', b + '/dashboard', { contentType: 'text/html', marker: '/dashboard/login' }),
        checkJson('manifest PWA', b + '/manifest.json', (j) => {
          if (!j || !j.name) return { detail: 'manifest sem nome' };
          if (!Array.isArray(j.icons) || !j.icons.length || !j.icons[0].src) return { detail: 'manifest sem ícones' };
          if (!j.start_url)   return { detail: 'manifest sem start_url' };
          if (!j.theme_color) return { detail: 'manifest sem theme_color' };
          return null;
        }),
        checkContent('ícone PWA', b + '/icon.svg', { contentType: 'image/svg+xml', marker: '<svg' }),
        checkContent('og coming-soon', b + '/og-coming-soon.png', { contentType: 'image/png' }),
        checkXml('sitemap.xml', b + '/sitemap.xml', { rootTag: '<urlset' }),
        checkContent('robots.txt', b + '/robots.txt', { contentType: 'text/plain', marker: 'Sitemap:' }),
        checkSecurityTxt('security.txt (RFC 9116)', b + '/.well-known/security.txt'),
        checkJson('GPC opt-out', b + '/.well-known/gpc.json', (j) => (j && j.gpc === true ? null : { detail: 'gpc≠true' })),
        checkContent('termos (LGPD)', b + '/termos', { contentType: 'text/html', marker: 'Termos de Uso' }),
        checkContent('privacidade', b + '/privacidade', { contentType: 'text/html', marker: 'Política de Privacidade' }),
        // The support form is gated by a Turnstile widget; if its markup is gone
        // the form can't be submitted, so we assert the widget renders.
        checkContent('formulário de suporte', b + '/suporte', { contentType: 'text/html', marker: 'cf-turnstile' }),
        checkStatusCode('roteamento (404)', b + '/__status_probe_404__', 404),
      ];
    },
  },
  {
    name: 'Fotos — Dashboard', url: 'https://fotos.lucafchala.com/dashboard', marker: '/dashboard/login',
  },
  {
    name: 'Dash', url: 'https://dash.lucafchala.com', marker: 'Painel',
    checks: (b) => [
      checkJson('data.json (PURLs)', b + '/data.json', (j) => (j && Array.isArray(j.redirects) ? null : { detail: 'campo redirects ausente' })),
    ],
  },
  {
    name: 'Paste', url: 'https://paste.lucafchala.com', marker: 'Paste',
    checks: (b) => [
      checkJson('pastes.json', b + '/pastes.json', (j) => (j && Array.isArray(j.pastes) ? null : { detail: 'lista de pastes inválida' })),
    ],
  },
  {
    name: 'URL', url: 'https://url.lucafchala.com', marker: 'url.lucafchala.com',
    checks: (b) => [
      checkJson('data.json (redirects)', b + '/data.json', (j) => (j && Array.isArray(j.redirects) ? null : { detail: 'campo redirects ausente' })),
    ],
  },
  {
    name: 'Keys', url: 'https://keys.lucafchala.com', marker: 'Chaves',
  },
  {
    name: 'Proof', url: 'https://proof.lucafchala.com',
    checks: (b) => [
      checkContent('prova de posse', b + '/proof-of-ownership.txt', { marker: 'Luca Ferriani Chala' }),
    ],
  },
];

async function checkService(svc) {
  const primary = await probePrimary(svc.url, svc.marker);
  const extra = svc.checks ? await Promise.all(svc.checks(svc.url)) : [];

  const checks = [{ label: 'disponibilidade', status: primary.status, detail: primary.detail }, ...extra];
  let status = primary.status;
  for (const c of extra) status = worst(status, c.status);

  const problems = checks
    .filter((c) => c.status !== 'up' && c.detail)
    .map((c) => `${c.label}: ${c.detail}`);

  return { name: svc.name, url: svc.url, status, statusCode: primary.statusCode, rt: primary.rt, checks, problems };
}

// Edge-cached for 30 s so concurrent viewers share one upstream sweep per colo
// instead of fanning out a probe-per-check per tab per minute.
// Change detection and notifications run server-side off each fresh sweep:
// previous state lives in STATUS_KV, so the emailing decision never depends
// on anything a client sends (the old public /api/notify-all was an open relay).
export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(context.request.url);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const services = await Promise.all(SERVICES.map(checkService));
  const res = new Response(JSON.stringify({ services, checkedAt: new Date().toISOString() }), {
    // s-maxage caches at the edge only; max-age=0 keeps browsers revalidating
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=0, s-maxage=30' },
  });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  context.waitUntil(detectAndNotify(context.env, services));
  return res;
}

const NOTIFY_COOLDOWN_S = 3600; // at most one alert per service per hour

async function detectAndNotify(env, services) {
  const KV = env.STATUS_KV;
  if (!KV) return;

  let prev = {};
  try { prev = JSON.parse(await KV.get('last_status') || '{}') || {}; } catch { prev = {}; }

  const next = {};
  for (const s of services) next[s.name] = s.status;
  await KV.put('last_status', JSON.stringify(next));

  if (!env.RESEND_API_KEY || !env.NOTIFY_TO) return;

  const changes = [];
  for (const s of services) {
    const p = prev[s.name];
    if (!p || p === s.status) continue;
    // KV is eventually consistent, so two colos sweeping at once can rarely
    // double-send; the cooldown still bounds it to ~1 extra email per hour.
    if (await KV.get(`notify_sent:${s.name}`)) continue;
    await KV.put(`notify_sent:${s.name}`, '1', { expirationTtl: NOTIFY_COOLDOWN_S });
    changes.push({ name: s.name, url: s.url, from: p, to: s.status, problems: Array.isArray(s.problems) ? s.problems : [] });
  }
  if (changes.length === 0) return;

  await sendAlerts(env, changes).catch(e => console.error('status alert email failed', e));
}

async function sendAlerts(env, changes) {
  const { RESEND_API_KEY, NOTIFY_TO, NOTIFY_FROM = 'status@lucafchala.com', STATUS_KV: KV } = env;

  let subscribers = [];
  try { subscribers = JSON.parse(await KV.get('subscribers') || '[]') || []; } catch { subscribers = []; }
  if (!Array.isArray(subscribers)) subscribers = [];

  const deduped = [...new Set([NOTIFY_TO, ...subscribers.map(s => s.email)])];

  const rows = changes.map(c => {
    // List every failing check, not just the first — the whole point is to know
    // about *any* problem, so an alert spells out all of them at once.
    const problemList = (c.problems && c.problems.length)
      ? '<br>' + c.problems.map(p => '• ' + esc(p)).join('<br>')
      : '';
    return `<tr>
      <td style="padding:6px 12px 6px 0;font-family:monospace;font-size:13px;vertical-align:top">${esc(c.name)}</td>
      <td style="padding:6px 8px;font-family:monospace;font-size:12px;vertical-align:top">${icon(c.from)} → ${icon(c.to)}</td>
      <td style="padding:6px 0;font-family:monospace;font-size:11px;color:#9a8f80">${esc(c.url)}${problemList}</td>
    </tr>`;
  }).join('');

  const subject = changes.length === 1
    ? `${icon(changes[0].to)} ${changes[0].name} — status.lucafchala.com`
    : `${changes.length} mudanças de status — status.lucafchala.com`;

  const batch = deduped.map(email => {
    const sub = subscribers.find(s => s.email === email);
    const unsubUrl = sub
      ? `https://status.lucafchala.com/api/unsubscribe?token=${sub.token}`
      : null;
    return { from: NOTIFY_FROM, to: [email], subject, html: alertHtml(rows, unsubUrl) };
  });

  await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function icon(s) {
  return s === 'up' ? '🟢' : s === 'degraded' ? '🟡' : '🔴';
}

function alertHtml(rows, unsubUrl) {
  const footer = unsubUrl
    ? `<a href="${unsubUrl}" style="color:#c08030;text-decoration:none">Cancelar inscrição</a> &nbsp;·&nbsp; `
    : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0d0c0a;color:#e6e1d6;font-family:monospace;padding:32px;margin:0">
  <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#6a6358;margin-bottom:20px">status.lucafchala.com</p>
  <h1 style="font-family:Georgia,serif;font-weight:300;font-size:28px;margin:0 0 8px">
    Mudança de <em style="color:#c08030;font-style:italic">status</em>
  </h1>
  <p style="font-size:12px;color:#6a6358;margin:0 0 28px">${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}</p>
  <table style="border-collapse:collapse;width:100%;margin-bottom:28px">${rows}</table>
  <p style="font-size:11px;color:#6a6358;border-top:1px solid #252220;padding-top:16px;margin:0">
    ${footer}<a href="https://status.lucafchala.com" style="color:#c08030;text-decoration:none">Ver status</a>
  </p>
</body></html>`;
}
