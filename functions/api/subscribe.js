// Inscrição na lista de avisos de mudança de status.
//
// Este é o ÚNICO endpoint público do site que escreve em KV e que faz um
// terceiro (o Resend) mandar e-mail para um endereço escolhido por quem chama.
// Essas duas propriedades juntas são o que exige tudo o que vem abaixo — sem
// elas, seria um formulário comum.
//
// O que um endpoint assim vira sem controle nenhum:
//
//   1. **Um relay de e-mail.** Qualquer pessoa POSTa o endereço de uma vítima e
//      o site manda mensagem para ela, com o nosso domínio no remetente. Feito
//      em volume, é mail-bombing terceirizado — e quem apanha na reputação de
//      envio é lucafchala.com, não quem disparou.
//   2. **Um dreno da cota de escrita do KV.** São 1000 escritas/dia no plano
//      gratuito, para a CONTA INTEIRA — compartilhadas com o site de fotos.
//      Cada inscrição nova gasta uma. Mil POSTs esvaziam a cota do dia e
//      derrubam o que importa nos dois sites.
//   3. **Um valor de KV sem teto.** A lista era um array que só crescia. O
//      limite por valor é de 25 MB, e a escrita que o estoura falha inteira:
//      perde-se a LISTA TODA, não o excedente.
//
// Nenhum dos controles abaixo custa escrita de KV: são decididos com o que já
// está na mão (cabeçalho, memória do isolate, a leitura que já ia acontecer)
// ou, no teto diário, com uma linha no D1, que tem cem vezes mais folga.

import { contarNoDia } from './retrato.js';

// Teto de e-mails de confirmação por dia (fuso de São Paulo), para o site
// inteiro. A trava por IP é por isolate e por endereço: um atacante com
// vários IPs (ou um /64 de IPv6) e endereços distintos passava por ela, e
// cada tentativa custava uma escrita de KV e um envio pelo Resend. Cinquenta
// por dia é folga para um público real (é raro ver mais que um punhado de
// inscrições num dia) e deixa a maior parte da cota diária do Resend para os
// alertas, que são o motivo de a lista existir. Só vale com STATUS_DB: sem
// ele, o controle custaria justamente a escrita de KV que protege.
export const MAX_CONFIRMACOES_DIA = 50;

// Teto da lista. Chegando aqui, inscrição nova é recusada em vez de a escrita
// falhar mais adiante e levar junto quem já estava inscrito.
const MAX_SUBSCRIBERS = 2000;

// Trava por IP, em memória do ISOLATE. Não é um rate limit forte e não finge
// ser: um atacante distribuído passa por ela. É o que dá para ter de graça —
// um limite de verdade custaria uma escrita de KV por tentativa, o que
// entregaria de bandeja justamente o recurso (2) que ele existe para proteger.
// Contra o caso comum (um script, um IP) ela resolve, e o teto acima segura o
// resto.
const IP_WINDOW_MS = 3600_000;
const IP_MAX = 5;
/** @type {Map<string, number[]>} */
const _hits = new Map();

function ipThrottled(ip) {
  const agora = Date.now();
  const recentes = (_hits.get(ip) || []).filter(t => agora - t < IP_WINDOW_MS);
  // Poda oportunista: sem isto o Map cresce com todo IP que já passou por aqui,
  // e o isolate carrega esse peso até morrer.
  if (_hits.size > 5000) _hits.clear();
  if (recentes.length >= IP_MAX) { _hits.set(ip, recentes); return true; }
  recentes.push(agora);
  _hits.set(ip, recentes);
  return false;
}

// A trava conta por REDE, não por endereço: um provedor entrega um /64
// inteiro de IPv6 a cada cliente, e contar por /128 dava a ele 2⁶⁴ chaves
// novas — uma por tentativa. IPv4 (e IPv4 mapeado em IPv6) segue por
// endereço, que é o que um cliente comum tem.
export function chaveDoIp(ip) {
  if (typeof ip !== 'string' || !ip.includes(':')) return ip || 'unknown';
  const v4 = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4) return v4[1];
  const [cabeca, cauda = ''] = ip.split('%')[0].split('::');
  const a = cabeca ? cabeca.split(':') : [];
  const b = cauda ? cauda.split(':') : [];
  const meio = ip.includes('::') ? Array(Math.max(0, 8 - a.length - b.length)).fill('0') : [];
  const grupos = [...a, ...meio, ...b].slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16));
  return `${grupos.join(':')}::/64`;
}

