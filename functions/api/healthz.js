// Liveness + config probe — exposes only booleans so a missing binding or
// secret is discovered here instead of when a subscriber action fails.

export async function onRequestGet({ env }) {
  let kvOk = false;
  try {
    if (env.STATUS_KV) { await env.STATUS_KV.get('__healthz__'); kvOk = true; }
  } catch { kvOk = false; }

  return new Response(JSON.stringify({
    ok: true,
    kv: kvOk,
    resendKey: !!env.RESEND_API_KEY,
    notifyTo: !!env.NOTIFY_TO,
  }), {
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  });
}
