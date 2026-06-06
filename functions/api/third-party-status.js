// GitHub, Cloudflare, Anthropic → confirmed Atlassian Statuspage JSON API
// Resend → try Atlassian API first; fall back to connectivity check if not available
// Google → Google Cloud Status JSON (different format)
const SERVICES = [
  { name: 'GitHub',       api: 'https://www.githubstatus.com/api/v2/status.json',     page: 'https://www.githubstatus.com' },
  { name: 'Cloudflare',   api: 'https://www.cloudflarestatus.com/api/v2/status.json', page: 'https://www.cloudflarestatus.com' },
  { name: 'Claude',       api: 'https://status.anthropic.com/api/v2/status.json',     page: 'https://status.anthropic.com' },
  { name: 'Resend',       api: 'https://status.resend.com/api/v2/status.json', fallbackUrl: 'https://resend.com', page: 'https://status.resend.com' },
  { name: 'Google Drive', googleCloud: true, product: 'Google Drive',                 page: 'https://workspace.google.com/status' },
  { name: 'Google Fonts', googleCloud: true, product: 'Google Fonts',                 page: 'https://status.cloud.google.com' },
];

const GOOGLE_STATUS_URL = 'https://status.cloud.google.com/incidents.json';

function atlassianStatus(json) {
  const ind = json?.status?.indicator;
  const description = json?.status?.description || '';
  if (!ind || ind === 'none') return { status: 'up', description };
  if (ind === 'minor') return { status: 'degraded', description };
  return { status: 'down', description };
}

let googleCache = null;
let googleCacheAt = 0;

async function fetchGoogleCloud() {
  // cache within the same request batch (invocation-scoped)
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
  // incidents.json lists currently active incidents; filter by affected product
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
    const status = res.status >= 500 ? 'down' : 'up';
    return { name, page, status, description: '' };
  } catch {
    return { name, page, status: 'down', description: '' };
  }
}

async function checkOne(svc) {
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
    // If API doesn't exist or returns non-JSON, fall back to connectivity
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

export async function onRequestGet() {
  const results = await Promise.all(SERVICES.map(checkOne));
  return new Response(JSON.stringify({ services: results }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
