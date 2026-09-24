// /api/painel: o que a página lê numa chamada só.
//
// Dois riscos que não aparecem como erro:
//   • o teto de 50 subrequests é por invocação. Juntar tudo numa chamada é o
//     jeito de passar dele sem perceber — por isso o teste CONTA os fetch;
//   • uma seção que lança derrubava a resposta inteira, e o painel sumia por
//     causa de um provedor de terceiros fora do ar.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const painel = await import('../functions/api/painel.js');
const terceiros = await import('../functions/api/third-party-status.js');

const realFetch = globalThis.fetch;
let fetches = [];

/** Cache API em memória, por chave de URL — o que a borda faz por colo. */
function fakeCache() {
  const m = new Map();
  return {
    async match(req) { const r = m.get(req.url); return r ? r.clone() : undefined; },
    async put(req, res) { m.set(req.url, res.clone()); },
    _m: m,
  };
}

function context(url = 'https://status.lucafchala.com/api/painel', env = {}) {
  const pend = [];
  return {
    request: new Request(url),
    env,
    waitUntil(p) { pend.push(p); },
    async flush() { await Promise.all(pend); },
  };
}

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); } };
}

// Provedores e API da Cloudflare respondendo "tudo bem" — o caso de custo
// máximo é o de cache frio, não o de erro.
function mundoSaudavel() {
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input);
    fetches.push(url);
    if (url.endsWith('/graphql')) return new Response(JSON.stringify({ data: { viewer: { accounts: [{}] } } }));
    if (url.includes('/zones?')) return new Response(JSON.stringify({ success: true, result: [{ id: 'z1', name: 'lucafchala.com' }] }));
    if (url.includes('/ssl/certificate_packs')) return new Response(JSON.stringify({ success: true, result: [] }));
    if (url.includes('components.json')) return new Response(JSON.stringify({ components: [] }));
    if (url.includes('incidents.json')) return new Response('[]');
    return new Response(JSON.stringify({ status: { indicator: 'none', description: 'ok' } }));
  };
}

