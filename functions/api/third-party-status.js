// GitHub, Anthropic → Atlassian Statuspage JSON API
// Cloudflare → Atlassian components API filtered to Brazil (GRU/São Paulo) PoPs
// Resend → try Atlassian API first; fall back to connectivity check
// Google → Google Cloud Status JSON (different format)
const SERVICES = [
  { name: 'GitHub',       api: 'https://www.githubstatus.com/api/v2/status.json',     page: 'https://www.githubstatus.com' },
  { name: 'Cloudflare',   cloudflare: true,                                            page: 'https://www.cloudflarestatus.com' },
  { name: 'Claude',       api: 'https://status.anthropic.com/api/v2/status.json',     page: 'https://status.anthropic.com' },
  { name: 'Resend',       api: 'https://status.resend.com/api/v2/status.json', fallbackUrl: 'https://resend.com', page: 'https://status.resend.com' },
  { name: 'Google Drive', googleCloud: true, product: 'Google Drive',                 page: 'https://workspace.google.com/status' },
  { name: 'Google Fonts', googleCloud: true, product: 'Google Fonts',                 page: 'https://status.cloud.google.com' },
];

const GOOGLE_STATUS_URL = 'https://status.cloud.google.com/incidents.json';

// Atlassian component status → our status
function componentStatus(status) {
  if (!status || status === 'operational') return 'up';
  if (status === 'degraded_performance' || status === 'partial_outage' || status === 'under_maintenance') return 'degraded';
  return 'down'; // major_outage
}

function atlassianStatus(json) {
  const ind = json?.status?.indicator;
  const description = json?.status?.description || '';
  if (!ind || ind === 'none') return { status: 'up', description };
  if (ind === 'minor') return { status: 'degraded', description };
  return { status: 'down', description };
}

// Filter Cloudflare components to Brazil PoPs (GRU = São Paulo)
async function checkCloudflare(page) {
  const res = await fetch('https://www.cloudflarestatus.com/api/v2/components.json', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const components = json?.components || [];

  // Match Brazil data centers: name contains "Brazil", "GRU", or "São Paulo"
  const brazil = components.filter(c => {
    const n = (c.name || '').toLowerCase();
    return n.includes('brazil') || n.includes('gru') || n.includes('são paulo') || n.includes('sao paulo');
  });

  if (brazil.length === 0) {
    // No Brazil-specific components found; fall back to overall status
    const overall = json?.page?.status_indicator || 'none';
    return { status: componentStatus(overall), description: 'Brazil PoP data unavailable' };
  }

  // Worst status among matched Brazil components
  const statuses = brazil.map(c => c.status);
  let worst = 'up';
  for (const s of statuses) {
    const mapped = componentStatus(s);
    if (mapped === 'down') { worst = 'down'; break; }
    if (mapped === 'degraded') worst = 'degraded';
  }

  const affected = brazil.filter(c => c.status !== 'operational');
  const description = affected.length === 0
    ? 'All Brazil PoPs Operational'
    : affected.map(c => c.name).join(', ');

  return { status: worst, description };
}

let googleCache = null;
let googleCacheAt = 0;

async function fetchGoogleCloud() {
  if (googleCache && Date.now() - googleCacheAt < 5000) return googleCache;
  const res = await fetch(GOOGLE_STATUS_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  googleCache = await res.json();
  googleCacheAt = Date.now();
  return googleCache;
}

function googleCloudStatus(incidents, product) {
  if (!Array.isArray(incidents)) return { status: 'up', description: 'All Systems Operational' };
  const active = incidents.filter(inc => {
    const affected = (inc.affected_products || []).map(p => (p.title || p.id || '').toLowerCase());
    return affected.some(p => p.includes(product.toLowerCase().split(' ')[1]));
  });
  if (active.length === 0) return { status: 'up', description: 'All Systems Operational' };
  const severity = active[0].severity || 'medium';
  return {
    status: severity === 'low' ? 'degraded' : 'down',
    description: active[0].external_desc || 'Service disruption',
  };
}

async function connectivityCheck(url, name, page) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return { name, page, status: res.status >= 500 ? 'down' : 'up', description: '' };
  } catch {
    return { name, page, status: 'down', description: '' };
  }
}

async function checkOne(svc) {
  if (svc.cloudflare) {
    try {
      const { status, description } = await checkCloudflare(svc.page);
      return { name: svc.name, page: svc.page, status, description };
    } catch {
      return { name: svc.name, page: svc.page, status: 'down', description: '' };
    }
  }
  if (svc.googleCloud) {
    try {
      const incidents = await fetchGoogleCloud();
      const { status, description } = googleCloudStatus(incidents, svc.product);
      return { name: svc.name, page: svc.page, status, description };
    } catch {
      return { name: svc.name, page: svc.page, status: 'down', description: '' };
    }
  }
  try {
    const res = await fetch(svc.api, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404 || res.status === 403) {
      if (svc.fallbackUrl) return connectivityCheck(svc.fallbackUrl, svc.name, svc.page);
      return { name: svc.name, page: svc.page, status: 'up', description: '' };
    }
    if (!res.ok) return { name: svc.name, page: svc.page, status: 'degraded', description: `HTTP ${res.status}` };
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      if (svc.fallbackUrl) return connectivityCheck(svc.fallbackUrl, svc.name, svc.page);
      return { name: svc.name, page: svc.page, status: 'up', description: '' };
    }
    const { status, description } = atlassianStatus(json);
    return { name: svc.name, page: svc.page, status, description };
  } catch {
    if (svc.fallbackUrl) return connectivityCheck(svc.fallbackUrl, svc.name, svc.page);
    return { name: svc.name, page: svc.page, status: 'down', description: '' };
  }
}

// Cache de borda de 2 min, compartilhado por colo. A página de status de um
// provedor muda na escala de minutos (é gente escrevendo um incidente), então
// 30 s só multiplicava as idas aos provedores sem mostrar nada mais novo.
//
// A chave é FIXA, não a URL do pedido: com a URL inteira, `?x=<aleatório>`
// furava o cache e cada pedido virava 5–6 fetches de saída — a mesma porta de
// amplificação que o /api/status fecha com o piso por isolate.
export const TERCEIROS_CACHE_S = 120;

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      // s-maxage caches at the edge only; max-age=0 keeps browsers revalidating
      'Cache-Control': `public, max-age=0, s-maxage=${TERCEIROS_CACHE_S}`,
    },
  });
}

// Usada também pelo /api/painel, que junta tudo o que a página lê numa
// chamada só. Devolve o objeto, não a Response, para poder ser composta.
export async function verificarTerceiros(context) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + '/api/third-party-status');
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const results = await Promise.all(SERVICES.map(checkOne));
  const body = { services: results, checkedAt: new Date().toISOString() };
  context.waitUntil(cache.put(cacheKey, json(body)));
  return body;
}

export async function onRequestGet(context) {
  return json(await verificarTerceiros(context));
}
