// /api/resumo: o que a home de lucafchala.com lê para as bolinhas de status.
//
// O que falha em silêncio aqui é a outra origem: sem
// Access-Control-Allow-Origin o navegador descarta a resposta e a home só
// deixa de desenhar — nenhum erro visível (foi o que aconteceu com o
// /api/painel em 2026-09-24). E o custo: este endpoint é chamado por
// visitante de OUTRO site, então não pode sondar nada.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { d1Sqlite } from './d1.mjs';

const resumo = await import('../functions/api/resumo.js');
const retrato = await import('../functions/api/retrato.js');

const realFetch = globalThis.fetch;
let fetches = [];
beforeEach(() => {
  fetches = [];
  globalThis.fetch = async (u) => { fetches.push(String(u?.url || u)); return new Response('{}'); };
  const m = new Map();
  globalThis.caches = { default: { async match(r) { const x = m.get(r.url); return x ? x.clone() : undefined; }, async put(r, res) { m.set(r.url, res.clone()); } } };
});
afterEach(() => { globalThis.fetch = realFetch; });

function ctx(env, url = 'https://status.lucafchala.com/api/resumo') {
  const pend = [];
  return { request: new Request(url, { headers: { Origin: 'https://lucafchala.com' } }), env, waitUntil(p) { pend.push(p); }, flush: () => Promise.all(pend) };
}

const PAYLOAD = {
  checkedAt: '2026-09-24T12:00:00Z',
  services: [
    { name: 'lucafchala.com', url: 'https://lucafchala.com', status: 'up', rt: 200, checks: [{ label: 'x', status: 'up', detail: 'muito texto '.repeat(50) }], problems: [] },
    { name: 'Paste', url: 'https://paste.lucafchala.com', status: 'degraded', rt: 900, checks: [], problems: ['lento'] },
    { name: 'Esquisito', url: 'https://x.lucafchala.com', status: 'checking' },
  ],
};

describe('GET /api/resumo', () => {
  test('com retrato: CORS aberto, só nome/url/estado, nenhuma sonda', async () => {
    const DB = d1Sqlite();
    await retrato.gravarVarredura(DB, PAYLOAD, 'agendador', Date.now());
    const c = ctx({ STATUS_DB: DB });
    const res = await resumo.onRequestGet(c);
    await c.flush();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(res.headers.get('Cache-Control'), /s-maxage=60/);
    const body = await res.json();
    assert.equal(body.retratoCompartilhado, true);
    assert.deepEqual(body.services, [
      { name: 'lucafchala.com', url: 'https://lucafchala.com', status: 'up' },
      { name: 'Paste', url: 'https://paste.lucafchala.com', status: 'degraded' },
    ], 'estado fora de up/degraded/down fica de fora; checks e problems não vazam');
    assert.equal(fetches.length, 0, 'visitante de outro site nunca dispara sonda');
  });

  test('payload pequeno (a home não precisa do painel de ~90 KB)', async () => {
    const DB = d1Sqlite();
    const muitos = { services: Array.from({ length: 13 }, (_, i) => ({ ...PAYLOAD.services[0], name: 's' + i, url: `https://s${i}.lucafchala.com` })) };
    await retrato.gravarVarredura(DB, muitos, 'agendador', Date.now());
    const txt = await (await resumo.onRequestGet(ctx({ STATUS_DB: DB }))).text();
    assert.ok(txt.length < 2000, `resumo com 13 serviços tem ${txt.length} bytes`);
  });

  test('sem STATUS_DB ou com o D1 quebrado: 200, CORS, nada a desenhar', async () => {
    for (const env of [{}, { STATUS_DB: { prepare() { throw new Error('D1 down'); }, async batch() { throw new Error('D1 down'); } } }]) {
      const res = await resumo.onRequestGet(ctx(env));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
      assert.deepEqual(await res.json(), { retratoCompartilhado: false, services: [] });
    }
  });

  test('query aleatória não fura o cache', async () => {
    const DB = d1Sqlite();
    await retrato.gravarVarredura(DB, PAYLOAD, 'agendador', Date.now());
    const c1 = ctx({ STATUS_DB: DB }, 'https://status.lucafchala.com/api/resumo?a=1');
    await resumo.onRequestGet(c1); await c1.flush();
    let leu = false;
    const espiao = { prepare() { leu = true; throw new Error('não devia ler'); } };
    const res = await resumo.onRequestGet(ctx({ STATUS_DB: espiao }, 'https://status.lucafchala.com/api/resumo?b=2'));
    assert.equal(leu, false);
    assert.equal((await res.json()).retratoCompartilhado, true);
  });

  test('OPTIONS responde 204 com CORS', () => {
    const res = resumo.onRequestOptions();
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  });
});
