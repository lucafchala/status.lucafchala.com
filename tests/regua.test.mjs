// As réguas que decidem a cor: dia das barras, painel atrás do Access e o
// Cloudflare no Brasil. Todas falham em silêncio — a página fica amarela (ou
// verde) sem nenhum erro —, por isso cada uma tem o caso que a motivou.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

await import('../uptime.js');
const { classeDia } = globalThis.lfUptime;
const retrato = await import('../functions/api/retrato.js');
const status = await import('../functions/api/status.js');
const terceiros = await import('../functions/api/third-party-status.js');

describe('cor do dia (classeDia)', () => {
  test('uma varredura lenta entre 144 não pinta o dia de amarelo', () => {
    assert.equal(classeDia({ total: 144, up: 143, degraded: 1, down: 0 }), 'up');
    assert.equal(classeDia({ total: 144, up: 137, degraded: 7, down: 0 }), 'up');
  });
  test('lentidão longa (≥ 5 % das varreduras) é amarelo', () => {
    assert.equal(classeDia({ total: 144, up: 136, degraded: 8, down: 0 }), 'degraded');
    assert.equal(classeDia({ total: 144, up: 0, degraded: 144, down: 0 }), 'degraded');
  });
  test('queda curta é amarelo; queda longa é vermelho (régua do medidor)', () => {
    assert.equal(classeDia({ total: 144, up: 143, degraded: 0, down: 1 }), 'degraded');
    assert.equal(classeDia({ total: 144, up: 142, degraded: 0, down: 2 }), 'down');
  });
  test('dia sem varredura é sem dado, nunca verde', () => {
    assert.equal(classeDia({ total: 0 }), null);
    assert.equal(classeDia(null), null);
  });
  test('as barras diárias usam a régua', () => {
    const agora = Date.now();
    const dia = retrato.diaLocal(agora);
    const b = retrato.barrasDiarias({ Fotos: { [dia]: { total: 144, up: 143, degraded: 1, down: 0 } } }, agora);
    const hoje = b.servicos.Fotos.at(-1);
    assert.equal(hoje.estado, 'up');
    assert.equal(hoje.lentas, 1, 'a lentidão continua na dica da barra');
  });
});

describe('painel atrás do Cloudflare Access (avaliarAcesso)', () => {
  const alvo = 'https://fotos.lucafchala.com/dashboard';
  const r = (status, location) => new Response(null, { status, headers: location ? { location } : {} });
  test('302 para o login do Access = de pé e protegido', () => {
    const v = status.avaliarAcesso(r(302, 'https://equipe.cloudflareaccess.com/cdn-cgi/access/login/fotos.lucafchala.com?kid=x'), alvo);
    assert.equal(v.status, 'up');
  });
  test('200 = painel aberto sem portão: problema, com o motivo', () => {
    const v = status.avaliarAcesso(new Response('<html>painel</html>', { status: 200 }), alvo);
    assert.equal(v.status, 'degraded');
    assert.match(v.detail, /sem Cloudflare Access/);
  });
  test('redirecionamento para outro lugar não passa', () => {
    assert.equal(status.avaliarAcesso(r(302, 'https://evil.example/cdn-cgi/access/login/x'), alvo).status, 'degraded');
    assert.equal(status.avaliarAcesso(r(302, '/dashboard/login'), alvo).status, 'degraded');
  });
  test('5xx = offline', () => {
    assert.equal(status.avaliarAcesso(r(503), alvo).status, 'down');
  });
});

describe('Cloudflare no Brasil (estadoBrasil)', () => {
  const pop = (nome, st = 'operational') => ({ name: `${nome}, Brazil - (${nome.slice(0, 3).toUpperCase()})`, status: st });
  const gru = (st = 'operational') => ({ name: 'São Paulo, Brazil - (GRU)', status: st });
  const muitos = (n, st) => Array.from({ length: n }, (_, i) => pop(`Cidade${i}`, st));
  test('PoP pequeno fora não deixa o Cloudflare vermelho', () => {
    const lista = [gru(), ...muitos(27, 'operational'), pop('Palmas', 'major_outage'), pop('Campos', 'major_outage')];
    assert.equal(terceiros.estadoBrasil(lista), 'up');
  });
  test('São Paulo manda', () => {
    assert.equal(terceiros.estadoBrasil([gru('degraded_performance'), ...muitos(20, 'operational')]), 'degraded');
    assert.equal(terceiros.estadoBrasil([gru('major_outage'), ...muitos(20, 'operational')]), 'down');
  });
  test('problema amplo pesa mesmo com São Paulo bem', () => {
    assert.equal(terceiros.estadoBrasil([gru(), ...muitos(10, 'degraded_performance'), ...muitos(20, 'operational')]), 'degraded');
    assert.equal(terceiros.estadoBrasil([gru(), ...muitos(15, 'major_outage'), ...muitos(15, 'operational')]), 'down');
  });
  test('status desconhecido de São Paulo não vira verde', () => {
    assert.equal(terceiros.estadoBrasil([gru('algo_novo'), ...muitos(5, 'operational')]), 'unknown');
  });
});
