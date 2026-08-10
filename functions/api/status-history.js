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

export async function onRequestGet(context) {
  const KV = context.env.STATUS_KV;

  if (!KV) {
    return json({
      available: false,
      detail: 'STATUS_KV ausente — histórico não é registrado',
      entries: [], services: {}, checkedAt: new Date().toISOString(),
    });
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

  return json({
    available: true,
    windowHours: HISTORY_WINDOW_MS / 3600_000,
    entries,
    services: summarize(entries),
    flapping,
    worstSeverity: entries.reduce((acc, e) => (RANK[e.to] > RANK[acc] ? e.to : acc), 'up'),
    checkedAt: new Date().toISOString(),
  });
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      // Short edge cache: the log only changes on a real transition, but the
      // dashboard polls this alongside /api/status every 60 s.
      'Cache-Control': 'public, max-age=0, s-maxage=30',
    },
  });
}
