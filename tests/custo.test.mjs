// Quanto uma varredura custa — contado, não estimado.
//
// Cada requisição que a varredura faz ao fotos é uma invocação do Worker dele,
// dentro da cota diária da conta inteira. Este arquivo simula todos os sites
// saudáveis e CONTA as idas de uma varredura, para que um corte de custo não
// possa voltar calado (e para que a tabela "antes → depois" dos PRs tenha de
// onde sair).

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const status = await import('../functions/api/status.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const MARCAS = [
  'Luca', 'Radio', 'fotos', '/dashboard/login', 'Painel', 'Paste', 'url.lucafchala.com', 'Chaves',
  'Acesso restrito', 'subs', 'Hevy', 'monitoramento de serviços', 'data-title="', 'drive-turnstile',
  'rem-turnstile', 'property="og:title"', 'cf-turnstile', 'Termos de Uso', 'Política de Privacidade', '<svg',
].join(' ');
const HTML = `<html>${MARCAS} ${'x'.repeat(300)}</html>`;
const SEG = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-site',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; upgrade-insecure-requests",
};

/** Todos os sites saudáveis; o healthz do fotos declara `versaoId`. Conta tudo. */
function mundo(versaoId = 'v1', { dominio403 = false } = {}) {
  const idas = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input?.url || input));
    idas.push(url.host + url.pathname);
    const html = (ct = 'text/html') => new Response(HTML, { status: 200, headers: { 'content-type': ct, ...SEG } });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (dominio403 && url.host === 'fotos.lucafchala.com') return new Response('bloqueado', { status: 403 });
    if (url.pathname === '/api/healthz' && url.host.startsWith('fotos')) {
      return json({ contrato: 1, ok: true, kv: true, events: 3, d1: 'ok', kvLatencyMs: 5, d1LatencyMs: 5,
        cron: { stale: false, ageHours: 1 }, selftest: { ok: true, problems: [], drive: { ok: 1, live: 1 }, forms: { turnstile: true, resend: true, adminEmail: true }, sample: 'festa' },
        config: {}, termsVersion: 't', versao: versaoId ? { id: versaoId, tag: 'abc1234', em: '2026-09-24T10:00:00Z' } : null });
    }
    if (url.pathname === '/api/healthz') return json({ kv: true, resendKey: true, notifyTo: true, subscribers: 1 });
    if (url.pathname === '/sitemap.xml') return new Response('<?xml version="1.0"?><urlset></urlset>', { headers: { 'content-type': 'application/xml' } });
    if (url.pathname === '/manifest.json') return json({ name: 'f', icons: [{ src: '/i' }], start_url: '/', theme_color: '#000' });
    if (url.pathname === '/.well-known/gpc.json') return json({ gpc: true });
    if (url.pathname.endsWith('/data.json')) return json({ redirects: [{ createdAt: '2026-09-01' }] });
    if (url.pathname === '/pastes.json') return json({ pastes: [{ createdAt: '2026-09-01' }] });
    if (url.pathname === '/.well-known/security.txt') return new Response('Contact: mailto:a@b.co\nExpires: 2030-01-01T00:00:00Z\n');
    if (url.pathname === '/robots.txt') return new Response('Sitemap: x '.repeat(10), { headers: { 'content-type': 'text/plain' } });
    if (url.pathname === '/icon.svg') return html('image/svg+xml');
    if (url.pathname === '/og-coming-soon.png') return html('image/png');
    if (url.pathname === '/__status_probe_404__') return new Response('', { status: 404 });
    if (url.pathname === '/proof-of-ownership.txt') return new Response('Luca Ferriani Chala '.repeat(5));
    return html();
  };
  return {
    idas,
    fotos: () => idas.filter((u) => u.startsWith('fotos.')).length,
    para: (trecho) => idas.filter((u) => u.includes(trecho)).length,
  };
}

const fotosDe = (payload) => payload.services.find((s) => s.name === 'Fotos');

