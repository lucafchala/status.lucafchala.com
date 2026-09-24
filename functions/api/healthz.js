// Liveness + config probe.
//
// Público, só diz que a Function responde: `{ ok: true }`. Os booleanos de
// configuração e a contagem de inscritos contavam a qualquer um quais segredos
// faltavam e quanta gente está na lista — reconhecimento de graça. Eles saem
// para quem manda `X-Status-Token` igual ao segredo STATUS_ADMIN_TOKEN (o
// próprio painel lê a configuração do ambiente e não precisa disto).

function tokenConfere(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const HEADERS = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };

export async function onRequestGet({ request, env }) {
  if (!tokenConfere(request.headers.get('X-Status-Token'), env.STATUS_ADMIN_TOKEN)) {
    return new Response(JSON.stringify({ ok: true }), { headers: HEADERS });
  }

  let kvOk = false;
  let subscribers = null;
  let pendingAlerts = null;
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
      // Alertas que o Resend recusou e aguardam nova tentativa (status.js).
      try { const p = JSON.parse(await env.STATUS_KV.get('alert_pending') || '[]'); pendingAlerts = Array.isArray(p) ? p.length : null; } catch { pendingAlerts = null; }
    }
  } catch { kvOk = false; }

  return new Response(JSON.stringify({
    ok: true,
    kv: kvOk,
    resendKey: !!env.RESEND_API_KEY,
    notifyTo: !!env.NOTIFY_TO,
    subscribers,
    pendingAlerts,
    turnstile: !!(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY),
    // Whether account-wide quota + certificate monitoring is wired at all.
    cloudflareApi: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID),
  }), { headers: HEADERS });
}
