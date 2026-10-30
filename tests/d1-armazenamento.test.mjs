// "D1 · armazenamento" em /api/quota-stats.
//
// A linha ficou meses em "sem dados" sem ninguém ver: a cota existia em LIMITS,
// mas nenhuma consulta preenchia `usage.d1Storage`, e `unknown` é cinza, não
// vermelho. O que se pina aqui: o total é a soma dos bancos, cada banco conta
// pela data MAIS RECENTE da janela (não a série inteira), e sem dado (vazio ou
// erro) a linha segue `unknown` — nunca 0, que leria como "tudo certo".

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const quota = await import('../functions/api/quota-stats.js');

const GB = 1024 ** 3;
const realFetch = globalThis.fetch;
// A Cache API não existe no Node; lerCotas só precisa de match/put.
beforeEach(() => { globalThis.caches = { default: { match: async () => undefined, put: async () => {} } }; });
afterEach(() => { globalThis.fetch = realFetch; });

/** Cloudflare falsa: só a consulta de armazenamento do D1 interessa. */
function cloudflare({ linhas, erro } = {}) {
  const consultas = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url || input);
    if (url.endsWith('/graphql')) {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes('d1StorageAdaptiveGroups')) {
        consultas.push({ query, variables });
        if (erro) return new Response(JSON.stringify({ errors: [{ message: erro }] }));
        return new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1StorageAdaptiveGroups: linhas }] } } }));
      }
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{}] } } }));
    }
    if (url.includes('/zones?')) return new Response(JSON.stringify({ success: true, result: [] }));
    return new Response('{}', { status: 404 });
  };
  return consultas;
}

const ctx = () => ({ request: new Request('https://status.lucafchala.com/api/quota-stats'), env: { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a' }, waitUntil() {} });
const linha = (databaseId, date, bytes) => ({ max: { databaseSizeBytes: bytes }, dimensions: { databaseId, date } });
const d1 = (body) => body.quotas.find((q) => q.key === 'd1Storage');

describe('/api/quota-stats — D1 · armazenamento', () => {
  test('soma o tamanho de todos os bancos da conta', async () => {
    cloudflare({ linhas: [linha('a', '2026-10-30', 1 * GB), linha('b', '2026-10-30', 0.5 * GB)] });
    const q = d1(await quota.lerCotas(ctx()));
    assert.equal(q.used, 1.5 * GB);
    assert.equal(q.limit, 5 * GB);
    assert.equal(q.pct, 30);
    assert.equal(q.status, 'up');
    assert.equal(q.bytes, true);
  });

  test('cada banco vale pelo tamanho da data mais recente, não pela série', async () => {
    cloudflare({ linhas: [
      // fora de ordem de propósito: o resultado não pode depender da ordenação
      linha('a', '2026-10-30', 2 * GB),
      linha('a', '2026-10-28', 1 * GB),
      linha('a', '2026-10-29', 1.5 * GB),
      linha('b', '2026-10-29', 0.25 * GB),
      linha('b', '2026-10-28', 0.1 * GB),
    ] });
    const q = d1(await quota.lerCotas(ctx()));
    assert.equal(q.used, 2.25 * GB, 'a 2 GB + b 0.25 GB; somar a série daria 5.35 GB');
  });

  test('a janela da consulta cobre mais que o dia de hoje', async () => {
    const consultas = cloudflare({ linhas: [linha('a', '2026-10-29', GB)] });
    await quota.lerCotas(ctx());
    assert.equal(consultas.length, 1);
    const { sinceDate, untilDate } = consultas[0].variables;
    assert.ok(sinceDate < untilDate, 'logo após a meia-noite UTC a amostra de hoje pode não existir');
    assert.match(consultas[0].query, /max\{databaseSizeBytes\}/);
    assert.match(consultas[0].query, /dimensions\{databaseId date\}/);
  });

  test('sem linhas: segue unknown, nunca 0', async () => {
    for (const linhas of [[], null, undefined]) {
      cloudflare({ linhas });
      const body = await quota.lerCotas(ctx());
      const q = d1(body);
      assert.equal(q.used, null);
      assert.equal(q.pct, null);
      assert.equal(q.status, 'unknown');
    }
  });

  test('linhas sem tamanho legível também ficam unknown', async () => {
    cloudflare({ linhas: [{ max: {}, dimensions: { databaseId: 'a', date: '2026-10-30' } }, { max: { databaseSizeBytes: null }, dimensions: { databaseId: 'b', date: '2026-10-30' } }] });
    const q = d1(await quota.lerCotas(ctx()));
    assert.equal(q.used, null);
    assert.equal(q.status, 'unknown');
  });

  test('erro da GraphQL: unknown, o motivo vai em errors[] e as outras linhas seguem', async () => {
    cloudflare({ erro: 'unknown field "d1StorageAdaptiveGroups"' });
    const body = await quota.lerCotas(ctx());
    const q = d1(body);
    assert.equal(q.used, null);
    assert.equal(q.status, 'unknown');
    assert.ok(body.errors.some((e) => /D1 storage/.test(e)), `errors: ${JSON.stringify(body.errors)}`);
    assert.ok(!body.errors.some((e) => /unknown field/.test(e)), 'o texto cru da API não vai para o payload público');
    assert.equal(body.errors.length, 1, 'só esta consulta falhou');
    assert.equal(body.quotas.find((q2) => q2.key === 'd1RowsRead').status, 'up', 'as linhas lidas do D1 vêm de outra consulta e seguem');
  });

  test('limiares: 75 % avisa, 95 % é crítico', async () => {
    const casos = [[3.7 * GB, 'up'], [3.75 * GB, 'degraded'], [4.7 * GB, 'degraded'], [4.75 * GB, 'down']];
    for (const [bytes, esperado] of casos) {
      cloudflare({ linhas: [linha('a', '2026-10-30', bytes)] });
      const q = d1(await quota.lerCotas(ctx()));
      assert.equal(q.status, esperado, `${bytes / GB} GB`);
    }
  });
});
