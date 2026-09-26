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
  workerRequests: { limit: 100000,  period: 'dia',   label: 'Workers + Pages · requisições' },
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

// O Worker do fotos hora a hora nas últimas 24 h: requisições, invocações
// com erro (exceção, CPU estourada) e CPU p99. É o "extremamente detalhado"
// que não custa sonda nenhuma — a Cloudflare já mede tudo isso de cada
// invocação, e a GraphQL Analytics não gasta cota de Worker. Consulta à parte
// das de cota: se um campo não existir no plano, cai só esta linha.
const Q_WORKER_HORA = `query($accountTag:String!,$since:Time!,$until:Time!,$script:String!){viewer{accounts(filter:{accountTag:$accountTag}){
  workersInvocationsAdaptive(limit:48,filter:{scriptName:$script,datetime_geq:$since,datetime_leq:$until},orderBy:[datetimeHour_ASC]){sum{requests errors}quantiles{cpuTimeP99}dimensions{datetimeHour}}
}}}`;

// Durable Objects: o fotos guarda contadores e rate limit neles, e o painel
// de cotas não os mostrava. Cada chamada a um DO é uma requisição a mais que
// o painel de Workers não conta do mesmo jeito.
const Q_DO = `query($accountTag:String!,$since:Time!,$until:Time!){viewer{accounts(filter:{accountTag:$accountTag}){
  durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{datetime_geq:$since,datetime_leq:$until}){sum{requests}dimensions{scriptName}}
}}}`;

// Pages Functions (este painel: /api/*) moram num dataset À PARTE do de
// Workers — verificado em produção: workersInvocationsAdaptive só trazia o
// `fotos`. Mas o teto de 100 mil requisições/dia do plano gratuito é de
// Workers E Pages Functions somados; sem esta consulta a cota
// "Workers · requisições" subcontava justamente o painel.
const Q_PAGES = `query($accountTag:String!,$since:Time!,$until:Time!){viewer{accounts(filter:{accountTag:$accountTag}){
  pagesFunctionsInvocationsAdaptiveGroups(limit:100,filter:{datetime_geq:$since,datetime_leq:$until}){sum{requests errors}dimensions{scriptName}}
}}}`;

// Worker detalhado hora a hora (o que mais importa acompanhar).
export const WORKER_DETALHADO = 'fotos';

// Storage is a point-in-time maximum per namespace/database, so the account
// total is the sum of each one's latest peak — not a sum over the time series.
function sumMax(rows, field) {
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows.reduce((acc, r) => acc + (r?.max?.[field] || 0), 0);
}

// A GraphQL devolve CPU em microssegundos.
function msDeUs(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v / 100) / 10 : null;
}

function sumOf(rows, field) {
  if (!Array.isArray(rows)) return null;
  return rows.reduce((acc, r) => acc + (r?.sum?.[field] || 0), 0);
}

