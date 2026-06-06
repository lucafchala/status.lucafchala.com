export async function onRequestGet({ request, env }) {
  const KV = env.STATUS_KV;
  const token = new URL(request.url).searchParams.get('token');

  if (!KV || !token) return html(errorPage('Link inválido.'));

  const email = await KV.get(`tok:${token}`);
  if (!email) return html(errorPage('Link inválido ou já utilizado.'));

  await KV.delete(`sub:${email}`);
  await KV.delete(`tok:${token}`);

  return html(successPage(email));
}

function successPage(email) {
  return page('Inscrição cancelada', `
    <h1 class="name">Inscrição <em>cancelada</em></h1>
    <p class="micro" style="margin-top:10px">você foi removido da lista de alertas</p>
    <p style="font-size:12px;color:var(--muted);margin-top:24px">${email}</p>
  `);
}

function errorPage(msg) {
  return page('Erro', `
    <h1 class="name">Link <em>inválido</em></h1>
    <p style="font-size:12px;color:var(--muted);margin-top:24px">${msg}</p>
  `);
}

function page(title, body) {
  return `<!DOCTYPE html><html lang="pt-BR" data-theme="dark"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title} — status.lucafchala.com</title>
  <meta name="theme-color" content="#0d0c0a"/>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;1,400&family=JetBrains+Mono:wght@400&display=swap"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0d0c0a;--text:#e6e1d6;--muted:#6a6358;--accent:#c08030;--border:#252220}
    body{background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;
         min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px}
    .wrap{max-width:480px;width:100%;text-align:center}
    .name{font-family:'Cormorant Garamond',serif;font-weight:300;font-size:clamp(32px,8vw,52px);line-height:0.92}
    .name em{font-style:italic;color:var(--accent)}
    .micro{font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:var(--muted)}
    a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  </style>
  </head><body><div class="wrap">
    ${body}
    <p style="margin-top:40px;font-size:11px;color:var(--muted)">
      <a href="https://status.lucafchala.com">← voltar ao status</a>
    </p>
  </div></body></html>`;
}

function html(content) {
  return new Response(content, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
