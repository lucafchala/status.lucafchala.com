// Retrato compartilhado (D1): visitante lê, só o agendador varre.
//
// O que isto protege é CUSTO que cresce com o público — o defeito que não
// aparece em teste nenhum de "a resposta está certa", porque a resposta está
// certa: ela só custou 38 subrequests e 17 requisições no fotos para sair.
// Por isso os testes contam fetch de saída e linhas no banco.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { d1Sqlite } from './d1.mjs';

const status = await import('../functions/api/status.js');
const retrato = await import('../functions/api/retrato.js');
const historico = await import('../functions/api/status-history.js');
const painel = await import('../functions/api/painel.js');

const realFetch = globalThis.fetch;
const realNow = Date.now;
let clock = new Date('2026-09-24T12:00:00Z').getTime();
let fetches = [];

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = new Map();
  return {
    writesOf(k) { return writes.get(k) || 0; },
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { writes.set(k, (writes.get(k) || 0) + 1); store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

function fakeCache() {
  const m = new Map();
  return {
    async match(req) { const r = m.get(req.url); return r ? r.clone() : undefined; },
    async put(req, res) { m.set(req.url, res.clone()); },
  };
}

// Todo site "responde bem": o custo de uma varredura é o que interessa.
function mundo() {
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input);
    fetches.push(url);
    if (url.includes('/api/quota-stats')) return new Response(JSON.stringify({ configured: false }));
    return new Response('<html>' + 'x'.repeat(300) + '</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
}
const sondas = () => fetches.filter((u) => !u.includes('status.lucafchala.com/api/quota-stats'));

function ctx(url, env) {
  const pend = [];
  return {
    request: new Request(url),
    env,
    waitUntil(p) { pend.push(p); },
    async flush() { await Promise.all(pend); },
  };
}

const PAGINA = 'https://status.lucafchala.com/api/status';

beforeEach(() => {
  fetches = [];
  clock = new Date('2026-09-24T12:00:00Z').getTime();
  Date.now = () => clock;
  globalThis.caches = { default: fakeCache() };
  mundo();
});
afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; });

async function pedir(url, env) {
  const c = ctx(url, env);
  const res = await status.onRequestGet(c);
  await c.flush();
  return res;
}

