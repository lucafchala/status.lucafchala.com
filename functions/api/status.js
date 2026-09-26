// First-party health checks. Runs server-side (Pages Function) so it can read
// real status codes AND response bodies cross-origin — something the browser
// can't, since none of these subdomains send CORS headers. That lets us verify
// each service actually *works* (renders its page, serves its data, passes its
// own /api/healthz) instead of only confirming "the server answered".
//
// Each service has a primary availability probe (status code + latency + a
// content marker proving the right page rendered) plus optional functional
// sub-checks. A service's overall status is the worst of all its checks, and
// every failing check is reported in `problems` so the dashboard can show
// exactly what broke.

// The history log's shape is defined next to the endpoint that serves it, so
// this writer and that reader can never drift apart.
import { HISTORY_KEY, readHistory, trimHistory } from './status-history.js';
import { LATENCY_KEY, readLatency, trimLatency, shouldSample, buildSample } from './latency-trends.js';
import { lerRetrato, tomarVez, gravarVarredura, marcarAgendador, RETRATO_TTL_MS } from './retrato.js';

const TIMEOUT_MS  = 10000;
const DEGRADED_MS = 2500;
// fotos is the most-used service in the suite, so its primary probe holds it
// to a tighter latency SLA than everything else instead of sharing DEGRADED_MS.
const FOTOS_DEGRADED_MS = 1500;
// A KV read from inside the worker that takes longer than this is a warning —
// every page render reads KV, so sustained latency here is felt site-wide.
const KV_LATENCY_BUDGET_MS = 400;
// RFC 9116 security.txt should never be within two weeks of its Expires — a
// scanner would flag it, so we flag it first.
const SECTXT_SOON_MS = 14 * 86400_000;

// Data that stops being republished is a broken pipeline, but "old" is not by
// itself a failure — a URL shortener can legitimately go months without a new
// redirect. So age is reported as information and only the unambiguous breakage
// (an empty collection, or a timestamp in the future) is flagged.
const FRESHNESS_STALE_MS = 30 * 86400_000;
// Resend answering slower than this means alert delivery is already at risk.
const RESEND_BUDGET_MS = 3000;

const RANK = { up: 0, degraded: 1, down: 2 };
function worst(a, b) { return RANK[a] >= RANK[b] ? a : b; }

// Alert severity. `down` and `degraded` are both "something is wrong", but they
// don't deserve the same interruption: a slow response at 3am can wait, a dead
// service can't. Recoveries are their own class so they never read as an alarm.
function severityOf(from, to) {
  if (to === 'down') return 'critico';
  if (to === 'degraded') return 'atencao';
  return RANK[from] > 0 ? 'recuperado' : 'info';
}

const SEVERITY_RANK = { info: 0, recuperado: 1, atencao: 2, critico: 3 };
const SEVERITY_LABEL = { critico: 'CRÍTICO', atencao: 'ATENÇÃO', recuperado: 'RECUPERADO', info: 'INFO' };

// Uma tentativa a mais quando a rede falha (timeout, conexão recusada, DNS): um
// soluço de um instante não pode virar "fora do ar" num e-mail para todo mundo.
// Só custa subrequest quando a primeira falha; resposta HTTP, qualquer que seja
// o código, é resposta e não é repetida.
const RETRY_TIMEOUT_MS = 5000;
async function fetchSvc(url, opts = {}) {
  try {
    return await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), ...opts });
  } catch {
    return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(RETRY_TIMEOUT_MS), ...opts });
  }
}

function netDetail(e) {
  return e && e.name === 'TimeoutError' ? 'timeout' : 'sem resposta';
}

// Primary probe: status code + latency, plus an optional content marker so a
// 200 that returns a blank page, a parked placeholder, or a Cloudflare error
// interstitial is caught as degraded instead of passing as "up".
// Returns `text` alongside the verdict (not just for its own marker check) so
// a service's `checks` can reuse the already-fetched homepage body instead of
// re-fetching the same URL — e.g. fotos' gallery-depth check below. Undefined
// when the body was never read (4xx/5xx short-circuit, or a network error).
async function probePrimary(url, marker, degradedMs = DEGRADED_MS) {
  const start = Date.now();
  try {
    const res = await fetchSvc(url);
    const rt = Date.now() - start;
    const code = res.status;
    if (code >= 500) { res.body?.cancel(); return { status: 'down', statusCode: code, rt, detail: `HTTP ${code}` }; }
    if (code >= 400) { res.body?.cancel(); return { status: 'degraded', statusCode: code, rt, detail: `HTTP ${code}` }; }
    const text = await res.text();
    if (rt > degradedMs)                  return { status: 'degraded', statusCode: code, rt, detail: `resposta lenta (${rt}ms)`, text };
    if (text.length < 200)                return { status: 'degraded', statusCode: code, rt, detail: 'resposta vazia', text };
    if (marker && !text.includes(marker)) return { status: 'degraded', statusCode: code, rt, detail: 'conteúdo esperado ausente', text };
    return { status: 'up', statusCode: code, rt, detail: '', text };
  } catch (e) {
    return { status: 'down', statusCode: null, rt: Date.now() - start, detail: netDetail(e) };
  }
}

// A page sub-check: 2xx + (optionally) the right content. 5xx → down, 4xx or a
// missing marker → degraded.
async function checkContent(label, url, { marker, contentType } = {}) {
  try {
    const res = await fetchSvc(url);
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status}` }; }
    if (res.status >= 400) { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status}` }; }
    const ct = res.headers.get('content-type') || '';
    if (contentType && !ct.includes(contentType)) {
      res.body?.cancel();
      return { label, status: 'degraded', detail: `tipo inesperado (${ct.split(';')[0] || 'desconhecido'})` };
    }
    const text = await res.text();
    if (text.length < 50)                 return { label, status: 'degraded', detail: 'resposta vazia' };
    if (marker && !text.includes(marker)) return { label, status: 'degraded', detail: 'conteúdo esperado ausente' };
    return { label, status: 'up', detail: '' };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// A data-file sub-check: must be valid JSON and pass the validator. This is the
// "functional" part for the static sites — it proves the JSON the page renders
// from is present and well-formed, not just that index.html loads.
async function checkJson(label, url, validate) {
  try {
    const res = await fetchSvc(url, { headers: { Accept: 'application/json' } });
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status}` }; }
    if (!res.ok)           { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status}` }; }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { label, status: 'degraded', detail: 'JSON inválido' }; }
    const problem = validate ? validate(json) : null;
    if (problem) return { label, status: problem.status || 'degraded', detail: problem.detail };
    return { label, status: 'up', detail: '' };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

function humanAge(ms) {
  const d = Math.floor(ms / 86400_000);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(ms / 3600_000);
  if (h >= 1) return `${h}h`;
  return `${Math.max(0, Math.floor(ms / 60_000))}min`;
}

// Data-freshness sub-check for the JSON the small static apps render from.
// `Last-Modified` is preferred (it is the publish time); when the host doesn't
// send one, the newest timestamp found inside the items stands in.
//
// Age by itself is NOT treated as a failure: these files legitimately sit
// untouched for months, so a staleness threshold would only manufacture alerts.
// What *is* flagged is unambiguous breakage — an empty collection (a build that
// published nothing over real data) or a timestamp in the future (a clock or
// publish bug) — while the age rides along in the detail so a pipeline that
// quietly stopped is still visible at a glance.
function avaliarFrescor(label, json, lastModHeader, { collection, timestampFields = ['updatedAt', 'createdAt', 'date', 'time'] } = {}) {
  const items = json && collection ? json[collection] : null;
  if (!Array.isArray(items)) return { label, status: 'degraded', detail: `coleção "${collection}" ausente` };
  if (items.length === 0)    return { label, status: 'degraded', detail: 'coleção vazia (publicação quebrada?)' };

  let updatedAt = lastModHeader ? new Date(lastModHeader).getTime() : NaN;
  if (!Number.isFinite(updatedAt)) {
    const stamps = items
      .flatMap(it => (it && typeof it === 'object' ? timestampFields.map(f => it[f]) : []))
      .map(v => new Date(v).getTime())
      .filter(Number.isFinite);
    updatedAt = stamps.length ? Math.max(...stamps) : NaN;
  }

  if (!Number.isFinite(updatedAt)) return { label, status: 'up', detail: `${items.length} itens · sem carimbo de data` };

  const age = Date.now() - updatedAt;
  // A minute of slack absorbs ordinary clock skew between hosts; anything
  // beyond that is a genuinely wrong timestamp, not a rounding artifact.
  if (age < -60_000) return { label, status: 'degraded', detail: `carimbo no futuro (${humanAge(-age)} à frente)` };

  const stale = age > FRESHNESS_STALE_MS ? ' (parado?)' : '';
  return { label, status: 'up', detail: `${items.length} itens · atualizado há ${humanAge(age)}${stale}` };
}

