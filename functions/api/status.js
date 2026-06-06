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

const TIMEOUT_MS  = 10000;
const DEGRADED_MS = 2500;
// Minimum interval between subscriber notifications for the same service
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

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
    if (res.status >= 500)      status = 'down';
    else if (res.status >= 400) status = 'degraded';
    else                        status = rt > DEGRADED_MS ? 'degraded' : 'up';
    return { name: svc.name, url: svc.url, status, statusCode: res.status, rt };
  } catch {
    return { name: svc.name, url: svc.url, status: 'down', statusCode: null, rt: Date.now() - start };
  }
}

async function getSubscribers(KV) {
  const list = await KV.list({ prefix: 'sub:' });
  const emails = [];
  for (const key of list.keys) {
    const val = await KV.get(key.name);
    if (val) {
      try { emails.push(JSON.parse(val)); } catch {}
    }
  }
  return emails;
}

async function notifySubscribers(env, changes) {
  const KV = env.STATUS_KV;
  const RESEND_API_KEY = env.RESEND_API_KEY;
  const NOTIFY_FROM    = env.NOTIFY_FROM || 'status@lucafchala.com';
  if (!KV || !RESEND_API_KEY || changes.length === 0) return;

  const subscribers = await getSubscribers(KV);
  if (subscribers.length === 0) return;

  const rows = changes.map(c => {
    const from = statusIcon(c.from);
    const to   = statusIcon(c.to);
    return `<tr>
      <td style="padding:6px 12px 6px 0;font-family:monospace;font-size:13px">${c.name}</td>
      <td style="padding:6px 8px;font-family:monospace;font-size:11px">${from} → ${to}</td>
      <td style="padding:6px 0;font-family:monospace;font-size:11px;color:#9a8f80">${c.url || ''}</td>
    </tr>`;
  }).join('');

  const subject = changes.length === 1
    ? `${statusIcon(changes[0].to)} ${changes[0].name} — status.lucafchala.com`
    : `${changes.length} serviços com mudança de status — status.lucafchala.com`;

  for (const sub of subscribers) {
    const unsubUrl = `https://status.lucafchala.com/api/unsubscribe?token=${sub.token}`;
    const html = alertEmail(rows, unsubUrl);
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: NOTIFY_FROM, to: [sub.email], subject, html }),
    }).catch(() => {});
  }
}

function statusIcon(s) {
  if (s === 'up') return '🟢';
  if (s === 'degraded') return '🟡';
  return '🔴';
}

function alertEmail(rows, unsubUrl) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0d0c0a;color:#e6e1d6;font-family:monospace;padding:32px;margin:0">
  <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#6a6358;margin-bottom:20px">status.lucafchala.com</p>
  <h1 style="font-family:Georgia,serif;font-weight:300;font-size:28px;margin:0 0 8px">
    Mudança de <em style="color:#c08030;font-style:italic">status</em>
  </h1>
  <p style="font-size:12px;color:#6a6358;margin:0 0 28px">${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
  <table style="border-collapse:collapse;width:100%;margin-bottom:28px">${rows}</table>
  <p style="font-size:11px;color:#6a6358;border-top:1px solid #252220;padding-top:16px;margin:0">
    <a href="${unsubUrl}" style="color:#c08030;text-decoration:none">Cancelar inscrição</a>
    &nbsp;·&nbsp;
    <a href="https://status.lucafchala.com" style="color:#c08030;text-decoration:none">Ver status</a>
  </p>
</body></html>`;
}

export async function onRequestGet({ env }) {
  const services = await Promise.all(SERVICES.map(checkOne));
  const checkedAt = new Date().toISOString();

  // Change detection via KV (fire-and-forget, don't block response)
  detectAndNotify(env, services).catch(() => {});

  return new Response(JSON.stringify({ services, checkedAt }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function detectAndNotify(env, current) {
  const KV = env.STATUS_KV;
  if (!KV) return;

  const now = Date.now();
  const lastRaw = await KV.get('last_status');
  const last = lastRaw ? JSON.parse(lastRaw) : {};

  // Build map: name → status
  const currentMap = Object.fromEntries(current.map(s => [s.name, s.status]));

  // Find changes, respecting per-service cooldown
  const changes = [];
  for (const svc of current) {
    const prev = last[svc.name];
    if (!prev) continue; // first run — don't alert, just establish baseline
    if (prev.status === svc.status) continue;

    const lastNotified = prev.notifiedAt || 0;
    if (now - lastNotified < NOTIFY_COOLDOWN_MS) continue;

    changes.push({ name: svc.name, url: svc.url, from: prev.status, to: svc.status });
    currentMap[svc.name] = { status: svc.status, notifiedAt: now };
  }

  // Build new stored state (preserve notifiedAt for unchanged services)
  const newState = {};
  for (const svc of current) {
    const changed = changes.find(c => c.name === svc.name);
    newState[svc.name] = {
      status: svc.status,
      notifiedAt: changed ? now : (last[svc.name]?.notifiedAt || 0),
    };
  }
  await KV.put('last_status', JSON.stringify(newState));

  if (changes.length > 0) {
    await notifySubscribers(env, changes);
  }
}
