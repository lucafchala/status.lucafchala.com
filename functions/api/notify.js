export async function onRequestPost({ request, env }) {
  const RESEND_API_KEY = env.RESEND_API_KEY;
  const NOTIFY_TO      = env.NOTIFY_TO;      // e.g. "you@example.com"
  const NOTIFY_FROM    = env.NOTIFY_FROM || 'status@lucafchala.com';

  if (!RESEND_API_KEY || !NOTIFY_TO) {
    return new Response('not configured', { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const failed = body.failed;
  if (!Array.isArray(failed) || failed.length === 0) {
    return new Response('nothing to notify', { status: 400 });
  }

  const rows = failed.map(s => {
    const label = s.status === 'degraded' ? '🟡 lento' : '🔴 offline';
    return `<tr>
      <td style="padding:6px 12px 6px 0;font-family:monospace;font-size:13px">${s.name}</td>
      <td style="padding:6px 12px 6px 0;font-family:monospace;font-size:11px;color:#9a8f80">${s.url}</td>
      <td style="padding:6px 0;font-family:monospace;font-size:12px">${label}</td>
    </tr>`;
  }).join('');

  const count = failed.length;
  const subject = count === 1
    ? `⚠️ ${failed[0].name} está fora do ar — lucafchala.com`
    : `⚠️ ${count} serviços com problema — lucafchala.com`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#0d0c0a;color:#e6e1d6;font-family:monospace;padding:32px;margin:0">
  <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#6a6358;margin-bottom:20px">
    status.lucafchala.com
  </p>
  <h1 style="font-family:Georgia,serif;font-weight:300;font-size:28px;margin:0 0 8px">
    Alerta de <em style="color:#c08030;font-style:italic">serviços</em>
  </h1>
  <p style="font-size:12px;color:#6a6358;margin:0 0 28px">
    ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
  </p>
  <table style="border-collapse:collapse;width:100%;margin-bottom:28px">
    ${rows}
  </table>
  <p style="font-size:11px;color:#6a6358;border-top:1px solid #252220;padding-top:16px;margin:0">
    Notificação automática de <a href="https://status.lucafchala.com" style="color:#c08030;text-decoration:none">status.lucafchala.com</a>.
    Você receberá outro alerta para este serviço somente após 1 hora.
  </p>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: NOTIFY_FROM,
      to: [NOTIFY_TO],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return new Response(`resend error: ${err}`, { status: 502 });
  }

  return new Response('ok', { status: 200 });
}
