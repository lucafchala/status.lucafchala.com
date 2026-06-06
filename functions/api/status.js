const SERVICES = [
  { name: 'lucafchala.com',    url: 'https://lucafchala.com' },
  { name: 'Rádio',             url: 'https://radio.lucafchala.com' },
  { name: 'Fotos',             url: 'https://fotos.lucafchala.com' },
  { name: 'Fotos — Dashboard', url: 'https://fotos.lucafchala.com/dashboard' },
  { name: 'Dash',              url: 'https://dash.lucafchala.com' },
  { name: 'Now',               url: 'https://now.lucafchala.com' },
  { name: 'Paste',             url: 'https://paste.lucafchala.com' },
  { name: 'Weblog',            url: 'https://weblog.lucafchala.com' },
  { name: 'URL',               url: 'https://url.lucafchala.com' },
];

const TIMEOUT_MS = 10000;
const DEGRADED_MS = 2500;

async function checkOne(svc) {
  const start = Date.now();
  try {
    const res = await fetch(svc.url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const rt = Date.now() - start;
    // treat any HTTP response (including 4xx) as reachable
    const status = rt > DEGRADED_MS ? 'degraded' : 'up';
    return { name: svc.name, url: svc.url, status, statusCode: res.status, rt };
  } catch (e) {
    const rt = Date.now() - start;
    return { name: svc.name, url: svc.url, status: 'down', statusCode: null, rt };
  }
}

export async function onRequestGet() {
  const services = await Promise.all(SERVICES.map(checkOne));
  return new Response(JSON.stringify({ services, checkedAt: new Date().toISOString() }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
