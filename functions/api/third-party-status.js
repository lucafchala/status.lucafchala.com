// GitHub, Anthropic → Atlassian Statuspage JSON API
// Cloudflare → Atlassian components API filtered to Brazil (GRU/São Paulo) PoPs
// Resend → try Atlassian API first; fall back to connectivity check
// Google Drive → Google Workspace Status Dashboard (incidents.json)
//
// "Sem dados" (`unknown`) é a resposta honesta quando a página de status do
// provedor não respondeu ou respondeu algo ilegível: não sabemos. Antes isso
// virava verde (403/404/JSON inválido) ou vermelho (timeout) — os dois
// afirmavam algo que ninguém verificou.
//
// Google Fonts saiu: o ecossistema hospeda as próprias fontes. Drive continua
// porque o fotos entrega as fotos por links do Drive — mas pelo feed do
// Workspace, que é onde o Drive aparece (o feed do Google Cloud não o cobre).
const SERVICES = [
  { name: 'GitHub',       api: 'https://www.githubstatus.com/api/v2/status.json',     page: 'https://www.githubstatus.com' },
  { name: 'Cloudflare',   cloudflare: true,                                            page: 'https://www.cloudflarestatus.com' },
  { name: 'Claude',       api: 'https://status.anthropic.com/api/v2/status.json',     page: 'https://status.anthropic.com' },
  { name: 'Resend',       api: 'https://status.resend.com/api/v2/status.json', fallbackUrl: 'https://resend.com', page: 'https://status.resend.com' },
  { name: 'Google Drive', google: 'https://www.google.com/appsstatus/dashboard/incidents.json', product: 'Google Drive', page: 'https://www.google.com/appsstatus/dashboard/' },
];

// Atlassian component status → our status
export function componentStatus(status) {
  if (!status || status === 'operational') return 'up';
  if (status === 'degraded_performance' || status === 'partial_outage' || status === 'under_maintenance') return 'degraded';
  if (status === 'major_outage') return 'down';
  return 'unknown';
}

// `maintenance` é o indicador de manutenção em andamento: não é incidente, mas
// também não é "tudo normal" para quem depende do serviço naquele momento.
export function atlassianStatus(json) {
  const ind = json?.status?.indicator;
  const description = json?.status?.description || '';
  if (ind === 'none') return { status: 'up', description };
  if (ind === 'minor' || ind === 'maintenance') return { status: 'degraded', description };
  if (ind === 'major' || ind === 'critical') return { status: 'down', description };
  return { status: 'unknown', description: 'resposta sem indicador' };
}

// Filter Cloudflare components to Brazil PoPs (GRU = São Paulo)
async function checkCloudflare() {
  const res = await fetch('https://www.cloudflarestatus.com/api/v2/components.json', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) { res.body?.cancel(); return { status: 'unknown', description: `HTTP ${res.status}` }; }
  const json = await res.json();
  const components = json?.components;
  if (!Array.isArray(components)) return { status: 'unknown', description: 'resposta ilegível' };

  // Match Brazil data centers: name contains "Brazil", "GRU", or "São Paulo"
  const brazil = components.filter(c => {
    const n = (c.name || '').toLowerCase();
    return n.includes('brazil') || n.includes('gru') || n.includes('são paulo') || n.includes('sao paulo');
  });

  if (brazil.length === 0) {
    // No Brazil-specific components found; fall back to overall status
    return { ...atlassianStatus({ status: { indicator: json?.status?.indicator } }), description: 'Brazil PoP data unavailable' };
  }

  // Worst status among matched Brazil components
  let worst = 'up';
  for (const c of brazil) {
    const mapped = componentStatus(c.status);
    if (mapped === 'down') { worst = 'down'; break; }
    if (mapped === 'degraded') worst = 'degraded';
  }

  const affected = brazil.filter(c => c.status !== 'operational');
  const description = affected.length === 0
    ? 'All Brazil PoPs Operational'
    : affected.map(c => c.name).join(', ');

  return { status: worst, description };
}

// Os feeds do Google (Cloud e Workspace) listam incidentes ANTIGOS também; o
// que ainda está aberto é o que não tem `end`. Sem esse filtro, qualquer
// incidente dos últimos meses deixava a linha vermelha para sempre.
export function googleStatus(incidents, product) {
  if (!Array.isArray(incidents)) return { status: 'unknown', description: 'resposta ilegível' };
  const alvo = product.toLowerCase();
  const active = incidents.filter(inc => {
    if (!inc || inc.end) return false;
    const affected = (inc.affected_products || []).map(p => (p.title || '').toLowerCase());
    return affected.includes(alvo);
  });
  if (active.length === 0) return { status: 'up', description: 'Sem incidentes abertos' };
  // status_impact: SERVICE_INFORMATION | SERVICE_DISRUPTION | SERVICE_OUTAGE
  const pior = active.some(i => i.status_impact === 'SERVICE_OUTAGE' || i.severity === 'high') ? 'down' : 'degraded';
  const titulo = String(active[0].external_desc || 'Incidente em andamento')
    .replace(/\*\*Title:\*\*\s*/i, '').split('\n').map(l => l.trim()).find(Boolean) || 'Incidente em andamento';
  return { status: pior, description: titulo.slice(0, 140) };
}

async function checkGoogle(url, product) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) { res.body?.cancel(); return { status: 'unknown', description: `HTTP ${res.status}` }; }
  let incidents;
  try { incidents = JSON.parse(await res.text()); } catch { return { status: 'unknown', description: 'resposta ilegível' }; }
  return googleStatus(incidents, product);
}

async function connectivityCheck(url, name, page) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    res.body?.cancel();
    return { name, page, status: res.status >= 500 ? 'down' : 'up', description: 'página de status indisponível; site responde' };
  } catch {
    return { name, page, status: 'unknown', description: 'sem resposta' };
  }
}

export async function checkOne(svc) {
  const base = { name: svc.name, page: svc.page };
  try {
    if (svc.cloudflare) return { ...base, ...(await checkCloudflare()) };
    if (svc.google) return { ...base, ...(await checkGoogle(svc.google, svc.product)) };

    const res = await fetch(svc.api, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      res.body?.cancel();
      if (svc.fallbackUrl) return connectivityCheck(svc.fallbackUrl, svc.name, svc.page);
      return { ...base, status: 'unknown', description: `HTTP ${res.status}` };
    }
    let json;
    try { json = JSON.parse(await res.text()); } catch {
      if (svc.fallbackUrl) return connectivityCheck(svc.fallbackUrl, svc.name, svc.page);
      return { ...base, status: 'unknown', description: 'resposta ilegível' };
    }
    return { ...base, ...atlassianStatus(json) };
  } catch {
    if (svc.fallbackUrl) return connectivityCheck(svc.fallbackUrl, svc.name, svc.page);
    return { ...base, status: 'unknown', description: 'sem resposta' };
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
