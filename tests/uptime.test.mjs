// O medidor de uptime: a conta (uptime.js), o que o /api/resumo publica dela e
// a página carregando o arquivo na ordem certa.
//
// O que falha em silêncio aqui é a MÉDIA: serviço sem dado entrando como 100 %
// (ou 0 %) puxa o número do anel para um lado sem nenhum erro visível. É a
// regra "dado que falta não é verde" do resto do painel.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { d1Sqlite } from './d1.mjs';

await import('../uptime.js');
const { mediaPct, uptimeJanela, classeUptime } = globalThis.lfUptime;
const resumo = await import('../functions/api/resumo.js');
const retrato = await import('../functions/api/retrato.js');

describe('mediaPct', () => {
  test('média só dos que têm dado: null, undefined e NaN ficam fora', () => {
    assert.equal(mediaPct([100, 98, null, undefined, NaN]), 99);
  });
  test('ninguém com dado → null, nunca 100 nem 0', () => {
    assert.equal(mediaPct([]), null);
    assert.equal(mediaPct([null, undefined]), null);
  });
  test('zero é dado: um serviço fora o tempo todo conta', () => {
    assert.equal(mediaPct([100, 0]), 50);
  });
});

describe('uptimeJanela', () => {
  test('pondera pelas varreduras e ignora período sem dado', () => {
    const lista = [
      { estado: 'up', pct: 100, varreduras: 3 },
      { estado: 'down', pct: 50, varreduras: 1 },
      { estado: null },
      null,
      { estado: 'up', pct: null, varreduras: 9 },
    ];
    assert.equal(uptimeJanela(lista), (300 + 50) / 4);
  });
  test('janela sem nenhum dado → null', () => {
    assert.equal(uptimeJanela([{ estado: null }, null]), null);
    assert.equal(uptimeJanela([]), null);
  });
  test('período sem contagem de varreduras pesa 1', () => {
    assert.equal(uptimeJanela([{ estado: 'up', pct: 100 }, { estado: 'up', pct: 90 }]), 95);
  });
});

describe('classeUptime', () => {
  test('limites: verde a partir de 99,9, âmbar a partir de 99, senão vermelho', () => {
    assert.equal(classeUptime(100), 'up');
    assert.equal(classeUptime(99.9), 'up');
    assert.equal(classeUptime(99.89), 'degraded');
    assert.equal(classeUptime(99), 'degraded');
    assert.equal(classeUptime(98.99), 'down');
    assert.equal(classeUptime(0), 'down');
  });
  test('sem dado é neutro, nunca verde', () => {
    assert.equal(classeUptime(null), 'nd');
    assert.equal(classeUptime(undefined), 'nd');
    assert.equal(classeUptime(NaN), 'nd');
  });
});

describe('/api/resumo: uptime', () => {
  beforeEach(() => {
    const m = new Map();
    globalThis.caches = { default: { async match(r) { const x = m.get(r.url); return x ? x.clone() : undefined; }, async put(r, res) { m.set(r.url, res.clone()); } } };
  });

  const svc = (name, status) => ({ name, url: `https://${name}.lucafchala.com`, status });

  test('média das varreduras das últimas 24 h e 48 h, só de quem tem dado', async () => {
    const DB = d1Sqlite();
    const agora = Date.now();
    // a: 1 de 2 varreduras fora → 50 %; b: sempre no ar → 100 %. Média 75.
    await retrato.gravarVarredura(DB, { services: [svc('a', 'down'), svc('b', 'up')] }, 'agendador', agora - 3600_000);
    await retrato.gravarVarredura(DB, { services: [svc('a', 'up'), svc('b', 'up')] }, 'agendador', agora);
    const r = await resumo.montarResumo(DB, agora);
    assert.deepEqual(r.uptime, { h24: 75, h48: 75 });
  });

  test('série ilegível → uptime null (nunca 100) e o resto do resumo segue', async () => {
    const DB = d1Sqlite();
    await retrato.gravarVarredura(DB, { services: [svc('a', 'up')] }, 'agendador', Date.now());
    const quebraSerie = {
      prepare(sql) {
        if (/FROM varredura WHERE em >=/.test(sql)) throw new Error('série fora do ar');
        return DB.prepare(sql);
      },
      batch: (...a) => DB.batch(...a),
      exec: (...a) => DB.exec(...a),
    };
    const r = await resumo.montarResumo(quebraSerie);
    assert.equal(r.retratoCompartilhado, true);
    assert.equal(r.uptime, null);
    assert.equal(r.services.length, 1);
  });

  test('sem STATUS_DB não há campo de uptime a inventar', async () => {
    assert.deepEqual(await resumo.montarResumo(undefined), { retratoCompartilhado: false, services: [] });
  });
});

describe('página', () => {
  const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  test('uptime.js é carregado antes do app.js, com data-cfasync="false"', () => {
    const i = HTML.indexOf('src="/uptime.js"');
    const j = HTML.indexOf('src="/app.js"');
    assert.ok(i > 0 && j > i, 'uptime.js precisa vir antes do app.js (app.js lê window.lfUptime)');
    assert.match(HTML.match(/<script[^>]*uptime\.js[^>]*>/)[0], /data-cfasync="false"/);
  });
  test('o medidor tem todos os ids que o app.js preenche', () => {
    const JS = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
    const usados = [...JS.matchAll(/getElementById\('((?:anel|jan)[^']*)'\)/g)].map((m) => m[1]);
    for (const id of ['anel-90', 'anel-valor', 'anel-pct', 'anel-rotulo', 'jan-hist-rot', ...usados]) {
      assert.ok(HTML.includes(`id="${id}"`), `index.html sem id="${id}"`);
    }
    for (const j of ['24', '48', 'hist']) {
      for (const suf of ['', '-pct', '-barra']) assert.ok(HTML.includes(`id="jan-${j}${suf}"`), `sem jan-${j}${suf}`);
    }
  });
});
