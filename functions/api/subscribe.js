// All subscribers stored in one KV key as a JSON array.
// Cost: 1 read + 1 write per subscribe/unsubscribe (vs 2-3 ops with per-key storage).

export async function onRequestPost({ request, env }) {
  const KV = env.STATUS_KV;
  if (!KV) return json({ error: 'not configured' }, 500);

  let email;
  try { ({ email } = await request.json()); } catch {
    return json({ error: 'invalid body' }, 400);
  }
  email = (email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'invalid email' }, 400);
  }

  // 1 read
  const raw = await KV.get('subscribers');
  const subs = raw ? JSON.parse(raw) : [];

  if (subs.some(s => s.email === email)) {
    return json({ ok: true, already: true });
  }

  const token = crypto.randomUUID();
  subs.push({ email, token, subscribedAt: new Date().toISOString() });

  // 1 write
  await KV.put('subscribers', JSON.stringify(subs));

  // Welcome email (1 Resend call)
  const { RESEND_API_KEY, NOTIFY_FROM = 'status@lucafchala.com' } = env;
  if (RESEND_API_KEY) {
    const unsubUrl = `https://status.lucafchala.com/api/unsubscribe?token=${token}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: [email],
        subject: 'Inscrição confirmada — status.lucafchala.com',
        html: welcomeHtml(unsubUrl),
      }),
    }).catch(() => {});
  }

  return json({ ok: true });
}

function welcomeHtml(unsubUrl) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0d0c0a;color:#e6e1d6;font-family:monospace;padding:32px;margin:0">
  <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#6a6358;margin-bottom:20px">status.lucafchala.com</p>
  <h1 style="font-family:Georgia,serif;font-weight:300;font-size:28px;margin:0 0 12px">
    Inscrição <em style="color:#c08030;font-style:italic">confirmada</em>
  </h1>
  <p style="font-size:13px;color:#9a8f80;margin:0 0 28px">
    Você receberá um email sempre que o status de um serviço mudar.
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
