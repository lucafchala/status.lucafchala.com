// Cloudflare free-tier headroom + TLS certificate expiry for the account.
//
// Why this exists: the tightest limit on the free plan is 1,000 KV writes/day,
// and it is shared account-wide with the fotos site. Exhausting it doesn't fail
// loudly — writes simply start erroring — so the headroom has to be visible
// *before* it runs out. Same for KV storage, Workers requests and D1 rows.
//
// Everything here comes from the Cloudflare API, which needs a read-only token
// (Account Analytics:Read for the usage numbers; Zone:Read + SSL and
// Certificates:Read for the expiry dates). Without CF_API_TOKEN/CF_ACCOUNT_ID
// the endpoint answers `configured: false` and the dashboard hides the panel —
// it never guesses a number it cannot measure.
//
// Not tracked, on purpose:
//   • Bandwidth — Cloudflare Pages serves static assets with *unlimited*
//     bandwidth on the free plan, so there is no quota to report.
//   • Pages builds (500/month) — counting them means paginating every
//     deployment of every project on every sweep; the cost isn't worth a limit
//     a personal site never approaches.

const CF_API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 8000;

// Free-plan limits. `period: 'dia'` resets at UTC midnight (which is why the
// daily window below is computed in UTC, not America/Sao_Paulo).
const GB = 1024 ** 3;
const LIMITS = {
  kvWrites:       { limit: 1000,    period: 'dia',   label: 'KV · escritas' },
  kvReads:        { limit: 100000,  period: 'dia',   label: 'KV · leituras' },
  kvDeletes:      { limit: 1000,    period: 'dia',   label: 'KV · exclusões' },
  kvLists:        { limit: 1000,    period: 'dia',   label: 'KV · listagens' },
  kvStorage:      { limit: 1 * GB,  period: 'total', label: 'KV · armazenamento', bytes: true },
  workerRequests: { limit: 100000,  period: 'dia',   label: 'Workers · requisições' },
  d1RowsRead:     { limit: 5000000, period: 'dia',   label: 'D1 · linhas lidas' },
  d1RowsWritten:  { limit: 100000,  period: 'dia',   label: 'D1 · linhas escritas' },
  d1Storage:      { limit: 5 * GB,  period: 'total', label: 'D1 · armazenamento', bytes: true },
};

// A quota is worth acting on well before it's gone: at 75% there's still a day
// to shed load, at 95% the next sweep may already be failing writes.
const WARN_PCT = 75;
const CRIT_PCT = 95;

// A certificate inside this window is a real risk — Universal SSL renews
// automatically, so anything this close to expiry means renewal is stuck.
const CERT_WARN_DAYS = 30;

// `unknown` ranks with `up` so a dataset we couldn't read never *raises* the
// overall status — but it is kept distinct so the row can say "sem dados"
// instead of showing a reassuring green it hasn't earned.
const RANK = { unknown: 0, up: 0, degraded: 1, down: 2 };

function utcDayWindow() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    since: start.toISOString(),
    until: now.toISOString(),
    sinceDate: start.toISOString().slice(0, 10),
    untilDate: now.toISOString().slice(0, 10),
  };
}

