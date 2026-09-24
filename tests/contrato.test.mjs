// O que este painel lê do healthz do fotos contra o contrato que o fotos
// publica (docs/healthz-contrato.json no repositório dele).
//
// Por que existe: cada campo que status.js lê é uma segunda cópia de um nome
// que mora no fotos. Já divergiu — o `hashMs` saiu de lá e aqui ficou o rótulo
// "hash" e o README por meses (#38). O contrato é a cópia única; este teste
// confere o lado de cá:
//
//   • os campos LIDOS são descobertos, não listados: as funções de status.js
//     rodam sobre o exemplo do contrato embrulhado num Proxy que anota cada
//     propriedade acessada. Uma lista escrita à mão seria uma terceira cópia,
//     e envelheceria como o README envelheceu;
//   • todo campo lido tem de estar no contrato, e o número do contrato tem de
//     ser o que este painel conhece;
//   • sobre o exemplo (um fotos saudável), toda linha derivada sai verde e
//     nenhuma cai no "healthz antigo".
//
// O contrato vem do GitHub (o repositório do fotos é público). No CI isso
// roda em todo push, todo PR e toda semana (checks.yml) — o fotos pode mudar
// o contrato sem ninguém tocar aqui. Para testar contra um checkout local:
// CONTRATO_FOTOS=../fotos/docs/healthz-contrato.json node --test tests/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const status = await import('../functions/api/status.js');

const URL_CONTRATO = 'https://raw.githubusercontent.com/lucafchala/fotos/main/docs/healthz-contrato.json';

async function carregarContrato() {
  if (process.env.CONTRATO_FOTOS) return JSON.parse(readFileSync(process.env.CONTRATO_FOTOS, 'utf8'));
  const res = await fetch(URL_CONTRATO, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`contrato do fotos: HTTP ${res.status} em ${URL_CONTRATO}`);
  return res.json();
}

const CONTRATO = await carregarContrato();

/** Embrulha `obj` e anota em `lidos` o caminho de cada propriedade acessada. */
function espiao(obj, lidos, pre = '') {
  return new Proxy(obj, {
    get(alvo, prop, rec) {
      const v = Reflect.get(alvo, prop, rec);
      if (typeof prop !== 'string') return v;
      if (Array.isArray(alvo)) return v;           // índices/length de array não são campo
      const caminho = pre ? `${pre}.${prop}` : prop;
      lidos.add(caminho);
      return v && typeof v === 'object' && !Array.isArray(v) ? espiao(v, lidos, caminho) : v;
    },
    has(alvo, prop) {
      if (typeof prop === 'string' && !Array.isArray(alvo)) lidos.add(pre ? `${pre}.${prop}` : prop);
      return Reflect.has(alvo, prop);
    },
  });
}

async function linhasDoFotos(payload, lidos) {
  const h = { status: 200, json: espiao(structuredClone(payload), lidos) };
  // A sonda da página de evento lê só `selftest.sample` e busca a página; a
  // busca é simulada com uma página que tem as três marcas.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('drive-turnstile rem-turnstile property="og:title"', { status: 200 });
  try {
    return [
      status.healthInfra('saúde', h),
      status.healthSelftest('autoteste', h),
      status.healthConfig('configuração implantada', h),
      await status.checkEventPage('página de evento', h, 'https://fotos.lucafchala.com'),
    ];
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('contrato do healthz do fotos', () => {
  test('este painel conhece a versão do contrato que o fotos publica', () => {
    assert.equal(CONTRATO.contrato, status.CONTRATO_HEALTHZ_CONHECIDO,
      'o fotos mudou o contrato: revise o que status.js lê e suba CONTRATO_HEALTHZ_CONHECIDO');
  });

  test('todo campo que status.js lê está no contrato', async () => {
    const lidos = new Set();
    await linhasDoFotos(CONTRATO.exemplo, lidos);
    assert.ok(lidos.size > 10, `o espião viu poucos campos (${lidos.size}) — ele parou de funcionar?`);
    const fora = [...lidos].filter((c) => !(c in CONTRATO.campos));
    assert.deepEqual(fora, [], `status.js lê campos que o contrato do fotos não tem: ${fora.join(', ')}`);
  });

  test('nada do que saiu de propósito é lido', async () => {
    const lidos = new Set();
    await linhasDoFotos(CONTRATO.exemplo, lidos);
    for (const c of CONTRATO.ausentes || []) assert.equal(lidos.has(c), false, `status.js ainda lê ${c}`);
  });

  test('sobre o exemplo (fotos saudável), toda linha sai verde e sem "healthz antigo"', async () => {
    const linhas = await linhasDoFotos(CONTRATO.exemplo, new Set());
    for (const l of linhas) {
      assert.equal(l.status, 'up', `${l.label}: ${l.detail}`);
      assert.doesNotMatch(l.detail, /antigo|indisponível/, `${l.label} caiu no caminho de payload velho`);
    }
    const config = linhas[2];
    assert.equal(config.versao.tag, CONTRATO.exemplo.versao.tag, 'a versão implantada chega à linha');
  });

  test('contrato de número desconhecido vira degradado, não verde', async () => {
    const linhas = await linhasDoFotos({ ...CONTRATO.exemplo, contrato: status.CONTRATO_HEALTHZ_CONHECIDO + 1 }, new Set());
    assert.equal(linhas[2].status, 'degraded');
    assert.match(linhas[2].detail, /contrato do healthz/);
  });

  test('o espião pega leitura de campo fora do contrato', () => {
    // Sem isto, um espião quebrado (que não anota nada) passaria em tudo.
    const lidos = new Set();
    const j = espiao({ a: { b: 1 } }, lidos);
    void j.a.b; void ('c' in j);
    assert.deepEqual([...lidos].sort(), ['a', 'a.b', 'c']);
  });
});