async function collectUsage(token, accountTag) {
  const w = utcDayWindow();
  const usage = {};
  // O texto cru do erro da API vai para o log; o payload (público) leva o
  // conjunto de dados e um motivo classificado.
  const errors = [];

  const agora = new Date();
  const ontem = new Date(agora.getTime() - 24 * 3600_000);
  const [kvOps, kvStore, workers, d1, hora, dobj, pages] = await Promise.all([
    gql(token, accountTag, Q_KV_OPS, { since: w.since, until: w.until }).catch(e => { errors.push(motivo('KV ops', e)); return null; }),
    gql(token, accountTag, Q_KV_STORAGE, { sinceDate: w.sinceDate, untilDate: w.untilDate }).catch(e => { errors.push(motivo('KV storage', e)); return null; }),
    gql(token, accountTag, Q_WORKERS, { since: w.since, until: w.until }).catch(e => { errors.push(motivo('Workers', e)); return null; }),
    gql(token, accountTag, Q_D1, { sinceDate: w.sinceDate, untilDate: w.untilDate }).catch(e => { errors.push(motivo('D1', e)); return null; }),
    gql(token, accountTag, Q_WORKER_HORA, { since: ontem.toISOString(), until: agora.toISOString(), script: WORKER_DETALHADO })
      .catch(e => { errors.push(motivo(`${WORKER_DETALHADO} por hora`, e)); return null; }),
    gql(token, accountTag, Q_DO, { since: w.since, until: w.until }).catch(e => { errors.push(motivo('Durable Objects', e)); return null; }),
    gql(token, accountTag, Q_PAGES, { since: w.since, until: w.until }).catch(e => { errors.push(motivo('Pages Functions', e)); return null; }),
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
    // A mesma consulta já vinha por Worker e era somada: o detalhe sai de
    // graça. Taxa de erro e CPU por script é o que diz QUAL Worker está mal.
    usage.porWorker = rows
      .map(r => {
        const req = r?.sum?.requests || 0;
        const err = r?.sum?.errors || 0;
        return {
          script: r?.dimensions?.scriptName || '?',
          requests: req,
          errors: err,
          errosPct: req ? Math.round((err / req) * 10000) / 100 : null,
          cpuP50Ms: msDeUs(r?.quantiles?.cpuTimeP50),
          cpuP99Ms: msDeUs(r?.quantiles?.cpuTimeP99),
        };
      })
      .sort((a, b) => b.requests - a.requests);
  }
  if (pages) {
    const rows = pages.pagesFunctionsInvocationsAdaptiveGroups || [];
    const req = sumOf(rows, 'requests');
    const err = sumOf(rows, 'errors');
    usage.pagesRequests = req;
    // Entra na mesma cota: o teto é da conta, Workers e Pages somados.
    if (typeof usage.workerRequests === 'number' && typeof req === 'number') usage.workerRequests += req;
    if (usage.porWorker && req) {
      usage.porWorker.push({
        script: 'Pages Functions', requests: req, errors: err,
        errosPct: req ? Math.round((err / req) * 10000) / 100 : null, cpuP50Ms: null, cpuP99Ms: null,
      });
      usage.porWorker.sort((a, b) => b.requests - a.requests);
    }
  }
  if (hora) {
    usage.workerPorHora = {
      script: WORKER_DETALHADO,
      horas: (hora.workersInvocationsAdaptive || []).map(r => ({
        hora: r?.dimensions?.datetimeHour || null,
        requests: r?.sum?.requests || 0,
        errors: r?.sum?.errors || 0,
        cpuP99Ms: msDeUs(r?.quantiles?.cpuTimeP99),
      })).filter(h => h.hora),
    };
  }
  if (dobj) {
    const rows = dobj.durableObjectsInvocationsAdaptiveGroups || [];
    usage.durableObjects = {
      requests: sumOf(rows, 'requests'),
      porScript: rows.map(r => ({ script: r?.dimensions?.scriptName || '?', requests: r?.sum?.requests || 0 }))
        .sort((a, b) => b.requests - a.requests),
    };
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
      // Check `success` explicitly: an authorization failure here returns a
      // body with no `result`, which would otherwise read as "this zone has no
      // certificate" — sending someone to hunt a certificate problem when the
      // real fix is a missing scope on the API token.
      //
      // E "não consegui ler" é `unknown`, não `degraded`: um token sem o escopo
      // de SSL deixava o TLS permanentemente amarelo, o painel de cotas inteiro
      // `degraded`, e a linha entrava no rastreio de transições como se o
      // certificado tivesse problema. Desconhecido aparece como desconhecido,
      // com o motivo — nem verde por omissão, nem alarme inventado.
      if (!packs?.success) {
        // O texto cru da API da Cloudflare fica no log; a linha pública (este
        // retorno chega ao /api/painel) diz só a causa, como motivo() faz.
        console.error(`quota-stats: certificados de ${z.name}:`, packs?.errors);
        return { zone: z.name, status: 'unknown', detail: `não verificado (${porque(new Error(String(packs?.errors?.[0]?.message || '')))})` };
      }

      const active = (packs.result || []).filter(p => p.status === 'active');
      const dates = active
        .flatMap(p => p.certificates || [])
        .map(c => new Date(c.expires_on).getTime())
        .filter(Number.isFinite);
      // No pack is NOT an outage. Universal SSL is issued and renewed by
      // Cloudflare without appearing as a certificate pack on every plan, so a
      // zone can be perfectly well served by a certificate this endpoint never
      // lists. Reporting that as a problem is exactly the false alarm this
      // dashboard is built to avoid — say what is known and move on.
      if (!dates.length) return { zone: z.name, status: 'up', detail: 'Universal SSL (gerenciado, sem data exposta)' };

      // The soonest expiry is what bounds the zone: one stale pack breaks the
      // hostnames it covers even while the others are freshly renewed.
      const soonest = Math.min(...dates);
      const days = Math.floor((soonest - Date.now()) / 86400_000);
      if (days < 0)                return { zone: z.name, status: 'down',     detail: `expirado há ${-days}d`, days };
      if (days < CERT_WARN_DAYS)   return { zone: z.name, status: 'degraded', detail: `expira em ${days}d (renovação travada?)`, days };
      return { zone: z.name, status: 'up', detail: `válido +${days}d`, days };
    } catch (e) {
      console.error(`quota-stats: certificados de ${z.name}:`, e);
      return { zone: z.name, status: 'unknown', detail: `não verificado (${porque(e)})` };
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

// Usada também pelo /api/painel. Devolve o objeto, não a Response.
function motivo(rotulo, e) {
  console.error(`quota-stats: ${rotulo}:`, e);
  return `${rotulo}: ${porque(e)}`;
}

function porque(e) {
  const m = String(e && e.message || '');
  return /unauthori|permission|forbidden|authentication|\b40[13]\b/i.test(m) ? 'sem permissão no token'
    : /timeout|timed out|abort/i.test(m) ? 'tempo esgotado'
    : 'a API não respondeu';
}

export async function lerCotas(context) {
  const { env } = context;
  const token = env.CF_API_TOKEN;
  const accountTag = env.CF_ACCOUNT_ID;

  if (!token || !accountTag) {
    return {
      configured: false,
      // Spelled out so the panel can tell the operator exactly what to add
      // rather than just disappearing.
      detail: 'monitoramento de cotas não configurado — cotas e certificados não monitorados',
      checkedAt: new Date().toISOString(),
    };
  }

  // Cached hard: quota counters move slowly, and every miss costs four GraphQL
  // queries plus a zone/cert sweep against the Cloudflare API.
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + '/api/quota-stats');
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const [usageResult, certs] = await Promise.all([
    collectUsage(token, accountTag).catch(e => ({ usage: {}, errors: [motivo('uso da conta', e)] })),
    collectCerts(token, accountTag).catch(e => [{ zone: '—', status: 'unknown', detail: `não verificado (${e.message})` }]),
  ]);

  const quotas = buildQuotas(usageResult.usage);
  const worst = quotas.concat(certs).reduce(
    (acc, q) => (RANK[q.status] > RANK[acc] ? q.status : acc), 'up',
  );

  const body = {
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
    // Detalhe que não é cota (não entra em alerta nem em `status`): serve para
    // ler, não para disparar e-mail. Ausente = consulta que não respondeu, e
    // o motivo está em `errors`.
    porWorker: usageResult.usage.porWorker ?? null,
    workerPorHora: usageResult.usage.workerPorHora ?? null,
    durableObjects: usageResult.usage.durableObjects ?? null,
    // Surfaced rather than swallowed: a dataset we couldn't read is itself
    // worth knowing about, since it silently hides a quota.
    errors: usageResult.errors,
    note: 'Cotas do plano gratuito, janela diária em UTC. Banda não é medida (Pages tem tráfego ilimitado).',
    checkedAt: new Date().toISOString(),
  };

  context.waitUntil(cache.put(cacheKey, json(body, 200, 300)));
  return body;
}

export async function onRequestGet(context) {
  return json(await lerCotas(context), 200, 300);
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
