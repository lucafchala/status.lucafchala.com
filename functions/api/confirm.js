// Confirmação da inscrição (segunda metade do double opt-in de subscribe.js).
//
// Mesma forma do unsubscribe.js, pelo mesmo motivo: GET só MOSTRA um botão, e o
// POST executa. Antivírus de e-mail e preview de link abrem cada URL da
// mensagem; se o GET confirmasse, o scanner confirmaria por quem nunca leu —
// e o double opt-in viraria de enfeite.
//
// A autorização é o par id + token do link, que só existe na caixa de entrada
// do endereço. Por isso o POST não exige same-origin além do que o formulário
// desta própria página já garante.

import { pendingKey, MAX_SUBSCRIBERS, welcomeHtml } from './subscribe.js';

const ID_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[0-9a-f-]{36}$/i;

async function lerPendente(KV, id, token) {
  if (!KV || !id || !token || !ID_RE.test(id) || !TOKEN_RE.test(token)) return null;
  let p = null;
  try { p = JSON.parse(await KV.get(pendingKey(id)) || 'null'); } catch { p = null; }
  if (!p || typeof p.email !== 'string' || p.token !== token) return null;
  return p;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const token = url.searchParams.get('token');
  const p = await lerPendente(env.STATUS_KV, id, token);
  if (!p) return page({ state: 'invalid' });
  return page({ state: 'confirm', email: p.email, id, token });
}

export async function onRequestPost({ request, env }) {
  const { STATUS_KV: KV, RESEND_API_KEY, NOTIFY_FROM = 'status@lucafchala.com' } = env;
  const fd = await request.formData().catch(() => null);
  const id = fd ? String(fd.get('id') || '') : '';
  const token = fd ? String(fd.get('token') || '') : '';

  const p = await lerPendente(KV, id, token);
  if (!p) return page({ state: 'invalid' }, 400);

  const raw = await KV.get('subscribers');
  let subs = [];
  try { subs = raw ? JSON.parse(raw) : []; } catch { subs = []; }
  if (!Array.isArray(subs)) subs = [];

  // Clique duplo, ou dois links pedidos: já está na lista é SUCESSO.
  const existente = subs.find((s) => s && s.email === p.email);
  if (existente) {
    await KV.delete(pendingKey(id)).catch(() => {});
    return page({ state: 'done', email: p.email });
  }
  if (subs.length >= MAX_SUBSCRIBERS) {
    console.error(`confirm recusado: lista no teto (${subs.length})`);
    return page({ state: 'full' }, 503);
  }

  // O token do link vira o token de cancelamento: quem tem um tem o outro.
  subs.push({ email: p.email, token, subscribedAt: new Date().toISOString(), confirmedAt: new Date().toISOString() });
  await KV.put('subscribers', JSON.stringify(subs));
  await KV.delete(pendingKey(id)).catch(() => {});

  // Boas-vindas com o link de cancelamento. Falhar aqui não desfaz a
  // inscrição: ela já está confirmada, e cada alerta traz o mesmo link.
  if (RESEND_API_KEY) {
    const unsubUrl = `https://status.lucafchala.com/api/unsubscribe?token=${token}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: [p.email],
        subject: 'Inscrição confirmada — status.lucafchala.com',
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        html: welcomeHtml(unsubUrl),
      }),
    }).then((r) => { if (!r.ok) console.error('welcome email failed', r.status); })
      .catch((e) => console.error('welcome email failed', e));
  }

  return page({ state: 'done', email: p.email });
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

/**
 * @param {{ state: 'confirm'|'done'|'invalid'|'full', email?: string, id?: string, token?: string }} opts
 */
function page({ state, email = '', id = '', token = '' }, status = 200) {
  const T = {
    confirm: ['Confirmar inscrição', 'Confirmar <em>inscrição</em>?',
      `<p class="msg">Receber um e-mail em ${esc(email)} quando um serviço de lucafchala.com mudar de status. Dá para cancelar pelo link de cada mensagem.</p>
       <form method="POST" action="/api/confirm">
         <input type="hidden" name="id" value="${esc(id)}">
         <input type="hidden" name="token" value="${esc(token)}">
         <button type="submit">Confirmar inscrição</button>
       </form>`],
    done: ['Inscrição confirmada', 'Inscrição <em>confirmada</em>',
      `<p class="msg">${esc(email)} vai receber os avisos de mudança de status.</p>`],
    full: ['Lista fechada', 'Lista <em>fechada</em>',
      '<p class="msg">A lista de inscrições está temporariamente fechada. Tente mais tarde.</p>'],
    invalid: ['Erro', 'Link <em>inválido</em>',
      '<p class="msg">Link inválido, expirado (vale 24 horas) ou já utilizado. Peça um novo na página de status.</p>'],
  }[state];

  return new Response(`<!DOCTYPE html><html lang="pt-BR" data-theme="dark"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${T[0]} — status.lucafchala.com</title>
  <meta name="theme-color" content="#0d0c0a"/>
  <meta name="robots" content="noindex,nofollow"/>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
  <link rel="stylesheet" href="/cancelar.css"/>
  </head>
  <body><div class="wrap">
    <h1>${T[1]}</h1>
    ${T[2]}
    <p class="voltar">
      <a href="https://status.lucafchala.com">← voltar ao status</a>
    </p>
  </div></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'X-Content-Type-Options': 'nosniff',
      // Mesma política da página de cancelamento: nenhum script, estilo e
      // fontes só da própria origem.
      'Content-Security-Policy': [
        "default-src 'none'",
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
