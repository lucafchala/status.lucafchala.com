// Called by the browser when it detects a status change (via localStorage diff).
// Cost: 1 KV read + 1 Resend batch call — only triggered on actual changes.

export async function onRequestPost({ request, env }) {
  const { RESEND_API_KEY, NOTIFY_TO, NOTIFY_FROM = 'status@lucafchala.com', STATUS_KV: KV } = env;
  if (!RESEND_API_KEY || !NOTIFY_TO) return ok();

  let changes;
  try { ({ changes } = await request.json()); } catch { return ok(); }
  if (!Array.isArray(changes) || changes.length === 0) return ok();

  // 1 KV read — only subscribers, nothing else
  const subsRaw = KV ? await KV.get('subscribers') : null;
  const subscribers = subsRaw ? JSON.parse(subsRaw) : [];

  const to = [NOTIFY_TO, ...subscribers.map(s => s.email)];
  const deduped = [...new Set(to)];

  const rows = changes.map(c =>
    `<tr>
      <td style="padding:6px 12px 6px 0;font-family:monospace;font-size:13px">${c.name}</td>
      <td style="padding:6px 8px;font-family:monospace;font-size:12px">${icon(c.from)} → ${icon(c.to)}</td>
      <td style="padding:6px 0;font-family:monospace;font-size:11px;color:#9a8f80">${c.url || ''}</td>
    </tr>`
  ).join('');

  const subject = changes.length === 1
    ? `${icon(changes[0].to)} ${changes[0].name} — status.lucafchala.com`
    : `${changes.length} mudanças de status — status.lucafchala.com`;

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
