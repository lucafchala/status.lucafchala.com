// Recent status transitions, so a green dashboard still tells you what happened.
//
// The dashboard is memoryless by design: it shows what is true *now*. That
// leaves the most common question unanswered — "is this a new problem, or the
// same one from an hour ago?" — and hides flapping entirely, since a service
// that fails every ten minutes looks perfectly healthy between sweeps.
//
// The log is written by /api/status inside the block that already detects a
// change, so it costs one extra KV write per real transition and nothing at all
// in steady state (KV writes are the account-wide 1k/day free-tier limit).

export const HISTORY_KEY = 'history';
export const HISTORY_WINDOW_MS = 48 * 3600_000; // matches what the dashboard shows
export const HISTORY_MAX = 60;                  // bounds the value's size in KV

const RANK = { up: 0, degraded: 1, down: 2 };

// Newest-first, window-trimmed, size-capped. Exported so the writer in
// /api/status and this reader can never disagree about the shape.
export function trimHistory(entries, now = Date.now()) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(e => e && typeof e.at === 'string' && typeof e.name === 'string')
    .filter(e => {
      const t = new Date(e.at).getTime();
      return Number.isFinite(t) && now - t <= HISTORY_WINDOW_MS;
    })
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, HISTORY_MAX);
}

export async function readHistory(KV) {
  if (!KV) return [];
  try {
    const raw = await KV.get(HISTORY_KEY);
    return trimHistory(raw ? JSON.parse(raw) : []);
  } catch {
    // A corrupt value must not take the endpoint down with it — an empty log
    // reads as "nothing recorded", which is the safe interpretation.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Linha do tempo reconstruída do log — as barras e o uptime SEM o D1
// ---------------------------------------------------------------------------
// Com o retrato em D1 (retrato.js), barras e uptime saem da contagem de cada
// varredura. Sem ele, ainda dá para desenhar 48 barras horárias a custo ZERO:
// o estado atual (`last_status`) mais as transições deste log determinam o
// estado de cada serviço em cada instante da janela — andando para trás, antes
// de cada transição o estado era o `from` dela.
//
// Duas honestidades:
//   • o log tem teto (HISTORY_MAX). Se encheu, antes da entrada mais antiga não
//     se sabe nada — e esse trecho sai como "sem dado", não como verde;
//   • é o estado REGISTRADO, amostrado pelas varreduras. Uma queda que começou
//     e acabou entre duas varreduras não existe para este log (nem para o D1).
export const BARRAS_HORAS = 48;
const HORA_MS = 3600_000;

export function linhaDoTempo(entries, atual, agora = Date.now(), janela = HISTORY_WINDOW_MS) {
  const inicio = agora - janela;
  const cronologicas = Array.isArray(entries) ? entries : [];
  const cortado = cronologicas.length >= HISTORY_MAX;
  const limite = cortado
    ? Math.max(inicio, new Date(cronologicas[cronologicas.length - 1].at).getTime())
    : inicio;

  const nomes = new Set([...Object.keys(atual || {}), ...cronologicas.map((e) => e.name)]);
  const servicos = {};
  for (const nome of nomes) {
    const trans = cronologicas.filter((e) => e.name === nome); // mais nova primeiro
    const segs = [];
    let fim = agora;
    let estado = (atual && atual[nome]) || (trans[0] && trans[0].to) || null;
    for (const t of trans) {
      const at = new Date(t.at).getTime();
      if (!Number.isFinite(at) || at < limite) break;
      if (at < fim) segs.push({ de: at, ate: fim, estado });
      fim = Math.min(fim, at);
      estado = t.from || null;
    }
    if (fim > limite) segs.push({ de: limite, ate: fim, estado });
    servicos[nome] = segs.reverse();
  }
  return { inicio, limite, agora, servicos };
}

const PIOR = { up: 0, degraded: 1, down: 2 };

// Tempo fora do ar e tempo conhecido de um serviço num intervalo.
function medir(segs, de, ate) {
  let conhecido = 0, fora = 0, pior = null;
  for (const s of segs) {
    const a = Math.max(de, s.de), b = Math.min(ate, s.ate);
    if (b <= a || !s.estado || !(s.estado in PIOR)) continue;
    conhecido += b - a;
    if (s.estado === 'down') fora += b - a;
    if (pior == null || PIOR[s.estado] > PIOR[pior]) pior = s.estado;
  }
  return { conhecido, fora, pior };
}

// Mesmo formato normalizado que retrato.barrasDiarias devolve — a página
// desenha os dois sem saber de onde vieram.
export function barrasHorarias(linha, horas = BARRAS_HORAS) {
  const fimUltima = Math.floor(linha.agora / HORA_MS) * HORA_MS + HORA_MS;
  const periodos = [];
  for (let i = horas - 1; i >= 0; i--) {
    const de = fimUltima - (i + 1) * HORA_MS;
    periodos.push({ inicio: new Date(de).toISOString(), fim: new Date(de + HORA_MS).toISOString() });
  }
  const servicos = {};
  for (const [nome, segs] of Object.entries(linha.servicos)) {
    servicos[nome] = periodos.map((p) => {
      const m = medir(segs, Date.parse(p.inicio), Math.min(Date.parse(p.fim), linha.agora));
      if (!m.conhecido) return { estado: null, pct: null };
      return { estado: m.pior, pct: Math.round(((m.conhecido - m.fora) / m.conhecido) * 10000) / 100 };
    });
  }
  return { tipo: 'horario', fonte: 'transicoes', periodos, servicos };
}

// Disponibilidade ponderada pelo tempo — só sobre o tempo CONHECIDO.
export function uptimeTransicoes(linha, desde) {
  const out = {};
  for (const [nome, segs] of Object.entries(linha.servicos)) {
    const m = medir(segs, Math.max(desde, linha.limite), linha.agora);
    out[nome] = { pct: m.conhecido ? Math.round(((m.conhecido - m.fora) / m.conhecido) * 10000) / 100 : null };
  }
  return out;
}

// Per-service summary of the last incident: when it started, how long it took
// to recover, and whether it is still open. `entries` is newest-first, so a
// service's recovery is the *earlier* index and its onset the later one.
function summarize(entries) {
  const byService = new Map();

  for (const e of entries) {
    if (!byService.has(e.name)) byService.set(e.name, []);
    byService.get(e.name).push(e);
  }

  const out = {};
  for (const [name, list] of byService) {
    // list is newest-first. The most recent transition into a non-up state is
    // the onset of the last incident; anything newer that lands on 'up' closed it.
    const onsetIdx = list.findIndex(e => e.to !== 'up');
    if (onsetIdx === -1) {
      out[name] = { changes: list.length, lastIncident: null };
      continue;
    }
    const onset = list[onsetIdx];
    const recovery = list.slice(0, onsetIdx).reverse().find(e => e.to === 'up') || null;

    const startedAt = new Date(onset.at).getTime();
    const endedAt = recovery ? new Date(recovery.at).getTime() : null;

    out[name] = {
      changes: list.length,
      lastIncident: {
        severity: onset.to,
        startedAt: onset.at,
        endedAt: recovery ? recovery.at : null,
        resolved: !!recovery,
        durationMs: endedAt ? endedAt - startedAt : Date.now() - startedAt,
        agoMs: Date.now() - (endedAt ?? startedAt),
        problems: Array.isArray(onset.problems) ? onset.problems : [],
      },
    };
  }
  return out;
}

// Usada também pelo /api/painel. Devolve o objeto, não a Response.
export async function resumoHistorico(KV) {
  if (!KV) {
    return {
      available: false,
      detail: 'armazenamento não configurado — histórico não é registrado',
      entries: [], services: {}, checkedAt: new Date().toISOString(),
    };
  }

  const entries = await readHistory(KV);

  // Flapping is the failure mode a live dashboard hides best: a service that
  // recovers before you look at it reads as healthy every single time.
  const flapping = Object.entries(
    entries.reduce((acc, e) => { acc[e.name] = (acc[e.name] || 0) + 1; return acc; }, {}),
  )
    .filter(([, n]) => n >= 4)
    .map(([name, changes]) => ({ name, changes }))
    .sort((a, b) => b.changes - a.changes);

  return {
    available: true,
    windowHours: HISTORY_WINDOW_MS / 3600_000,
    entries,
    services: summarize(entries),
    flapping,
    worstSeverity: entries.reduce((acc, e) => (RANK[e.to] > RANK[acc] ? e.to : acc), 'up'),
    checkedAt: new Date().toISOString(),
  };
}

export async function onRequestGet(context) {
  return json(await resumoHistorico(context.env.STATUS_KV));
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      // Short edge cache: the log only changes on a real transition. (A página
      // lê o histórico pelo /api/painel; esta rota fica para quem a consulta
      // direto.)
      'Cache-Control': 'public, max-age=0, s-maxage=30',
    },
  });
}
