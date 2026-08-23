// Testes das Pages Functions.
//
// Rodam com o executor embutido do Node (`node --test`), sem dependência
// nenhuma: este repositório não tem package.json e não vale a pena ganhar um
// para isto. O que importa é que os controles abaixo parem de ser afirmações
// no comentário e passem a ser afirmações verificáveis.
//
// A regra do que entra aqui é a mesma da suíte de segurança do site de fotos:
// controle de segurança falha em SILÊNCIO. Um rate limit que parou de contar,
// um GET que voltou a apagar, uma mensagem de erro que voltou a dizer qual
// binding falta — nada disso quebra uma tela, e por isso cada um precisa de um
// teste afirmando o comportamento NEGATIVO ("isto tem que ser recusado").

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const subscribe = await import('../functions/api/subscribe.js');
const unsubscribe = await import('../functions/api/unsubscribe.js');

/** KV em memória, com contador de escritas — a cota de escrita é o recurso escasso. */
function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    writes: 0,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { this.writes++; store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

const TOKEN = '11111111-2222-3333-4444-555555555555';

function subsJSON(...emails) {
  return JSON.stringify(emails.map((email, i) => ({
    email,
    token: i === 0 ? TOKEN : `${i}1111111-2222-3333-4444-555555555555`,
    subscribedAt: '2026-01-01T00:00:00Z',
  })));
}

function postReq(body, headers = {}) {
  return new Request('https://status.lucafchala.com/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': randomIp(), ...headers },
    body: JSON.stringify(body),
  });
}

// IP novo por chamada: a trava por IP é estado de MÓDULO e sobrevive entre
// testes. Um IP fixo faria um teste envenenar o seguinte — e o sintoma seria
// uma falha em cascata difícil de ler.
let _ip = 0;
function randomIp() { return `10.0.0.${++_ip % 250}`; }

describe('POST /api/subscribe', () => {
  test('recusa requisição de outro site (CSRF)', async () => {
    const res = await subscribe.onRequestPost({
      request: postReq({ email: 'a@b.co' }, { 'Sec-Fetch-Site': 'cross-site' }),
      env: { RESEND_API_KEY: 'k', STATUS_KV: fakeKV() },
    });
    assert.equal(res.status, 403);
  });

  test('aceita navegação direta (Sec-Fetch-Site: none)', async () => {
    // 'none' é o usuário digitando a URL / usando favorito. Não é ataque, e
    // barrar por isso custaria compatibilidade sem comprar segurança.
    const env = { RESEND_API_KEY: 'k', STATUS_KV: fakeKV({ subscribers: '[]' }) };
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    const res = await subscribe.onRequestPost({
      request: postReq({ email: 'novo@b.co' }, { 'Sec-Fetch-Site': 'none' }),
      env,
    });
    assert.equal(res.status, 200);
  });

  test('recusa e-mail inválido antes de tocar no KV', async () => {
    const kv = fakeKV();
    const res = await subscribe.onRequestPost({
      request: postReq({ email: 'não-é-email' }),
      env: { RESEND_API_KEY: 'k', STATUS_KV: kv },
    });
    assert.equal(res.status, 400);
    assert.equal(kv.writes, 0, 'entrada inválida não pode custar escrita de KV');
  });

  test('não conta qual binding está faltando para o público', async () => {
    // Reconhecimento de graça: as mensagens antigas diziam "RESEND_API_KEY
    // ausente" / "STATUS_KV ausente", ou seja, contavam a quem sondasse qual
    // serviço está por trás e o que está configurado.
    const res = await subscribe.onRequestPost({
      request: postReq({ email: 'a@b.co' }),
      env: { STATUS_KV: fakeKV() },   // sem RESEND_API_KEY
    });
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.doesNotMatch(body.error, /RESEND_API_KEY|STATUS_KV|binding/i);
  });

  test('não devolve o corpo cru da resposta do Resend', async () => {
    // Ele carrega mensagem de erro de um serviço interno — e vai para um
    // endereço que ainda não foi confirmado.
    const env = { RESEND_API_KEY: 'k', STATUS_KV: fakeKV({ subscribers: '[]' }) };
    globalThis.fetch = async () => new Response('domain lucafchala.com is not verified', { status: 403 });
    const res = await subscribe.onRequestPost({ request: postReq({ email: 'novo2@b.co' }), env });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.doesNotMatch(body.error, /not verified|lucafchala\.com/);
  });

  test('é idempotente para quem já está inscrito, sem gastar escrita', async () => {
    const kv = fakeKV({ subscribers: subsJSON('ja@b.co') });
    const res = await subscribe.onRequestPost({
      request: postReq({ email: 'ja@b.co' }),
      env: { RESEND_API_KEY: 'k', STATUS_KV: kv },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).already, true);
    assert.equal(kv.writes, 0);
  });

  test('trava o mesmo IP depois de algumas tentativas', async () => {
    // A trava é o que impede um laço de curl de esvaziar a cota de escrita do
    // KV — 1000/dia para a conta inteira, compartilhada com o site de fotos.
    const env = { RESEND_API_KEY: 'k', STATUS_KV: fakeKV({ subscribers: '[]' }) };
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    const ip = '203.0.113.99';
    const codes = [];
    for (let i = 0; i < 8; i++) {
      const req = new Request('https://status.lucafchala.com/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ email: `p${i}@b.co` }),
      });
      codes.push((await subscribe.onRequestPost({ request: req, env })).status);
    }
    assert.ok(codes.includes(429), `esperava um 429 na sequência, veio ${codes.join(',')}`);
  });

  test('recusa inscrição nova com a lista no teto', async () => {
    // Sem teto, o valor cresce até passar dos 25 MB por valor do KV — e a
    // escrita que estoura falha INTEIRA, levando junto quem já estava inscrito.
    const muitos = Array.from({ length: 2000 }, (_, i) => ({ email: `u${i}@b.co`, token: `t${i}` }));
    const kv = fakeKV({ subscribers: JSON.stringify(muitos) });
    const res = await subscribe.onRequestPost({
      request: postReq({ email: 'ultimo@b.co' }),
      env: { RESEND_API_KEY: 'k', STATUS_KV: kv },
    });
    assert.equal(res.status, 503);
    assert.equal(kv.writes, 0);
  });
});