// O arquivo de dados de Dash, Paste e URL alimenta DUAS linhas — "é JSON
// válido com a coleção?" e "está fresco?" — e era buscado duas vezes, uma por
// linha: três subrequests por varredura pagando pelo mesmo arquivo. Uma busca,
// duas linhas. Erro de rede ou HTTP vale para as duas, como antes.
function checkDados(labelJson, labelFrescor, url, validate, opts) {
  const busca = (async () => {
    try {
      const res = await fetchSvc(url, { headers: { Accept: 'application/json' } });
      if (res.status >= 500) { res.body?.cancel(); return { erro: { status: 'down', detail: `HTTP ${res.status}` } }; }
      if (!res.ok)           { res.body?.cancel(); return { erro: { status: 'degraded', detail: `HTTP ${res.status}` } }; }
      const lastMod = res.headers.get('last-modified');
      const text = await res.text();
      try { return { json: JSON.parse(text), lastMod }; } catch { return { erro: { status: 'degraded', detail: 'JSON inválido' } }; }
    } catch (e) {
      return { erro: { status: 'down', detail: netDetail(e) } };
    }
  })();
  return [
    busca.then((r) => {
      if (r.erro) return { label: labelJson, ...r.erro };
      const problem = validate ? validate(r.json) : null;
      if (problem) return { label: labelJson, status: problem.status || 'degraded', detail: problem.detail };
      return { label: labelJson, status: 'up', detail: '' };
    }),
    busca.then((r) => (r.erro ? { label: labelFrescor, ...r.erro } : avaliarFrescor(labelFrescor, r.json, r.lastMod, opts))),
  ];
}

