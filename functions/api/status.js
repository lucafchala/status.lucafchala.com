export const SERVICES = [
  { name: 'lucafchala.com',    url: 'https://lucafchala.com' },
  { name: 'Rádio',             url: 'https://radio.lucafchala.com' },
  { name: 'Fotos',             url: 'https://fotos.lucafchala.com' },
  { name: 'Fotos — Dashboard', url: 'https://fotos.lucafchala.com/dashboard' },
  { name: 'Dash',              url: 'https://dash.lucafchala.com' },
  { name: 'Paste',             url: 'https://paste.lucafchala.com' },
  { name: 'URL',               url: 'https://url.lucafchala.com' },
  { name: 'Keys',              url: 'https://keys.lucafchala.com' },
  { name: 'Proof',             url: 'https://proof.lucafchala.com' },
];

const TIMEOUT_MS  = 10000;
const DEGRADED_MS = 2500;

async function checkOne(svc) {
  const start = Date.now();
  try {
    const res = await fetch(svc.url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    res.body?.cancel(); // discard body — we only need the status code
    const rt = Date.now() - start;
    let status;
    if      (res.status >= 500) status = 'down';
    else if (res.status >= 400) status = 'degraded';
    else                        status = rt > DEGRADED_MS ? 'degraded' : 'up';
    return { name: svc.name, url: svc.url, status, statusCode: res.status, rt };
  } catch {
    return { name: svc.name, url: svc.url, status: 'down', statusCode: null, rt: Date.now() - start };
  }
}

// Edge-cached for 30 s so concurrent viewers share one upstream sweep per colo
// instead of fanning out 9 fetches per tab per minute.
// Change detection and notifications run server-side off each fresh sweep:
// previous state lives in STATUS_KV, so the emailing decision never depends
// on anything a client sends (the old public /api/notify-all was an open relay).
export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(context.request.url);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const services = await Promise.all(SERVICES.map(checkOne));
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

  // All transitions — for incident log, independent of notification cooldown
  const transitions = services
    .filter(s => prev[s.name] && prev[s.name] !== s.status)
    .map(s => ({ name: s.name, url: s.url, from: prev[s.name], to: s.status }));

  if (transitions.length > 0) {
    await recordIncidents(KV, transitions).catch(e => console.error('incident log failed', e));
  }

  if (!env.RESEND_API_KEY || !env.NOTIFY_TO) return;

  const changes = [];
  for (const c of transitions) {
    // KV is eventually consistent, so two colos sweeping at once can rarely
    // double-send; the cooldown still bounds it to ~1 extra email per hour.
    if (await KV.get(`notify_sent:${c.name}`)) continue;
    await KV.put(`notify_sent:${c.name}`, '1', { expirationTtl: NOTIFY_COOLDOWN_S });
    changes.push(c);
  }
  if (changes.length === 0) return;

  await sendAlerts(env, changes).catch(e => console.error('status alert email failed', e));
}

async function recordIncidents(KV, transitions) {
  let incidents = [];
  try {
    incidents = JSON.parse(await KV.get('incidents') || '[]') || [];
  } catch { incidents = []; }
  if (!Array.isArray(incidents)) incidents = [];

  const now = new Date().toISOString();
  for (const c of transitions) {
    if (c.to !== 'up') {
      // Service degraded or went down — open a new incident
      incidents.push({ name: c.name, url: c.url, status: c.to, at: now, resolvedAt: null });
    } else {
      // Service recovered — close the most recent open incident for this service
      for (let i = incidents.length - 1; i >= 0; i--) {
        if (incidents[i].name === c.name && incidents[i].resolvedAt === null) {
          incidents[i].resolvedAt = now;
          break;
        }
      }
    }
  }

  // Keep last 100
  if (incidents.length > 100) incidents = incidents.slice(incidents.length - 100);
  await KV.put('incidents', JSON.stringify(incidents));
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
      <td style="padding:6px 0;font-family:monospace;font-size:11px;color:#9a8f80">${esc(c.url)}</td>
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