beforeEach(() => { fetches = []; globalThis.caches = { default: fakeCache() }; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('/api/painel', () => {
  test('cabe no teto de subrequests com o cache frio, e com folga', async () => {
    // 50 por invocação no plano gratuito. A varredura (~38) fica de fora
    // justamente por isso; o que sobra aqui precisa de margem.
    mundoSaudavel();
    const ctx = context('https://status.lucafchala.com/api/painel', { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', STATUS_KV: fakeKV() });
    const res = await painel.onRequestGet(ctx);
    assert.equal(res.status, 200);
    assert.ok(fetches.length <= 15, `painel fez ${fetches.length} fetch com o cache frio`);
    assert.ok(!fetches.some((u) => u.includes('/api/status')), 'o painel não varre');
  });

  test('traz as quatro seções que a página usava em quatro chamadas', async () => {
    mundoSaudavel();
    const body = await (await painel.onRequestGet(context(undefined, { STATUS_KV: fakeKV() }))).json();
    for (const k of ['terceiros', 'cotas', 'historico', 'latencia']) assert.ok(k in body, `falta ${k}`);
    assert.equal(body.cotas.configured, false);
    assert.ok(Array.isArray(body.terceiros.services));
  });

  test('uma seção que lança vira { erro } e não derruba as outras', async () => {
    mundoSaudavel();
    // KV que lança em toda leitura: histórico e latência já engolem isso
    // sozinhos; o teste força o pior caso quebrando a seção de terceiros.
    const cache = globalThis.caches.default;
    globalThis.caches.default = {
      ...cache,
      async match(req) { if (req.url.endsWith('/api/third-party-status')) throw new Error('boom'); return cache.match(req); },
    };
    const res = await painel.onRequestGet(context(undefined, { STATUS_KV: fakeKV() }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.terceiros.erro, 'a seção quebrada diz que não leu');
    assert.ok(body.historico && !body.historico.erro, 'as outras seguem');
  });

  test('query aleatória não fura o cache (painel e terceiros)', async () => {
    // Com a URL inteira como chave, `?x=<aleatório>` virava 5–6 fetches a
    // provedores por pedido — amplificação de graça.
    mundoSaudavel();
    const c1 = context('https://status.lucafchala.com/api/painel?x=1', { STATUS_KV: fakeKV() });
    await painel.onRequestGet(c1); await c1.flush();
    const antes = fetches.length;
    const c2 = context('https://status.lucafchala.com/api/painel?x=2', { STATUS_KV: fakeKV() });
    await painel.onRequestGet(c2); await c2.flush();
    assert.equal(fetches.length, antes, 'o segundo pedido não saiu para a rede');

    fetches = [];
    const t1 = context('https://status.lucafchala.com/api/third-party-status?a=1');
    await terceiros.onRequestGet(t1); await t1.flush();
    const t2 = context('https://status.lucafchala.com/api/third-party-status?a=2');
    await terceiros.onRequestGet(t2); await t2.flush();
    assert.equal(fetches.length, 0, 'terceiros já estava no cache pela chave fixa');
  });
});

const quota = await import('../functions/api/quota-stats.js');

describe('/api/quota-stats — o que a Cloudflare já mede de cada Worker', () => {
  function cloudflare({ doQuebrado = false } = {}) {
    globalThis.fetch = async (input, init) => {
      const url = String(input?.url || input);
      if (url.endsWith('/graphql')) {
        const q = JSON.parse(init.body).query;
        if (q.includes('durableObjectsInvocationsAdaptiveGroups')) {
          if (doQuebrado) return new Response(JSON.stringify({ errors: [{ message: 'unknown field' }] }));
          return new Response(JSON.stringify({ data: { viewer: { accounts: [{ durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 340 }, dimensions: { scriptName: 'fotos' } }] }] } } }));
        }
        if (q.includes('datetimeHour')) {
          return new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
            { sum: { requests: 100, errors: 0 }, quantiles: { cpuTimeP99: 4100 }, dimensions: { datetimeHour: '2026-09-24T10:00:00Z' } },
            { sum: { requests: 80, errors: 4 }, quantiles: { cpuTimeP99: 39100 }, dimensions: { datetimeHour: '2026-09-24T11:00:00Z' } },
          ] }] } } }));
        }
        if (q.includes('workersInvocationsAdaptive')) {
          return new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
            { sum: { requests: 180, errors: 4 }, quantiles: { cpuTimeP50: 1200, cpuTimeP99: 39100 }, dimensions: { scriptName: 'fotos' } },
            { sum: { requests: 900, errors: 0 }, quantiles: { cpuTimeP50: 800, cpuTimeP99: 3000 }, dimensions: { scriptName: 'status-agendador' } },
          ] }] } } }));
        }
        return new Response(JSON.stringify({ data: { viewer: { accounts: [{}] } } }));
      }
      if (url.includes('/zones?')) return new Response(JSON.stringify({ success: true, result: [] }));
      return new Response('{}', { status: 404 });
    };
  }
  const ctx = () => ({ request: new Request('https://status.lucafchala.com/api/quota-stats'), env: { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a' }, waitUntil() {} });

  test('detalhe por Worker, com taxa de erro e CPU em ms, maior primeiro', async () => {
    cloudflare();
    const body = await quota.lerCotas(ctx());
    assert.deepEqual(body.porWorker.map((w) => w.script), ['status-agendador', 'fotos']);
    const fotos = body.porWorker.find((w) => w.script === 'fotos');
    assert.equal(fotos.errosPct, 2.22);
    assert.equal(fotos.cpuP50Ms, 1.2);
    assert.equal(fotos.cpuP99Ms, 39.1);
    assert.equal(body.workerPorHora.script, 'fotos');
    assert.equal(body.workerPorHora.horas.length, 2);
    assert.equal(body.durableObjects.requests, 340);
    // Somas de cota continuam as mesmas.
    assert.equal(body.quotas.find((q) => q.key === 'workerRequests').used, 1080);
  });

  test('consulta nova que falha custa só a própria linha', async () => {
    cloudflare({ doQuebrado: true });
    const body = await quota.lerCotas(ctx());
    assert.equal(body.durableObjects, null);
    assert.ok(body.errors.some((e) => /Durable Objects/.test(e)));
    assert.ok(body.porWorker.length === 2, 'o resto segue');
    assert.equal(body.quotas.find((q) => q.key === 'workerRequests').used, 1080);
  });
});
