// Tudo o que a página lê, menos a varredura, numa chamada só.
//
// A página fazia cinco chamadas por atualização — status, terceiros, cotas,
// histórico e latência — a cada 60 s, com a aba visível ou não. Uma aba
// esquecida aberta eram ~7.200 invocações de Pages Function por dia, contra um
// teto de 100 mil da CONTA inteira (Workers e Pages somados).
//
// Por que a varredura (/api/status) fica de fora: o teto de subrequests é por
// INVOCAÇÃO — 50 no plano gratuito. Uma varredura sozinha já faz ~38; somadas
// às idas a terceiros (~6) e à API da Cloudflare para as cotas (~6), uma
// invocação só passaria do teto justamente no pior momento, com o cache frio.
// Quando a varredura passar a morar num retrato compartilhado (ler em vez de
// sondar), ela entra aqui e a página faz uma chamada só.
//
// Cada seção falha sozinha: um provedor fora do ar ou uma cota ilegível viram
// `{ erro }` naquela seção, nunca um 500 que apaga as outras quatro.

import { verificarTerceiros } from './third-party-status.js';
import { lerCotas } from './quota-stats.js';
import { resumoHistorico } from './status-history.js';
import { resumoLatencia } from './latency-trends.js';

// Mesma ordem de grandeza do que ele agrega: o histórico e a latência só mudam
// quando uma varredura roda, terceiros e cotas têm cache próprio de 2 e 5 min.
export const PAINEL_CACHE_S = 60;

async function secao(nome, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(`painel: seção ${nome} falhou`, e);
    return { erro: 'não foi possível ler agora' };
  }
}

export async function montarPainel(context) {
  const KV = context.env.STATUS_KV;
  const [terceiros, cotas, historico, latencia] = await Promise.all([
    secao('terceiros', () => verificarTerceiros(context)),
    secao('cotas', () => lerCotas(context)),
    secao('historico', () => resumoHistorico(KV)),
    secao('latencia', () => resumoLatencia(KV)),
  ]);
  return { terceiros, cotas, historico, latencia, geradoEm: new Date().toISOString() };
}

export async function onRequestGet(context) {
  const cache = caches.default;
  // Chave fixa: query nenhuma fura o cache (ver third-party-status.js).
  const cacheKey = new Request(new URL(context.request.url).origin + '/api/painel');
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const res = new Response(JSON.stringify(await montarPainel(context)), {
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': `public, max-age=0, s-maxage=${PAINEL_CACHE_S}`,
    },
  });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
