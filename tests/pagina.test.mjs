// A página estática contra a CSP estrita do _headers.
//
// A política diz `script-src 'self'; style-src 'self'; font-src 'self'`, sem
// 'unsafe-inline'. Isso só vale enquanto nenhum arquivo servido trouxer script
// inline, atributo `on…`, atributo de estilo ou recurso de terceiro — e um
// deslize desses não quebra teste nenhum de função: quebra a página no
// navegador, calado (a lição mais cara do fotos, RETOMADA §5.1). Este arquivo
// confere o texto; a verificação de verdade é o navegador (ver o PR).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const raiz = new URL('../', import.meta.url);
const ler = (p) => readFileSync(new URL(p, raiz), 'utf8');
const HTML = ler('index.html');
const CSS = ler('app.css');
const JS = ler('app.js');
const HEADERS = ler('_headers');

const semComentarios = (js) => js.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('página estática × CSP estrita', () => {
  test('a CSP não tem unsafe-inline nem origem de terceiro', () => {
    const csp = HEADERS.match(/^\s+Content-Security-Policy:\s*(.+)$/m)[1];
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.doesNotMatch(csp, /googleapis|gstatic|https:\/\//);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /style-src 'self'(;|$)/);
    assert.match(csp, /font-src 'self'(;|$)/);
  });

  test('index.html: nenhum script ou estilo inline, nenhum atributo on… ou de estilo', () => {
    assert.doesNotMatch(HTML, /<style/i);
    assert.doesNotMatch(HTML, /\sstyle=/i);
    assert.doesNotMatch(HTML, /\son[a-z]+=/i);
    for (const tag of HTML.match(/<script\b[^>]*>/gi) || []) {
      assert.match(tag, /\ssrc="\/[^"]+"/, `script sem src: ${tag}`);
    }
    assert.doesNotMatch(HTML, /<script\b[^>]*>[^<\s]/i, 'script com corpo inline');
  });

  test('index.html só carrega recursos da própria origem', () => {
    const recursos = [...HTML.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/gi)]
      .filter((m) => !/rel="(canonical|sitemap)"/.test(m[0]))
      .map((m) => m[1]);
    assert.ok(recursos.length >= 4);
    for (const r of recursos) assert.match(r, /^\//, `recurso de fora: ${r}`);
  });

  test('app.js não gera HTML com atributo de estilo ou handler inline', () => {
    const js = semComentarios(JS);
    assert.doesNotMatch(js, /style="/);
    assert.doesNotMatch(js, /\son[a-z]+="/);
  });

  test('cada fonte do app.css existe, está no preload certo, e o hash do nome é o do conteúdo', () => {
    const fontes = [...CSS.matchAll(/url\('(\/fonts\/[^']+\.woff2)'\)/g)].map((m) => m[1]);
    assert.equal(fontes.length, 3);
    for (const f of fontes) {
      const caminho = new URL('.' + f, raiz);
      assert.ok(existsSync(caminho), `${f} não existe`);
      // `immutable` no _headers só é seguro se o nome muda quando o conteúdo
      // muda: o hash no nome tem de ser o do arquivo.
      const hash = createHash('sha256').update(readFileSync(caminho)).digest('hex').slice(0, 10);
      assert.match(f, new RegExp(`\\.${hash}\\.woff2$`), `${f}: hash do conteúdo é ${hash}`);
    }
    for (const m of HTML.matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)) {
      assert.ok(fontes.includes(m[1]), `preload de fonte que o CSS não usa: ${m[1]}`);
    }
    assert.match(HEADERS, /\/fonts\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
  });
});

describe('página de cancelamento (Function) × a mesma CSP', () => {
  test('sem estilo inline e sem fonte de terceiro', async () => {
    const { onRequestGet } = await import('../functions/api/unsubscribe.js');
    const res = await onRequestGet({
      request: new Request('https://status.lucafchala.com/api/unsubscribe?token=11111111-2222-3333-4444-555555555555'),
      env: { STATUS_KV: { async get() { return '[]'; } } },
    });
    const html = await res.text();
    assert.doesNotMatch(html, /<style|\sstyle=|googleapis|gstatic/i);
    assert.match(html, /href="\/cancelar\.css"/);
    const csp = res.headers.get('Content-Security-Policy');
    assert.match(csp, /style-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
  });
});
