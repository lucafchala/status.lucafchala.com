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
import { resumoHistorico, linhaDoTempo, barrasHorarias, uptimeTransicoes } from './status-history.js';
import { resumoLatencia, resumoDeEntradas } from './latency-trends.js';
import { lerRetrato, lerSerie, lerBarrasDiarias, uptimeDe, RETRATO_TTL_MS } from './retrato.js';

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

// As barras de 90 dias mudam devagar (só o dia de hoje anda) e cada leitura
// custa ~1.200 linhas lidas no D1 (13 serviços × 90 dias). Cache próprio de
// 10 min, para não pagar isso a cada minuto de cada colo.
export const BARRAS_CACHE_S = 600;

async function barrasCacheadas(context, DB) {
  const cache = caches.default;
  const key = new Request(new URL(context.request.url).origin + '/api/painel/barras-diarias');
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const barras = await lerBarrasDiarias(DB);
  context.waitUntil(cache.put(key, new Response(JSON.stringify(barras), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=0, s-maxage=${BARRAS_CACHE_S}` },
  })));
  return barras;
}

// Com o retrato em D1 o painel traz TUDO — inclusive o status, lido, não
// varrido — e a página faz uma chamada só. Sem ele, o status fica de fora
// (a página chama /api/status) e barras e uptime saem do log de transições.
async function comRetrato(context, DB) {
  const agora = Date.now();
  const [r, serie, barras] = await Promise.all([
    lerRetrato(DB),
    lerSerie(DB, agora),
    secao('barras', () => barrasCacheadas(context, DB)),
  ]);
  const idadeMs = r ? agora - r.em : null;
  return {
    status: r ? { ...r.payload, retrato: { origem: r.origem, idadeMs, atrasado: idadeMs > RETRATO_TTL_MS } } : null,
    latencia: resumoDeEntradas(serie, null),
    barras,
    uptime: {
      fonte: 'd1',
      h24: uptimeDe(serie, agora - 24 * 3600_000),
      h48: uptimeDe(serie, agora - 48 * 3600_000),
    },
  };
}

async function semRetrato(KV, historico) {
  const agora = Date.now();
  let atual = {};
  try { atual = JSON.parse((KV && await KV.get('last_status')) || '{}') || {}; } catch { atual = {}; }
  const linha = linhaDoTempo(historico && !historico.erro ? historico.entries : [], atual, agora);
  return {
    status: null,
    latencia: await resumoLatencia(KV),
    barras: KV ? barrasHorarias(linha) : { erro: 'STATUS_KV ausente — sem histórico para desenhar' },
    uptime: KV ? {
      fonte: 'transicoes',
      h24: uptimeTransicoes(linha, agora - 24 * 3600_000),
      h48: uptimeTransicoes(linha, agora - 48 * 3600_000),
    } : null,
  };
}

export async function montarPainel(context) {
  const KV = context.env.STATUS_KV;
  const DB = context.env.STATUS_DB;
  const [terceiros, cotas, historico] = await Promise.all([
    secao('terceiros', () => verificarTerceiros(context)),
    secao('cotas', () => lerCotas(context)),
    secao('historico', () => resumoHistorico(KV)),
  ]);

  let serie = null;
  let retratoCompartilhado = false;
  if (DB) {
    try { serie = await comRetrato(context, DB); retratoCompartilhado = true; }
    catch (e) { console.error('painel: D1 não respondeu; usando o KV', e); }
  }
  if (!serie) serie = await secao('serie', () => semRetrato(KV, historico));

  return {
    status: serie.status ?? null,
    terceiros, cotas, historico,
    latencia: serie.latencia ?? { erro: 'não foi possível ler agora' },
    barras: serie.barras ?? { erro: 'não foi possível ler agora' },
    uptime: serie.uptime ?? null,
    // A página decide por aqui se ainda precisa chamar /api/status.
    retratoCompartilhado,
    geradoEm: new Date().toISOString(),
  };
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