describe('/api/status com STATUS_DB', () => {
  test('banco vazio: o primeiro pedido varre e grava o retrato', async () => {
    const DB = d1Sqlite();
    const res = await pedir(PAGINA, { STATUS_DB: DB, STATUS_KV: fakeKV() });
    assert.equal(res.status, 200);
    assert.ok(sondas().length > 20, 'varreu');
    const n = DB.sqlite.prepare('SELECT COUNT(*) AS n FROM varredura').get().n;
    assert.equal(n, 1);
    const dias = DB.sqlite.prepare('SELECT COUNT(*) AS n FROM dia').get().n;
    assert.equal(dias, status.SERVICES.length, 'uma linha por serviço no agregado diário');
  });

  test('visitante com retrato recente LÊ: zero sonda', async () => {
    const DB = d1Sqlite();
    await pedir(PAGINA + '?source=cloudflare-cron', { STATUS_DB: DB, STATUS_KV: fakeKV() });
    fetches = [];
    clock += 3 * 60_000;
    const res = await pedir(PAGINA, { STATUS_DB: DB, STATUS_KV: fakeKV() });
    assert.equal(fetches.length, 0, 'nenhum fetch de saída');
    const body = await res.json();
    assert.equal(body.retrato.origem, 'agendador');
    assert.equal(body.retrato.atrasado, false);
    assert.equal(res.headers.get('X-Sweep-Age-Ms'), String(3 * 60_000));
  });

  test('mil visitantes em 10 min: nenhuma varredura extra', async () => {
    // O defeito que isto fecha: cada visitante que errava o cache varria.
    const DB = d1Sqlite();
    await pedir(PAGINA + '?source=cloudflare-cron', { STATUS_DB: DB, STATUS_KV: fakeKV() });
    fetches = [];
    for (let i = 0; i < 1000; i++) {
      clock += 600;
      await pedir(PAGINA + '?t=' + i, { STATUS_DB: DB, STATUS_KV: fakeKV() });
    }
    assert.equal(fetches.length, 0);
  });

  test('agendador morto: visitantes varrem no máximo uma vez a cada 4 min', async () => {
    const DB = d1Sqlite();
    await pedir(PAGINA + '?source=cloudflare-cron', { STATUS_DB: DB, STATUS_KV: fakeKV() });
    clock += retrato.RETRATO_TTL_MS + 1;       // retrato velho: agendador parou
    let varreduras = 0;
    for (let i = 0; i < 600; i++) {            // 1 pedido a cada 2 s por 20 min
      fetches = [];
      await pedir(PAGINA, { STATUS_DB: DB, STATUS_KV: fakeKV() });
      if (sondas().length) varreduras++;
      clock += 2000;
    }
    assert.ok(varreduras <= 6, `20 min de visitantes com o agendador parado: ${varreduras} varreduras`);
    assert.ok(varreduras >= 1, 'mas o retrato se corrige');
  });

  test('?varrer em laço: no máximo uma varredura a cada 4 min, para a conta inteira', async () => {
    // Qualquer um pode pedir. A trava é no banco, não no isolate: vale para
    // todos os colos juntos.
    const DB = d1Sqlite();
    let varreduras = 0;
    for (let i = 0; i < 240; i++) {            // 1 pedido por segundo por 4 min
      fetches = [];
      await pedir(PAGINA + '?varrer=' + i, { STATUS_DB: DB, STATUS_KV: fakeKV() });
      if (sondas().length) varreduras++;
      clock += 1000;
    }
    assert.equal(varreduras, 1);
  });

  test('a trava é atômica: dois pedidos no mesmo instante, uma vez só', async () => {
    const DB = d1Sqlite();
    const agora = Date.now();
    const [a, b] = await Promise.all([retrato.tomarVez(DB, agora), retrato.tomarVez(DB, agora)]);
    assert.equal([a, b].filter(Boolean).length, 1);
  });

  test('o agendador a cada 10 min sempre passa pela trava', async () => {
    const DB = d1Sqlite();
    let varreduras = 0;
    for (let i = 0; i < 6; i++) {
      fetches = [];
      await pedir(PAGINA + '?source=cloudflare-cron', { STATUS_DB: DB, STATUS_KV: fakeKV() });
      if (sondas().length) varreduras++;
      clock += 10 * 60_000;
    }
    assert.equal(varreduras, 6);
  });

  test('com o D1, a latência não gasta escrita de KV', async () => {
    const DB = d1Sqlite();
    const KV = fakeKV({ last_status: '{}' });
    for (let i = 0; i < 6; i++) {
      await pedir(PAGINA + '?source=cloudflare-cron', { STATUS_DB: DB, STATUS_KV: KV });
      clock += 30 * 60_000;
    }
    assert.equal(KV.writesOf('latency'), 0);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM varredura').get().n, 6, 'uma amostra por varredura, no D1');
  });

  test('D1 fora do ar não derruba o painel: cai para a varredura por pedido', async () => {
    const quebrado = { prepare() { throw new Error('D1 down'); }, async batch() { throw new Error('D1 down'); } };
    const res = await pedir(PAGINA, { STATUS_DB: quebrado, STATUS_KV: fakeKV() });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray((await res.json()).services));
  });

  test('sem STATUS_DB: comportamento de antes (o visitante varre)', async () => {
    // O piso por isolate (20 s) é estado de módulo: o teste anterior acabou de
    // varrer no mesmo relógio. Passado o piso, o visitante volta a varrer.
    clock += 60_000;
    const res = await pedir(PAGINA, { STATUS_KV: fakeKV() });
    assert.equal(res.status, 200);
    assert.ok(sondas().length > 20);
  });
});