// Alert delivery is the one failure the dashboard cannot discover by failing:
// if Resend rejects our key or the sender domain loses verification, every
// outage e-mail is dropped silently while the dashboard itself stays green.
//
// Validating the key against the domains endpoint proves delivery works WITHOUT
// sending anything — a real test message per sweep would burn through the 100
// e-mails/day the free tier allows and put an alert in the inbox every ten
// minutes, which is the opposite of what a monitor should do.
async function checkResend(label, env) {
  const key = env?.RESEND_API_KEY;
  if (!key) return { label, status: 'degraded', detail: 'RESEND_API_KEY ausente (sem alertas)' };

  const from = env.NOTIFY_FROM || 'status@lucafchala.com';
  const domain = from.split('@')[1] || '';
  const start = Date.now();
  try {
    const res = await fetchSvc('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    const rt = Date.now() - start;

    if (res.status === 401 || res.status === 403) {
      res.body?.cancel();
      return { label, status: 'down', detail: 'chave rejeitada (alertas não seriam entregues)' };
    }
    if (res.status === 429) { res.body?.cancel(); return { label, status: 'degraded', detail: 'rate-limited pela Resend' }; }
    if (!res.ok)            { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status}` }; }

    const json = await res.json().catch(() => null);
    const list = Array.isArray(json?.data) ? json.data : [];
    const entry = list.find(d => d?.name === domain);

    if (!entry)                      return { label, status: 'degraded', detail: `domínio ${domain} não cadastrado na Resend` };
    if (entry.status !== 'verified') return { label, status: 'degraded', detail: `domínio ${domain} não verificado (${entry.status || 'desconhecido'})` };
    if (rt > RESEND_BUDGET_MS)       return { label, status: 'degraded', detail: `API lenta (${rt}ms)` };
    return { label, status: 'up', detail: `${domain} verificado · ${rt}ms` };
  } catch (e) {
    // Não alcançar a API da Resend daqui não prova que o status caiu nem que
    // os alertas deixaram de sair: a Resend tem a própria linha em terceiros.
    // Como `down`, um soluço de rede virava CRÍTICO "Status" para todo inscrito.
    // `down` fica para o que é certeza: a chave recusada (401/403).
    return { label, status: 'degraded', detail: netDetail(e) };
  }
}

// fotos exposes a deep /api/healthz: { ok, kv, events, d1, kvLatencyMs,
// d1LatencyMs, cron, selftest, config, termsVersion, colo, … }. We fetch it
// ONCE per sweep and derive four dashboard rows from that single response:
// infra health, the functional self-test, the deployed configuration, and a
// deep-probe of a real event page. Fields absent on an older healthz payload
// are simply skipped, so this stays correct even when the two repos deploy
// independently.
//
// Uma busca só não é por causa de rate limit: o healthz do fotos NÃO tem
// limite ("Sem rate limit de propósito", em handleHealthz). É por custo — cada
// busca é uma requisição a mais no Worker do fotos e um subrequest a mais aqui.
function fetchHealthz(url) {
  return fetchSvc(url, { headers: { Accept: 'application/json' } }).then(async (res) => {
    // Um 429 aqui não vem do fotos (que não limita o healthz): vem de alguma
    // camada na frente dele — regra de WAF, rate limiting da zona. Já foi
    // tratado como "ignorado" e virava verde; é o contrário do que se quer
    // saber, porque o visitante esbarraria na mesma camada.
    if (res.status === 429) { res.body?.cancel(); return { rateLimited: true }; }
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; }
    catch { return { status: res.status, parseError: true }; }
  }).catch((e) => ({ netError: netDetail(e) }));
}

// Row 1 — pure infrastructure: KV binding/latency, D1 and its latency, the
// daily-cron heartbeat. (Form/config problems live in the self-test row.)
// Não há tempo de hash: o fotos tirou o `hashMs` do payload porque o Workers
// congela o relógio durante execução síncrona e o número era sempre 0.
export function healthInfra(label, h) {
  h = h || {};
  if (h.rateLimited) return { label, status: 'degraded', detail: 'HTTP 429 (o healthz não tem rate limit: bloqueio na frente do Worker?)' };
  if (h.netError)    return { label, status: 'down', detail: h.netError };
  if (h.parseError)  return { label, status: 'down', detail: 'healthz sem JSON' };
  const j = h.json;
  if (!j || typeof j !== 'object')      return { label, status: 'down', detail: 'healthz sem JSON' };
  if (j.kv === false || j.ok === false) return { label, status: 'down', detail: 'KV indisponível' };
  if (h.status >= 500)                  return { label, status: 'down', detail: `HTTP ${h.status}` };

  const issues = [];
  if (j.d1 === 'down')                                          issues.push('D1 (consentimento) indisponível');
  if (typeof j.kvLatencyMs === 'number' && j.kvLatencyMs > KV_LATENCY_BUDGET_MS) issues.push(`KV lento (${j.kvLatencyMs}ms)`);
  if (typeof j.d1LatencyMs === 'number' && j.d1 === 'ok' && j.d1LatencyMs > 1000) issues.push(`D1 lento (${j.d1LatencyMs}ms)`);
  if (j.cron && j.cron.stale === true)                          issues.push(`cron parado (${j.cron.ageHours}h sem rodar)`);
  // Unlike freshness elsewhere (age alone isn't a failure), a photography
  // business's gallery legitimately hitting zero events is as unambiguous a
  // breakage signal as an empty data.json is for the static sites — it means
  // either total data loss or a KV binding pointed at the wrong namespace.
  if (j.events === 0)                                           issues.push('0 eventos (perda de dados?)');
  if (issues.length) return { label, status: 'degraded', detail: issues.join(' · ') };

  const bits = [];
  if (typeof j.events === 'number') bits.push(`${j.events} eventos`);
  if (typeof j.kvLatencyMs === 'number') bits.push(`KV ${j.kvLatencyMs}ms`);
  if (typeof j.d1LatencyMs === 'number' && j.d1 === 'ok') bits.push(`D1 ${j.d1LatencyMs}ms`);
  // An unbound consent log is legitimate (fotos treats it as optional), but it
  // must be *visible* — silently reporting nothing is how a missing binding
  // survives a deploy unnoticed.
  else if (j.d1 === 'absent') bits.push('D1 ausente');
  if (j.colo) bits.push(j.colo);
  return { label, status: 'up', detail: bits.join(' · ') };
}

// Row 2 — the functional self-test fotos runs over its own data: broken/missing
// Drive links on live events, bad data (dup slugs, invalid status), and form
// backends (Turnstile/Resend/ADMIN_EMAIL) that are unset. This is what flags
// "something we changed went wrong" rather than just a hard 500.
export function healthSelftest(label, h) {
  h = h || {};
  // If healthz is unreachable/unparseable/blocked, the infra row already owns
  // that outage — don't double-count it here.
  if (h.rateLimited || h.netError || h.parseError || !h.json) return { label, status: 'up', detail: '—' };
  const st = h.json.selftest;
  if (!st) return { label, status: 'up', detail: 'autoteste indisponível (healthz antigo)' };
  if (Array.isArray(st.problems) && st.problems.length)
    return { label, status: 'degraded', detail: st.problems.join(' · ') };
  const bits = [];
  if (st.drive && typeof st.drive.ok === 'number') {
    bits.push(`Drive ${st.drive.ok}/${st.drive.live || 0} ok`);
  }
  const formIssues = [];
  if (st.forms) {
    if (!st.forms.turnstile) formIssues.push('Turnstile');
    if (!st.forms.resend) formIssues.push('Resend');
    if (!st.forms.adminEmail) formIssues.push('ADMIN_EMAIL');
  }
  if (formIssues.length) bits.push(`forms (faltam: ${formIssues.join(', ')})`);
  else bits.push('forms ok');
  return { label, status: 'up', detail: bits.join(' · ') };
}

// Row 3 — the deployed configuration fotos reports about itself: which optional
// integrations are wired and which Terms version is live. Deliberately always
// `up`: every *failure* this could describe is already owned by another row
// (missing secrets by the self-test, a dead D1 by the infra row), so alerting on
// it again would double-count. Its value is that the panel states the deployed
// configuration outright, instead of leaving it to be inferred from what didn't
// break — which is how a drifted Terms version between the two repos hides.
// Versão do CONTRATO do healthz do fotos que este painel sabe ler. O contrato
// mora num lugar só — docs/healthz-contrato.json, no repositório do fotos — e
// tests/contrato.test.mjs baixa aquele arquivo e reprova se este número
// divergir ou se alguma função daqui ler um campo que ele não tem.
export const CONTRATO_HEALTHZ_CONHECIDO = 1;

function quando(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function healthConfig(label, h) {
  h = h || {};
  if (h.rateLimited || h.netError || h.parseError || !h.json) return { label, status: 'up', detail: '—' };
  const j = h.json;
  // Contrato que este painel não conhece: um campo pode ter mudado de
  // sentido, e ler como antes daria verde errado. Não é o fotos que está mal
  // — é o monitor que ficou para trás —, mas é degradado do mesmo jeito:
  // desconhecido não é "ok".
  if (typeof j.contrato === 'number' && j.contrato !== CONTRATO_HEALTHZ_CONHECIDO) {
    return {
      label, status: 'degraded',
      detail: `contrato do healthz ${j.contrato}, este painel lê o ${CONTRATO_HEALTHZ_CONHECIDO} — atualize functions/api/status.js`,
    };
  }
  // A versão que respondeu (binding de version metadata do fotos): a etiqueta
  // é o SHA curto do commit. Vai também como campo à parte na linha, para o
  // retrato guardar e a página marcar o deploy na linha do tempo.
  const v = j.versao && typeof j.versao === 'object' && typeof j.versao.id === 'string' ? j.versao : null;
  const versao = v ? { id: v.id, tag: typeof v.tag === 'string' ? v.tag : null, em: typeof v.em === 'string' ? v.em : null } : null;
  const c = j.config;
  const bits = [];
  if (versao) bits.push(`versão ${versao.tag || versao.id.slice(0, 8)}${versao.em ? ` de ${quando(versao.em)}` : ''}`);
  if (c) {
    const wired = [];
    if (c.turnstile)  wired.push('Turnstile');
    if (c.resend)     wired.push('Resend');
    if (c.consentDb)  wired.push('D1');
    if (c.adminEmail) wired.push('admin');
    bits.push(wired.length ? `integrações: ${wired.join(', ')}` : 'nenhuma integração ativa');
  }
  if (j.termsVersion) bits.push(`termos ${j.termsVersion}`);
  if (j.country) bits.push(j.country);
  const row = { label, status: 'up', detail: bits.length ? bits.join(' · ') : 'sem config (healthz antigo)' };
  if (versao) row.versao = versao;
  return row;
}

// Row 3 — deep-probe a real event page (the healthy slug fotos nominates): the
// Drive-access gate and the removal form must both render. Sends the per-event
// view cookie so this monitoring hit never inflates the view counter.
export async function checkEventPage(label, h, base) {
  const slug = h && h.json && h.json.selftest && h.json.selftest.sample;
  if (!slug) return { label, status: 'up', detail: 'sem evento p/ testar' };
  try {
    const res = await fetchSvc(base + '/' + encodeURIComponent(slug), { headers: { Cookie: `fv_${slug}=1` } });
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status} em /${slug}` }; }
    if (res.status >= 400) { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status} em /${slug}` }; }
    const text = await res.text();
    const missing = [];
    if (!text.includes('drive-turnstile'))      missing.push('gate do Drive');
    if (!text.includes('rem-turnstile'))        missing.push('form de remoção');
    // og:title is unconditional in event.js (og:image isn't, it depends on the
    // event having a cover) — its absence means the share-preview template
    // itself broke, which WhatsApp/Instagram link previews depend on silently.
    if (!text.includes('property="og:title"'))  missing.push('preview og:title');
    if (missing.length) return { label, status: 'degraded', detail: `/${slug}: faltando ${missing.join(' + ')}` };
    return { label, status: 'up', detail: `/${slug} ok` };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// Security-header probe, VALUE-level (not just presence): checked against the
// literal values the worker sets in html() (src/index.js) — so a header that's
// still present but silently weakened (a shortened HSTS max-age, an X-Frame-
// Options loosened from DENY, a CSP directive dropped) is caught, which a
// presence-only check structurally can't. This is fotos-specific by design:
// it's the one service that gets this depth, proportional to being the
// highest-priority site in the suite.
//
// The CSP part compares each directive's VALUE against a set of acceptable
// values (see CSP_AT_LEAST_AS_STRICT), so tightening the deployed policy does
// NOT require touching this file — only a change that moves outside the
// acceptable set does.
const HSTS_MIN_MAX_AGE = 15552000; // 180d floor; the deployed value is 1y, but a
                                    // shorter (still reasonable) value shouldn't page.

// Directives where a *stricter* value than the expected one is legitimate, and
// must not be reported as a problem.
//
// This check exists to catch weakening. Matching a directive by literal string
// makes it also catch STRENGTHENING, which is the opposite of the job: fotos
// tightened `base-uri` from 'self' to 'none' (no page uses <base>, so forbidding
// the element outright beats allowing a same-origin one) and the panel started
// reporting `CSP sem "base-uri 'self'"` — pushing towards undoing a real
// hardening to silence a monitor. A check that punishes the improvement it is
// meant to protect is worse than no check.
//
// So: compare the directive's VALUE against the set of values that are at least
// as strict as what we expect. 'none' is stricter than 'self' for all three
// below; anything else (a host list, `*`, missing) still fails.
const CSP_AT_LEAST_AS_STRICT = {
  'default-src': ["'self'", "'none'"],
  'base-uri': ["'none'", "'self'"],
  'form-action': ["'none'", "'self'"],
  'frame-ancestors': ["'none'"], // already the strictest possible
};

function cspDirectiveIssue(csp, name) {
  // `;`-separated, and the directive name must match whole — otherwise
  // `script-src` would satisfy a lookup for `src`.
  const found = csp.split(';')
    .map(part => part.trim())
    .find(part => part === name || part.startsWith(name + ' '));

  if (!found) return `CSP sem "${name}"`;

  const value = found.slice(name.length).trim();
  const permitido = CSP_AT_LEAST_AS_STRICT[name];
  if (permitido && !permitido.includes(value)) {
    return `CSP "${name}" fraco ("${value}", esperado ${permitido.join(' ou ')})`;
  }
  return null;
}
async function checkSecurityHeaderValues(label, url) {
  try {
    const res = await fetchSvc(url);
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status}` }; }
    res.body?.cancel();
    const h = (name) => res.headers.get(name) || '';
    const issues = [];

    if (h('x-content-type-options') !== 'nosniff')                        issues.push('X-Content-Type-Options');
    if (h('x-frame-options') !== 'DENY')                                  issues.push('X-Frame-Options');
    if (h('referrer-policy') !== 'strict-origin-when-cross-origin')       issues.push('Referrer-Policy');
    if (h('cross-origin-opener-policy') !== 'same-origin')                issues.push('Cross-Origin-Opener-Policy');
    if (h('cross-origin-resource-policy') !== 'same-site')                issues.push('Cross-Origin-Resource-Policy');

    const hsts = h('strict-transport-security');
    const hstsAge = Number((hsts.match(/max-age=(\d+)/) || [])[1]);
    if (!hsts)                                                    issues.push('Strict-Transport-Security ausente');
    else if (!Number.isFinite(hstsAge) || hstsAge < HSTS_MIN_MAX_AGE) issues.push(`HSTS max-age fraco (${hsts})`);
    else if (!/includeSubDomains/i.test(hsts))                      issues.push('HSTS sem includeSubDomains');

    const perms = h('permissions-policy');
    for (const directive of ['camera=()', 'microphone=()', 'geolocation=()']) {
      if (!perms.includes(directive)) issues.push(`Permissions-Policy sem ${directive}`);
    }

    const csp = h('content-security-policy');
    if (!csp) {
      issues.push('Content-Security-Policy ausente');
    } else {
      for (const name of ['default-src', 'frame-ancestors', 'base-uri', 'form-action']) {
        const problema = cspDirectiveIssue(csp, name);
        if (problema) issues.push(problema);
      }
      // Sem valor: presença basta.
      if (!csp.split(';').map(p => p.trim()).includes('upgrade-insecure-requests')) {
        issues.push('CSP sem "upgrade-insecure-requests"');
      }
    }

    if (issues.length) return { label, status: 'degraded', detail: issues.join(' · ') };
    return { label, status: 'up', detail: 'CSP/HSTS/9 cabeçalhos com valores íntegros' };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// Valid-XML sub-check: right content-type, the XML declaration, and a required
// root element — proves sitemap.xml is actually a sitemap, not an error page
// served with a 200.
async function checkXml(label, url, { rootTag } = {}) {
  try {
    const res = await fetchSvc(url);
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status}` }; }
    if (res.status >= 400) { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status}` }; }
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!ct.includes('xml'))                 return { label, status: 'degraded', detail: `tipo inesperado (${ct.split(';')[0] || 'desconhecido'})` };
    if (!text.includes('<?xml'))             return { label, status: 'degraded', detail: 'declaração XML ausente' };
    if (rootTag && !text.includes(rootTag))  return { label, status: 'degraded', detail: `elemento ${rootTag}…> ausente` };
    return { label, status: 'up', detail: '' };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// RFC 9116 security.txt: must declare a Contact and an Expires still in the