function cfFetch(path, token) {
  return fetch(CF_API + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(r => r.json());
}

// Each dataset is queried separately: the GraphQL API fails a whole document
// when any one field is unavailable for the plan, so isolating them means a
// dataset we can't read costs us that row only, not the entire panel.
async function gql(token, accountTag, query, variables) {
  const res = await fetch(CF_API + '/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { accountTag, ...variables } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0]?.message || 'erro GraphQL');
  return json.data?.viewer?.accounts?.[0] || {};
}

const Q_KV_OPS = `query($accountTag:String!,$since:Time!,$until:Time!){viewer{accounts(filter:{accountTag:$accountTag}){
  kvOperationsAdaptiveGroups(limit:100,filter:{datetime_geq:$since,datetime_leq:$until}){sum{requests}dimensions{actionType}}
}}}`;

const Q_KV_STORAGE = `query($accountTag:String!,$sinceDate:Date!,$untilDate:Date!){viewer{accounts(filter:{accountTag:$accountTag}){
  kvStorageAdaptiveGroups(limit:100,filter:{date_geq:$sinceDate,date_leq:$untilDate}){max{byteCount keyCount}dimensions{namespaceId}}
}}}`;

const Q_WORKERS = `query($accountTag:String!,$since:Time!,$until:Time!){viewer{accounts(filter:{accountTag:$accountTag}){
  workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$since,datetime_leq:$until}){sum{requests errors}quantiles{cpuTimeP50 cpuTimeP99}dimensions{scriptName}}
}}}`;

const Q_D1 = `query($accountTag:String!,$sinceDate:Date!,$untilDate:Date!){viewer{accounts(filter:{accountTag:$accountTag}){
  d1AnalyticsAdaptiveGroups(limit:100,filter:{date_geq:$sinceDate,date_leq:$untilDate}){sum{rowsRead rowsWritten}dimensions{databaseId}}
}}}`;

// Storage is a point-in-time maximum per namespace/database, so the account
// total is the sum of each one's latest peak — not a sum over the time series.
function sumMax(rows, field) {
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows.reduce((acc, r) => acc + (r?.max?.[field] || 0), 0);
}

function sumOf(rows, field) {
  if (!Array.isArray(rows)) return null;
  return rows.reduce((acc, r) => acc + (r?.sum?.[field] || 0), 0);
}

async function collectUsage(token, accountTag) {
  const w = utcDayWindow();
  const usage = {};
  const errors = [];

  const [kvOps, kvStore, workers, d1] = await Promise.all([
    gql(token, accountTag, Q_KV_OPS, { since: w.since, until: w.until }).catch(e => { errors.push(`KV ops: ${e.message}`); return null; }),
    gql(token, accountTag, Q_KV_STORAGE, { sinceDate: w.sinceDate, untilDate: w.untilDate }).catch(e => { errors.push(`KV storage: ${e.message}`); return null; }),
    gql(token, accountTag, Q_WORKERS, { since: w.since, until: w.until }).catch(e => { errors.push(`Workers: ${e.message}`); return null; }),
    gql(token, accountTag, Q_D1, { sinceDate: w.sinceDate, untilDate: w.untilDate }).catch(e => { errors.push(`D1: ${e.message}`); return null; }),
  ]);

  if (kvOps) {
    const rows = kvOps.kvOperationsAdaptiveGroups || [];
    const byAction = {};
    for (const r of rows) byAction[r?.dimensions?.actionType] = (byAction[r?.dimensions?.actionType] || 0) + (r?.sum?.requests || 0);
    usage.kvWrites  = byAction.write  ?? 0;
    usage.kvReads   = byAction.read   ?? 0;
    usage.kvDeletes = byAction.delete ?? 0;
    usage.kvLists   = byAction.list   ?? 0;
  }
  if (kvStore) {
    const rows = kvStore.kvStorageAdaptiveGroups || [];
    usage.kvStorage = sumMax(rows, 'byteCount');
    usage.kvKeys    = sumMax(rows, 'keyCount');
  }
  if (workers) {
    const rows = workers.workersInvocationsAdaptive || [];
    usage.workerRequests = sumOf(rows, 'requests');
    usage.workerErrors   = sumOf(rows, 'errors');
    // CPU quantiles are per-script; the account-level signal we want is the
    // worst p99 across scripts, since that's what approaches the 10 ms ceiling.
    const p99s = rows.map(r => r?.quantiles?.cpuTimeP99).filter(v => typeof v === 'number');
    usage.cpuP99Us = p99s.length ? Math.max(...p99s) : null;
  }
  if (d1) {
    const rows = d1.d1AnalyticsAdaptiveGroups || [];
    usage.d1RowsRead    = sumOf(rows, 'rowsRead');
    usage.d1RowsWritten = sumOf(rows, 'rowsWritten');
  }

  return { usage, errors };
}

// Certificate expiry, straight from the zone's certificate packs. A Worker
// can't inspect the peer certificate of its own subrequests, so this is the
// only first-party way to see an expiry date — and it's the authoritative one,
// since it's the same record Cloudflare renews from.
async function collectCerts(token, accountTag) {
  const zonesRes = await cfFetch(`/zones?account.id=${encodeURIComponent(accountTag)}&per_page=50`, token);
  if (!zonesRes?.success) throw new Error(zonesRes?.errors?.[0]?.message || 'não foi possível listar as zonas');

  const zones = zonesRes.result || [];
  const out = await Promise.all(zones.map(async (z) => {
    try {
      const packs = await cfFetch(`/zones/${z.id}/ssl/certificate_packs?status=all`, token);
      const active = (packs?.result || []).filter(p => p.status === 'active');
      const dates = active
        .flatMap(p => p.certificates || [])
        .map(c => new Date(c.expires_on).getTime())
        .filter(Number.isFinite);
      if (!dates.length) return { zone: z.name, status: 'degraded', detail: 'sem certificado ativo' };

      // The soonest expiry is what bounds the zone: one stale pack breaks the
      // hostnames it covers even while the others are freshly renewed.
      const soonest = Math.min(...dates);
      const days = Math.floor((soonest - Date.now()) / 86400_000);
      if (days < 0)                return { zone: z.name, status: 'down',     detail: `expirado há ${-days}d`, days };
      if (days < CERT_WARN_DAYS)   return { zone: z.name, status: 'degraded', detail: `expira em ${days}d (renovação travada?)`, days };
      return { zone: z.name, status: 'up', detail: `válido +${days}d`, days };
    } catch (e) {
      return { zone: z.name, status: 'degraded', detail: `não verificado (${e.message})` };
    }
  }));
  return out;
}

function pct(used, limit) {
  if (typeof used !== 'number' || !limit) return null;
  return Math.round((used / limit) * 1000) / 10;
}

function quotaStatus(p) {
  if (p == null) return 'unknown';
  if (p >= CRIT_PCT) return 'down';
  if (p >= WARN_PCT) return 'degraded';
  return 'up';
}

function buildQuotas(usage) {
  return Object.entries(LIMITS).map(([key, def]) => {
    const used = usage[key];
    const p = pct(used, def.limit);
    return {
      key,
      label: def.label,
      period: def.period,
      bytes: !!def.bytes,
      used: typeof used === 'number' ? used : null,
      limit: def.limit,
      pct: p,
      remaining: typeof used === 'number' ? Math.max(0, def.limit - used) : null,
      status: quotaStatus(p),
    };
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  const token = env.CF_API_TOKEN;
  const accountTag = env.CF_ACCOUNT_ID;

  if (!token || !accountTag) {
    return json({
      configured: false,
      // Spelled out so the panel can tell the operator exactly what to add
      // rather than just disappearing.
      detail: 'CF_API_TOKEN e CF_ACCOUNT_ID ausentes — cotas e certificados não monitorados',
      checkedAt: new Date().toISOString(),
    }, 200, 300);
  }

  // Cached hard: quota counters move slowly, and every miss costs four GraphQL
  // queries plus a zone/cert sweep against the Cloudflare API.
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + '/api/quota-stats');
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const [usageResult, certs] = await Promise.all([
    collectUsage(token, accountTag).catch(e => ({ usage: {}, errors: [e.message] })),
    collectCerts(token, accountTag).catch(e => [{ zone: '—', status: 'degraded', detail: `não verificado (${e.message})` }]),
  ]);

  const quotas = buildQuotas(usageResult.usage);
  const worst = quotas.concat(certs).reduce(
    (acc, q) => (RANK[q.status] > RANK[acc] ? q.status : acc), 'up',
  );

  const res = json({
    configured: true,
    status: worst,
    quotas,
    certs,
    extra: {
      kvKeys: usageResult.usage.kvKeys ?? null,
      workerErrors: usageResult.usage.workerErrors ?? null,
      cpuP99Ms: typeof usageResult.usage.cpuP99Us === 'number'
        ? Math.round(usageResult.usage.cpuP99Us / 1000 * 10) / 10
        : null,
    },
    // Surfaced rather than swallowed: a dataset we couldn't read is itself
    // worth knowing about, since it silently hides a quota.
    errors: usageResult.errors,
    note: 'Cotas do plano gratuito, janela diária em UTC. Banda não é medida (Pages tem tráfego ilimitado).',
    checkedAt: new Date().toISOString(),
  }, 200, 300);

  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function json(data, status = 200, sMaxAge = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': `public, max-age=0, s-maxage=${sMaxAge}`,
    },
  });
}
