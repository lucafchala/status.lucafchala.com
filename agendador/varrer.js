// A varredura pedida pelo agendador. Mora fora do index.js porque o módulo de
// ENTRADA de um Worker só pode exportar handlers e classes: um `export const`
// lá derruba o workerd na inicialização ("Incorrect type for map entry") — a
// mesma armadilha que o fotos registra para o src/index.js dele. Pego rodando
// o handler `scheduled` no workerd local (`wrangler dev --test-scheduled`); o
// teste em Node importava o módulo e passava.

// O domínio próprio primeiro: é o caminho que o público usa. O endereço
// pages.dev do mesmo projeto é a segunda tentativa — se uma regra de WAF ou de
// bot na zona passar a barrar o agendador, a varredura continua saindo (e o
// log diz qual dos dois respondeu).
export const ALVOS = [
  'https://status.lucafchala.com/api/status?source=cloudflare-cron',
  'https://status-lucafchala-com.pages.dev/api/status?source=cloudflare-cron',
];
// Uma varredura leva de 2 a 10 s (timeout de 10 s por sonda, em paralelo).
export const TIMEOUT_MS = 45_000;

export async function varrer(fetchImpl = fetch) {
  const falhas = [];
  for (const alvo of ALVOS) {
    try {
      const res = await fetchImpl(alvo, {
        headers: { 'User-Agent': 'status-agendador (Cloudflare Cron Trigger)', Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const origem = res.headers.get('X-Sweep-Source');
      const idade = res.headers.get('X-Sweep-Age-Ms');
      await res.body?.cancel();
      if (res.ok) {
        return { alvo, status: res.status, origem, idadeMs: idade == null ? null : Number(idade), falhas };
      }
      falhas.push(`${new URL(alvo).host}: HTTP ${res.status}`);
    } catch (e) {
      falhas.push(`${new URL(alvo).host}: ${e && e.name === 'TimeoutError' ? 'timeout' : (e && e.message) || 'erro'}`);
    }
  }
  throw new Error(`nenhum alvo varreu — ${falhas.join(' · ')}`);
}
