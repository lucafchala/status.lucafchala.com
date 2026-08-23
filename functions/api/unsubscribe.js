// Cancelamento de inscrição.
//
// ---------------------------------------------------------------------------
// Por que o GET não cancela mais nada
// ---------------------------------------------------------------------------
// Isto era um `onRequestGet` que apagava o inscrito. GET é definido como método
// SEGURO (RFC 9110 §9.2.1): não pode ter efeito colateral, porque a rede
// inteira trata GET como algo que se pode repetir à vontade. Quem faz isso, na
// prática, é justamente a infraestrutura por onde este link passa:
//
//   - antivírus e gateways de e-mail corporativos abrem cada link da mensagem
//     para verificá-lo — e cancelavam a inscrição antes de a pessoa ler;
//   - o pré-carregamento do browser e o preview de link de aplicativos de
//     mensagem fazem o mesmo;
//   - qualquer imagem/iframe apontando para a URL, num site hostil, também.
//
// O resultado é o pior de dois mundos: gente que nunca clicou parava de receber
// aviso, e não havia como distinguir isso de um cancelamento de verdade.
//
// Agora o GET só MOSTRA (leitura pura, nenhum efeito), e o POST executa. É a
// mesma forma que a RFC 8058 padroniza para o botão nativo de "cancelar
// inscrição" dos clientes de e-mail: eles mandam um POST com
// `List-Unsubscribe=One-Click` no corpo, que cai direto no handler abaixo — daí
// os cabeçalhos `List-Unsubscribe`/`List-Unsubscribe-Post` que subscribe.js e
// status.js passam a enviar. Um clique continua bastando; ele só deixou de ser
// disparável por quem não é a pessoa.
//
// O token continua sendo a autorização, e é por isso que este POST não exige
// same-origin: o clique de um clique da RFC 8058 vem do cliente de e-mail, sem
// contexto do site. Quem tem o token está na caixa de entrada do endereço.

const TOKEN_RE = /^[0-9a-f-]{36}$/i; // crypto.randomUUID()

/** Lê a lista e acha o índice do token. Sem efeito colateral. */
async function lookup(KV, token) {
  // 1 read — guard the parse so corrupt KV can't 500 the endpoint
  const raw = await KV.get('subscribers');
  let subs = [];
  try { subs = raw ? JSON.parse(raw) : []; } catch { subs = []; }
  if (!Array.isArray(subs)) subs = [];
  return { subs, idx: subs.findIndex(s => s && s.token === token) };
}

export async function onRequestGet({ request, env }) {
  const KV = env.STATUS_KV;
  const token = new URL(request.url).searchParams.get('token');

  if (!KV || !token || !TOKEN_RE.test(token)) return page({ state: 'invalid' });

  const { subs, idx } = await lookup(KV, token);
  if (idx === -1) return page({ state: 'invalid' });

  // Confirmação. O único efeito de abrir este link é ver esta página.
  return page({ state: 'confirm', email: subs[idx].email, token });
}

export async function onRequestPost({ request, env }) {
  const KV = env.STATUS_KV;
  // O token pode vir na query (formulário desta página e RFC 8058, que POSTa
  // na MESMA URL do cabeçalho List-Unsubscribe) ou no corpo do formulário.
  const url = new URL(request.url);
  let token = url.searchParams.get('token');
  if (!token) {
    const fd = await request.formData().catch(() => null);
    token = fd ? String(fd.get('token') || '') : '';
  }

  if (!KV || !token || !TOKEN_RE.test(token)) return page({ state: 'invalid' }, 400);

  const { subs, idx } = await lookup(KV, token);
  // Já cancelado é SUCESSO, não erro: o botão de um clique pode ser acionado
  // duas vezes, e a segunda não pode dizer "link inválido" a quem de fato já
  // não está mais na lista. Idempotência é requisito da RFC 8058.
  if (idx === -1) return page({ state: 'done' });

  const { email } = subs[idx];
  subs.splice(idx, 1);

  // 1 write
  await KV.put('subscribers', JSON.stringify(subs));

  return page({ state: 'done', email });
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

/**
 * @param {{ state: 'confirm'|'done'|'invalid', email?: string, token?: string }} opts
 */
function page({ state, email = '', token = '' }, status = 200) {
  const confirm = state === 'confirm';
  const done = state === 'done';

  const title = done ? 'Inscrição cancelada' : confirm ? 'Cancelar inscrição' : 'Erro';
  const heading = done
    ? 'Inscrição <em>cancelada</em>'
    : confirm ? 'Cancelar <em>inscrição</em>?' : 'Link <em>inválido</em>';

  const body = done
    ? `<p class="msg">${email ? `Inscrição de ${esc(email)} cancelada.` : 'Inscrição cancelada.'}</p>`
    : confirm
      // O POST é o que executa — ver o cabeçalho deste arquivo.
      ? `<p class="msg">Confirme para parar de receber os avisos${email ? ` em ${esc(email)}` : ''}.</p>
         <form method="POST" action="/api/unsubscribe">
           <input type="hidden" name="token" value="${esc(token)}">
           <button type="submit">Cancelar inscrição</button>
         </form>`
      : '<p class="msg">Link inválido ou já utilizado.</p>';

  return new Response(`<!DOCTYPE html><html lang="pt-BR" data-theme="dark"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title} — status.lucafchala.com</title>
  <meta name="theme-color" content="#0d0c0a"/>
  <meta name="robots" content="noindex,nofollow"/>
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
    .msg{font-size:12px;color:var(--muted);margin-top:20px}
    form{margin-top:28px}
    button{font-family:inherit;font-size:12px;letter-spacing:.08em;text-transform:uppercase;
           background:transparent;color:var(--accent);border:1px solid var(--accent);
           padding:10px 20px;border-radius:2px;cursor:pointer}
    button:hover{background:var(--accent);color:var(--bg)}
    a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  </style></head>
  <body><div class="wrap">
    <h1>${heading}</h1>
    ${body}
    <p style="margin-top:40px;font-size:11px;color:var(--muted)">
      <a href="https://status.lucafchala.com">← voltar ao status</a>
    </p>
  </div></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'X-Content-Type-Options': 'nosniff',
      // CSP própria, e não herdada do `_headers`: aquele arquivo governa os
      // assets estáticos, e uma resposta de Function não pode depender dele
      // para ter política. Esta página renderiza um endereço de e-mail vindo
      // do armazenamento e não executa script nenhum — então `script-src
      // 'none'` é literalmente o que ela precisa.
      'Content-Security-Policy': [
        "default-src 'none'",
        "style-src 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "img-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
      'X-Frame-Options': 'DENY',
      // A página carrega o endereço de quem cancelou; nada disso pode ficar em
      // cache intermediário nem ser indexado.
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
