// Called by the browser when it detects a status change (via localStorage diff).
// The endpoint is public, so the payload is untrusted: only known services are
// accepted (URL comes from our own list, never the request), transitions must be
// valid, and a KV cooldown enforces at most one alert per service per hour —
// the client's localStorage cooldown is advisory only.

import { SERVICES } from './status.js';

const VALID_STATUS = new Set(['up', 'degraded', 'down']);
const COOLDOWN_S = 3600; // mirrors the client's NOTIFY_COOLDOWN_MS
const MAX_CHANGES = 20;

export async function onRequestPost({ request, env }) {
  const { RESEND_API_KEY, NOTIFY_TO, NOTIFY_FROM = 'status@lucafchala.com', STATUS_KV: KV } = env;
  if (!RESEND_API_KEY || !NOTIFY_TO || !KV) return ok();

  let changes;
  try { ({ changes } = await request.json()); } catch { return ok(); }
  if (!Array.isArray(changes) || changes.length === 0) return ok();

  const byName = new Map(SERVICES.map(s => [s.name, s.url]));
  const seen = new Set();
  const accepted = [];
  for (const c of changes.slice(0, MAX_CHANGES)) {
    if (!c || typeof c.name !== 'string' || !byName.has(c.name) || seen.has(c.name)) continue;
    if (!VALID_STATUS.has(c.from) || !VALID_STATUS.has(c.to) || c.from === c.to) continue;
    seen.add(c.name);
    accepted.push({ name: c.name, url: byName.get(c.name), from: c.from, to: c.to });
  }

  const notifiable = [];
  for (const c of accepted) {
    const key = `notify_sent:${c.name}`;
    if (await KV.get(key)) continue;
    await KV.put(key, '1', { expirationTtl: COOLDOWN_S });
    notifiable.push(c);
  }
  if (notifiable.length === 0) return ok();

  const subsRaw = await KV.get('subscribers');
  const subscribers = subsRaw ? JSON.parse(subsRaw) : [];

  const to = [NOTIFY_TO, ...subscribers.map(s => s.email)];
  const deduped = [...new Set(to)];

  const rows = notifiable.map(c =>
    `<tr>
      <td style="padding:6px 12px 6px 0;font-family:monospace;font-size:13px">${esc(c.name)}</td>
      <td style="padding:6px 8px;font-family:monospace;font-size:12px">${icon(c.from)} → ${icon(c.to)}</td>
      <td style="padding:6px 0;font-family:monospace;font-size:11px;color:#9a8f80">${esc(c.url)}</td>
    </tr>`
  ).join('');

  const subject = notifiable.length === 1
    ? `${icon(notifiable[0].to)} ${notifiable[0].name} — status.lucafchala.com`
    : `${notifiable.length} mudanças de status — status.lucafchala.com`;

  // 1 Resend batch call for everyone (admin + subscribers)
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
  }).catch(() => {});

  return ok();
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

function ok() {
  return new Response('ok', { status: 200 });
}