describe('o que o D1 guarda', () => {
  test('poda: nada mais velho que 48 h em varredura, nem que 90 dias em dia', async () => {
    const DB = d1Sqlite();
    const payload = { services: [{ name: 'Fotos', status: 'up', rt: 100 }], checkedAt: '' };
    const t0 = Date.now();
    await retrato.gravarVarredura(DB, payload, 'agendador', t0 - 100 * 86400_000);
    await retrato.gravarVarredura(DB, payload, 'agendador', t0 - 49 * 3600_000);
    await retrato.gravarVarredura(DB, payload, 'agendador', t0);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM varredura').get().n, 1);
    const dias = DB.sqlite.prepare('SELECT dia FROM dia ORDER BY dia').all().map((r) => r.dia);
    assert.deepEqual(dias, [retrato.diaLocal(t0 - 49 * 3600_000), retrato.diaLocal(t0)]);
  });

  test('agregado diário conta cada estado', async () => {
    const DB = d1Sqlite();
    const t = Date.now();
    for (const st of ['up', 'up', 'degraded', 'down']) {
      await retrato.gravarVarredura(DB, { services: [{ name: 'Fotos', status: st, rt: 100 }] }, 'agendador', t);
    }
    const r = DB.sqlite.prepare("SELECT total, up, degraded, down FROM dia WHERE servico = 'Fotos'").get();
    assert.deepEqual({ ...r }, { total: 4, up: 2, degraded: 1, down: 1 });
    const barras = await retrato.lerBarrasDiarias(DB, t);
    const hoje = barras.servicos.Fotos.at(-1);
    assert.equal(hoje.estado, 'down');
    assert.equal(hoje.pct, 75, 'lento conta como disponível; offline não');
  });

  test('dia sem varredura é "sem dado", nunca verde por omissão', async () => {
    const DB = d1Sqlite();
    await retrato.gravarVarredura(DB, { services: [{ name: 'Fotos', status: 'up', rt: 1 }] }, 'agendador', Date.now());
    const barras = await retrato.lerBarrasDiarias(DB);
    assert.equal(barras.periodos.length, 90);
    assert.equal(barras.servicos.Fotos.length, 90);
    assert.equal(barras.servicos.Fotos[0].estado, null);
    assert.equal(barras.servicos.Fotos.at(-1).estado, 'up');
  });

  test('uptime: fração das varreduras sem "offline"', () => {
    const agora = Date.now();
    const serie = [
      { at: new Date(agora - 1000).toISOString(), st: { Fotos: 'up', Paste: 'down' } },
      { at: new Date(agora - 2000).toISOString(), st: { Fotos: 'degraded', Paste: 'up' } },
      { at: new Date(agora - 30 * 3600_000).toISOString(), st: { Fotos: 'down', Paste: 'up' } },
    ];
    const h24 = retrato.uptimeDe(serie, agora - 24 * 3600_000);
    assert.equal(h24.Fotos.pct, 100);
    assert.equal(h24.Paste.pct, 50);
    const h48 = retrato.uptimeDe(serie, agora - 48 * 3600_000);
    assert.equal(h48.Fotos.pct, 66.67);
  });
});

describe('deploys na série', () => {
  test('a versão declarada pelo fotos vira marcador quando muda, com a hora da versão', async () => {
    const DB = d1Sqlite();
    const svc = (id, tag, em) => ({ services: [{ name: 'Fotos', status: 'up', rt: 100, checks: [{ label: 'configuração implantada', status: 'up', detail: '', versao: { id, tag, em } }] }] });
    const t = Date.now();
    await retrato.gravarVarredura(DB, svc('v1', 'aaa1111', '2026-09-24T08:00:00.000Z'), 'agendador', t - 3 * 3600_000);
    await retrato.gravarVarredura(DB, svc('v1', 'aaa1111', '2026-09-24T08:00:00.000Z'), 'agendador', t - 2 * 3600_000);
    await retrato.gravarVarredura(DB, svc('v2', 'bbb2222', '2026-09-24T10:55:00.000Z'), 'agendador', t - 1 * 3600_000);
    const serie = await retrato.lerSerie(DB, t);
    assert.deepEqual(retrato.implantacoesDe(serie), [
      { servico: 'Fotos', tag: 'bbb2222', id: 'v2', em: '2026-09-24T10:55:00.000Z' },
    ]);
  });
});

