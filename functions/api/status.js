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

const TIMEOUT_MS  = 10000;
const DEGRADED_MS = 2500;
// fotos is the most-used service in the suite, so its primary probe holds it
// to a tighter latency SLA than everything else instead of sharing DEGRADED_MS.
const FOTOS_DEGRADED_MS = 1500;
// fotos hashes the login password with PBKDF2 on the request path; the deploy
// smoke test fails the build above this, so the dashboard flags it as degraded.
const HASH_BUDGET_MS = 200;
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

function fetchSvc(url, opts = {}) {
  return fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), ...opts });
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
async function checkFreshness(label, url, { collection, timestampFields = ['updatedAt', 'createdAt', 'date', 'time'] } = {}) {
  try {
    const res = await fetchSvc(url, { headers: { Accept: 'application/json' } });
    if (res.status >= 500) { res.body?.cancel(); return { label, status: 'down', detail: `HTTP ${res.status}` }; }
    if (!res.ok)           { res.body?.cancel(); return { label, status: 'degraded', detail: `HTTP ${res.status}` }; }

    const lastModHeader = res.headers.get('last-modified');
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { label, status: 'degraded', detail: 'JSON inválido' }; }

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
  } catch (e) {
    return { label, status: 'down', detail: netDetail(e) };
  }
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
    return { label, status: 'down', detail: netDetail(e) };
  }
}

// fotos exposes a deep /api/healthz: { ok, kv, events, d1, hashMs, kvLatencyMs,
// cron, selftest, config, colo, … }. We fetch it ONCE per sweep (it's rate-
// limited to 10/min/IP) and derive THREE dashboard rows from that single
// response: infra health, the functional self-test, and a deep-probe of a real
// event page. Fields absent on an older healthz payload are simply skipped, so
// this stays correct even when the two repos deploy independently.
function fetchHealthz(url) {
  return fetchSvc(url, { headers: { Accept: 'application/json' } }).then(async (res) => {
    // healthz is rate-limited; a 429 from our own sweep isn't an outage.
    if (res.status === 429) { res.body?.cancel(); return { rateLimited: true }; }
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; }
    catch { return { status: res.status, parseError: true }; }
  }).catch((e) => ({ netError: netDetail(e) }));
}

