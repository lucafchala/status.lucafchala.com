export async function onRequestGet(context) {
  const KV = context.env.STATUS_KV;
  if (!KV) {
    return new Response(JSON.stringify({ incidents: [] }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    });
  }

  let incidents = [];
  try {
    incidents = JSON.parse(await KV.get('incidents') || '[]') || [];
  } catch { incidents = []; }
  if (!Array.isArray(incidents)) incidents = [];

  // Most recent 20, most recent first
  const recent = incidents.slice(-20).reverse();

  return new Response(JSON.stringify({ incidents: recent }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=0, s-maxage=30',
    },
  });
}