describe('barras sem D1, do log de transições', () => {
  const H = 3600_000;
  test('reconstrói o estado de cada hora a partir do estado atual e das transições', () => {
    const agora = new Date('2026-09-24T12:30:00Z').getTime();
    const entries = [
      { name: 'Fotos', from: 'down', to: 'up', at: new Date(agora - 3 * H).toISOString() },
      { name: 'Fotos', from: 'up', to: 'down', at: new Date(agora - 5 * H).toISOString() },
    ];
    const linha = historico.linhaDoTempo(entries, { Fotos: 'up', Paste: 'up' }, agora);
    const barras = historico.barrasHorarias(linha);
    assert.equal(barras.periodos.length, 48);
    const fotos = barras.servicos.Fotos;
    // A última barra é a hora corrente (12:00–13:00); a queda foi 07:30–09:30.
    const idx = (iso) => barras.periodos.findIndex((p) => p.inicio === iso);
    assert.equal(fotos[idx('2026-09-24T07:00:00.000Z')].estado, 'down');
    assert.equal(fotos[idx('2026-09-24T08:00:00.000Z')].estado, 'down');
    assert.equal(fotos[idx('2026-09-24T09:00:00.000Z')].estado, 'down');
    assert.equal(fotos[idx('2026-09-24T10:00:00.000Z')].estado, 'up');
    assert.equal(fotos[idx('2026-09-24T06:00:00.000Z')].estado, 'up');
    assert.equal(fotos[idx('2026-09-24T07:00:00.000Z')].pct, 50, 'caiu na metade da hora');
    assert.ok(barras.servicos.Paste.every((b) => b.estado === 'up'));
    const up24 = historico.uptimeTransicoes(linha, agora - 24 * H);
    assert.equal(up24.Fotos.pct, 91.67, '2 h fora em 24');
  });

  test('log cheio: antes da entrada mais antiga é "sem dado", não verde', () => {
    const agora = new Date('2026-09-24T12:30:00Z').getTime();
    const entries = [];
    for (let i = 0; i < historico.HISTORY_MAX; i++) {
      entries.push({ name: 'Treino', from: i % 2 ? 'up' : 'degraded', to: i % 2 ? 'degraded' : 'up', at: new Date(agora - (i + 1) * 10 * 60_000).toISOString() });
    }
    const linha = historico.linhaDoTempo(entries, { Treino: 'up' }, agora);
    const barras = historico.barrasHorarias(linha);
    assert.equal(barras.servicos.Treino[0].estado, null, 'o começo da janela ficou sem dado');
  });
});

describe('/api/painel com STATUS_DB', () => {
  test('traz o status LIDO: a página faz uma chamada só, sem varredura', async () => {
    const DB = d1Sqlite();
    await pedir(PAGINA + '?source=cloudflare-cron', { STATUS_DB: DB, STATUS_KV: fakeKV() });
    fetches = [];
    globalThis.caches = { default: fakeCache() };
    const c = ctx('https://status.lucafchala.com/api/painel', { STATUS_DB: DB, STATUS_KV: fakeKV() });
    const body = await (await painel.onRequestGet(c)).json();
    await c.flush();
    assert.equal(body.retratoCompartilhado, true);
    assert.ok(Array.isArray(body.status.services) && body.status.services.length === status.SERVICES.length);
    assert.equal(body.barras.tipo, 'diario');
    assert.equal(body.uptime.fonte, 'd1');
    assert.equal(body.latencia.samples, 1);
    assert.ok(!fetches.some((u) => u.includes('fotos.lucafchala.com')), 'nenhuma sonda saiu do painel');
  });

  test('sem STATUS_DB: barras horárias do log, e o status fica para o /api/status', async () => {
    const KV = fakeKV({ last_status: JSON.stringify({ Fotos: 'up' }), history: '[]' });
    const c = ctx('https://status.lucafchala.com/api/painel', { STATUS_KV: KV });
    const body = await (await painel.onRequestGet(c)).json();
    assert.equal(body.retratoCompartilhado, false);
    assert.equal(body.status, null);
    assert.equal(body.barras.tipo, 'horario');
    assert.equal(body.uptime.fonte, 'transicoes');
  });
});