// Row 1 — pure infrastructure: KV binding/latency, D1, login hashing, the
// daily-cron heartbeat. (Form/config problems live in the self-test row.)
function healthInfra(label, h) {
  if (h.rateLimited) return { label, status: 'up', detail: 'rate-limited (ignorado)' };
  if (h.netError)    return { label, status: 'down', detail: h.netError };
  if (h.parseError)  return { label, status: 'down', detail: 'healthz sem JSON' };
  const j = h.json;
  if (j.kv === false || j.ok === false) return { label, status: 'down', detail: 'KV indisponível' };
  if (h.status >= 500)                  return { label, status: 'down', detail: `HTTP ${h.status}` };

  const issues = [];
  if (j.d1 === 'down')                                          issues.push('D1 (consentimento) indisponível');
  if (typeof j.hashMs === 'number' && j.hashMs > HASH_BUDGET_MS) issues.push(`hashing lento (${j.hashMs}ms)`);
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
  if (typeof j.hashMs === 'number') bits.push(`hash ${j.hashMs}ms`);
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
function healthSelftest(label, h) {
  if (h.rateLimited) return { label, status: 'up', detail: 'rate-limited (ignorado)' };
  // If healthz is unreachable/unparseable, the infra row already owns that
  // outage — don't double-count it here.
  if (h.netError || h.parseError || !h.json) return { label, status: 'up', detail: '—' };
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
function healthConfig(label, h) {
  if (h.rateLimited) return { label, status: 'up', detail: 'rate-limited (ignorado)' };
  if (h.netError || h.parseError || !h.json) return { label, status: 'up', detail: '—' };
  const j = h.json;
  const c = j.config;
  const bits = [];
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
  return { label, status: 'up', detail: bits.length ? bits.join(' · ') : 'sem config (healthz antigo)' };
}

// Row 3 — deep-probe a real event page (the healthy slug fotos nominates): the
// Drive-access gate and the removal form must both render. Sends the per-event
// view cookie so this monitoring hit never inflates the view counter.
async function checkEventPage(label, h, base) {
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

export const SERVICES = [
  {
    name: 'lucafchala.com', url: 'https://lucafchala.com', marker: 'Luca',
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
    checks: (b, env, primaryText) => {
      // One healthz fetch, three derived rows (infra + self-test + event-page
      // deep-probe) — keeps us under the 10/min healthz rate limit.
      const health = fetchHealthz(b + '/api/healthz');
      return [
        health.then((h) => healthInfra('saúde · KV/D1/hash/cron', h)),
        health.then((h) => healthSelftest('autoteste · dados/forms/Drive', h)),
        health.then((h) => healthConfig('configuração implantada', h)),
        health.then((h) => checkEventPage('página de evento (Drive + remoção + preview)', h, b)),
        // Headers are set by the shared html() helper on every HTML response, so we
        // assert them against the *static* /termos page (no KV read on fotos' side)
        // instead of the homepage, which would trigger a second events read.
        // Value-level, not presence-only: parsed against the literal policy
        // deployed in html() (src/index.js), so a weakened-but-present header
        // (a shortened HSTS, a loosened X-Frame-Options) is caught too.
        checkSecurityHeaderValues('cabeçalhos de segurança (valores)', b + '/termos'),
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
          status: primaryText == null || primaryText.includes('data-title="') ? 'up' : 'degraded',
          detail: primaryText == null ? '—' : (primaryText.includes('data-title="') ? '' : 'grade sem cards de evento'),
        },
        checkContent('painel /dashboard', b + '/dashboard', { contentType: 'text/html', marker: '/dashboard/login' }),
        checkJson('manifest PWA', b + '/manifest.json', (j) => {
          if (!j || !j.name) return { detail: 'manifest sem nome' };
          if (!Array.isArray(j.icons) || !j.icons.length || !j.icons[0].src) return { detail: 'manifest sem ícones' };
          if (!j.start_url)   return { detail: 'manifest sem start_url' };
          if (!j.theme_color) return { detail: 'manifest sem theme_color' };
          return null;
        }),
        checkContent('ícone PWA', b + '/icon.svg', { contentType: 'image/svg+xml', marker: '<svg' }),
        checkContent('og coming-soon', b + '/og-coming-soon.png', { contentType: 'image/png' }),
        checkXml('sitemap.xml', b + '/sitemap.xml', { rootTag: '<urlset' }),
        checkContent('robots.txt', b + '/robots.txt', { contentType: 'text/plain', marker: 'Sitemap:' }),
        checkSecurityTxt('security.txt (RFC 9116)', b + '/.well-known/security.txt'),
        checkJson('GPC opt-out', b + '/.well-known/gpc.json', (j) => (j && j.gpc === true ? null : { detail: 'gpc≠true' })),
        checkContent('termos (LGPD)', b + '/termos', { contentType: 'text/html', marker: 'Termos de Uso' }),
        checkContent('privacidade', b + '/privacidade', { contentType: 'text/html', marker: 'Política de Privacidade' }),
        // The support form is gated by a Turnstile widget; if its markup is gone
        // the form can't be submitted, so we assert the widget renders.
        checkContent('formulário de suporte', b + '/suporte', { contentType: 'text/html', marker: 'cf-turnstile' }),
        checkStatusCode('roteamento (404)', b + '/__status_probe_404__', 404),
      ];
    },
  },
  {
    name: 'Fotos — Dashboard', url: 'https://fotos.lucafchala.com/dashboard', marker: '/dashboard/login',
  },
  {
    name: 'Dash', url: 'https://dash.lucafchala.com', marker: 'Painel',
    checks: (b) => [
      checkJson('data.json (PURLs)', b + '/data.json', (j) => (j && Array.isArray(j.redirects) ? null : { detail: 'campo redirects ausente' })),
      checkFreshness('atualidade dos dados', b + '/data.json', { collection: 'redirects' }),
    ],
  },
  {
    name: 'Paste', url: 'https://paste.lucafchala.com', marker: 'Paste',
    checks: (b) => [
      checkJson('pastes.json', b + '/pastes.json', (j) => (j && Array.isArray(j.pastes) ? null : { detail: 'lista de pastes inválida' })),
      checkFreshness('atualidade dos dados', b + '/pastes.json', { collection: 'pastes' }),
    ],
  },
  {
    name: 'URL', url: 'https://url.lucafchala.com', marker: 'url.lucafchala.com',
    checks: (b) => [
      checkJson('data.json (redirects)', b + '/data.json', (j) => (j && Array.isArray(j.redirects) ? null : { detail: 'campo redirects ausente' })),
      checkFreshness('atualidade dos dados', b + '/data.json', { collection: 'redirects' }),
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
    name: 'Edifício Maison Blanche', url: 'https://edificio-maison-blanche.lucafchala.com', marker: 'Maison Blanche',
  },
  {
    // The static page is the front end; the real functional surface is the
    // Worker it POSTs/GETs to. Both get checked: the page renders, and the
    // leaderboard Worker (a separate origin, not covered by the primary probe)
    // actually answers with the shape the front end expects.
    name: 'Restricted', url: 'https://restricted.lucafchala.com', marker: 'restricted.lucafchala.com',
    checks: () => [
      checkJson('leaderboard (Worker)', 'https://ctf-leaderboard.lucafchala.workers.dev/?action=list', (j) => (
        j && Array.isArray(j.entries) ? null : { detail: 'campo entries ausente' }
      )),
    ],
  },
  {
    // The dashboard monitors itself: its own /api/healthz exposes whether the
    // STATUS_KV binding, the Resend key, and the admin recipient are present —
    // the exact config drift that silently breaks alerting/subscriptions. (A
    // *total* status-page outage can't self-report, since /api/status wouldn't
    // run; the GitHub Actions monitor's non-200 is the backstop for that.)
    name: 'Status', url: 'https://status.lucafchala.com', marker: 'monitoramento de serviços',
    checks: (b, env) => [
      checkJson('saúde · KV/Resend/notify', b + '/api/healthz', (j) => {
        if (!j) return { detail: 'healthz inválido' };
        const probs = [];
        if (j.kv === false)        probs.push('STATUS_KV ausente (alertas/inscrições off)');
        if (j.resendKey === false) probs.push('RESEND_API_KEY ausente (sem e-mail)');
        if (j.notifyTo === false)  probs.push('NOTIFY_TO ausente (sem destinatário)');
        if (probs.length) return { detail: probs.join(' · ') };
        // Healthy: report the reach of an alert. Zero subscribers is a valid
        // state (NOTIFY_TO still gets everything), so it's shown, not flagged.
        const bits = [];
        if (typeof j.subscribers === 'number') bits.push(`${j.subscribers} inscrito${j.subscribers === 1 ? '' : 's'}`);
        if (j.cloudflareApi === false) bits.push('cotas não monitoradas');
        return bits.length ? { status: 'up', detail: bits.join(' · ') } : null;
      }),
      // Config presence (above) only proves the key *exists*; this proves it is
      // still accepted and the sender domain is still verified.
      checkResend('entrega de alertas (Resend)', env),
    ],
  },
];

async function checkService(svc, env) {
  const primary = await probePrimary(svc.url, svc.marker, svc.degradedMs);
  const extra = svc.checks ? await Promise.all(svc.checks(svc.url, env, primary.text)) : [];

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
export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(context.request.url);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const services = await Promise.all(SERVICES.map((s) => checkService(s, context.env)));
  const res = new Response(JSON.stringify({ services, checkedAt: new Date().toISOString() }), {
    // s-maxage caches at the edge only; max-age=0 keeps browsers revalidating
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=0, s-maxage=30' },
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
const _fallback = { lastStatus: null, notifiedAt: new Map() };

// Free-tier headroom joins change detection, so a limit that starts running out
// reaches the inbox instead of waiting to be spotted on the dashboard. Fetched
// over HTTP rather than recomputed, so the endpoint's own 5-minute edge cache
// absorbs the cost of running this on every sweep (including the 10-min cron).
//
// `quiesceOnRecovery` marks these as worsening-only: the daily counters reset at
// UTC midnight, so a quota that peaked yesterday "recovers" every single night.
// Emailing that — or logging it as an incident — would be pure clockwork noise.
async function quotaEntries(origin) {
  try {
    const res = await fetchSvc(origin + '/api/quota-stats', { headers: { Accept: 'application/json' } });
    if (!res.ok) { res.body?.cancel(); return []; }
    const j = await res.json();
    if (!j || j.configured === false) return [];

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
        problems: q.status === 'up' ? [] : [
          `${q.label}: ${q.pct}% usado${q.remaining != null ? ` · restam ${q.remaining.toLocaleString('pt-BR')}` : ''}${q.period === 'dia' ? ' hoje (zera à meia-noite UTC)' : ''}`,
        ],
      });
    }
    for (const c of j.certs || []) {
      entries.push({
        name: `TLS · ${c.zone}`,
        status: c.status,
        url: origin,
        quiesceOnRecovery: true,
        problems: c.status === 'up' ? [] : [`certificado de ${c.zone}: ${c.detail}`],
      });
    }
    return entries;
  } catch {
    // Quota visibility failing must never take the service sweep's alerting
    // down with it.
    return [];
  }
}

export async function detectAndNotify(env, services, origin) {
  const KV = env.STATUS_KV;
  if (!KV) return;

  // Services and quota rows run through one pipeline from here: same change
  // detection, same severity, same per-name cooldown, same batched e-mail.
  const tracked = [
    ...services.map((s) => ({
      name: s.name, status: s.status, url: s.url,
      problems: s.problems, quiesceOnRecovery: false,
    })),
    ...(await quotaEntries(origin)),
  ];

  let prev = {};
  try { prev = JSON.parse(await KV.get('last_status') || '{}') || {}; } catch { prev = {}; }
  // Só existe depois de uma gravação recusada, e nesse caso o KV está velho de
  // propósito: quem sabe o estado mais recente é o espelho.
  if (_fallback.lastStatus) prev = { ...prev, ..._fallback.lastStatus };

  // Write last_status ONLY when something actually changed. KV writes are the
  // tightest free-tier limit (1k/day, shared account-wide with the fotos site),
  // and the sweep runs every 5 min from the cron — so an unconditional write was
  // ~288 wasted writes/day on a value that rarely changes. Now: ~0 in steady
  // state, a write only on a real transition.
  const next = {};
  let changed = false;
  for (const s of tracked) {
    next[s.name] = s.status;
    if (prev[s.name] !== s.status) changed = true;
  }
  if (!changed) {
    for (const k of Object.keys(prev)) { if (!(k in next)) { changed = true; break; } } // a service was removed
  }
  // Every real transition, logged. This is what lets a green dashboard still
  // answer "was it already broken an hour ago?" — and it rides along inside the
  // `changed` block precisely so it costs nothing in steady state. Transitions
  // are recorded even when e-mail is unconfigured: the log is a record of what
  // happened, not a side effect of alerting.
  const transitions = tracked
    .filter((s) => prev[s.name] && prev[s.name] !== s.status)
    // A quota falling back to `up` is the UTC-midnight reset, not a recovery.
    // Its new state is still recorded below, so the next crossing alerts again —
    // it just doesn't announce the clock.
    .filter((s) => !(s.quiesceOnRecovery && s.status === 'up'))
    .map((s) => ({
      name: s.name,
      from: prev[s.name],
      to: s.status,
      at: new Date().toISOString(),
      severity: severityOf(prev[s.name], s.status),
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
  // em ~48 escritas/dia em vez das 288 de uma gravação por varredura.
  if (shouldSample()) {
    try {
      const series = await readLatency(KV);
      const sample = buildSample(services);
      if (sample) await KV.put(LATENCY_KEY, JSON.stringify(trimLatency([sample, ...series])));
    } catch (e) {
      // Telemetria nunca pode derrubar a varredura que ela observa.
      console.error('latency sample failed', e);
    }
  }

  if (!env.RESEND_API_KEY || !env.NOTIFY_TO) return;

  // Severity floor, so a noisy class of change can be muted without giving up
  // alerting entirely (ALERT_MIN_SEVERITY=atencao mutes recovery notices;
  // =critico pages only for hard outages). Defaults to alerting on everything.
  const floor = SEVERITY_RANK[env.ALERT_MIN_SEVERITY] ?? SEVERITY_RANK.info;

  const changes = [];
  const now = Date.now();
  for (const t of transitions) {
    if (SEVERITY_RANK[t.severity] < floor) continue;
    const s = tracked.find((x) => x.name === t.name);
    // KV is eventually consistent, so two colos sweeping at once can rarely
    // double-send; the cooldown still bounds it to ~1 extra email per hour.
    let onCooldown = false;
    try { onCooldown = !!(await KV.get(`notify_sent:${t.name}`)); } catch { onCooldown = false; }
    // Cooldown que não pôde ser GRAVADO não protege nada: sem este segundo
    // olhar, uma cota estourada faria a mesma transição render e-mail a cada
    // varredura (a cada 10 min pelo cron, a cada 60 s com o painel aberto).
    if (!onCooldown) {
      const last = _fallback.notifiedAt.get(t.name);
      if (last && now - last < NOTIFY_COOLDOWN_S * 1000) onCooldown = true;
    }
    if (onCooldown) continue;
    try {
      await KV.put(`notify_sent:${t.name}`, '1', { expirationTtl: NOTIFY_COOLDOWN_S });
    } catch (e) {
      console.error('notify cooldown write failed (cota de KV?)', e);
    }
    // Marcado sempre, tenha o KV aceitado ou não: é o que segura o teto quando
    // a gravação falhou.
    _fallback.notifiedAt.set(t.name, now);
    changes.push({ ...t, url: s ? s.url : '' });
  }
  if (changes.length === 0) return;

  await sendAlerts(env, changes).catch(e => console.error('status alert email failed', e));
}

async function sendAlerts(env, changes) {
  const { RESEND_API_KEY, NOTIFY_TO, NOTIFY_FROM = 'status@lucafchala.com', STATUS_KV: KV } = env;

  let subscribers = [];
  try { subscribers = JSON.parse(await KV.get('subscribers') || '[]') || []; } catch { subscribers = []; }
  if (!Array.isArray(subscribers)) subscribers = [];

  const deduped = [...new Set([NOTIFY_TO, ...subscribers.map(s => s.email)])];

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

  const batch = deduped.map(email => {
    const sub = subscribers.find(s => s.email === email);
    const unsubUrl = sub
      ? `https://status.lucafchala.com/api/unsubscribe?token=${sub.token}`
      : null;
    return { from: NOTIFY_FROM, reply_to: NOTIFY_FROM, to: [email], subject, html: alertHtml(rows, unsubUrl) };
  });

  await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });
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