// future. An expired (or near-expired) file is a compliance regression — catch
// it before an external scanner does.
async function checkSecurityTxt(label, url) {
  try {
    const res = await fetchSvc(url);
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status}` }; }
    if (res.status >= 400) { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status}` }; }
    const text = await res.text();
    if (!/^Contact:/im.test(text)) return { label, status: 'degraded', detail: 'sem campo Contact' };
    const m = text.match(/^Expires:\s*(.+)$/im);
    if (!m) return { label, status: 'degraded', detail: 'sem campo Expires' };
    const exp = new Date(m[1].trim()).getTime();
    if (!Number.isFinite(exp))    return { label, status: 'degraded', detail: 'Expires inválido' };
    const left = exp - Date.now();
    if (left < 0)                 return { label, status: 'degraded', detail: 'expirado' };
    if (left < SECTXT_SOON_MS)    return { label, status: 'degraded', detail: `expira em ${Math.ceil(left / 86400_000)}d` };
    return { label, status: 'up', detail: `válido +${Math.floor(left / 86400_000)}d` };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// Negative probe: a path that must NOT exist should answer 404. A 200 means the
// router/catch-all broke (a soft-404 served as 200, or every slug resolving).
async function checkStatusCode(label, url, expected) {
  try {
    const res = await fetchSvc(url);
    res.body?.cancel();
    if (res.status === expected) return { label, status: 'up', detail: `HTTP ${res.status}` };
    if (res.status >= 500)       return { label, status: 'down', detail: `HTTP ${res.status}` };
    return { label, status: 'degraded', detail: `HTTP ${res.status} (esperado ${expected})` };
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// O mesmo Worker do fotos, sem as regras da zona lucafchala.com (WAF, bot
// fight mode). Ver o comentário das sondas profundas do fotos em SERVICES.
export const FOTOS_WORKERS_DEV = 'https://fotos.lucafchala.workers.dev';

// Intervalo máximo entre duas conferências de uma sonda estática do fotos
// (o que mora no bundle do Worker), quando a versão implantada não mudou.
export const ESTATICAS_TTL_MS = 3 * 3600_000;

// Linha da varredura anterior que ainda vale para esta: mesma versão
// implantada, conferida há menos de ESTATICAS_TTL_MS, e VERDE — uma linha com
// problema é reconferida em toda varredura, para a recuperação aparecer na
// hora. Sem versão conhecida (healthz antigo, binding ausente, healthz fora do
// ar), nada é reaproveitado: sem saber se houve deploy, sonda-se.
export function reaproveitavel(anterior, label, versaoId, agora = Date.now()) {
  if (!versaoId || !anterior || !Array.isArray(anterior.checks)) return null;
  const c = anterior.checks.find((x) => x && x.label === label);
  if (!c || c.status !== 'up' || c.versaoId !== versaoId) return null;
  const em = Date.parse(c.verificadoEm);
  if (!Number.isFinite(em) || agora - em > ESTATICAS_TTL_MS || em > agora) return null;
  return c;
}

function estatica(label, health, anterior, run) {
  return health.then(async (h) => {
    const versaoId = h && h.json && h.json.versao && typeof h.json.versao.id === 'string' ? h.json.versao.id : null;
    const velha = reaproveitavel(anterior, label, versaoId);
    if (velha) return { ...velha };
    const r = await run();
    return { ...r, verificadoEm: new Date().toISOString(), versaoId };
  });
}

// O visitante chega pelo domínio próprio; o workers.dev é o mesmo Worker sem
// a zona na frente. Comparar os dois diz ONDE está a falha:
//   • domínio 403/429 e Worker bem → é a zona barrando (WAF, bot fight mode):
//     o site está de pé, e a sonda — ou o visitante — está sendo recusada;
//   • domínio sem resposta ou 5xx e Worker bem → rota, DNS ou TLS da zona;
//   • os dois mal → é o site.
// Degradado quando só o domínio falha: o visitante esbarra na mesma coisa, e
// a linha principal já diz o quê; esta diz por quê.
export function dominioOuWorker(label, primary, h) {
  const workerOk = !!(h && h.json && h.status === 200 && h.json.ok === true);
  const dominioOk = primary.status === 'up' || (primary.statusCode != null && primary.statusCode < 400);
  if (dominioOk) return { label, status: 'up', detail: workerOk ? 'mesmo Worker nos dois endereços' : '' };
  if (!workerOk) return { label, status: 'up', detail: 'os dois endereços falham: é o site, não a zona' };
  const code = primary.statusCode;
  if (code === 403 || code === 429) {
    return { label, status: 'degraded', detail: `domínio próprio respondeu ${code}, o Worker responde pelo workers.dev: a zona (WAF/bot) está barrando, não o site` };
  }
  return { label, status: 'degraded', detail: `domínio próprio ${code ? `HTTP ${code}` : 'sem resposta'}, o Worker responde pelo workers.dev: rota, DNS ou TLS da zona` };
}

export const SERVICES = [
  {
    name: 'lucafchala.com', url: 'https://lucafchala.com', marker: 'Luca',
    // O `_redirects` do site é gerado pelo dash e responde antes dos arquivos:
    // um splat que pegasse tudo transformaria cada link quebrado em 200.
    checks: (b) => [checkStatusCode('roteamento (404)', b + '/__status_probe_404__', 404)],
  },
  {
    name: 'Rádio', url: 'https://radio.lucafchala.com', marker: 'Radio',
  },
  {
    // fotos gets deliberately exhaustive coverage: every public route, every
    // data file, the deep healthz, the security headers, the RFC 9116 contact,
    // the PWA contract, and a negative routing probe. The service's status is
    // the worst of all of them, and every failure is named — so nothing breaks
    // on fotos without showing up here first.
    name: 'Fotos', url: 'https://fotos.lucafchala.com', marker: 'fotos',
    // Tighter latency SLA than the rest of the suite (see FOTOS_DEGRADED_MS) —
    // it's the most-used service, so it's held to a stricter bar, not just a
    // deeper one.
    degradedMs: FOTOS_DEGRADED_MS,
    checks: (b, env, primary, anterior) => {
      // Sondas PROFUNDAS (healthz e página de evento) pelo workers.dev; o
      // domínio próprio fica para o que o visitante vê — a sonda principal,
      // os cabeçalhos, as páginas. É o que separa "o fotos caiu" de "o
      // domínio está barrando a sonda" (WAF/bot da zona): o workers.dev é o
      // MESMO Worker sem as regras da zona, o endereço que o smoke do deploy
      // já usa pelo mesmo motivo. Não custa requisição a mais — só muda de
      // onde vêm as duas que já existiam.
      //
      // One healthz fetch, four derived rows (infra + self-test + deployed
      // config + event-page deep-probe): uma requisição a menos no fotos por
      // linha, não um rate limit a respeitar (o healthz não tem).
      const health = fetchHealthz(FOTOS_WORKERS_DEV + '/api/healthz');
      // Sondas do que MORA NO BUNDLE do Worker (páginas estáticas, manifest,
      // ícones, robots, cabeçalhos): só mudam com um deploy, e todo deploy já
      // passa pelo smoke. Rodam de novo quando a versão implantada muda ou a
      // cada ESTATICAS_TTL_MS; no resto, a linha é a da varredura anterior,
      // com a hora em que foi conferida. Eram 11 das 17 requisições que cada
      // varredura fazia no fotos.
      const est = (label, run) => estatica(label, health, anterior, run);
      return [
        health.then((h) => healthInfra('saúde · KV/D1/cron', h)),
        health.then((h) => healthSelftest('autoteste · dados/forms/Drive', h)),
        health.then((h) => healthConfig('configuração implantada', h)),
        health.then((h) => checkEventPage('página de evento (Drive + remoção + preview)', h, FOTOS_WORKERS_DEV)),
        health.then((h) => dominioOuWorker('domínio próprio × workers.dev', primary, h)),
        // Headers are set by the shared html() helper on every HTML response, so we
        // assert them against the *static* /termos page (no KV read on fotos' side)
        // instead of the homepage, which would trigger a second events read.
        // Value-level, not presence-only: parsed against the literal policy
        // deployed in html() (src/index.js), so a weakened-but-present header
        // (a shortened HSTS, a loosened X-Frame-Options) is caught too.
        // No domínio próprio: é lá que regra de zona pode mudar um cabeçalho.
        est('cabeçalhos de segurança (valores)', () => checkSecurityHeaderValues('cabeçalhos de segurança (valores)', b + '/termos')),
        // The homepage marker above only proves the shell rendered; this proves
        // the gallery actually painted event cards, not an empty grid. Reuses
        // the primary probe's already-fetched body instead of a second GET to
        // '/' — fotos is a single KV-backed Worker, so re-fetching the homepage
        // would mean a second Workers invocation *and* a second events read for
        // every sweep, purely to re-derive text the primary probe already has.
        // Marker is data-title (unconditional on every card) rather than
        // data-card (gallery.js omits it on the featured card, which would
        // false-positive a healthy one-event gallery). If the primary probe
        // never got a body (4xx/5xx/network error), that row already owns the
        // failure — this one reports 'up' rather than double-counting it.
        {
          label: 'galeria — eventos renderizam',
          status: primary.text == null || primary.text.includes('data-title="') ? 'up' : 'degraded',
          detail: primary.text == null ? '—' : (primary.text.includes('data-title="') ? '' : 'grade sem cards de evento'),
        },
        // O sitemap sai da lista de eventos (dado, não bundle): toda varredura.
        checkXml('sitemap.xml', b + '/sitemap.xml', { rootTag: '<urlset' }),
        // /dashboard também é sondado como serviço próprio ("Fotos — Dashboard")
        // a cada varredura; aqui ele entra só no ritmo das estáticas.
        est('painel /dashboard', () => checkContent('painel /dashboard', b + '/dashboard', { contentType: 'text/html', marker: '/dashboard/login' })),
        est('manifest PWA', () => checkJson('manifest PWA', b + '/manifest.json', (j) => {
          if (!j || !j.name) return { detail: 'manifest sem nome' };
          if (!Array.isArray(j.icons) || !j.icons.length || !j.icons[0].src) return { detail: 'manifest sem ícones' };
          if (!j.start_url)   return { detail: 'manifest sem start_url' };
          if (!j.theme_color) return { detail: 'manifest sem theme_color' };
          return null;
        })),
        est('ícone PWA', () => checkContent('ícone PWA', b + '/icon.svg', { contentType: 'image/svg+xml', marker: '<svg' })),
        est('og coming-soon', () => checkContent('og coming-soon', b + '/og-coming-soon.png', { contentType: 'image/png' })),
        est('robots.txt', () => checkContent('robots.txt', b + '/robots.txt', { contentType: 'text/plain', marker: 'Sitemap:' })),
        // Muda com o tempo (Expires), não com o deploy — mas a margem de aviso
        // é de 14 dias; conferir a cada 3 h sobra.
        est('security.txt (RFC 9116)', () => checkSecurityTxt('security.txt (RFC 9116)', b + '/.well-known/security.txt')),
        est('GPC opt-out', () => checkJson('GPC opt-out', b + '/.well-known/gpc.json', (j) => (j && j.gpc === true ? null : { detail: 'gpc≠true' }))),
        est('termos (LGPD)', () => checkContent('termos (LGPD)', b + '/termos', { contentType: 'text/html', marker: 'Termos de Uso' })),
        est('privacidade', () => checkContent('privacidade', b + '/privacidade', { contentType: 'text/html', marker: 'Política de Privacidade' })),
        // The support form is gated by a Turnstile widget; if its markup is gone
        // the form can't be submitted, so we assert the widget renders.
        est('formulário de suporte', () => checkContent('formulário de suporte', b + '/suporte', { contentType: 'text/html', marker: 'cf-turnstile' })),
        est('roteamento (404)', () => checkStatusCode('roteamento (404)', b + '/__status_probe_404__', 404)),
      ];
    },
  },
  {
    name: 'Fotos — Dashboard', url: 'https://fotos.lucafchala.com/dashboard', marker: '/dashboard/login',
  },
  {
    name: 'Dash', url: 'https://dash.lucafchala.com', marker: 'Painel',
    checks: (b) => checkDados('data.json (PURLs)', 'atualidade dos dados', b + '/data.json',
      (j) => (j && Array.isArray(j.redirects) ? null : { detail: 'campo redirects ausente' }), { collection: 'redirects' }),
  },
  {
    name: 'Paste', url: 'https://paste.lucafchala.com', marker: 'Paste',
    checks: (b) => checkDados('pastes.json', 'atualidade dos dados', b + '/pastes.json',
      (j) => (j && Array.isArray(j.pastes) ? null : { detail: 'lista de pastes inválida' }), { collection: 'pastes' }),
  },
  {
    name: 'URL', url: 'https://url.lucafchala.com', marker: 'url.lucafchala.com',
    checks: (b) => [
      ...checkDados('data.json (redirects)', 'atualidade dos dados', b + '/data.json',
        (j) => (j && Array.isArray(j.redirects) ? null : { detail: 'campo redirects ausente' }), { collection: 'redirects' }),
      checkStatusCode('roteamento (404)', b + '/__status_probe_404__', 404),
    ],
  },
  {
    name: 'Keys', url: 'https://keys.lucafchala.com', marker: 'Chaves',
  },
  {
    name: 'Proof', url: 'https://proof.lucafchala.com',
    checks: (b) => [
      checkContent('prova de posse', b + '/proof-of-ownership.txt', { marker: 'Luca Ferriani Chala' }),
    ],
  },
  {
    // PIN-gated (see _worker.js): the gate markup itself renders regardless of
    // auth state, so the marker check works without a session. Nothing beyond
    // the gate is reachable without the PIN, so there's no functional
    // sub-check to add here the way the other apps get one.
    name: 'RG', url: 'https://rg.lucafchala.com', marker: 'Acesso restrito',
  },
  {
    // Static, client-side-only (localStorage) — no API of its own to probe
    // beyond the page rendering.
    name: 'Pays', url: 'https://pays.lucafchala.com', marker: 'subs',
  },
  {
    // Static single-page tool — no backend, so a content marker is the whole
    // functional surface.
    name: 'Treino', url: 'https://treino.lucafchala.com', marker: 'Hevy',
  },
  {
    // The dashboard monitors itself: its own /api/healthz exposes whether the
    // STATUS_KV binding, the Resend key, and the admin recipient are present —
    // the exact config drift that silently breaks alerting/subscriptions. (A
    // *total* status-page outage can't self-report, since /api/status wouldn't
    // run; the GitHub Actions monitor's non-200 is the backstop for that.)
    name: 'Status', url: 'https://status.lucafchala.com', marker: 'monitoramento de serviços',
    checks: (b, env) => [
      checkJson('saúde', b + '/api/healthz', (j) => (j && j.ok === true ? null : { detail: 'healthz inválido' })),
      // A configuração é lida do próprio ambiente (é o mesmo projeto): o
      // healthz público não diz mais quais segredos faltam nem quantos são os
      // inscritos, e este detalhe vai para a /api/status, que é pública.
      Promise.resolve(configAlertas('configuração de alertas', env)),
      // Config presence (above) only proves the key *exists*; this proves it is
      // still accepted and the sender domain is still verified.
      checkResend('entrega de alertas (Resend)', env),
    ],
  },
];

function configAlertas(label, env) {
  const faltam = !env?.STATUS_KV || !env?.RESEND_API_KEY || !env?.NOTIFY_TO;
  if (faltam) return { label, status: 'degraded', detail: 'configuração incompleta (alertas ou inscrições afetados)' };
  return { label, status: 'up', detail: env.CF_API_TOKEN && env.CF_ACCOUNT_ID ? '' : 'cotas não monitoradas' };
}

// Uma verificação que lança (um payload inesperado, um bug) vira uma linha
// "instável" com nome, em vez de derrubar a varredura inteira num 500.
const ERRO_INTERNO = { status: 'degraded', detail: 'erro interno na verificação' };
function isolar(p, label = 'verificação') {
  return Promise.resolve(p).catch((e) => { console.error('check lançou', label, e); return { label, ...ERRO_INTERNO }; });
}

async function checkService(svc, env, anterior) {
  const primary = await probePrimary(svc.url, svc.marker, svc.degradedMs);
  let lista = [];
  try { lista = svc.checks ? svc.checks(svc.url, env, primary, anterior) : []; }
  catch (e) { console.error('checks lançou', svc.name, e); lista = [Promise.resolve({ label: 'verificações', ...ERRO_INTERNO })]; }
  const extra = await Promise.all(lista.map((p) => isolar(p)));

  const checks = [{ label: 'disponibilidade', status: primary.status, detail: primary.detail }, ...extra];
  let status = primary.status;
  for (const c of extra) status = worst(status, c.status);

  const problems = checks
    .filter((c) => c.status !== 'up' && c.detail)
    .map((c) => `${c.label}: ${c.detail}`);

  return { name: svc.name, url: svc.url, status, statusCode: primary.statusCode, rt: primary.rt, checks, problems };
}

// Edge-cached for 30 s so concurrent viewers share one upstream sweep per colo
// instead of fanning out a probe-per-check per tab per minute.
// Change detection and notifications run server-side off each fresh sweep:
// previous state lives in STATUS_KV, so the emailing decision never depends
// on anything a client sends (the old public /api/notify-all was an open relay).
// ---------------------------------------------------------------------------
// Piso entre varreduras REAIS, em memória do isolate
// ---------------------------------------------------------------------------
// O cache de borda tem 30 s, mas a chave dele é a URL INTEIRA — query incluída.
// Isso é proposital: é assim que o cron do GitHub Actions força uma varredura
// fresca, acrescentando `?t=<aleatório>`.
//
// O problema é que essa porta não é só do cron. Qualquer pessoa acrescenta uma
// query aleatória e provoca uma varredura COMPLETA: são ~20 fetches de saída
// para os subdomínios do dono a cada requisição. Um laço de curl vira, de
// graça, um amplificador contra a própria infraestrutura que este painel existe
// para vigiar — e ainda queima a cota de requisições do Pages.
//
// O piso fecha a porta sem tirar a chave do cron: um pedido que fura o cache de
// borda recebe o resultado da última varredura DESTE isolate se ela for recente
// demais, em vez de disparar outra. O cron roda a cada 10 min e nunca esbarra
// nisso; o painel aberto (que pede a cada 2–10 min) também não. Só o laço de curl
// esbarra — que é exatamente quem deveria.
//
// Estado de módulo, então vale por isolate: um atacante distribuído ainda
// consegue algum fanout. O que ele NÃO consegue mais é multiplicar sem limite
// dentro de um isolate, que era o caso barato. Um piso de verdade exigiria
// escrita de KV por requisição — o recurso mais escasso da conta, e justamente
// o que não se pode gastar para se defender de um flood.
const SWEEP_MIN_INTERVAL_MS = 20_000;
let _lastSweepAt = 0;
/** @type {{ services: any[], checkedAt: string } | null} */
let _lastSweep = null;

// `anterior` é a varredura anterior (o retrato do D1, ou a última deste
// isolate sem ele): é de onde as sondas estáticas do fotos reaproveitam o
// resultado enquanto a versão implantada não muda.
export async function varrer(env, anterior = null) {
  const antes = (nome) => (anterior && Array.isArray(anterior.services) ? anterior.services.find((x) => x && x.name === nome) : null) || null;
  const services = await Promise.all(SERVICES.map((s) => checkService(s, env, antes(s.name)).catch((e) => {
    console.error('serviço lançou', s.name, e);
    return { name: s.name, url: s.url, status: 'degraded', statusCode: null, rt: 0, checks: [{ label: 'disponibilidade', ...ERRO_INTERNO }], problems: [`disponibilidade: ${ERRO_INTERNO.detail}`] };
  })));
  return { services, checkedAt: new Date().toISOString() };
}

// Quem pediu a varredura, pela query. Não é autenticação — qualquer um pode
// mandar `?varrer` —, e não precisa ser: com o retrato em D1, a trava global
// (retrato.tomarVez) limita a UMA varredura a cada 4 min para a conta inteira,
// quantos pedidos vierem. A origem só serve para o registro dizer quem varreu.
export function origemDoPedido(url) {
  const src = url.searchParams.get('source');
  if (src === 'cloudflare-cron') return 'agendador';
  if (src === 'gha-cron') return 'cron do GitHub';
  if (url.searchParams.has('varrer')) return 'pedido manual';
  return null;
}

// O payload é público de propósito: o painel (dash) e a home leem os pontos de
// status direto do navegador.
const CORS = { 'Access-Control-Allow-Origin': '*' };

function responder(payload, extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': extra.cacheControl || 'no-store',
    ...CORS,
  };
  if (extra.idadeMs != null) headers['X-Sweep-Age-Ms'] = String(Math.max(0, extra.idadeMs));
  if (extra.origem) headers['X-Sweep-Source'] = extra.origem;
  return new Response(JSON.stringify(payload), { status: extra.status || 200, headers });
}

// Com o retrato compartilhado: visitante LÊ; só varre quem pediu pela origem
// (agendador, cron) ou quando o retrato ficou velho demais — agendador
// atrasado ou morto. Nos dois casos, passando pela trava global.
//
// O segundo caso é uma escolha consciente: com o agendador parado, a página
// mostraria um dado de horas sem nunca se corrigir. Pela trava, o custo desse
// socorro não cresce com o público — no máximo uma varredura a cada 4 min,
// com um ou mil visitantes — e ele se desliga sozinho quando o agendador volta.
async function comRetrato(context, DB) {
  const url = new URL(context.request.url);
  const pedido = origemDoPedido(url);
  const agora = Date.now();
  const r = await lerRetrato(DB);
  const idadeMs = r ? agora - r.em : null;
  const atrasado = idadeMs == null || idadeMs > RETRATO_TTL_MS;
  // Antes da trava, e com ou sem a vez: o que o vigia precisa saber é que o
  // agendador está vivo e pedindo, não se ganhou a vez desta vez.
  if (pedido === 'agendador') {
    context.waitUntil(marcarAgendador(DB, agora).catch((e) => console.error('retrato: marca do agendador falhou', e)));
  }

  if ((pedido || atrasado) && await tomarVez(DB, agora)) {
    const payload = await varrer(context.env, r ? r.payload : null);
    const origem = pedido || 'visitante (retrato atrasado)';
    const fim = Date.now();
    context.waitUntil(gravarVarredura(DB, payload, origem, fim)
      .catch((e) => console.error('retrato: gravação falhou', e)));
    context.waitUntil(detectAndNotify(context.env, payload.services, url.origin, { latenciaNoD1: true }));
    return responder({ ...payload, retrato: { origem, idadeMs: 0, atrasado: false } }, { idadeMs: 0, origem });
  }

  if (!r) {
    // Banco novo e outra varredura em curso (a trava está com ela): não há o
    // que mostrar ainda, e varrer de novo seria exatamente o que a trava evita.
    const res = responder({ erro: 'primeira varredura em andamento', services: [] }, { status: 503 });
    res.headers.set('Retry-After', '60');
    return res;
  }
  return responder(
    { ...r.payload, retrato: { origem: r.origem, idadeMs, atrasado } },
    { idadeMs, origem: r.origem },
  );
}

export async function onRequestGet(context) {
  const DB = context.env.STATUS_DB;
  if (DB) {
    try {
      return await comRetrato(context, DB);
    } catch (e) {
      // D1 fora do ar não pode apagar o painel: cai para o comportamento de
      // antes do retrato (varredura por pedido, com cache e piso por isolate).
      console.error('retrato indisponível; varredura por pedido', e);
    }
  }
  return semRetrato(context);
}

// Sem STATUS_DB: o comportamento de sempre.
async function semRetrato(context) {
  const cache = caches.default;
  const cacheKey = new Request(context.request.url);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const agora = Date.now();
  if (_lastSweep && agora - _lastSweepAt < SWEEP_MIN_INTERVAL_MS) {
    // Serve o resultado recente sem sondar nada e sem repetir a detecção de
    // mudança: a varredura que produziu este corpo já rodou `detectAndNotify`.
    return new Response(JSON.stringify(_lastSweep), {
      headers: {
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=0, s-maxage=30',
        // Diz a quem lê que este corpo é reaproveitado, e de quando ele é. Um
        // painel que mostra "agora" sobre um dado de 15 s atrás mente pouco,
        // mas mente — e depurar isso sem o cabeçalho é adivinhação.
        'X-Sweep-Age-Ms': String(agora - _lastSweepAt),
        ...CORS,
      },
    });
  }

  const payload = await varrer(context.env, _lastSweep);
  const services = payload.services;
  _lastSweep = payload;
  _lastSweepAt = agora;

  const res = new Response(JSON.stringify(payload), {
    // s-maxage caches at the edge only; max-age=0 keeps browsers revalidating
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=0, s-maxage=30',
      // Os mesmos dois cabeçalhos do caminho com retrato: o agendador e o
      // vigia registram quem varreu e quão velho é o que receberam.
      'X-Sweep-Age-Ms': '0',
      'X-Sweep-Source': origemDoPedido(new URL(context.request.url)) || 'visitante',
      ...CORS,
    },
  });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  context.waitUntil(detectAndNotify(context.env, services, new URL(context.request.url).origin));
  return res;
}

