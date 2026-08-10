// Liveness + config probe — exposes only booleans and counts so a missing
// binding or secret is discovered here instead of when a subscriber action fails.

export async function onRequestGet({ env }) {
  let kvOk = false;
  let subscribers = null;
  try {
    if (env.STATUS_KV) {
      // One read that does double duty: it proves the binding answers AND
      // reports how many people would actually receive an alert. A subscriber
      // list that silently emptied looks identical to a healthy one from the
      // outside, right up until an outage goes unannounced.
      const raw = await env.STATUS_KV.get('subscribers');
      kvOk = true;
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        subscribers = Array.isArray(parsed) ? parsed.length : null;
      } catch {
        subscribers = null; // corrupt value — reported as unknown, not as zero
      }
    }
  } catch { kvOk = false; }

  return new Response(JSON.stringify({
    ok: true,
    kv: kvOk,
    resendKey: !!env.RESEND_API_KEY,
    notifyTo: !!env.NOTIFY_TO,
    subscribers,
    // Whether account-wide quota + certificate monitoring is wired at all.
    cloudflareApi: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID),
  }), {
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  });
}
