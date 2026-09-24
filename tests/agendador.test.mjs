// Agendador (agendador/index.js) e o vigia dele (scripts/vigia.mjs).
//
// O vigia é o alarme do alarme, e alarme errado dos dois lados custa caro:
// falhar à toa ensina o dono a ignorar o e-mail do GitHub; não falhar quando
// o agendador morreu é o monitor parado em silêncio — o defeito que tudo isto
// existe para fechar. Cada ramo tem teste.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const agendador = await import('../agendador/varrer.js');
// O módulo de entrada tem de carregar sem export que não seja handler
// (workerd recusa): importar confere a forma, o teste abaixo confere o resto.
const entrada = await import('../agendador/index.js');
const vigia = await import('../scripts/vigia.mjs');

const MIN = 60_000;

/** fetch roteado por trecho de URL; conta os pedidos de varredura. */
function rota(mapa) {
  const pedidos = [];
  const f = async (url) => {
    pedidos.push(String(url));
    for (const [trecho, resp] of Object.entries(mapa)) {
      // Fábrica, não Response pronta: um clone() compartilha o corpo via tee,
      // e o cancel() de um ramo só resolve quando o outro também cancela.
      if (String(url).includes(trecho)) return resp(url);
    }
    return texto('?', 404)();
  };
  f.pedidos = pedidos;
  f.varreduras = () => pedidos.filter((u) => u.includes('/api/status')).length;
  return f;
}
const json = (o, status = 200, headers = {}) => () => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const texto = (corpo, status) => () => new Response(corpo, { status });

describe('agendador (Cron Trigger)', () => {
  test('o módulo de entrada só exporta o handler (o workerd recusa o resto)', () => {
    // Um `export const` no index.js derrubou o Worker na inicialização no
    // workerd de verdade, com o teste em Node verde. Esta é a forma que o
    // runtime aceita: só `default`, com `scheduled`.
    assert.deepEqual(Object.keys(entrada), ['default']);
    assert.equal(typeof entrada.default.scheduled, 'function');
  });

  test('pede a varredura com a origem que o /api/status reconhece', async () => {
    const f = rota({ 'status.lucafchala.com/api/status': json({}, 200, { 'X-Sweep-Source': 'agendador', 'X-Sweep-Age-Ms': '0' }) });
    const r = await agendador.varrer(f);
    assert.match(f.pedidos[0], /\/api\/status\?source=cloudflare-cron$/);
    assert.equal(r.origem, 'agendador');
    assert.equal(r.idadeMs, 0);
  });

  test('domínio próprio barrado (WAF): cai para o pages.dev', async () => {
    const f = rota({
      'status.lucafchala.com/': texto('bloqueado', 403),
      'pages.dev/api/status': json({}, 200),
    });
    const r = await agendador.varrer(f);
    assert.match(r.alvo, /pages\.dev/);
    assert.deepEqual(r.falhas, ['status.lucafchala.com: HTTP 403']);
  });

  test('nenhum alvo varre: lança (vira falha em Cron Events)', async () => {
    const f = rota({ '/api/status': texto('fora', 503) });
    await assert.rejects(agendador.varrer(f), /nenhum alvo varreu/);
  });
});

describe('vigia (monitor.yml)', () => {
  const rodar = (f) => vigia.vigiar({ fetchImpl: f, espera: 0 });

  test('agendador em dia: não varre, não falha', async () => {
    const f = rota({ '/api/retrato': json({ configurado: true, idadeMs: 3 * MIN, origem: 'agendador', agendador: { ultimaEm: 'x', idadeMs: 3 * MIN } }) });
    const r = await rodar(f);
    assert.equal(r.falha, false);
    assert.equal(f.varreduras(), 0, 'nenhuma varredura extra');
  });

  test('agendador parado há 40 min: varre (socorro) E falha, com o motivo', async () => {
    const f = rota({
      '/api/retrato': json({ configurado: true, idadeMs: 40 * MIN, origem: 'agendador', agendador: { ultimaEm: 'x', idadeMs: 40 * MIN } }),
      '/api/status': json({}, 200, { 'X-Sweep-Source': 'cron do GitHub' }),
    });
    const r = await rodar(f);
    assert.equal(f.varreduras(), 1);
    assert.equal(r.falha, true, 'o e-mail do GitHub é o alarme do alarme');
    assert.match(r.mensagem, /AGENDADOR PARADO.*40 min/);
  });

  test('visitantes mantêm o retrato fresco, mas o agendador parou: ainda falha', async () => {
    // O retrato fresco não prova nada sobre o agendador — um visitante pode
    // ter varrido pelo socorro. O que se vigia é a varredura DELE.
    const f = rota({
      '/api/retrato': json({ configurado: true, idadeMs: 1 * MIN, origem: 'visitante (retrato atrasado)', agendador: { ultimaEm: 'x', idadeMs: 3 * 3600_000 } }),
      '/api/status': json({}),
    });
    assert.equal((await rodar(f)).falha, true);
  });

  test('agendador ainda não implantado: o GitHub varre, sem falhar', async () => {
    const f = rota({
      '/api/retrato': json({ configurado: true, idadeMs: 2 * 3600_000, origem: 'cron do GitHub', agendador: { ultimaEm: null, idadeMs: null } }),
      '/api/status': json({}),
    });
    const r = await rodar(f);
    assert.equal(f.varreduras(), 1);
    assert.equal(r.falha, false);
  });

  test('agendador não implantado e retrato recente: não varre de novo', async () => {
    const f = rota({ '/api/retrato': json({ configurado: true, idadeMs: 2 * MIN, origem: 'visitante (retrato atrasado)', agendador: { ultimaEm: null } }) });
    await rodar(f);
    assert.equal(f.varreduras(), 0);
  });

  test('sem STATUS_DB: varre, como o cron sempre fez', async () => {
    const f = rota({ '/api/retrato': json({ configurado: false }), '/api/status': json({}) });
    const r = await rodar(f);
    assert.equal(f.varreduras(), 1);
    assert.equal(r.falha, false);
    assert.match(f.pedidos.find((u) => u.includes('/api/status')), /source=gha-cron/);
  });

  test('varredura que falha falha o job', async () => {
    const f = rota({ '/api/retrato': json({ configurado: false }), '/api/status': texto('x', 500) });
    assert.equal((await rodar(f)).falha, true);
  });

  test('status fora do ar inteiro: falha', async () => {
    const f = rota({});
    const r = await rodar(f);
    assert.equal(r.falha, true);
    assert.match(r.mensagem, /não responde/);
  });
});
