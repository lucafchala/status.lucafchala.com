// A conta do medidor de uptime, num arquivo só.
//
// Existe separado porque a mesma regra é usada em dois lugares — a página
// (app.js) e o /api/resumo (resumo.js) — e porque uma regra escrita duas vezes
// é corrigida uma vez só. Script clássico (a CSP não tem 'unsafe-inline' e a
// página não usa módulos): publica `lfUptime` no escopo global, e o Node e o
// Worker importam o arquivo só pelo efeito.
//
// Princípio herdado do resto do painel: dado que falta não é verde. Serviço ou
// dia sem leitura fica FORA da média — nem como 100 %, nem como 0 %.
(function (g) {
  'use strict';

  // Média simples entre os serviços que têm dado.
  function mediaPct(valores) {
    const v = valores.filter((x) => typeof x === 'number' && Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  // Disponibilidade de uma janela de barras: média ponderada pelo número de
  // varreduras de cada período. Período sem dado não entra.
  function uptimeJanela(lista) {
    let peso = 0, soma = 0;
    for (const b of lista) {
      if (!b || !b.estado || b.pct == null) continue;
      const w = b.varreduras || 1;
      peso += w; soma += w * b.pct;
    }
    return peso ? soma / peso : null;
  }

  // Verde só a partir de 99,9 %; de 99 % a 99,9 % é degradado; abaixo disso,
  // vermelho. Sem dado, neutro ('nd').
  function classeUptime(p) {
    if (p == null || !Number.isFinite(p)) return 'nd';
    return p >= 99.9 ? 'up' : p >= 99 ? 'degraded' : 'down';
  }

  g.lfUptime = { mediaPct, uptimeJanela, classeUptime };
})(globalThis);
