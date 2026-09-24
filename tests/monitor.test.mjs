// Testes da varredura: o que ela conclui sobre o que sonda, e quanto ela
// custa em escrita de KV.
//
// Mesma regra de functions.test.mjs: o que falha em SILÊNCIO precisa de teste.
// Aqui são três famílias:
//   • um sinal lido do jeito errado vira verde (o 429 "ignorado", o
//     certificado que ninguém conseguiu ler);
//   • uma cadência que depende do relógio grava demais com o painel aberto e
//     nada com o cron atrasado — sem nenhum erro em lugar nenhum;
//   • o custo. A cota de escrita do KV é da conta inteira, então o teste conta
//     escritas em vez de só conferir o resultado.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const status = await import('../functions/api/status.js');
const latency = await import('../functions/api/latency-trends.js');
const quota = await import('../functions/api/quota-stats.js');

/** KV em memória que conta escrita por chave. */
function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = new Map();
  return {
    writes,
    writesOf(k) { return writes.get(k) || 0; },
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { writes.set(k, (writes.get(k) || 0) + 1); store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

// Relógio controlado. `new Date()` sem argumento não passa por Date.now no V8,
// mas todo cálculo de janela deste código passa (o `now = Date.now()` padrão).
const realNow = Date.now;
let clock = 0;
function setClock(iso) { clock = new Date(iso).getTime(); }
function advance(ms) { clock += ms; }

const realFetch = globalThis.fetch;
beforeEach(() => { Date.now = () => clock; });
afterEach(() => { Date.now = realNow; globalThis.fetch = realFetch; });

// Varredura mínima: o que buildSample precisa (nome, status, rt).
const SWEEP = [
  { name: 'Fotos', status: 'up', rt: 250, url: 'https://fotos.lucafchala.com', problems: [] },
  { name: 'Treino', status: 'up', rt: 400, url: 'https://treino.lucafchala.com', problems: [] },
];

// /api/quota-stats sem token: o caminho mais comum e o que não gera linha.
function quotaNaoConfigurada() {
  globalThis.fetch = async () => new Response(JSON.stringify({ configured: false }), { status: 200 });
}

describe('healthz do fotos lido pela varredura', () => {
  test('429 é degradado, não "ignorado"', () => {
    // O fotos não limita o healthz ("Sem rate limit de propósito"). Um 429 só
    // pode vir de uma camada na frente do Worker, e o visitante esbarra nela
    // também. Tratar como verde era esconder exatamente isso.
    const row = status.healthInfra('saúde', { rateLimited: true });
    assert.equal(row.status, 'degraded');
    assert.match(row.detail, /429/);
  });

  test('o 429 não é contado duas vezes nas linhas derivadas', () => {
    // A linha de infraestrutura já é dona do problema; as outras dizem "—".
    assert.equal(status.healthSelftest('autoteste', { rateLimited: true }).status, 'up');
    assert.equal(status.healthConfig('config', { rateLimited: true }).status, 'up');
  });

  test('o rótulo não promete medir hash', () => {
    // hashMs saiu do healthz do fotos: o relógio do Workers congela durante
    // execução síncrona e o número era sempre 0.
    const fotos = status.SERVICES.find((s) => s.name === 'Fotos');
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    const rows = fotos.checks('https://fotos.lucafchala.com', {}, '');
    return Promise.all(rows).then((resolved) => {
      const labels = resolved.map((r) => r.label).join(' | ');
      assert.doesNotMatch(labels, /hash/i);
    });
  });
});

describe('cadência da amostra de latência', () => {
  test('série vazia amostra', () => {
    assert.equal(latency.shouldSample([], new Date('2026-09-24T12:17:00Z').getTime()), true);
  });

  test('amostra de 10 min atrás não amostra de novo', () => {
    const now = new Date('2026-09-24T12:17:00Z').getTime();
    const series = [{ at: new Date(now - 10 * 60_000).toISOString(), rt: { Fotos: 1 } }];
    assert.equal(latency.shouldSample(series, now), false);
  });

  test('amostra a cada ~30 min mesmo com o disparo escorregando', () => {
    // Cron a cada 10 min com alguns segundos de atraso: a terceira varredura
    // encontra a amostra com 29 min e pouco. Sem folga, a cadência viraria 40.
    const now = new Date('2026-09-24T12:30:00Z').getTime();
    const series = [{ at: new Date(now - 29 * 60_000 - 20_000).toISOString(), rt: { Fotos: 1 } }];
    assert.equal(latency.shouldSample(series, now), true);
  });

  test('carimbo no futuro sai da série em vez de travar a amostragem', () => {
    const now = new Date('2026-09-24T12:00:00Z').getTime();
    const series = latency.trimLatency([
      { at: '2026-09-25T12:00:00Z', rt: { Fotos: 1 } },   // um dia à frente
      { at: '2026-09-24T11:00:00Z', rt: { Fotos: 2 } },
    ], now);
    assert.equal(series.length, 1);
    assert.equal(series[0].at, '2026-09-24T11:00:00Z');
    assert.equal(latency.shouldSample(series, now), true);
  });
});

describe('custo da varredura em escrita de KV', () => {
  test('painel aberto 24 h (uma varredura por minuto) grava no máximo 50 amostras', async () => {
    // O defeito medido em produção: com a cadência pelo relógio, as cinco
    // varreduras que caíam nos primeiros 5 min de cada meia hora gravavam
    // todas — ~240 escritas/dia de uma cota de 1000 para a conta inteira.
    quotaNaoConfigurada();
    const kv = fakeKV({ last_status: JSON.stringify({ Fotos: 'up', Treino: 'up' }) });
    setClock('2026-09-24T00:00:10Z');
    for (let i = 0; i < 1440; i++) {
      await status.detectAndNotify({ STATUS_KV: kv }, SWEEP, 'https://status.lucafchala.com');
      advance(60_000);
    }
    const escritas = kv.writesOf(latency.LATENCY_KEY);
    assert.ok(escritas >= 48 && escritas <= 50, `esperava 48–50 escritas, vieram ${escritas}`);
    assert.equal(kv.writesOf('last_status'), 0, 'estado estável não grava last_status');
  });

  test('cron atrasado (varreduras a cada ~3 h em minutos quaisquer) grava toda vez', async () => {
    // O outro lado do mesmo defeito: o cron do GitHub rodava a cada ~3 h e
    // quase nunca caía na janela — 3 amostras em 48 h. Cada varredura dessas
    // encontra a última amostra com horas de idade e TEM de gravar.
    quotaNaoConfigurada();
    const kv = fakeKV({ last_status: JSON.stringify({ Fotos: 'up', Treino: 'up' }) });
    setClock('2026-09-24T00:17:00Z');
    for (let i = 0; i < 6; i++) {
      await status.detectAndNotify({ STATUS_KV: kv }, SWEEP, 'https://status.lucafchala.com');
      advance(3 * 3600_000 + 13 * 60_000);
    }
    assert.equal(kv.writesOf(latency.LATENCY_KEY), 6);
  });
});

describe('certificado que o token não consegue ler', () => {
  /** Simula a API da Cloudflare: GraphQL vazio, uma zona, e o endpoint de
   *  certificados recusando por falta de escopo — o estado real de produção. */
  function cloudflareSemEscopoDeSsl() {
    globalThis.fetch = async (input) => {
      const url = String(input?.url || input);
      if (url.endsWith('/graphql')) {
        return new Response(JSON.stringify({ data: { viewer: { accounts: [{}] } } }));
      }
      if (url.includes('/zones?')) {
        return new Response(JSON.stringify({ success: true, result: [{ id: 'z1', name: 'lucafchala.com' }] }));
      }
      if (url.includes('/ssl/certificate_packs')) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'Unauthorized to access requested resource' }] }));
      }
      return new Response('{}', { status: 404 });
    };
  }

  // A Cache API não existe no Node; a quota-stats só precisa de match/put.
  beforeEach(() => {
    globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  });

  test('é desconhecido, com o motivo — nem verde, nem degradado', async () => {
    cloudflareSemEscopoDeSsl();
    const res = await quota.onRequestGet({
      request: new Request('https://status.lucafchala.com/api/quota-stats'),
      env: { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a' },
      waitUntil() {},
    });
    const body = await res.json();
    assert.equal(body.certs[0].status, 'unknown');
    assert.match(body.certs[0].detail, /Unauthorized/);
    assert.notEqual(body.status, 'degraded', 'o painel inteiro não pode ficar amarelo por um dado não lido');
  });

  test('não entra no rastreio de transições (nem alerta, nem histórico)', async () => {
    const payload = {
      configured: true,
      quotas: [],
      certs: [{ zone: 'lucafchala.com', status: 'unknown', detail: 'não verificado (Unauthorized)' }],
    };
    globalThis.fetch = async () => new Response(JSON.stringify(payload));
    const kv = fakeKV({ last_status: JSON.stringify({ Fotos: 'up', Treino: 'up' }) });
    setClock('2026-09-24T12:00:00Z');
    await status.detectAndNotify({ STATUS_KV: kv }, SWEEP, 'https://status.lucafchala.com');
    const last = JSON.parse(kv._store.get('last_status'));
    assert.equal('TLS · lucafchala.com' in last, false);
    assert.equal(kv.writesOf('last_status'), 0);
  });
});
