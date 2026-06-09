// 1 read + 1 write per unsubscribe (token stored inside the subscribers array)

export async function onRequestGet({ request, env }) {
  const KV = env.STATUS_KV;
  const token = new URL(request.url).searchParams.get('token');

  if (!KV || !token) return page('Link inválido.', false);

  // 1 read
  const raw = await KV.get('subscribers');
  const subs = raw ? JSON.parse(raw) : [];
  const idx = subs.findIndex(s => s.token === token);

  if (idx === -1) return page('Link inválido ou já utilizado.', false);

  const { email } = subs[idx];
  subs.splice(idx, 1);

  // 1 write
  await KV.put('subscribers', JSON.stringify(subs));

  return page(`Inscrição de ${esc(email)} cancelada.`, true);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function page(message, success) {
  const title = success ? 'Inscrição cancelada' : 'Erro';
  const heading = success ? 'Inscrição <em>cancelada</em>' : 'Link <em>inválido</em>';
  return new Response(`<!DOCTYPE html><html lang="pt-BR" data-theme="dark"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title} — status.lucafchala.com</title>
  <meta name="theme-color" content="#0d0c0a"/>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;1,400&family=JetBrains+Mono:wght@400&display=swap"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0d0c0a;--text:#e6e1d6;--muted:#6a6358;--accent:#c08030}
    body{background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;
         min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px}
    .wrap{max-width:480px;width:100%;text-align:center}
    h1{font-family:'Cormorant Garamond',serif;font-weight:300;font-size:clamp(32px,8vw,52px);line-height:0.92}
    h1 em{font-style:italic;color:var(--accent)}
    a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  </style></head>
  <body><div class="wrap">
    <h1>${heading}</h1>
    <p style="font-size:12px;color:var(--muted);margin-top:20px">${message}</p>
    <p style="margin-top:40px;font-size:11px;color:var(--muted)">
      <a href="https://status.lucafchala.com">← voltar ao status</a>
    </p>
  </div></body></html>`, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}