// Quem é o MESMO destinatário. `ana+x@gmail.com`, `ana+y@gmail.com` e
// `a.na@googlemail.com` caem na mesma caixa; com a chave pelo endereço
// literal, cada variação contava como gente nova e ganhava o próprio e-mail
// de confirmação — a regra "um link por endereço por dia" não segurava nada
// contra quem quisesse encher uma caixa. A chave junta as variações; o
// e-mail continua indo para o endereço digitado.
const PONTOS_NAO_CONTAM = new Set(['gmail.com', 'googlemail.com']);
export function chaveDoEndereco(email) {
  const arroba = email.lastIndexOf('@');
  let local = email.slice(0, arroba);
  let dominio = email.slice(arroba + 1);
  local = local.split('+')[0] || local;
  if (PONTOS_NAO_CONTAM.has(dominio)) { local = local.replace(/\./g, ''); dominio = 'gmail.com'; }
  return `${local}@${dominio}`;
}

// Mesma checagem do site de fotos (isCrossSiteRequest, src/security.js), pelo
// mesmo motivo: `Sec-Fetch-Site` é o browser dizendo de onde a requisição
// partiu, e o valor é inforjável por script. Corta outro site acionando este
// endpoint em nome de quem o visita.
//
// Ausência de sinal passa de propósito: um cliente que não manda nem
// Sec-Fetch-Site nem Origin não é um browser, e um não-browser não sofre CSRF —
// ele já controla a própria requisição. Barrar por ausência custaria
// compatibilidade sem comprar segurança.
function crossSite(request) {
  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  if (secFetchSite) return !(secFetchSite === 'same-origin' || secFetchSite === 'none');
  const origin = request.headers.get('Origin');
  if (origin) {
    try { return new URL(origin).host !== new URL(request.url).host; } catch { return true; }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Confirmação dupla (double opt-in)
// ---------------------------------------------------------------------------
// Antes, o POST já gravava o endereço na lista e mandava "Inscrição
// confirmada": qualquer pessoa inscrevia o endereço de outra, que passava a
// receber alertas que nunca pediu. Agora o POST só guarda um PENDENTE (24 h) e
// manda um link; quem entra na lista é quem abriu a caixa de entrada e clicou
// (ver confirm.js). É também o que a LGPD pede de um consentimento.
//
// A chave do pendente é o hash do DESTINATÁRIO (chaveDoEndereco), não o
// token: assim um segundo POST para a mesma caixa dentro das 24 h — ainda que
// com outro `+tag` — não manda outro e-mail. O teto de mensagens por
// destinatário vale entre isolates, sem escrita extra.
export const PENDING_TTL_S = 24 * 3600;
export const pendingKey = (id) => `pending_sub:${id}`;

export async function emailId(email) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// Turnstile é opcional: só é exigido quando o segredo existe. O GET abaixo diz
// à página se deve carregar o widget.
async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  try {
    const body = new FormData();
    body.append('secret', env.TURNSTILE_SECRET_KEY);
    body.append('response', token);
    if (ip && ip !== 'unknown') body.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body, signal: AbortSignal.timeout(5000),
    });
    const j = await res.json();
    return j && j.success === true;
  } catch (e) {
    console.error('turnstile verify failed', e);
    return false;
  }
}

export async function onRequestGet({ env }) {
  return json({ turnstile: env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SITE_KEY : null });
}

// Resposta única para "enviamos o link", "já tinha um link pendente" e "já é
// inscrito": diferenciar os três contaria a quem sonda quais endereços estão
// na lista.
const PENDENTE = { ok: true, pending: true };

export { crossSite, MAX_SUBSCRIBERS };

