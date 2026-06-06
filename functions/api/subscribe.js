export async function onRequestPost({ request, env }) {
  const KV = env.STATUS_KV;
  if (!KV) return json({ error: 'not configured' }, 500);

  let email;
  try {
    ({ email } = await request.json());
  } catch {
    return json({ error: 'invalid body' }, 400);
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'invalid email' }, 400);
  }

  const key = `sub:${email.toLowerCase()}`;
  const existing = await KV.get(key);
  if (existing) return json({ ok: true, already: true });

  const token = crypto.randomUUID();
  await KV.put(key, JSON.stringify({ email, token, subscribedAt: new Date().toISOString() }));
  await KV.put(`tok:${token}`, email.toLowerCase());

  // Welcome email
  const RESEND_API_KEY = env.RESEND_API_KEY;
  const NOTIFY_FROM    = env.NOTIFY_FROM || 'status@lucafchala.com';
  if (RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: [email],
        subject: 'Inscrição confirmada — status.lucafchala.com',
        html: welcomeEmail(email, token),
      }),
    }).catch(() => {});
  }

  return json({ ok: true });
}

function welcomeEmail(email, token) {
  const unsubUrl = `https://status.lucafchala.com/api/unsubscribe?token=${token}`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0d0c0a;color:#e6e1d6;font-family:monospace;padding:32px;margin:0">
  <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#6a6358;margin-bottom:20px">status.lucafchala.com</p>
  <h1 style="font-family:Georgia,serif;font-weight:300;font-size:28px;margin:0 0 12px">
    Inscrição <em style="color:#c08030;font-style:italic">confirmada</em>
  </h1>
  <p style="font-size:13px;color:#9a8f80;margin:0 0 28px">
    Você receberá alertas quando o status de qualquer serviço mudar.
  </p>
  <p style="font-size:11px;color:#6a6358;border-top:1px solid #252220;padding-top:16px;margin:0">
    <a href="${unsubUrl}" style="color:#c08030;text-decoration:none">Cancelar inscrição</a>
    &nbsp;·&nbsp;
    <a href="https://status.lucafchala.com" style="color:#c08030;text-decoration:none">status.lucafchala.com</a>
  </p>
</body></html>`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