const NOTIFY_COOLDOWN_S = 3600; // at most one alert per service per hour

// Espelho em memória para quando o KV RECUSA escrita — que é exatamente o
// cenário sobre o qual este alerta precisa avisar. A cota de escrita do plano
// gratuito (1000/dia, conta inteira) é o limite mais apertado que existe aqui;
// quando ela acaba, o `put` passa a lançar exceção e as duas gravações desta
// função — `last_status` e `notify_sent` — derrubavam a varredura ANTES de
// chegar ao envio do e-mail. Ou seja: o alarme de "estourei os limites" ficava
// desligado justamente por ter estourado os limites. Sem barulho nenhum.
//
// Guardar em memória do isolate custa zero (persistir exigiria a escrita que
// acabou de ser recusada) e resolve as duas metades:
//
//   • `lastStatus` impede o isolate de redetectar a MESMA transição a cada
//     varredura — sem isso, com o KV velho preso no valor antigo, o alerta
//     dispararia de novo a cada ciclo;
//   • `notifiedAt` substitui o cooldown que não pôde ser gravado, mantendo o
//     teto de um e-mail por serviço por hora.
//
// Vale só para este isolate, como todo estado de módulo. Se a Cloudflare rodar
// a varredura em outro, ele pode mandar mais um e-mail — o que é o lado certo
// de errar: repetir um aviso é barato, engolir o único aviso não é.
const _fallback = { lastStatus: null, notifiedAt: new Map(), pending: null };

