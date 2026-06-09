export const SERVICES = [
  { name: 'lucafchala.com',    url: 'https://lucafchala.com' },
  { name: 'Rádio',             url: 'https://radio.lucafchala.com' },
  { name: 'Fotos',             url: 'https://fotos.lucafchala.com' },
  { name: 'Fotos — Dashboard', url: 'https://fotos.lucafchala.com/dashboard' },
  { name: 'Dash',              url: 'https://dash.lucafchala.com' },
  { name: 'Paste',             url: 'https://paste.lucafchala.com' },
  { name: 'URL',               url: 'https://url.lucafchala.com' },
  { name: 'Keys',              url: 'https://keys.lucafchala.com' },
  { name: 'Proof',             url: 'https://proof.lucafchala.com' },
];

const TIMEOUT_MS  = 10000;
const DEGRADED_MS = 2500;

async function checkOne(svc) {
  const start = Date.now();
  try {
    const res = await fetch(svc.url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    res.body?.cancel(); // discard body — we only need the status code
    const rt = Date.now() - start;
    let status;
    if      (res.status >= 500) status = 'down';
    else if (res.status >= 400) status = 'degraded';
    else                        status = rt > DEGRADED_MS ? 'degraded' : 'up';
    return { name: svc.name, url: svc.url, status, statusCode: res.status, rt };
  } catch {
    return { name: svc.name, url: svc.url, status: 'down', statusCode: null, rt: Date.now() - start };
  }
}

// Pure check — zero KV operations.
// Change detection and notifications are handled client-side via localStorage.
// Edge-cached for 30 s so concurrent viewers share one upstream sweep per colo
// instead of fanning out 9 fetches per tab per minute.
export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(context.request.url);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const services = await Promise.all(SERVICES.map(checkOne));
  const res = new Response(JSON.stringify({ services, checkedAt: new Date().toISOString() }), {
    // s-maxage caches at the edge only; max-age=0 keeps browsers revalidating
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=0, s-maxage=30' },
  });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
