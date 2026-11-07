// Aviso de lançamento de álbum do fotos: a faixa azul no topo desta página.
//
// Nos outros sites a faixa vem de um script do fotos (/destaque.js), que lê
// https://fotos.lucafchala.com/api/destaque direto do navegador. Aqui isso não
// pode: a CSP é `script-src 'self'` e `connect-src 'self'`, sem origem de
// terceiro (tests/pagina.test.mjs). Então quem pergunta ao fotos é ESTA
// função, do lado do servidor, e a página desenha a faixa com o próprio app.js,
// lendo /api/destaque da mesma origem.
//
// O que chega do fotos é tratado como dado de fora: só passam os quatro campos
// que a faixa usa, com tamanho limitado, e o link só para um endereço de
// álbum conhecido (HOSTS_DE_ALBUM). Qualquer coisa fora disso, fotos fora do
// ar ou demorando: `{ ativo: false }` — a página só não mostra a faixa.
//
// Antes do lançamento o fotos já responde `{ ativo: false }`: nada aparece
// até o dono lançar o álbum e marcar "Destaque máximo no site" no painel.

export const DESTAQUE_FONTE = 'https://fotos.lucafchala.com/api/destaque';
export const DESTAQUE_CACHE_S = 300;
// Domínio novo de álbum (DOMINIOS_DE_ALBUM no fotos) precisa entrar aqui,
// senão a faixa some calada para ele.
export const HOSTS_DE_ALBUM = new Set(['fotos.lucafchala.com', 'entrenos2026.com']);
const INATIVO = Object.freeze({ ativo: false });

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': `public, max-age=${DESTAQUE_CACHE_S}, s-maxage=${DESTAQUE_CACHE_S}`,
};

const texto = (v, max) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Só o que a faixa desenha, conferido. */
export function limpaDestaque(d) {
  if (!d || typeof d !== 'object' || d.ativo !== true) return INATIVO;
  const slug = typeof d.slug === 'string' && /^[a-z0-9-]{1,60}$/.test(d.slug) ? d.slug : '';
  const titulo = texto(d.titulo, 80);
  const linha = texto(d.linha, 80);
  let url;
  try { url = new URL(String(d.url)); } catch { return INATIVO; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS_DE_ALBUM.has(url.hostname)) return INATIVO;
  if (!slug || !titulo) return INATIVO;
  return { ativo: true, slug, titulo, linha, url: url.href };
}

export async function lerDestaque() {
  try {
    const r = await fetch(DESTAQUE_FONTE, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
      cf: { cacheTtl: DESTAQUE_CACHE_S },
    });
    if (!r.ok) { console.error('destaque: fotos respondeu', r.status); return INATIVO; }
    return limpaDestaque(await r.json());
  } catch (e) {
    console.error('destaque: fotos não respondeu', e);
    return INATIVO;
  }
}

export async function onRequestGet(context) {
  const cache = caches.default;
  // Chave fixa: nenhuma query fura o cache (mesma regra do /api/resumo).
  const cacheKey = new Request(new URL(context.request.url).origin + '/api/destaque');
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const res = new Response(JSON.stringify(await lerDestaque()), { headers: HEADERS });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