describe('/api/unsubscribe', () => {
  const getReq = token =>
    new Request(`https://status.lucafchala.com/api/unsubscribe?token=${token}`);

  test('GET não cancela nada — só mostra a confirmação', async () => {
    // RFC 9110 §9.2.1: GET é SEGURO. Antivírus de e-mail corporativo, preview
    // de link e pré-carregamento do browser abrem cada URL da mensagem — e
    // cancelavam a inscrição antes de a pessoa ler.
    const kv = fakeKV({ subscribers: subsJSON('quem@b.co') });
    const res = await unsubscribe.onRequestGet({ request: getReq(TOKEN), env: { STATUS_KV: kv } });
    const html = await res.text();

    assert.equal(res.status, 200);
    assert.equal(kv.writes, 0, 'GET não pode escrever');
    assert.equal(JSON.parse(kv._store.get('subscribers')).length, 1, 'ninguém pode sair por um GET');
    assert.match(html, /method="POST"/, 'a página tem de oferecer o POST que executa');
  });

  test('POST cancela de verdade', async () => {
    const kv = fakeKV({ subscribers: subsJSON('quem@b.co', 'outro@b.co') });
    const res = await unsubscribe.onRequestPost({
      request: new Request(`https://status.lucafchala.com/api/unsubscribe?token=${TOKEN}`, { method: 'POST' }),
      env: { STATUS_KV: kv },
    });
    assert.equal(res.status, 200);
    const restantes = JSON.parse(kv._store.get('subscribers'));
    assert.equal(restantes.length, 1);
    assert.equal(restantes[0].email, 'outro@b.co');
  });

  test('POST repetido é sucesso, não erro (RFC 8058 exige idempotência)', async () => {
    const kv = fakeKV({ subscribers: subsJSON('quem@b.co') });
    const req = () => new Request(`https://status.lucafchala.com/api/unsubscribe?token=${TOKEN}`, { method: 'POST' });
    assert.equal((await unsubscribe.onRequestPost({ request: req(), env: { STATUS_KV: kv } })).status, 200);
    const segundo = await unsubscribe.onRequestPost({ request: req(), env: { STATUS_KV: kv } });
    assert.equal(segundo.status, 200, 'o botão de um clique pode ser acionado duas vezes');
    assert.match(await segundo.text(), /cancelada/i);
  });

  test('token malformado é recusado sem ler o KV', async () => {
    const kv = fakeKV({ subscribers: subsJSON('quem@b.co') });
    const res = await unsubscribe.onRequestGet({ request: getReq('../../etc/passwd'), env: { STATUS_KV: kv } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /inválido/i);
    assert.equal(kv.writes, 0);
  });

  test('escapa o endereço na página de confirmação', async () => {
    const hostil = '"><script>alert(1)</script>@b.co';
    const kv = fakeKV({ subscribers: JSON.stringify([{ email: hostil, token: TOKEN }]) });
    const html = await (await unsubscribe.onRequestGet({ request: getReq(TOKEN), env: { STATUS_KV: kv } })).text();
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  test('a página não pode ser indexada nem ficar em cache', async () => {
    // Ela carrega o endereço de quem cancelou.
    const kv = fakeKV({ subscribers: subsJSON('quem@b.co') });
    const res = await unsubscribe.onRequestGet({ request: getReq(TOKEN), env: { STATUS_KV: kv } });
    assert.match(res.headers.get('Cache-Control') || '', /no-store/);
    assert.match(res.headers.get('X-Robots-Tag') || '', /noindex/);
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  });
});
