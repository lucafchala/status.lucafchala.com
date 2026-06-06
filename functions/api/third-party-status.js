const SERVICES = [
  { name: 'GitHub',       api: 'https://www.githubstatus.com/api/v2/status.json',     page: 'https://www.githubstatus.com' },
  { name: 'Cloudflare',   api: 'https://www.cloudflarestatus.com/api/v2/status.json', page: 'https://www.cloudflarestatus.com' },
  { name: 'Claude',       api: 'https://status.anthropic.com/api/v2/status.json',     page: 'https://status.anthropic.com' },
  { name: 'Resend',       api: 'https://status.resend.com/api/v2/status.json',        page: 'https://status.resend.com' },
  { name: 'Google Drive', api: 'https://www.googlecloudstatus.com/api/v2/status.json', page: 'https://workspace.google.com/status' },
  { name: 'Google Fonts', api: null, url: 'https://fonts.googleapis.com',             page: 'https://status.cloud.google.com' },
];

function indicatorToStatus(indicator) {
  if (!indicator || indicator === 'none') return 'up';
  if (indicator === 'minor') return 'degraded';
  return 'down';
}

async function checkOne(svc) {
  if (svc.api) {
    try {
      const res = await fetch(svc.api, { signal: AbortSignal.timeout(8000) });
      const json = await res.json();
      return {
        name: svc.name,
        page: svc.page,
        status: indicatorToStatus(json?.status?.indicator),
        description: json?.status?.description || '',
      };
    } catch {
      return { name: svc.name, page: svc.page, status: 'down', description: '' };
    }
  } else {
    try {
      await fetch(svc.url, { signal: AbortSignal.timeout(8000) });
      return { name: svc.name, page: svc.page, status: 'up', description: '' };
    } catch {
      return { name: svc.name, page: svc.page, status: 'down', description: '' };
    }
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
