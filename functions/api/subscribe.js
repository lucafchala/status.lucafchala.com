export async function onRequestPost({ request, env }) {
  const { RESEND_API_KEY, NOTIFY_TO, NOTIFY_FROM = 'status@lucafchala.com', STATUS_KV: KV } = env;

  let email;
  try { ({ email } = await request.json()); } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  email = (email || '').trim().toLowerCase();
  if (!email || email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(email)) {
    return json({ error: 'Email inválido' }, 400);
  }

  if (!RESEND_API_KEY) {
    return json({ error: 'Serviço de email não configurado (RESEND_API_KEY ausente)' }, 500);
  }

  // If KV is not bound, still accept the subscription — notify admin via email
  // so no subscriber is silently lost during setup.
  if (!KV) {
    if (NOTIFY_TO) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: NOTIFY_FROM,
          to: [NOTIFY_TO],
          subject: `Nova inscrição pendente — ${email}`,
          html: `<p style="font-family:monospace">${esc(email)} quer receber alertas mas STATUS_KV não está configurado. Adicione o binding no Cloudflare Pages.</p>`,
        }),
      }).catch(e => console.error('pending-subscription email failed', e));
    }
    return json({ error: 'Armazenamento não configurado (STATUS_KV ausente)' }, 500);
  }

  // 1 read — guard the parse so corrupt KV can't 500 the endpoint
  const raw = await KV.get('subscribers');
  let subs = [];
  try { subs = raw ? JSON.parse(raw) : []; } catch { subs = []; }
  if (!Array.isArray(subs)) subs = [];

  if (subs.some(s => s.email === email)) {
    return json({ ok: true, already: true });
  }

  const token = crypto.randomUUID();
  subs.push({ email, token, subscribedAt: new Date().toISOString() });

  // 1 write
  await KV.put('subscribers', JSON.stringify(subs));

  // Welcome email
  const unsubUrl = `https://status.lucafchala.com/api/unsubscribe?token=${token}`;
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: NOTIFY_FROM,
      to: [email],
      subject: 'Inscrição confirmada — status.lucafchala.com',
      html: welcomeHtml(unsubUrl),
    }),
  });

  if (!emailRes.ok) {
    const detail = await emailRes.text().catch(() => '');
    return json({ error: `Inscrição salva, mas email falhou: ${emailRes.status}${detail ? ' — ' + detail : ''}` }, 502);
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

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