// Free-tier headroom joins change detection, so a limit that starts running out
// reaches the inbox instead of waiting to be spotted on the dashboard. Fetched
// over HTTP rather than recomputed, so the endpoint's own 5-minute edge cache
// absorbs repeated sweeps that land in the same colo. (O cron, que roda a
// intervalos maiores que 5 min, quase sempre erra esse cache: para ele esta
// chamada custa uma invocação a mais de Pages Function por varredura.)
//
// Linha que a quota-stats não conseguiu LER (`unknown`) não entra: não é
// problema de cota nem de certificado, e tratá-la como tal inventaria um
// incidente. O motivo continua visível no painel e em `errors[]`.
//
// `quiesceOnRecovery` marks these as worsening-only: the daily counters reset at
// UTC midnight, so a quota that peaked yesterday "recovers" every single night.
// Emailing that — or logging it as an incident — would be pure clockwork noise.
async function quotaEntries(origin) {
  try {
    const res = await fetchSvc(origin + '/api/quota-stats', { headers: { Accept: 'application/json' } });
    if (!res.ok) { res.body?.cancel(); return null; }
    const j = await res.json();
    if (!j || typeof j !== 'object') return null;
    if (j.configured === false) return [];

    const entries = [];
    for (const q of j.quotas || []) {
      // A dataset we couldn't read is not a quota problem — quota-stats already
      // reports it under errors[], and guessing here would invent an outage.
      if (q.status === 'unknown') continue;
      entries.push({
        name: `cota · ${q.label}`,
        status: q.status,
        url: origin,
        quiesceOnRecovery: true,
        ownerOnly: true,
        problems: q.status === 'up' ? [] : [
          `${q.label}: ${q.pct}% usado${q.remaining != null ? ` · restam ${q.remaining.toLocaleString('pt-BR')}` : ''}${q.period === 'dia' ? ' hoje (zera à meia-noite UTC)' : ''}`,
        ],
      });
    }
    for (const c of j.certs || []) {
      if (c.status === 'unknown') continue;
      entries.push({
        name: `TLS · ${c.zone}`,
        status: c.status,
        url: origin,
        quiesceOnRecovery: true,
        ownerOnly: true,
        problems: c.status === 'up' ? [] : [`certificado de ${c.zone}: ${c.detail}`],
      });
    }
    return entries;
  } catch {
    // Quota visibility failing must never take the service sweep's alerting
    // down with it.
    return null;
  }
}