export async function onRequestPost({ request, env }) {
  const { RESEND_API_KEY, NOTIFY_TO, NOTIFY_FROM = 'status@lucafchala.com', STATUS_KV: KV } = env;

  if (crossSite(request)) return json({ error: 'Origem não permitida' }, 403);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (ipThrottled(chaveDoIp(ip))) return json({ error: 'Muitas tentativas. Tente mais tarde.' }, 429);

  let email, turnstile;
  try { ({ email, turnstile } = await request.json()); } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  email = (typeof email === 'string' ? email : '').trim().toLowerCase();
  if (!email || email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(email)) {
    return json({ error: 'Email inválido' }, 400);
  }

  if (!(await turnstileOk(env, turnstile, ip))) {
    return json({ error: 'Verificação anti-robô falhou. Recarregue a página e tente de novo.' }, 403);
  }

  // ---------------------------------------------------------------------------
  // Falha de CONFIGURAÇÃO não se explica para o público.
  // ---------------------------------------------------------------------------
  // As mensagens aqui diziam qual binding estava faltando pelo nome
  // ("RESEND_API_KEY ausente", "STATUS_KV ausente"). Isso é reconhecimento de
  // graça para quem sonda o site: conta qual serviço está por trás, o que está
  // configurado e o que não está. Quem precisa do detalhe é o dono — e ele já
  // tem a linha "configuração de alertas" no próprio painel, e o log.
  if (!RESEND_API_KEY || !KV) {
    console.error(`subscribe indisponível: resendKey=${!!RESEND_API_KEY} kv=${!!KV}`);
    // Aviso ao dono, quando dá: sem isto, uma inscrição perdida por
    // configuração faltando é silenciosa dos dois lados.
    if (RESEND_API_KEY && NOTIFY_TO) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: NOTIFY_FROM,
          to: [NOTIFY_TO],
          subject: 'Inscrição perdida — status.lucafchala.com',
          html: `<p style="font-family:monospace">Alguém tentou se inscrever nos alertas, mas STATUS_KV não está configurado. Adicione o binding no Cloudflare Pages.</p>`,
        }),
      }).catch(e => console.error('pending-subscription email failed', e));
    }
    return json({ error: 'Serviço de inscrição indisponível no momento.' }, 503);
  }

  // 1 read — guard the parse so corrupt KV can't 500 the endpoint
  const raw = await KV.get('subscribers');
  let subs = [];
  try { subs = raw ? JSON.parse(raw) : []; } catch { subs = []; }
  if (!Array.isArray(subs)) subs = [];

  const chave = chaveDoEndereco(email);
  if (subs.some(s => s && typeof s.email === 'string' && chaveDoEndereco(s.email) === chave)) return json(PENDENTE);

  // O teto é checado depois do "já inscrito": quem já está na lista continua
  // recebendo a resposta idempotente mesmo com a lista cheia.
  if (subs.length >= MAX_SUBSCRIBERS) {
    console.error(`subscribe recusado: lista no teto (${subs.length})`);
    return json({ error: 'Lista de inscrições temporariamente fechada.' }, 503);
  }

  const id = await emailId(chave);
  if (await KV.get(pendingKey(id))) return json(PENDENTE);

  // Teto diário (ver MAX_CONFIRMACOES_DIA): depois das respostas que não
  // mandam nada — quem já é inscrito ou pendente não gasta vaga — e antes da
  // escrita de KV, para a recusa custar zero escrita. D1 que não responde
  // fecha a porta em vez de abri-la: o teto existe para o dia ruim.
  if (env.STATUS_DB) {
    let cabe = false;
    try {
      cabe = await contarNoDia(env.STATUS_DB, 'confirmacoes', MAX_CONFIRMACOES_DIA);
    } catch (e) {
      console.error('subscribe: teto diário ilegível (D1)', e);
      return json({ error: 'Serviço de inscrição indisponível no momento.' }, 503);
    }
    if (!cabe) {
      console.error(`subscribe recusado: teto diário de ${MAX_CONFIRMACOES_DIA} confirmações atingido`);
      return json({ error: 'Muitas inscrições hoje. Tente de novo amanhã.' }, 429);
    }
  }

  const token = crypto.randomUUID();
  // 1 write
  await KV.put(pendingKey(id), JSON.stringify({ email, token, at: new Date().toISOString() }), { expirationTtl: PENDING_TTL_S });

  const confirmUrl = `https://status.lucafchala.com/api/confirm?id=${id}&token=${token}`;
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: NOTIFY_FROM,
      to: [email],
      subject: 'Confirme sua inscrição — status.lucafchala.com',
      html: confirmHtml(confirmUrl),
    }),
  });

  if (!emailRes.ok) {
    // O corpo cru da resposta da Resend ia para o cliente. Ele carrega
    // mensagem de erro de um serviço interno — às vezes com o endereço, o
    // domínio de envio ou o motivo da recusa — e nada disso é resposta para um
    // endereço não confirmado. Fica no log, onde o dono lê.
    const detail = await emailRes.text().catch(() => '');
    console.error(`confirmation email failed: ${emailRes.status} ${detail}`);
    // Sem o e-mail, o pendente só bloquearia uma nova tentativa por 24 h.
    await KV.delete(pendingKey(id)).catch(() => {});
    return json({ error: 'Não foi possível enviar o e-mail de confirmação. Tente mais tarde.' }, 502);
  }

  return json(PENDENTE);
}

function confirmHtml(confirmUrl) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0d0c0a;color:#e6e1d6;font-family:monospace;padding:32px;margin:0">
  <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#6a6358;margin-bottom:20px">status.lucafchala.com</p>
  <h1 style="font-family:Georgia,serif;font-weight:300;font-size:28px;margin:0 0 12px">
    Confirme a <em style="color:#c08030;font-style:italic">inscrição</em>
  </h1>
  <p style="font-size:13px;color:#9a8f80;margin:0 0 20px">
    Alguém (provavelmente você) pediu para receber um e-mail quando um serviço de lucafchala.com mudar de status.
    Para ativar, abra o link abaixo e confirme. Ele vale por 24 horas.
  </p>
  <p style="margin:0 0 28px"><a href="${confirmUrl}" style="color:#c08030">Confirmar inscrição</a></p>
  <p style="font-size:11px;color:#6a6358;border-top:1px solid #252220;padding-top:16px;margin:0">
    Se não foi você, ignore esta mensagem: sem a confirmação, nada é guardado depois de 24 horas.
  </p>
</body></html>`;
}

export function welcomeHtml(unsubUrl) {
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
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
