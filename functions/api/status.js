const SERVICES = [
  { name: 'lucafchala.com',    url: 'https://lucafchala.com' },
  { name: 'Rádio',             url: 'https://radio.lucafchala.com' },
  { name: 'Fotos',             url: 'https://fotos.lucafchala.com' },
  { name: 'Fotos — Dashboard', url: 'https://fotos.lucafchala.com/dashboard' },
  { name: 'Dash',              url: 'https://dash.lucafchala.com' },
  { name: 'Now',               url: 'https://now.lucafchala.com' },
  { name: 'Paste',             url: 'https://paste.lucafchala.com' },
  { name: 'Weblog',            url: 'https://weblog.lucafchala.com' },
  { name: 'URL',               url: 'https://url.lucafchala.com' },
];

const TIMEOUT_MS        = 10000;
const DEGRADED_MS       = 2500;
const CHECK_INTERVAL_MS = 2 * 60 * 1000;  // write KV at most once per 2 min
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000; // min gap between alerts per service

async function checkOne(svc) {
  const start = Date.now();
  try {
    const res = await fetch(svc.url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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

export async function onRequestGet({ env }) {
  const services = await Promise.all(SERVICES.map(checkOne));
  const checkedAt = new Date().toISOString();

  // Fire-and-forget: don't block the browser response
  detectAndNotify(env, services).catch(() => {});

  return new Response(JSON.stringify({ services, checkedAt }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function detectAndNotify(env, current) {
  const KV = env.STATUS_KV;
  if (!KV) return;

  const now = Date.now();

  // 1 KV read per browser refresh
  const raw = await KV.get('state');
  const state = raw ? JSON.parse(raw) : { checkedAt: 0, services: {} };

  // Only run change detection + write KV at most once per CHECK_INTERVAL_MS.
  // This is the main throttle: multiple tabs / rapid refreshes cost 1 read each
  // but only 1 write every 2 minutes (~720 writes/day vs free tier 1k/day).
  if (now - state.checkedAt < CHECK_INTERVAL_MS) return;

  const changes = [];
  const newServices = {};

  for (const svc of current) {
    const prev = state.services[svc.name];
    const lastNotified = prev?.notifiedAt || 0;
    newServices[svc.name] = { status: svc.status, notifiedAt: lastNotified };

    if (prev && prev.status !== svc.status && now - lastNotified >= NOTIFY_COOLDOWN_MS) {
      changes.push({ name: svc.name, url: svc.url, from: prev.status, to: svc.status });
      newServices[svc.name].notifiedAt = now;
    }
  }

  // 1 KV write every 2 min (regardless of whether anything changed)
  await KV.put('state', JSON.stringify({ checkedAt: now, services: newServices }));

  if (changes.length === 0) return;

  // 1 KV read — only reached when a service actually changed status (rare)
  const subsRaw = await KV.get('subscribers');
  const subscribers = subsRaw ? JSON.parse(subsRaw) : [];
  if (subscribers.length === 0) return;

  await notifySubscribers(env, subscribers, changes);
}

async function notifySubscribers(env, subscribers, changes) {
  const RESEND_API_KEY = env.RESEND_API_KEY;
  const NOTIFY_FROM    = env.NOTIFY_FROM || 'status@lucafchala.com';
  if (!RESEND_API_KEY) return;

  const rows = changes.map(c =>
    `<tr>
      <td style="padding:6px 12px 6px 0;font-family:monospace;font-size:13px">${c.name}</td>
      <td style="padding:6px 8px;font-family:monospace;font-size:12px">${icon(c.from)} → ${icon(c.to)}</td>
      <td style="padding:6px 0;font-family:monospace;font-size:11px;color:#9a8f80">${c.url}</td>
    </tr>`
  ).join('');

  const subject = changes.length === 1
    ? `${icon(changes[0].to)} ${changes[0].name} — status.lucafchala.com`
    : `${changes.length} mudanças de status — status.lucafchala.com`;

  // 1 Resend API call for all subscribers (batch)
  const batch = subscribers.map(sub => ({
    from: NOTIFY_FROM,
    to: [sub.email],
    subject,
    html: alertHtml(rows, `https://status.lucafchala.com/api/unsubscribe?token=${sub.token}`),
  }));

  await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  }).catch(() => {});
}

function icon(s) {
  return s === 'up' ? '🟢' : s === 'degraded' ? '🟡' : '🔴';
}

function alertHtml(rows, unsubUrl) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0d0c0a;color:#e6e1d6;font-family:monospace;padding:32px;margin:0">
  <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#6a6358;margin-bottom:20px">status.lucafchala.com</p>
  <h1 style="font-family:Georgia,serif;font-weight:300;font-size:28px;margin:0 0 8px">
    Mudança de <em style="color:#c08030;font-style:italic">status</em>
  </h1>
  <p style="font-size:12px;color:#6a6358;margin:0 0 28px">${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}</p>
  <table style="border-collapse:collapse;width:100%;margin-bottom:28px">${rows}</table>
  <p style="font-size:11px;color:#6a6358;border-top:1px solid #252220;padding-top:16px;margin:0">
    <a href="${unsubUrl}" style="color:#c08030;text-decoration:none">Cancelar inscrição</a>
    &nbsp;·&nbsp;
    <a href="https://status.lucafchala.com" style="color:#c08030;text-decoration:none">Ver status</a>
  </p>
</body></html>`;
}
