// Homelab: o estado vem do homelab-watchdog (cron próprio na Cloudflare), e
// esta varredura só o lê. O que não pode acontecer em silêncio:
//   • vigia mudo ou quebrado virar "fora do ar" (quem mede é o vigia);
//   • o endereço do vigia (ou qualquer outro do homelab) sair no payload;
//   • "sem dados" virar e-mail, transição no histórico ou barra verde.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { d1Sqlite } from './d1.mjs';

const status = await import('../functions/api/status.js');
const retrato = await import('../functions/api/retrato.js');

const VIGIA = 'https://homelab-watchdog.exemplo.workers.dev/';
const ENV = { HOMELAB_STATUS_URL: VIGIA };
const SINCE = '2026-09-27T14:42:30.224Z';

const realFetch = globalThis.fetch;
const realNow = Date.now;
let pedidos = [];
beforeEach(() => { pedidos = []; Date.now = () => Date.parse('2026-09-27T17:00:00Z'); });
afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; });

/** O vigia responde `resposta()`; qualquer outro endereço, um 200 vazio. */
function vigia(resposta) {
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input);
    pedidos.push(url);
    if (url === VIGIA) return resposta();
    return new Response('{}');
  };
}
const json = (o, init) => () => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' }, ...init });

describe('lerVigiaHomelab', () => {
  test('up: operacional, com o desde do vigia', async () => {
    vigia(json({ name: 'homelab', status: 'up', since: SINCE }));
    assert.deepEqual(await status.lerVigiaHomelab(ENV), { status: 'up', detail: '', desde: SINCE });
  });

  test('down: fora do ar, com o desde do vigia', async () => {
    vigia(json({ name: 'homelab', status: 'down', since: SINCE }));
    const r = await status.lerVigiaHomelab(ENV);
    assert.equal(r.status, 'down');
    assert.equal(r.desde, SINCE);
  });

  test('unknown do vigia (ainda não rodou): sem dados, sem desde', async () => {
    vigia(json({ name: 'homelab', status: 'unknown', since: null }));
    const r = await status.lerVigiaHomelab(ENV);
    assert.equal(r.status, 'unknown');
    assert.equal(r.desde, null);
  });

  test('erro de rede no vigia: sem dados, nunca fora do ar', async () => {
    vigia(() => { throw new TypeError('fetch failed'); });
    const r = await status.lerVigiaHomelab(ENV);
    assert.equal(r.status, 'unknown');
    assert.equal(r.detail, 'vigia sem resposta');
  });

  test('HTTP 500, JSON quebrado ou fora do contrato: sem dados', async () => {
    for (const resp of [
      () => new Response('erro', { status: 500 }),
      () => new Response('<html>'),
      json({ status: 'caiu' }),
      json(null),
    ]) {
      vigia(resp);
      assert.equal((await status.lerVigiaHomelab(ENV)).status, 'unknown');
    }
  });

  test('sem HOMELAB_STATUS_URL: sem dados, e nenhum pedido', async () => {
    vigia(json({ status: 'up' }));
    assert.equal((await status.lerVigiaHomelab({})).status, 'unknown');
    assert.equal(pedidos.length, 0);
  });

  test('since inválido ou no futuro: o estado fica, o desde some', async () => {
    vigia(json({ status: 'up', since: 'ontem' }));
    assert.deepEqual(await status.lerVigiaHomelab(ENV), { status: 'up', detail: '', desde: null });
    vigia(json({ status: 'up', since: '2030-01-01T00:00:00Z' }));
    assert.equal((await status.lerVigiaHomelab(ENV)).desde, null);
  });
});

describe('Homelab na varredura', () => {
  test('lê o vigia, não sonda o homelab, e o endereço do vigia não sai no payload', async () => {
    vigia(json({ name: 'homelab', status: 'down', since: SINCE }));
    const payload = await status.varrer(ENV);
    const h = payload.services.find((s) => s.name === 'Homelab');
    assert.equal(h.status, 'down');
    assert.equal(h.desde, SINCE);
    assert.equal(h.url, '');
    assert.equal(h.rt, null, 'tempo de resposta seria o do vigia, não o do homelab');
    assert.equal(pedidos.filter((u) => u === VIGIA).length, 1, 'uma leitura do vigia por varredura');
    assert.ok(!pedidos.some((u) => u.includes('homelab.lucafchala.com')), 'o homelab em si não é sondado');
    assert.ok(!JSON.stringify(payload).includes('homelab-watchdog'), 'endereço do vigia fora do payload');
  });

  test('vigia fora do ar: a linha é sem dados, e o resto da varredura segue', async () => {
    vigia(() => { throw new TypeError('fetch failed'); });
    const payload = await status.varrer(ENV);
    assert.equal(payload.services.find((s) => s.name === 'Homelab').status, 'unknown');
    assert.equal(payload.services.length, status.SERVICES.length);
  });
});

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  let writes = 0;
  return {
    get writes() { return writes; },
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { writes++; store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

describe('sem dados não é transição', () => {
  const homelab = (st) => ({ name: 'Homelab', status: st, url: '', rt: null, problems: [] });
  const outro = { name: 'Paste', status: 'up', url: 'https://paste.lucafchala.com', rt: 200, problems: [] };

  test('up → unknown → up: nenhuma escrita, nenhum e-mail, last_status intacto', async () => {
    const kv = fakeKV({ last_status: JSON.stringify({ Homelab: 'up', Paste: 'up' }) });
    const lotes = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input?.url || input);
      if (url.endsWith('/emails/batch')) { lotes.push(JSON.parse(init.body)); return new Response('{}'); }
      return new Response(JSON.stringify({ configured: false }));
    };
    const env = { STATUS_KV: kv, RESEND_API_KEY: 'k', NOTIFY_TO: 'dono@x.co' };
    // latenciaNoD1: a amostra de latência do Paste não é o que se conta aqui.
    const opts = { latenciaNoD1: true };
    await status.detectAndNotify(env, [homelab('unknown'), outro], 'https://status.lucafchala.com', opts);
    await status.detectAndNotify(env, [homelab('up'), outro], 'https://status.lucafchala.com', opts);
    assert.equal(kv.writes, 0);
    assert.equal(lotes.length, 0);
    assert.deepEqual(JSON.parse(kv._store.get('last_status')), { Homelab: 'up', Paste: 'up' });
  });

  test('up → down alerta como qualquer serviço', async () => {
    const kv = fakeKV({ last_status: JSON.stringify({ Homelab: 'up' }) });
    const lotes = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input?.url || input);
      if (url.endsWith('/emails/batch')) { lotes.push(JSON.parse(init.body)); return new Response('{}'); }
      return new Response(JSON.stringify({ configured: false }));
    };
    await status.detectAndNotify({ STATUS_KV: kv, RESEND_API_KEY: 'k', NOTIFY_TO: 'dono@x.co' }, [homelab('down')], 'https://status.lucafchala.com');
    assert.equal(lotes.length, 1);
    assert.match(lotes[0][0].subject, /CRÍTICO.*Homelab/);
  });

  test('o retrato não conta sem dados como dia verde', async () => {
    const DB = d1Sqlite();
    await retrato.gravarVarredura(DB, { services: [homelab('unknown'), outro] }, 'teste');
    const linhas = DB.sqlite.prepare('SELECT servico FROM dia').all().map((r) => r.servico);
    assert.deepEqual(linhas, ['Paste']);
  });
});
