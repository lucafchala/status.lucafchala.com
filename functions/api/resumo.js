// Resumo público e mínimo do último retrato: nome, URL e estado de cada
// serviço. É o que a home (lucafchala.com, "04 Ecossistema") lê para as
// bolinhas de status.
//
// Por que um endpoint próprio, e não CORS no /api/painel:
//   • o painel pesa ~90 KB (histórico, barras, cotas, terceiros) e a home usa
//     três campos por serviço;
//   • montar o painel com o cache frio consulta D1, terceiros e a API da
//     Cloudflare numa invocação só — caro para cada visitante da home;
//   • este aqui só LÊ o retrato em D1. Nunca varre, nunca chama terceiros:
//     visitante de outro site não consegue gerar custo de sonda.
//
// Sem STATUS_DB (ou com o D1 fora do ar) responde `retratoCompartilhado:
// false` e nenhum serviço — a home, então, simplesmente não desenha nada.
//
// Aberto a qualquer origem (`Access-Control-Allow-Origin: *`) e sem cookie:
// o conteúdo é o mesmo que a página pública de status mostra.

import { lerRetrato, RETRATO_TTL_MS } from './retrato.js';

export const RESUMO_CACHE_S = 60;
const ESTADOS = new Set(['up', 'degraded', 'down']);

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': `public, max-age=${RESUMO_CACHE_S}, s-maxage=${RESUMO_CACHE_S}`,
};

export async function montarResumo(DB, agora = Date.now()) {
  if (!DB) return { retratoCompartilhado: false, services: [] };
  let r = null;
  try { r = await lerRetrato(DB); } catch (e) { console.error('resumo: D1 não respondeu', e); return { retratoCompartilhado: false, services: [] }; }
  if (!r) return { retratoCompartilhado: false, services: [] };
  const idadeMs = agora - r.em;
  return {
    retratoCompartilhado: true,
    checkedAt: new Date(r.em).toISOString(),
    atrasado: idadeMs > RETRATO_TTL_MS,
    services: r.payload.services
      .filter((s) => s && typeof s.name === 'string' && typeof s.url === 'string' && ESTADOS.has(s.status))
      .map((s) => ({ name: s.name, url: s.url, status: s.status })),
  };
}

export async function onRequestGet(context) {
  const cache = caches.default;
  // Chave fixa: nenhuma query fura o cache (mesma regra do /api/painel).
  const cacheKey = new Request(new URL(context.request.url).origin + '/api/resumo');
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const res = new Response(JSON.stringify(await montarResumo(context.env.STATUS_DB)), { headers: HEADERS });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// Pré-voo não é necessário (GET simples, sem cabeçalhos próprios), mas um
// cliente que mande OPTIONS recebe a resposta certa em vez de 405.
export function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
}