describe('custo de uma varredura', () => {
  test('primeira varredura: 17 requisições no fotos (tudo conferido)', async () => {
    const m = mundo();
    const p = await status.varrer({});
    assert.equal(m.fotos(), 17);
    assert.equal(fotosDe(p).status, 'up', JSON.stringify(fotosDe(p).problems));
  });

  test('varredura seguinte, mesma versão: 5 requisições no fotos (as estáticas reaproveitadas)', async () => {
    mundo();
    const p1 = await status.varrer({});
    const m = mundo();
    const p2 = await status.varrer({}, p1);
    assert.equal(m.fotos(), 5, m.idas.filter((u) => u.startsWith('fotos.')).join(' | '));
    const f = fotosDe(p2);
    assert.equal(f.status, 'up');
    assert.equal(f.checks.length, fotosDe(p1).checks.length, 'as linhas continuam todas lá');
    const termos = f.checks.find((c) => c.label === 'termos (LGPD)');
    assert.equal(termos.verificadoEm, fotosDe(p1).checks.find((c) => c.label === 'termos (LGPD)').verificadoEm,
      'a linha reaproveitada diz quando foi conferida de verdade');
  });

  test('versão nova (deploy): as estáticas rodam de novo', async () => {
    mundo('v1');
    const p1 = await status.varrer({});
    const m = mundo('v2');
    await status.varrer({}, p1);
    assert.equal(m.fotos(), 17);
  });

  test('sem versão no healthz (binding ausente, healthz antigo): nada é reaproveitado', async () => {
    mundo(null);
    const p1 = await status.varrer({});
    const m = mundo(null);
    await status.varrer({}, p1);
    assert.equal(m.fotos(), 17);
  });

  test('linha estática que falhou é reconferida na varredura seguinte', async () => {
    mundo();
    const p1 = await status.varrer({});
    const f = fotosDe(p1);
    f.checks.find((c) => c.label === 'robots.txt').status = 'degraded';
    const m = mundo();
    await status.varrer({}, p1);
    assert.equal(m.para('fotos.lucafchala.com/robots.txt'), 1);
  });

  test('passadas 3 h, mesmo sem deploy, as estáticas rodam de novo', () => {
    const agora = Date.now();
    const velha = { checks: [{ label: 'robots.txt', status: 'up', versaoId: 'v1', verificadoEm: new Date(agora - status.ESTATICAS_TTL_MS - 1).toISOString() }] };
    assert.equal(status.reaproveitavel(velha, 'robots.txt', 'v1', agora), null);
    const nova = { checks: [{ ...velha.checks[0], verificadoEm: new Date(agora - 60_000).toISOString() }] };
    assert.ok(status.reaproveitavel(nova, 'robots.txt', 'v1', agora));
  });

  test('Dash, Paste e URL buscam o arquivo de dados UMA vez, para as duas linhas', async () => {
    const m = mundo();
    const p = await status.varrer({});
    assert.equal(m.para('dash.lucafchala.com/data.json'), 1);
    assert.equal(m.para('paste.lucafchala.com/pastes.json'), 1);
    assert.equal(m.para('url.lucafchala.com/data.json'), 1);
    const dash = p.services.find((s) => s.name === 'Dash');
    assert.deepEqual(dash.checks.map((c) => c.label), ['disponibilidade', 'data.json (PURLs)', 'atualidade dos dados']);
    assert.ok(dash.checks.every((c) => c.status === 'up'));
  });

  test('sondas profundas do fotos vão pelo workers.dev; o resto, pelo domínio', async () => {
    const m = mundo();
    await status.varrer({});
    assert.equal(m.para('fotos.lucafchala.workers.dev/api/healthz'), 1);
    assert.equal(m.para('fotos.lucafchala.workers.dev/festa'), 1);
    assert.equal(m.para('fotos.lucafchala.com/api/healthz'), 0);
  });

  test('subrequests por varredura, no total: 38 → 24 depois da primeira', async () => {
    mundo();
    const p1 = await status.varrer({});
    const m = mundo();
    await status.varrer({}, p1);
    assert.ok(m.idas.length <= 24, `${m.idas.length} fetch`);
  });
});

describe('domínio próprio × workers.dev', () => {
  test('domínio 403 com o Worker de pé: é a zona, e a linha diz isso', async () => {
    mundo('v1', { dominio403: true });
    const f = fotosDe(await status.varrer({}));
    const linha = f.checks.find((c) => c.label === 'domínio próprio × workers.dev');
    assert.equal(linha.status, 'degraded');
    assert.match(linha.detail, /zona \(WAF\/bot\)/);
    assert.equal(f.checks.find((c) => c.label === 'saúde · KV/D1/cron').status, 'up', 'o Worker em si está bem');
  });

  test('os dois de pé: verde', () => {
    const r = status.dominioOuWorker('x', { status: 'up', statusCode: 200 }, { status: 200, json: { ok: true } });
    assert.equal(r.status, 'up');
  });

  test('os dois fora: é o site — a linha não duplica o alarme', () => {
    const r = status.dominioOuWorker('x', { status: 'down', statusCode: 502 }, { netError: 'timeout' });
    assert.equal(r.status, 'up');
    assert.match(r.detail, /é o site/);
  });

  test('domínio sem resposta com o Worker de pé: rota/DNS/TLS', () => {
    const r = status.dominioOuWorker('x', { status: 'down', statusCode: null }, { status: 200, json: { ok: true } });
    assert.equal(r.status, 'degraded');
    assert.match(r.detail, /DNS/);
  });
});