// Linhas de cota/TLS falam da conta Cloudflare do dono, não de um serviço que
// o visitante usa: vão só para o NOTIFY_TO.
const OWNER_ONLY_PREFIXES = ['cota · ', 'TLS · '];
function isOwnerOnlyName(name) { return OWNER_ONLY_PREFIXES.some((p) => name.startsWith(p)); }

export async function detectAndNotify(env, services, origin, { latenciaNoD1 = false } = {}) {
  const KV = env.STATUS_KV;
  if (!KV) return;

  const quotas = await quotaEntries(origin);

  let prev = {};
  let prevOk = true;
  try { prev = JSON.parse(await KV.get('last_status') || '{}') || {}; } catch { prev = {}; prevOk = false; }
  // Só existe depois de uma gravação recusada, e nesse caso o KV está velho de
  // propósito: quem sabe o estado mais recente é o espelho.
  if (_fallback.lastStatus) { prev = { ...prev, ..._fallback.lastStatus }; prevOk = true; }

  // Services and quota rows run through one pipeline from here: same change
  // detection, same severity, same cooldown, same batched e-mail.
  const tracked = [
    ...services.map((s) => ({
      name: s.name, status: s.status, url: s.url,
      problems: s.problems, quiesceOnRecovery: false,
    })),
    ...(quotas || []),
  ];

  // Write last_status ONLY when something actually changed. KV writes are the
  // tightest free-tier limit (1k/day, shared account-wide with the fotos site),
  // and a sweep runs on every cron tick plus every visitor poll that misses the
  // cache — an unconditional write would be one write per sweep (144/day at the
  // cron's nominal 10 min, far more with the dashboard open) on a value that
  // rarely changes. Now: ~0 in steady state, a write only on a real transition.
  const next = {};
  for (const s of tracked) next[s.name] = s.status;
  // quota-stats fora do ar não é "todas as cotas sumiram": as linhas anteriores
  // seguem como estavam, senão a volta dela contaria como primeira aparição.
  if (quotas === null) {
    for (const [k, v] of Object.entries(prev)) if (isOwnerOnlyName(k) && !(k in next)) next[k] = v;
  }
  let changed = false;
  for (const k of Object.keys(next)) { if (prev[k] !== next[k]) { changed = true; break; } }
  if (!changed) {
    for (const k of Object.keys(prev)) { if (!(k in next)) { changed = true; break; } } // a service was removed
  }

  // Um serviço que aparece pela primeira vez já quebrado conta como saída do
  // verde: antes ele entrava calado em last_status e o alerta nunca vinha.
  // Só quando há um last_status lido e não vazio — a primeira varredura de uma
  // instalação nova (ou um KV ilegível) não pode virar uma rajada de e-mails.
  const knowsHistory = prevOk && Object.keys(prev).length > 0;
  const fromOf = (s) => prev[s.name] || (knowsHistory ? 'up' : null);

  // Every real transition, logged. This is what lets a green dashboard still
  // answer "was it already broken an hour ago?" — and it rides along inside the
  // `changed` block precisely so it costs nothing in steady state. Transitions
  // are recorded even when e-mail is unconfigured: the log is a record of what
  // happened, not a side effect of alerting.
  const transitions = tracked
    .filter((s) => { const f = fromOf(s); return f && f !== s.status; })
    // A quota falling back to `up` is the UTC-midnight reset, not a recovery.
    // Its new state is still recorded below, so the next crossing alerts again —
    // it just doesn't announce the clock.
    .filter((s) => !(s.quiesceOnRecovery && s.status === 'up'))
    .map((s) => ({
      name: s.name,
      from: fromOf(s),
      to: s.status,
      at: new Date().toISOString(),
      severity: severityOf(fromOf(s), s.status),
      problems: Array.isArray(s.problems) ? s.problems.slice(0, 5) : [],
    }));

  if (changed) {
    try {
      await KV.put('last_status', JSON.stringify(next));
      // O KV voltou a aceitar escrita: o espelho cumpriu o papel e sai de cena,
      // senão ele mascararia transições futuras com um estado congelado.
      _fallback.lastStatus = null;
    } catch (e) {
      _fallback.lastStatus = next;
      console.error('last_status write failed (cota de KV?)', e);
    }
    if (transitions.length) {
      const log = await readHistory(KV);
      await KV.put(HISTORY_KEY, JSON.stringify(trimHistory([...transitions, ...log])))
        .catch((e) => console.error('history write failed', e));
    }
  }

  // Amostra de latência — independente de `changed`, porque a tendência que
  // interessa acontece justamente enquanto o status não muda: um serviço que
  // saiu de 300ms para 1800ms segue verde e é o aviso mais antecipado de que
  // algo vai quebrar. A cadência (no máximo a cada 30 min) é o que mantém isso
  // em ~48 escritas/dia (no máximo 50) qualquer que seja o ritmo das varreduras.
  //
  // A decisão lê a série antes (uma leitura de KV por varredura; leitura é
  // 100× mais farta que escrita) em vez de olhar o relógio: ver shouldSample.
  //
  // Com o retrato em D1, a série sai de lá — uma amostra por varredura, sem
  // custo de KV — e este bloco não roda: zero escrita de KV para latência.
  if (!latenciaNoD1) try {
    const series = await readLatency(KV);
    if (shouldSample(series)) {
      const sample = buildSample(services);
      if (sample) await KV.put(LATENCY_KEY, JSON.stringify(trimLatency([sample, ...series])));
    }
  } catch (e) {
    // Telemetria nunca pode derrubar a varredura que ela observa.
    console.error('latency sample failed', e);
  }

  if (!env.RESEND_API_KEY || !env.NOTIFY_TO) return;

  // Severity floor, so a noisy class of change can be muted without giving up
  // alerting entirely (ALERT_MIN_SEVERITY=atencao mutes recovery notices;
  // =critico pages only for hard outages). Defaults to alerting on everything.
  const floor = SEVERITY_RANK[env.ALERT_MIN_SEVERITY] ?? SEVERITY_RANK.info;
  const now = Date.now();
  const current = Object.fromEntries(tracked.map((s) => [s.name, s]));

  // Envio que falhou na varredura anterior. last_status já avançou, então sem
  // esta fila a transição nunca mais seria detectada e o aviso se perderia.
  // Só volta a tentar o que ainda é verdade agora.
  // O cooldown é por serviço E destino: repetir "caiu" dentro da hora é
  // ruído, mas a recuperação (ou a piora de degradado para fora do ar) é
  // notícia nova e sempre passa.
  const emCooldown = async (name, to) => {
    const key = cooldownKey(name, to);
    // KV is eventually consistent, so two colos sweeping at once can rarely
    // double-send; the cooldown still bounds it to ~1 extra email per hour.
    let onCooldown = false;
    try { onCooldown = !!(await KV.get(key)); } catch { onCooldown = false; }
    // Cooldown que não pôde ser GRAVADO não protege nada: sem este segundo
    // olhar, uma cota estourada faria a mesma transição render e-mail a cada
    // varredura (a cada disparo do cron, a cada poucos minutos com o painel aberto).
    if (!onCooldown) {
      const last = _fallback.notifiedAt.get(key);
      if (last && now - last < NOTIFY_COOLDOWN_S * 1000) onCooldown = true;
    }
    return onCooldown;
  };

  // A fila crua fica guardada à parte: um item que deixou de ser verdade (o
  // serviço voltou) sai do envio, e a fila tem de ser limpa mesmo assim. Antes
  // ela só era limpa quando sobrava algo para enviar; o item velho sobrevivia
  // (TTL de 6 h), voltava a casar na queda seguinte e mandava um segundo
  // CRÍTICO a todo inscrito. Item da fila também respeita o cooldown.
  const fila = await readPending(KV);
  const pending = [];
  for (const c of fila) {
    if (!current[c.name] || current[c.name].status !== c.to || transitions.some((t) => t.name === c.name)) continue;
    if (await emCooldown(c.name, c.to)) continue;
    pending.push(c);
  }

  const candidates = [];
  for (const t of transitions) {
    if (SEVERITY_RANK[t.severity] < floor) continue;
    if (await emCooldown(t.name, t.to)) continue;
    const s = current[t.name];
    candidates.push({ ...t, url: s ? s.url : '', ownerOnly: isOwnerOnlyName(t.name), attempts: 0 });
  }
  const changes = [...candidates, ...pending];
  if (changes.length === 0) {
    if (fila.length) await writePending(KV, []);
    return;
  }

  let ok = false;
  try { ok = await sendAlerts(env, changes); }
  catch (e) { console.error('status alert email failed', e); ok = false; }

  if (ok) {
    for (const c of changes) {
      const key = cooldownKey(c.name, c.to);
      try {
        await KV.put(key, '1', { expirationTtl: NOTIFY_COOLDOWN_S });
      } catch (e) {
        console.error('notify cooldown write failed (cota de KV?)', e);
      }
      // Marcado sempre, tenha o KV aceitado ou não: é o que segura o teto
      // quando a gravação falhou.
      _fallback.notifiedAt.set(key, now);
    }
    if (fila.length) await writePending(KV, []);
    return;
  }
  // Falhou: o cooldown não foi gasto, e a transição fica na fila para a
  // próxima varredura — no máximo MAX_ALERT_ATTEMPTS vezes, para um
  // destinatário que o Resend recusa sempre não virar e-mail repetido ao dono.
  const retry = changes
    .map((c) => ({ ...c, attempts: (c.attempts || 0) + 1 }))
    .filter((c) => c.attempts < MAX_ALERT_ATTEMPTS);
  await writePending(KV, retry);
}

