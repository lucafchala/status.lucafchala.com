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
// Nenhum dos controles abaixo custa I/O: são todos decididos com o que já está
// na mão (cabeçalho, memória do isolate, ou a leitura que já ia acontecer).

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

export async function onRequestPost({ request, env }) {
  const { RESEND_API_KEY, NOTIFY_TO, NOTIFY_FROM = 'status@lucafchala.com', STATUS_KV: KV } = env;

  if (crossSite(request)) return json({ error: 'Origem não permitida' }, 403);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (ipThrottled(ip)) return json({ error: 'Muitas tentativas. Tente mais tarde.' }, 429);

  let email;
  try { ({ email } = await request.json()); } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  email = (email || '').trim().toLowerCase();
  if (!email || email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(email)) {
    return json({ error: 'Email inválido' }, 400);
  }

  // ---------------------------------------------------------------------------
  // Falha de CONFIGURAÇÃO não se explica para o público.
  // ---------------------------------------------------------------------------
  // As mensagens aqui diziam qual binding estava faltando pelo nome
  // ("RESEND_API_KEY ausente", "STATUS_KV ausente"). Isso é reconhecimento de
  // graça para quem sonda o site: conta qual serviço está por trás, o que está
  // configurado e o que não está. Quem precisa do detalhe é o dono — e ele já
  // tem /api/healthz, que reporta cada binding como booleano, e o log.
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
          subject: `Nova inscrição pendente — ${email}`,
          html: `<p style="font-family:monospace">${esc(email)} quer receber alertas mas STATUS_KV não está configurado. Adicione o binding no Cloudflare Pages.</p>`,
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

  if (subs.some(s => s && s.email === email)) {
    return json({ ok: true, already: true });
  }

  // O teto é checado depois do "já inscrito": quem já está na lista continua
  // recebendo a resposta idempotente mesmo com a lista cheia.
  if (subs.length >= MAX_SUBSCRIBERS) {
    console.error(`subscribe recusado: lista no teto (${subs.length})`);
    return json({ error: 'Lista de inscrições temporariamente fechada.' }, 503);
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
      // RFC 8058: cliente de e-mail mostra o botão nativo de cancelar, e o
      // POST de um clique cai direto no onRequestPost do unsubscribe.
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      html: welcomeHtml(unsubUrl),
    }),
  });

  if (!emailRes.ok) {
    // O corpo cru da resposta da Resend ia para o cliente. Ele carrega
    // mensagem de erro de um serviço interno — às vezes com o endereço, o
    // domínio de envio ou o motivo da recusa — e nada disso é resposta para um
    // endereço não confirmado. Fica no log, onde o dono lê.
    const detail = await emailRes.text().catch(() => '');
    console.error(`welcome email failed: ${emailRes.status} ${detail}`);
    return json({ error: 'Inscrição salva, mas o e-mail de confirmação falhou.' }, 502);
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
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
