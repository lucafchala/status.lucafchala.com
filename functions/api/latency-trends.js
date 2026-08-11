// Tendência de tempo de resposta por serviço.
//
// O dashboard mostra a latência do instante em que a varredura rodou. Isso
// responde "está lento agora?", mas não responde a pergunta que costuma vir
// antes de um incidente: "está ficando lento?". Um serviço que saiu de 300ms
// para 1800ms continua verde — está dentro do orçamento de DEGRADED_MS — e
// mesmo assim é o aviso mais antecipado que existe de que algo vai quebrar.
//
// Nada aqui faz medição nova: `rt` já é medido em probePrimary() a cada
// varredura e simplesmente era descartado depois de virar texto na tela. Este
// módulo só o guarda.
//
// ORÇAMENTO DE ESCRITA — a restrição que define o desenho:
// a varredura roda de 5 em 5 minutos (288/dia) e as escritas em KV são o limite
// mais apertado do plano gratuito (1000/dia, compartilhado com o site de fotos).
// Gravar a cada varredura custaria 288 escritas/dia, ~29% da cota inteira, para
// uma série temporal que ninguém olha nesse detalhe. Por isso a amostra é
// gravada no máximo a cada 30 minutos: 48 escritas/dia (~5% da cota) e ainda
// assim 96 pontos por janela de 48h, de sobra para enxergar tendência.

export const LATENCY_KEY = 'latency';
export const LATENCY_WINDOW_MS = 48 * 3600_000; // mesma janela do histórico
export const LATENCY_INTERVAL_MS = 30 * 60_000; // cadência mínima entre gravações
export const LATENCY_MAX = 96;                  // 48h ÷ 30min — limita o tamanho do valor

// Recorta por janela e por quantidade, mais novo primeiro. Exportado para que o
// escritor (em /api/status) e o leitor (aqui) nunca discordem sobre o formato.
export function trimLatency(entries, now = Date.now()) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => e && typeof e.at === 'string' && e.rt && typeof e.rt === 'object')
    .filter((e) => {
      const t = new Date(e.at).getTime();
      return Number.isFinite(t) && now - t <= LATENCY_WINDOW_MS;
    })
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, LATENCY_MAX);
}

export async function readLatency(KV) {
  if (!KV) return [];
  try {
    const raw = await KV.get(LATENCY_KEY);
    return trimLatency(raw ? JSON.parse(raw) : []);
  } catch {
    // Um valor corrompido não pode derrubar o endpoint junto: série vazia lê
    // como "ainda não há amostras", que é a interpretação segura.
    return [];
  }
}

// Decide se já passou tempo suficiente desde a última amostra usando apenas
// tempo — zero KV reads. A varredura roda a cada 5 min (288/dia); com amostras
// a cada 30 min (48/dia), qualquer hora X do dia sempre produz amostra se
// (X % 30min) < 5min. Fico ao lado do custo porque essa *é* a regra de cadência.
export function shouldSample(now = Date.now()) {
  // Que múltiplo de 30min o relógio passou? Se é o primeiro de cada período
  // (primeiros 5 min em que a varredura roda), amostrar.
  return (now % LATENCY_INTERVAL_MS) < 5 * 60_000;
}

// Monta a amostra a partir dos serviços da varredura. Só entra quem tem `rt`
// numérico: um serviço que caiu por erro de rede tem tempo de resposta que mede
// o timeout, não o serviço, e poluiria a mediana com o valor do nosso próprio
// limite em vez do desempenho real.
export function buildSample(services, now = Date.now()) {
  const rt = {};
  for (const s of services) {
    if (s && typeof s.rt === 'number' && Number.isFinite(s.rt) && s.rt >= 0 && s.status !== 'down') {
      rt[s.name] = Math.round(s.rt);
    }
  }
  return Object.keys(rt).length ? { at: new Date(now).toISOString(), rt } : null;
}

// Percentil por interpolação do índice mais próximo. Com ~96 amostras não
// compensa nada mais sofisticado.
function percentile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

// Compara a metade mais recente da janela com a mais antiga. É o que transforma
// a série num sinal acionável: não "quanto está", mas "para onde está indo".
function trendOf(recent, older) {
  if (!recent.length || !older.length) return { direction: 'sem dados', deltaPct: null };
  const a = percentile(recent.slice().sort((x, y) => x - y), 0.5);
  const b = percentile(older.slice().sort((x, y) => x - y), 0.5);
  if (!b) return { direction: 'sem dados', deltaPct: null };
  const deltaPct = Math.round(((a - b) / b) * 100);
  // ±15% absorve o ruído normal de rede entre varreduras; abaixo disso, chamar
  // de tendência seria inventar sinal onde só há variação.
  const direction = deltaPct > 15 ? 'piorando' : deltaPct < -15 ? 'melhorando' : 'estável';
  return { direction, deltaPct };
}

export function summarize(entries) {
  const byService = new Map();
  // entries vem mais novo primeiro; preserva essa ordem por serviço para que a
  // divisão recente/antigo abaixo continue significando o que diz.
  for (const e of entries) {
    for (const [name, ms] of Object.entries(e.rt)) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
      if (!byService.has(name)) byService.set(name, []);
      byService.get(name).push(ms);
    }
  }

  const out = {};
  for (const [name, series] of byService) {
    const sorted = series.slice().sort((a, b) => a - b);
    const half = Math.floor(series.length / 2);
    out[name] = {
      samples: series.length,
      last: series[0],
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      // Precisa de duas metades povoadas para comparar; com menos de 4 amostras
      // qualquer "tendência" seria ruído com aparência de dado.
      trend: series.length >= 4
        ? trendOf(series.slice(0, half), series.slice(half))
        : { direction: 'sem dados', deltaPct: null },
    };
  }
  return out;
}

export async function onRequestGet(context) {
  const KV = context.env.STATUS_KV;

  if (!KV) {
    return json({
      available: false,
      detail: 'STATUS_KV ausente — latência não é registrada',
      entries: [], services: {}, checkedAt: new Date().toISOString(),
    });
  }

  const entries = await readLatency(KV);
  const services = summarize(entries);

  // Quem está piorando vem primeiro: é a lista que serve para agir.
  const worsening = Object.entries(services)
    .filter(([, v]) => v.trend.direction === 'piorando')
    .map(([name, v]) => ({ name, deltaPct: v.trend.deltaPct, p50: v.p50 }))
    .sort((a, b) => b.deltaPct - a.deltaPct);

  return json({
    available: true,
    windowHours: LATENCY_WINDOW_MS / 3600_000,
    intervalMinutes: LATENCY_INTERVAL_MS / 60_000,
    samples: entries.length,
    services,
    worsening,
    // A série crua acompanha para o dashboard poder desenhar sparkline sem uma
    // segunda ida ao servidor.
    entries,
    checkedAt: new Date().toISOString(),
  });
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      // A série só muda a cada 30 min; cache de borda mais longo que o do
      // /api/status, que reflete estado instantâneo.
      'Cache-Control': 'public, max-age=0, s-maxage=120',
    },
  });
}