const MAX_ALERT_ATTEMPTS = 3;
const PENDING_KEY = 'alert_pending';
const PENDING_TTL_S = 6 * 3600;
function cooldownKey(name, to) { return `notify_sent:${name}:${to}`; }

async function readPending(KV) {
  if (_fallback.pending) return _fallback.pending;
  try {
    const list = JSON.parse(await KV.get(PENDING_KEY) || '[]');
    return Array.isArray(list) ? list.filter((c) => c && typeof c.name === 'string' && typeof c.to === 'string') : [];
  } catch { return []; }
}

// Só grava quando há falha a lembrar ou fila a limpar: em estado normal, zero
// escrita. O espelho em memória cobre o KV que recusa escrita.
async function writePending(KV, list) {
  try {
    if (list.length) await KV.put(PENDING_KEY, JSON.stringify(list), { expirationTtl: PENDING_TTL_S });
    else await KV.delete(PENDING_KEY);
    _fallback.pending = null;
  } catch (e) {
    _fallback.pending = list.length ? list : [];
    console.error('alert_pending write failed', e);
  }
}

async function sendAlerts(env, changes) {
  const { RESEND_API_KEY, NOTIFY_TO, NOTIFY_FROM = 'status@lucafchala.com', STATUS_KV: KV } = env;

  let subscribers = [];
  try { subscribers = JSON.parse(await KV.get('subscribers') || '[]') || []; } catch { subscribers = []; }
  if (!Array.isArray(subscribers)) subscribers = [];

  // Cota e TLS vão só para o dono; o resto, para todos. Um inscrito sem nada
  // público nesta rodada não recebe e-mail.
  const publicChanges = changes.filter((c) => !c.ownerOnly);
  const subEmails = publicChanges.length ? subscribers.map((s) => s && s.email).filter(Boolean) : [];
  const recipients = [...new Set([NOTIFY_TO, ...subEmails])];
  const bySub = new Map(subscribers.filter((s) => s && s.email).map((s) => [s.email, s]));

  const ownerMail = buildAlert(changes);
  const publicMail = publicChanges.length ? buildAlert(publicChanges) : null;

  const batch = recipients.map(email => {
    const isOwner = email === NOTIFY_TO;
    const mail = isOwner ? ownerMail : publicMail;
    const sub = isOwner ? null : bySub.get(email);
    const unsubUrl = sub
      ? `https://status.lucafchala.com/api/unsubscribe?token=${encodeURIComponent(sub.token)}`
      : null;
    const msg = { from: NOTIFY_FROM, reply_to: NOTIFY_FROM, to: [email], subject: mail.subject, html: alertHtml(mail.rows, unsubUrl) };
    // RFC 8058: o cliente de e-mail passa a mostrar o botão nativo de cancelar
    // inscrição, e o POST de um clique cai no `onRequestPost` do
    // /api/unsubscribe. Só para quem é inscrito — o NOTIFY_TO do dono não tem
    // token e não deve poder se descadastrar dos próprios alertas por engano.
    //
    // O par de cabeçalhos vem junto ou não vem: `List-Unsubscribe` sozinho faz
    // o cliente cair no modo antigo (abrir o link), que é justamente o GET que
    // deixou de executar a ação.
    if (unsubUrl) {
      msg.headers = {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    }
    return msg;
  });

  // O endpoint de lote do Resend aceita no máximo 100 mensagens por chamada;
  // acima disso a chamada inteira era recusada — e ninguém sabia, porque a
  // resposta não era lida. O dono vai no primeiro lote.
  let ok = true;
  for (let i = 0; i < batch.length; i += RESEND_BATCH_MAX) {
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch.slice(i, i + RESEND_BATCH_MAX)),
    });
    if (!res.ok) {
      ok = false;
      const detail = await res.text().catch(() => '');
      console.error(`status alert batch ${i / RESEND_BATCH_MAX + 1} failed: HTTP ${res.status}`, detail.slice(0, 300));
    } else {
      res.body?.cancel();
    }
  }
  return ok;
}

const RESEND_BATCH_MAX = 100;

function buildAlert(changes) {
  // Worst-first: when several services change at once the mail already batches
  // them into one message, so the ordering is what decides whether the outage
  // or the recovery is the first thing read.
  const ordered = [...changes].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  const rows = ordered.map(c => {
    // List every failing check, not just the first — the whole point is to know
    // about *any* problem, so an alert spells out all of them at once.
    const problemList = (c.problems && c.problems.length)
      ? '<br>' + c.problems.map(p => '• ' + esc(p)).join('<br>')
      : '';
    return `<tr>
      <td style="padding:6px 12px 6px 0;font-family:monospace;font-size:13px;vertical-align:top">${esc(c.name)}</td>
      <td style="padding:6px 8px;font-family:monospace;font-size:12px;vertical-align:top">${icon(c.from)} → ${icon(c.to)}</td>
      <td style="padding:6px 8px;font-family:monospace;font-size:10px;letter-spacing:0.08em;color:${severityColor(c.severity)};vertical-align:top">${SEVERITY_LABEL[c.severity] || ''}</td>
      <td style="padding:6px 0;font-family:monospace;font-size:11px;color:#9a8f80">${esc(c.url)}${problemList}</td>
    </tr>`;
  }).join('');

  // The subject carries the worst severity in the batch, so triage happens in
  // the inbox list without opening anything.
  const top = ordered[0];
  const subject = ordered.length === 1
    ? `[${SEVERITY_LABEL[top.severity]}] ${icon(top.to)} ${top.name} — status.lucafchala.com`
    : `[${SEVERITY_LABEL[top.severity]}] ${ordered.length} mudanças de status — status.lucafchala.com`;
  return { rows, subject };
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function icon(s) {
  return s === 'up' ? '🟢' : s === 'degraded' ? '🟡' : '🔴';
}

function severityColor(sev) {
  if (sev === 'critico') return '#c05050';
  if (sev === 'atencao') return '#c08030';
  if (sev === 'recuperado') return '#5c9c6c';
  return '#6a6358';
}

function alertHtml(rows, unsubUrl) {
  const footer = unsubUrl
    ? `<a href="${unsubUrl}" style="color:#c08030;text-decoration:none">Cancelar inscrição</a> &nbsp;·&nbsp; `
    : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0d0c0a;color:#e6e1d6;font-family:monospace;padding:32px;margin:0">
  <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#6a6358;margin-bottom:20px">status.lucafchala.com</p>
  <h1 style="font-family:Georgia,serif;font-weight:300;font-size:28px;margin:0 0 8px">
    Mudança de <em style="color:#c08030;font-style:italic">status</em>
  </h1>
  <p style="font-size:12px;color:#6a6358;margin:0 0 28px">${new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}</p>
  <table style="border-collapse:collapse;width:100%;margin-bottom:28px">${rows}</table>
  <p style="font-size:11px;color:#6a6358;border-top:1px solid #252220;padding-top:16px;margin:0">
    ${footer}<a href="https://status.lucafchala.com" style="color:#c08030;text-decoration:none">Ver status</a>
  </p>
</body></html>`;
}
