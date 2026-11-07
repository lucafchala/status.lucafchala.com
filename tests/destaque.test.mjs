// /api/destaque: o aviso de lançamento de álbum do fotos, lido do lado do
// servidor (a CSP desta página não deixa o navegador falar com o fotos).
//
// O que falha em silêncio aqui:
//   • dado de fora vira link na página — só passa endereço https de álbum
//     conhecido, sem usuário/porta, e só os campos que a faixa usa;
//   • fotos fora do ar ou lento derrubaria a página — vira `{ ativo: false }`;
//   • um visitante gerando uma consulta ao fotos por visita — cache de 5 min,
//     com chave fixa que nenhuma query fura;
//   • a faixa montada com innerHTML ou estilo inline (a CSP barra calada).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const destaque = await import('../functions/api/destaque.js');
const { limpaDestaque, DESTAQUE_FONTE, HOSTS_DE_ALBUM } = destaque;

const ATIVO = { ativo: true, slug: 'entrenos2026', titulo: 'Entre Nós', linha: 'Turma 2026 · Colégio Santa Cruz', url: 'https://entrenos2026.com/' };

const realFetch = globalThis.fetch;
let pedidos = [];
let resposta = () => Response.json(ATIVO);
beforeEach(() => {
  pedidos = [];
  resposta = () => Response.json(ATIVO);
  globalThis.fetch = async (u) => { pedidos.push(String(u?.url || u)); return resposta(); };
  const m = new Map();
  globalThis.caches = { default: { async match(r) { const x = m.get(r.url); return x ? x.clone() : undefined; }, async put(r, res) { m.set(r.url, res.clone()); } } };
});
afterEach(() => { globalThis.fetch = realFetch; });

function ctx(url = 'https://status.lucafchala.com/api/destaque') {
  const pend = [];
  return { request: new Request(url), env: {}, waitUntil(p) { pend.push(p); }, flush: () => Promise.all(pend) };
}

describe('limpaDestaque', () => {
  test('passa só os cinco campos, com o link normalizado', () => {
    assert.deepEqual(limpaDestaque({ ...ATIVO, extra: 'x', rk: 'segredo' }), ATIVO);
    assert.deepEqual(limpaDestaque({ ...ATIVO, url: 'https://fotos.lucafchala.com/galeria/x' }).url, 'https://fotos.lucafchala.com/galeria/x');
  });

  test('link só https, de álbum conhecido, sem usuário nem porta', () => {
    for (const url of ['javascript:alert(1)', 'http://entrenos2026.com/', 'https://evil.example/', 'https://entrenos2026.com.evil.example/', 'https://x@entrenos2026.com/', 'https://entrenos2026.com:8443/', 'nada', 42]) {
      assert.deepEqual(limpaDestaque({ ...ATIVO, url }), { ativo: false }, String(url));
    }
    assert.ok(HOSTS_DE_ALBUM.has('entrenos2026.com'));
  });

  test('inativo, sem título, slug estranho ou lixo: nada', () => {
    for (const d of [null, 'x', { ativo: false }, { ...ATIVO, ativo: 'sim' }, { ...ATIVO, titulo: '' }, { ...ATIVO, slug: '../x' }, { ...ATIVO, slug: 'A' }]) {
      assert.deepEqual(limpaDestaque(d), { ativo: false });
    }
  });

  test('texto sem caractere de controle, com teto', () => {
    const d = limpaDestaque({ ...ATIVO, titulo: 'Entre\u0000 Nós‮' + 'x'.repeat(200), linha: 'a\nb' });
    assert.equal(d.linha, 'a b');
    assert.ok(d.titulo.startsWith('Entre Nós'));
    assert.equal(d.titulo.length, 80);
  });
});

describe('GET /api/destaque', () => {
  test('pergunta ao fotos uma vez e guarda 5 min; query não fura o cache; sem CORS', async () => {
    const c = ctx();
    const res = await destaque.onRequestGet(c); await c.flush();
    assert.deepEqual(await res.json(), ATIVO);
    assert.deepEqual(pedidos, [DESTAQUE_FONTE]);
    assert.match(res.headers.get('Cache-Control'), /max-age=300/);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
    await destaque.onRequestGet(ctx('https://status.lucafchala.com/api/destaque?x=1'));
    assert.equal(pedidos.length, 1);
  });

  test('fotos fora do ar, com erro ou devolvendo lixo: { ativo: false }', async () => {
    for (const r of [() => { throw new Error('rede'); }, () => new Response('x', { status: 503 }), () => new Response('não é json'), () => Response.json({ ...ATIVO, url: 'https://evil.example/' })]) {
      resposta = r;
      globalThis.caches = { default: { async match() {}, async put() {} } };
      const res = await destaque.onRequestGet(ctx());
      assert.deepEqual(await res.json(), { ativo: false });
    }
  });
});

describe('a faixa na página', () => {
  const JS = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const trecho = JS.slice(JS.indexOf('// ── Aviso de lançamento (fotos)'), JS.indexOf('// Um listener só, por delegação'));

  test('lê a própria origem, monta por textContent e fecha pela delegação', () => {
    assert.ok(trecho.length > 500);
    assert.match(trecho, /fetch\('\/api\/destaque'/);
    assert.doesNotMatch(trecho, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|\.style\b/);
    assert.doesNotMatch(trecho, /fotos\.lucafchala\.com/);
    assert.match(JS, /'destaque-fechar': \(\) => fechaDestaque\(\)/);
    assert.match(JS, /function toggleLang\(\) \{[^}]*pintaDestaque\(\);/);
  });

  test('o lugar dela no HTML: vazio, escondido, antes do topo', () => {
    assert.match(HTML, /<div class="destaque" id="destaque" hidden><\/div>/);
    assert.ok(HTML.indexOf('id="destaque"') < HTML.indexOf('<header class="topo">'));
  });

  test('os textos existem nos dois idiomas', () => {
    for (const k of ['destaque_aria', 'destaque_novo', 'destaque_no_ar', 'destaque_ver', 'destaque_fechar']) {
      assert.equal((JS.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 2, k);
    }
  });
});
