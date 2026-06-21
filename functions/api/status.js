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

// fotos exposes a rich /api/healthz: { ok, kv, events, d1, hashMs }. Parsing it
// lets the dashboard see *inside* the worker — KV binding, the events store,
// the optional D1 consent log, and whether login hashing fits the CPU budget.
async function checkFotosHealth(label, url) {
  try {
    const res = await fetchSvc(url, { headers: { Accept: 'application/json' } });
    // healthz is rate-limited (10/min/IP); a 429 from our own sweep isn't an
    // outage, so treat it as a pass rather than poisoning the status.
    if (res.status === 429) { res.body?.cancel(); return { label, status: 'up', detail: 'rate-limited (ignorado)' }; }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { label, status: 'down', detail: 'healthz sem JSON' }; }
    if (json.kv === false || json.ok === false) return { label, status: 'down', detail: 'KV indisponível' };
    if (res.status >= 500)                      return { label, status: 'down', detail: `HTTP ${res.status}` };
    if (json.d1 === 'down')                     return { label, status: 'degraded', detail: 'D1 (consentimento) indisponível' };
    if (typeof json.hashMs === 'number' && json.hashMs > HASH_BUDGET_MS)
      return { label, status: 'degraded', detail: `hashing lento (${json.hashMs}ms)` };
    const extra = typeof json.events === 'number' ? `${json.events} eventos · hash ${json.hashMs}ms` : '';
    return { label, status: 'up', detail: extra };
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
    name: 'Fotos', url: 'https://fotos.lucafchala.com', marker: 'fotos',
    checks: (b) => [
      checkFotosHealth('saúde · KV/D1/hash', b + '/api/healthz'),
      checkContent('painel /dashboard', b + '/dashboard', { contentType: 'text/html', marker: '/dashboard/login' }),
      checkJson('manifest PWA', b + '/manifest.json', (j) => (j && j.name ? null : { detail: 'manifest sem nome' })),
      checkContent('termos (LGPD)', b + '/termos', { contentType: 'text/html' }),
      checkContent('suporte', b + '/suporte', { contentType: 'text/html' }),
    ],
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
    changes.push({ name: s.name, url: s.url, from: p, to: s.status, problem: (s.problems && s.problems[0]) || '' });
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

  const rows = changes.map(c =>
    `<tr>
      <td style="padding:6px 12px 6px 0;font-family:monospace;font-size:13px">${esc(c.name)}</td>
      <td style="padding:6px 8px;font-family:monospace;font-size:12px">${icon(c.from)} → ${icon(c.to)}</td>
      <td style="padding:6px 0;font-family:monospace;font-size:11px;color:#9a8f80">${esc(c.url)}${c.problem ? '<br>' + esc(c.problem) : ''}</td>
    </tr>`
  ).join('');

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
