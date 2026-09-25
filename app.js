// Painel de status — o script da página.
// Em arquivo para a CSP poder dizer script-src 'self' sem 'unsafe-inline'.
//
// Layout no padrão das páginas de status da indústria: uma faixa-resumo com
// o estado de tudo numa frase; cada serviço com barras de histórico (uma por
// dia com o retrato em D1, uma por hora sem ele) e a disponibilidade; os
// incidentes das últimas 48 h numa linha do tempo; latência, terceiros e
// cotas embaixo.

const SERVICES = [
  { name: 'lucafchala.com',      url: 'https://lucafchala.com',                group: 'principal' },
  { name: 'Rádio',               url: 'https://radio.lucafchala.com',           group: 'principal' },
  { name: 'Status',              url: 'https://status.lucafchala.com',          group: 'principal' },
  { name: 'Fotos',               url: 'https://fotos.lucafchala.com',           group: 'apps' },
  { name: 'Fotos — Dashboard',   url: 'https://fotos.lucafchala.com/dashboard', group: 'apps' },
  { name: 'Dash',                url: 'https://dash.lucafchala.com',            group: 'apps' },
  { name: 'Paste',               url: 'https://paste.lucafchala.com',           group: 'apps' },
  { name: 'URL',                 url: 'https://url.lucafchala.com',             group: 'apps' },
  { name: 'Keys',                url: 'https://keys.lucafchala.com',            group: 'apps' },
  { name: 'Proof',               url: 'https://proof.lucafchala.com',           group: 'apps' },
  { name: 'RG',                  url: 'https://rg.lucafchala.com',              group: 'apps' },
  { name: 'Pays',                url: 'https://pays.lucafchala.com',            group: 'apps' },
  { name: 'Treino',              url: 'https://treino.lucafchala.com',          group: 'apps' },
];
const GRUPOS = ['principal', 'apps'];

const THIRD_PARTY = [
  { name: 'GitHub',       page: 'https://www.githubstatus.com' },
  { name: 'Cloudflare',   page: 'https://www.cloudflarestatus.com' },
  { name: 'Claude',       page: 'https://status.anthropic.com' },
  { name: 'Resend',       page: 'https://status.resend.com' },
  { name: 'Google Drive', page: 'https://www.google.com/appsstatus/dashboard/' },
];

// ── Idioma ──────────────────────────────────────────────────────────────
// PT/EN da moldura da página. O que vem do servidor (nomes de serviço,
// rótulos e detalhes das verificações, cotas) continua em português: é o
// mesmo texto dos alertas e do histórico, e traduzir no cliente inventaria
// uma segunda fonte da verdade. O `lang` é o cookie `lf_lang`, compartilhado
// com todo o ecossistema (ver tema.js).
const S = {
  pt: {
    g_principal: 'Principais', g_apps: 'Aplicativos',
    st_up: 'operacional', st_degraded: 'degradado', st_down: 'fora do ar', st_unknown: 'sem dados', st_checking: 'verificando',
    hist_loading: (n) => `histórico de ${n} ainda não carregado`,
    checks_of: (n) => `verificações de ${n}`,
    checked_at: (h) => `conferido às ${h}`,
    ok: 'ok',
    n_problems: (n) => `${n} problema${n > 1 ? 's' : ''}`,
    n_checks_ok: (n) => `${n} verificaç${n > 1 ? 'ões' : 'ão'} ok`,
    ago: (x) => `há ${x}`,
    was: (st, quando, dur) => `esteve ${st} ${quando} · durou ${dur}`,
    version: 'versão',
    no_data_bar: 'sem dado',
    available: (p) => `${p} disponível`,
    n_down_sweeps: (n) => `${n} varredura${n > 1 ? 's' : ''} fora do ar`,
    n_slow: (n) => `${n} degradada${n > 1 ? 's' : ''}`,
    of_n: (n) => `de ${n}`,
    hist_unavailable: 'histórico indisponível',
    legend_daily: (n) => `${n} dias · 1 barra por dia`,
    legend_hourly: (n) => `${n} h · 1 barra por hora (sem banco: reconstruído das transições)`,
    hist_of_unavailable: (n) => `histórico de ${n} indisponível`,
    bars_aria: (nome, n, diario, pct, down, deg, nd) => `${nome}, últimos ${n} ${diario ? 'dias' : 'h'}: ${pct == null ? 'sem dados' : fmtPct(pct) + ' disponível'}` +
      `${down ? `; ${down} ${diario ? 'dias' : 'horas'} com queda` : ''}` +
      `${deg ? `; ${deg} ${diario ? 'dias degradados' : 'horas degradadas'}` : ''}` +
      `${nd ? `; ${nd} sem dado` : ''}`,
    days_ago: (n) => `${n} dias atrás`, hours_ago: (n) => `${n} h atrás`,
    today: 'hoje', now: 'agora', yesterday: 'ontem',
    no_data_yet: 'sem dados ainda',
    all_up: 'Todos os sistemas operacionais',
    n_checked: (n) => `${n} serviços verificados`,
    all_down: 'Interrupção generalizada',
    all_down_sub: 'nenhum serviço respondeu como deveria',
    n_bad: (n) => `${n} serviços com problema`,
    no_answer: 'Sem resposta do servidor de status',
    no_answer_sub: 'estado desconhecido — nova tentativa automática',
    checked: 'verificado', just_now: 'agora há pouco', never_checked: 'ainda sem verificação',
    server_silent: 'sem resposta do servidor', scheduler_late: 'agendador atrasado',
    next_in: (x) => `próxima atualização em ${x}`, lt_1min: 'menos de 1 min',
    paused: 'pausado (aba em segundo plano)',
    unstable: (x) => `instável: ${x}`, n_changes: (n) => `${n} mudanças`,
    no_incidents: 'Nenhum incidente nas últimas 48 h.',
    ongoing: 'em andamento', since: 'desde', lasted: 'durou',
    trend_title: 'mediana recente vs. anterior',
    slowing: (x) => `ficando mais lento: ${x}`,
    samples: (n, min) => `${n} amostras · ${min ? `1 a cada ${min} min` : '1 por varredura'} · linha tracejada = deploy`,
    quotas_unread: 'cotas não lidas agora',
    not_monitored: 'não monitorado', no_cf_token: 'sem token da API da Cloudflare',
    unread: (x) => `não lido: ${x}`,
    per_worker: 'Por Worker, hoje', th_script: 'script', th_req: 'requisições', th_err: 'erros',
    hourly_title: (s) => `${s} · últimas 24 h, por hora`,
    hourly_bar: (q, r, e, c) => `${q}: ${r} requisições · ${e} erros · CPU p99 ${c} ms`,
    hourly_aria: (s, r, e, c) => `${s}, últimas 24 horas: ${r} requisições, ${e} com erro, CPU p99 máxima ${c} ms`,
    hourly_sum: (r, e, c) => `${r} requisições · ${e} com erro · CPU p99 máx. ${c} ms`,
    do_today: (r) => `Durable Objects hoje: ${r} requisições`,
    refreshing: '↻ atualizando…', refresh: '↻ atualizar',
    theme_light: 'claro', theme_dark: 'escuro', theme_aria: (x) => `mudar para o tema ${x}`,
    lang_btn: 'EN', lang_aria: 'Switch to English',
    sub_bad_email: 'Confira o endereço de e-mail.',
    sub_error: 'Erro — tente novamente.',
    sub_network: 'Falha de rede — tente novamente.',
    sub_button: 'Inscrever',
    sub_captcha: 'Complete a verificação anti-robô.',
  },
  en: {
    g_principal: 'Main', g_apps: 'Apps',
    st_up: 'operational', st_degraded: 'degraded', st_down: 'down', st_unknown: 'no data', st_checking: 'checking',
    hist_loading: (n) => `${n} history not loaded yet`,
    checks_of: (n) => `${n} checks`,
    checked_at: (h) => `checked at ${h}`,
    ok: 'ok',
    n_problems: (n) => `${n} problem${n > 1 ? 's' : ''}`,
    n_checks_ok: (n) => `${n} check${n > 1 ? 's' : ''} ok`,
    ago: (x) => `${x} ago`,
    was: (st, quando, dur) => `was ${st} ${quando} · lasted ${dur}`,
    version: 'version',
    no_data_bar: 'no data',
    available: (p) => `${p} available`,
    n_down_sweeps: (n) => `${n} sweep${n > 1 ? 's' : ''} down`,
    n_slow: (n) => `${n} degraded`,
    of_n: (n) => `of ${n}`,
    hist_unavailable: 'history unavailable',
    legend_daily: (n) => `${n} days · 1 bar per day`,
    legend_hourly: (n) => `${n} h · 1 bar per hour (no database: rebuilt from transitions)`,
    hist_of_unavailable: (n) => `${n} history unavailable`,
    bars_aria: (nome, n, diario, pct, down, deg, nd) => `${nome}, last ${n} ${diario ? 'days' : 'h'}: ${pct == null ? 'no data' : fmtPct(pct) + ' available'}` +
      `${down ? `; ${down} ${diario ? 'days' : 'hours'} with an outage` : ''}` +
      `${deg ? `; ${deg} ${diario ? 'days' : 'hours'} degraded` : ''}` +
      `${nd ? `; ${nd} without data` : ''}`,
    days_ago: (n) => `${n} days ago`, hours_ago: (n) => `${n} h ago`,
    today: 'today', now: 'now', yesterday: 'yesterday',
    no_data_yet: 'no data yet',
    all_up: 'All systems operational',
    n_checked: (n) => `${n} services checked`,
    all_down: 'Widespread outage',
    all_down_sub: 'no service answered as expected',
    n_bad: (n) => `${n} services with problems`,
    no_answer: 'No answer from the status server',
    no_answer_sub: 'state unknown — retrying automatically',
    checked: 'checked', just_now: 'just now', never_checked: 'not checked yet',
    server_silent: 'no answer from the server', scheduler_late: 'scheduler running late',
    next_in: (x) => `next update in ${x}`, lt_1min: 'under 1 min',
    paused: 'paused (tab in background)',
    unstable: (x) => `flapping: ${x}`, n_changes: (n) => `${n} changes`,
    no_incidents: 'No incidents in the last 48 h.',
    ongoing: 'ongoing', since: 'since', lasted: 'lasted',
    trend_title: 'recent median vs. previous',
    slowing: (x) => `getting slower: ${x}`,
    samples: (n, min) => `${n} samples · ${min ? `1 every ${min} min` : '1 per sweep'} · dashed line = deploy`,
    quotas_unread: 'quotas not read right now',
    not_monitored: 'not monitored', no_cf_token: 'no Cloudflare API token',
    unread: (x) => `not read: ${x}`,
    per_worker: 'Per Worker, today', th_script: 'script', th_req: 'requests', th_err: 'errors',
    hourly_title: (s) => `${s} · last 24 h, hourly`,
    hourly_bar: (q, r, e, c) => `${q}: ${r} requests · ${e} errors · CPU p99 ${c} ms`,
    hourly_aria: (s, r, e, c) => `${s}, last 24 hours: ${r} requests, ${e} with errors, max CPU p99 ${c} ms`,
    hourly_sum: (r, e, c) => `${r} requests · ${e} with errors · max CPU p99 ${c} ms`,
    do_today: (r) => `Durable Objects today: ${r} requests`,
    refreshing: '↻ refreshing…', refresh: '↻ refresh',
    theme_light: 'light', theme_dark: 'dark', theme_aria: (x) => `switch to ${x} theme`,
    lang_btn: 'PT', lang_aria: 'Mudar para português',
    sub_bad_email: 'Check the e-mail address.',
    sub_error: 'Error — please try again.',
    sub_network: 'Network error — please try again.',
    sub_button: 'Subscribe',
    sub_captcha: 'Complete the anti-bot check.',
  },
};

// Textos estáticos do HTML (data-i18n). O português está no próprio HTML e é
// o que aparece sem JavaScript; aqui só o inglês.
const HTML_EN = {
  skip: 'Skip to services',
  brand_aria: 'Status lucafchala.com — home',
  nav_aria: 'Actions',
  alerts_btn: 'Get alerts',
  home: 'home',
  sub_text: 'An e-mail when a service goes down, degrades or comes back. You can unsubscribe from the link in every message.',
  sub_label: 'Your e-mail',
  sub_ok: 'Subscribe',
  cancel: 'Cancel',
  sub_consent: 'We store only your address, to send these alerts. Nothing is saved until you confirm by e-mail; the link in each message removes it.',
  sub_pending: '✓ Almost there: if this address is not subscribed yet, we sent a confirmation link. It is valid for 24 hours.',
  h_services: 'Services',
  h_incidents: 'Recent incidents',
  h_latency: 'Response time',
  latency_note: '48 h · median and p95',
  h_third: 'Third-party services',
  third_note: 'that the ecosystem depends on',
  h_quotas: 'Cloudflare account quotas',
  quotas_note: 'today, UTC window',
  legend_aria: 'Bar legend',
  lg_up: 'operational', lg_degraded: 'degraded', lg_down: 'down', lg_nd: 'no data',
  loading: 'loading…',
  checking_all: 'Checking services…',
  history: 'history',
};

let lang = (window.lfPrefs && window.lfPrefs.lang) === 'en' ? 'en' : 'pt';
const HTML_PT = {};

function t(k, ...args) {
  const v = S[lang][k] ?? S.pt[k];
  return typeof v === 'function' ? v(...args) : v;
}
const locale = () => (lang === 'en' ? 'en-GB' : 'pt-BR');

function aplicarIdiomaHtml() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'pt-BR';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.dataset.i18n;
    if (!(k in HTML_PT)) HTML_PT[k] = el.textContent;
    el.textContent = lang === 'en' ? (HTML_EN[k] ?? HTML_PT[k]) : HTML_PT[k];
  });
  document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((par) => {
      const [attr, k] = par.split(':');
      const chave = attr + ':' + k;
      if (!(chave in HTML_PT)) HTML_PT[chave] = el.getAttribute(attr) || '';
      el.setAttribute(attr, lang === 'en' ? (HTML_EN[k] ?? HTML_PT[chave]) : HTML_PT[chave]);
    });
  });
  const b = document.getElementById('btn-lang');
  if (b) { b.textContent = t('lang_btn'); b.setAttribute('aria-label', t('lang_aria')); b.setAttribute('lang', lang === 'en' ? 'pt-BR' : 'en'); }
}

// Cadência. O dado que a página mostra muda quando uma varredura roda, e o
// agendador varre a cada 10 min. Pedir a cada 60 s — como era — pagava dez
// vezes pela mesma resposta, com a aba visível ou não: uma aba esquecida
// aberta eram ~7.200 invocações de Pages Function e ~24 mil requisições no
// Worker do fotos por dia. Agora a próxima atualização mira o momento em que
// a próxima varredura deve ter acontecido, entre 2 e 10 min, e pausa com a
// aba escondida.
const INTERVALO_AGENDADOR_MS = 10 * 60000;
const FOLGA_AGENDADOR_MS = 30000;
const ATUALIZA_MIN_MS = 2 * 60000;
const ATUALIZA_MAX_MS = 10 * 60000;
// Falha seguida dobra a espera (2, 4, 8… até 30 min). Um painel que martela
// um servidor que não responde só piora o incidente que está mostrando.
const BACKOFF_MAX_MS = 30 * 60000;
// O botão manual não fura esse piso: é o mesmo dado de 30 s atrás.
const MANUAL_PISO_MS = 30000;

let refreshTimer = null;
let ageTimer = null;
let checking = false;
let falhasSeguidas = 0;
let ultimaAtualizacao = 0;     // relógio do navegador, fim da última tentativa
let ultimaVarredura = null;    // checkedAt da última varredura recebida (ms)
let proximaEm = null;          // quando a próxima atualização está marcada (ms)
let modoRetrato = null;        // o servidor tem retrato compartilhado? (null: ainda não sei)
let retratoAtrasado = false;   // o agendador passou da hora
let ultimoAnuncio = '';        // o que a região aria-live disse por último
let resultados = [];           // última varredura aplicada
let historicoAtual = null;     // último /api/painel → historico
let barrasAtuais = null;       // último /api/painel → barras
let ultimoPainel = null;       // último /api/painel inteiro (para redesenhar ao trocar o idioma)

// ── Rede ────────────────────────────────────────────────────────────────
// Resposta que não é 2xx, ou corpo que não é JSON, conta como falha — não
// como "tudo offline". Quem não conseguiu perguntar não sabe a resposta.
async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function fetchStatus() {
  const json = await getJson('/api/status');
  if (!json || !Array.isArray(json.services)) throw new Error('resposta sem services');
  return json;
}

// Tudo o que a página lê numa chamada (functions/api/painel.js).
async function fetchPainel() {
  return getJson('/api/painel');
}

// Quanto esperar até a próxima atualização.
function proximaEspera(agora) {
  if (falhasSeguidas > 0) {
    return Math.min(ATUALIZA_MIN_MS * Math.pow(2, falhasSeguidas - 1), BACKOFF_MAX_MS);
  }
  if (ultimaVarredura == null) return ATUALIZA_MAX_MS;
  const alvo = ultimaVarredura + INTERVALO_AGENDADOR_MS + FOLGA_AGENDADOR_MS;
  return Math.min(ATUALIZA_MAX_MS, Math.max(ATUALIZA_MIN_MS, alvo - agora));
}

function agendar() {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  // Aba escondida não agenda nada: ninguém está olhando, e quem voltar
  // recebe uma atualização na hora (ver visibilitychange no fim).
  if (document.hidden) { proximaEm = null; return; }
  const espera = proximaEspera(Date.now());
  proximaEm = Date.now() + espera;
  refreshTimer = setTimeout(runChecks, espera);
}

// ── Formatação ──────────────────────────────────────────────────────────
// Estado nunca só por cor: cada um tem ícone e palavra.
const ESTADOS = {
  up:       { ic: '✓' },
  degraded: { ic: '!' },
  down:     { ic: '✕' },
  unknown:  { ic: '?' },
  checking: { ic: '…' },
};
const estadoDe = (s) => {
  const k = s in ESTADOS ? s : 'unknown';
  return { ic: ESTADOS[k].ic, txt: t('st_' + k) };
};
function statusLabel(s) { return estadoDe(s).txt; }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function fmtNum(n) { return n == null ? '—' : n.toLocaleString(locale()); }

function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

function fmtAge(ms) {
  if (ms == null) return '';
  const d = Math.floor(ms / 86400000); if (d >= 1) return d + ' d';
  const h = Math.floor(ms / 3600000);  if (h >= 1) return h + ' h';
  return Math.max(1, Math.floor(ms / 60000)) + ' min';
}

function fmtDur(ms) {
  if (ms == null || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 60) return Math.max(1, min) + ' min';
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  const v = p === 100 ? '100' : p.toFixed(p >= 99.95 ? 3 : 2);
  return (lang === 'en' ? v : v.replace('.', ',')) + ' %';
}

const FMT_HORA = { hour: '2-digit', minute: '2-digit' };
const FMT_DIA = { day: '2-digit', month: 'short' };
function hora(ms) { return new Date(ms).toLocaleTimeString(locale(), FMT_HORA); }
function dia(ms) { return new Date(ms).toLocaleDateString(locale(), FMT_DIA).replace('.', ''); }
function timeTag(ms, texto) {
  return `<time datetime="${new Date(ms).toISOString()}" title="${esc(new Date(ms).toLocaleString(locale()))}">${esc(texto)}</time>`;
}

function rtLabel(rt, status) {
  if (status === 'down' || rt == null) return '';
  if (rt >= 1000) { const v = (rt / 1000).toFixed(1); return (lang === 'en' ? v : v.replace('.', ',')) + ' s'; }
  return rt + ' ms';
}

function codeLabel(code) {
  if (!code || (code >= 200 && code < 400)) return '';
  return 'HTTP ' + code;
}

function mostra(id, sim) { const el = document.getElementById(id); if (el) el.hidden = !sim; }

// ── Esqueleto ───────────────────────────────────────────────────────────
function renderSkeletons() {
  const list = document.getElementById('services-list');
  list.innerHTML = GRUPOS.map((g) => `
    <div class="grupo">
      <h3 class="grupo-titulo">${esc(t('g_' + g))}</h3>
      <ul class="componentes">
        ${SERVICES.map((svc, i) => svc.group !== g ? '' : `
        <li class="componente" id="svc-${i}">
          <div class="comp-linha">
            <div class="comp-nome">
              <a href="${esc(svc.url)}" target="_blank" rel="noopener">${esc(svc.name)}</a>
              <span class="comp-url">${esc(svc.url.replace('https://', ''))}</span>
            </div>
            <span class="estado checking" id="lbl-${i}"><span class="estado-ic" aria-hidden="true">…</span><span>${esc(t('st_checking'))}</span></span>
          </div>
          <p class="comp-nota" id="hist-${i}"></p>
          <div class="barras" id="barras-${i}" role="img" aria-label="${esc(t('hist_loading', svc.name))}"></div>
          <div class="barras-rodape" aria-hidden="true">
            <span id="barras-ini-${i}"></span>
            <span class="uptime" id="uptime-${i}"></span>
            <span id="barras-fim-${i}"></span>
          </div>
          <p class="barra-info" id="barra-info-${i}" aria-hidden="true"></p>
          <div class="comp-meta">
            <span id="rt-${i}"></span>
            <span id="code-${i}"></span>
            <span id="up24-${i}"></span>
            <button class="checks-toggle" id="toggle-${i}" type="button" aria-expanded="false"
                    aria-controls="checks-${i}" data-action="checks" data-i="${i}" hidden></button>
          </div>
          <ul class="checks" id="checks-${i}" aria-label="${esc(t('checks_of', svc.name))}"></ul>
        </li>`).join('')}
      </ul>
    </div>`).join('');
}

function renderThirdPartySkeletons() {
  const list = document.getElementById('third-party-list');
  list.innerHTML = THIRD_PARTY.map((svc, i) => `
    <li>
      <a class="tp" href="${esc(svc.page)}" target="_blank" rel="noopener">
        <span class="tp-info"><span class="tp-nome">${esc(svc.name)}</span><span class="tp-desc" id="tp-desc-${i}">${esc(svc.page.replace('https://', ''))}</span></span>
        <span class="estado checking" id="tp-lbl-${i}"><span class="estado-ic" aria-hidden="true">…</span><span>${esc(t('st_checking'))}</span></span>
      </a>
    </li>`).join('');
}

function pintarEstado(el, status) {
  if (!el) return;
  const e = estadoDe(status);
  el.className = `estado ${status in ESTADOS ? status : 'unknown'}`;
  el.innerHTML = `<span class="estado-ic" aria-hidden="true">${e.ic}</span><span>${esc(e.txt)}</span>`;
}

// ── Serviços ────────────────────────────────────────────────────────────
function updateServiceRow(i, result) {
  if (i < 0) return;
  pintarEstado(document.getElementById(`lbl-${i}`), result.status);
  const rt = document.getElementById(`rt-${i}`);
  const code = document.getElementById(`code-${i}`);
  if (rt) rt.textContent = rtLabel(result.rt, result.status);
  if (code) code.textContent = codeLabel(result.statusCode);
  renderChecks(i, result);
}

// Detalhe de cada serviço. Um serviço com qualquer verificação falhando abre
// sozinho (o problema nunca fica atrás de um clique); um saudável recolhe
// atrás de "N verificações ok".
function renderChecks(i, result) {
  const panel  = document.getElementById(`checks-${i}`);
  const toggle = document.getElementById(`toggle-${i}`);
  if (!panel || !toggle) return;

  const checks = result.checks || [];
  if (!checks.length) { toggle.hidden = true; panel.classList.remove('show'); panel.innerHTML = ''; return; }

  panel.innerHTML = checks.map(c => {
    const e = estadoDe(c.status);
    const quando = c.verificadoEm && Number.isFinite(Date.parse(c.verificadoEm))
      ? ` <span class="check-quando">· ${esc(t('checked_at', '')).trim()} ${timeTag(Date.parse(c.verificadoEm), hora(Date.parse(c.verificadoEm)))}</span>` : '';
    return `
    <li class="check ${esc(c.status)}">
      <span class="check-ic" aria-hidden="true">${e.ic}</span>
      <span class="check-label"><span class="sr-only">${esc(e.txt)}: </span>${esc(c.label)}${quando}</span>
      <span class="check-detail">${esc(c.detail || (c.status === 'up' ? t('ok') : e.txt))}</span>
    </li>`;
  }).join('');

  const problems = checks.filter(c => c.status !== 'up').length;
  toggle.hidden = false;
  toggle.classList.toggle('has-problems', problems > 0);
  const aberto = problems > 0 || panel.classList.contains('show');
  panel.classList.toggle('show', aberto);
  toggle.setAttribute('aria-expanded', aberto ? 'true' : 'false');
  toggle.dataset.rotulo = problems > 0 ? t('n_problems', problems) : t('n_checks_ok', checks.length);
  toggle.textContent = `${aberto ? '▾' : '▸'} ${toggle.dataset.rotulo}`;
}

function toggleChecks(i) {
  const panel  = document.getElementById(`checks-${i}`);
  const toggle = document.getElementById(`toggle-${i}`);
  if (!panel || !toggle) return;
  const open = panel.classList.toggle('show');
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.textContent = `${open ? '▾' : '▸'} ${toggle.dataset.rotulo || ''}`;
}

// A versão implantada que o serviço declara (hoje só o fotos, pelo healthz).
function versaoDe(result) {
  const c = (result && result.checks || []).find(x => x && x.versao);
  return c ? c.versao : null;
}

// Nota sob o nome: o incidente recente (o que responde "isto é novo ou é o
// mesmo problema de uma hora atrás?") e o último deploy, se recente.
function applyServiceNotes(historico) {
  const svcs = (historico && historico.services) || {};
  SERVICES.forEach((s, i) => {
    const el = document.getElementById(`hist-${i}`);
    if (!el) return;
    const partes = [];
    const inc = svcs[s.name] && svcs[s.name].lastIncident;
    if (inc) {
      partes.push(inc.resolved
        ? t('was', esc(statusLabel(inc.severity)), timeTag(Date.parse(inc.endedAt), t('ago', fmtAge(inc.agoMs))), esc(fmtDur(inc.durationMs)))
        : `<span class="${esc(inc.severity)}">${esc(statusLabel(inc.severity))} ${timeTag(Date.parse(inc.startedAt), t('ago', fmtAge(inc.durationMs)))}</span>`);
    }
    const r = resultados.find(x => x.name === s.name);
    const v = versaoDe(r);
    const em = v && Date.parse(v.em);
    if (v && Number.isFinite(em) && Date.now() - em < 48 * 3600000) {
      partes.push(`<span class="selo" title="${esc(t('version'))} ${esc(v.id)}">deploy ${esc(v.tag || v.id.slice(0, 8))} ${timeTag(em, t('ago', fmtAge(Date.now() - em)))}</span>`);
    }
    el.innerHTML = partes.join(' · ');
  });
}

// ── Barras de histórico ─────────────────────────────────────────────────
function rotuloPeriodo(barras, k) {
  const p = barras.periodos[k];
  if (!p) return '';
  if (barras.tipo === 'diario') {
    const [y, m, d] = p.inicio.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' }).replace('.', '');
  }
  const ini = Date.parse(p.inicio);
  return `${dia(ini)}, ${hora(ini)}–${hora(ini + 3600000)}`;
}

function descreveBarra(barras, nome, k) {
  const b = (barras.servicos[nome] || [])[k] || { estado: null };
  const quando = rotuloPeriodo(barras, k);
  if (!b.estado) return `${quando}: ${t('no_data_bar')}`;
  const partes = [`${quando}: ${statusLabel(b.estado)}`];
  if (b.pct != null) partes.push(t('available', fmtPct(b.pct)));
  if (b.fora) partes.push(t('n_down_sweeps', b.fora));
  if (b.lentas) partes.push(t('n_slow', b.lentas));
  if (b.varreduras) partes.push(t('of_n', b.varreduras));
  return partes.join(' · ');
}

// Disponibilidade da janela: média ponderada pelo que se sabe. Dia sem dado
// não entra — nem como 100 %, nem como 0.
function uptimeJanela(lista) {
  let peso = 0, soma = 0;
  for (const b of lista) {
    if (!b || !b.estado || b.pct == null) continue;
    const w = b.varreduras || 1;
    peso += w; soma += w * b.pct;
  }
  return peso ? soma / peso : null;
}

function renderBarras(barras) {
  barrasAtuais = barras && !barras.erro && Array.isArray(barras.periodos) ? barras : null;
  const legenda = document.getElementById('barras-legenda');
  const diario = barrasAtuais && barrasAtuais.tipo === 'diario';
  const n = barrasAtuais ? barrasAtuais.periodos.length : 0;
  if (legenda) {
    legenda.textContent = !barrasAtuais ? t('hist_unavailable')
      : diario ? t('legend_daily', n) : t('legend_hourly', n);
  }
  SERVICES.forEach((s, i) => {
    const el = document.getElementById(`barras-${i}`);
    if (!el) return;
    const ini = document.getElementById(`barras-ini-${i}`);
    const fim = document.getElementById(`barras-fim-${i}`);
    const up = document.getElementById(`uptime-${i}`);
    if (!barrasAtuais) {
      el.innerHTML = ''; el.className = 'barras';
      el.setAttribute('aria-label', t('hist_of_unavailable', s.name));
      if (ini) ini.textContent = ''; if (fim) fim.textContent = ''; if (up) up.textContent = '';
      return;
    }
    const lista = barrasAtuais.servicos[s.name] || barrasAtuais.periodos.map(() => ({ estado: null }));
    el.className = `barras ${diario ? 'diario' : 'horario'}`;
    el.innerHTML = lista.map((b, k) =>
      `<span class="b ${esc(b.estado || 'nd')}" data-action="barra" data-i="${i}" data-k="${k}" title="${esc(descreveBarra(barrasAtuais, s.name, k))}"></span>`,
    ).join('');
    const conta = { up: 0, degraded: 0, down: 0, nd: 0 };
    for (const b of lista) conta[b.estado || 'nd']++;
    const pct = uptimeJanela(lista);
    el.setAttribute('aria-label', t('bars_aria', s.name, n, diario, pct, conta.down, conta.degraded, conta.nd));
    if (ini) ini.innerHTML = diario
      ? `<span class="so-largo">${esc(t('days_ago', n))}</span><span class="so-estreito">${esc(t('days_ago', 30))}</span>`
      : `<span class="so-largo">${esc(t('hours_ago', n))}</span><span class="so-estreito">${esc(t('hours_ago', 24))}</span>`;
    if (fim) fim.textContent = diario ? t('today') : t('now');
    if (up) up.textContent = pct == null ? t('no_data_yet') : t('available', fmtPct(pct));
  });
}

// Toque ou passagem do mouse numa barra: a linha abaixo diz o período.
function mostraBarra(el) {
  if (!barrasAtuais) return;
  const i = Number(el.dataset.i), k = Number(el.dataset.k);
  const info = document.getElementById(`barra-info-${i}`);
  document.querySelectorAll(`#barras-${i} .b.ativa`).forEach(x => x.classList.remove('ativa'));
  el.classList.add('ativa');
  if (info) info.textContent = descreveBarra(barrasAtuais, SERVICES[i].name, k);
}

function applyUptime(uptime) {
  const h24 = (uptime && uptime.h24) || {};
  const h48 = (uptime && uptime.h48) || {};
  SERVICES.forEach((s, i) => {
    const el = document.getElementById(`up24-${i}`);
    if (!el) return;
    const a = h24[s.name] && h24[s.name].pct, b = h48[s.name] && h48[s.name].pct;
    el.textContent = a == null && b == null ? '' : `24 h: ${fmtPct(a)} · 48 h: ${fmtPct(b)}`;
  });
}

// ── Faixa-resumo ────────────────────────────────────────────────────────
// Uma frase com o que importa: "tudo operacional", ou QUEM está mal e desde
// quando ("Treino degradado há 12 min"). O "desde quando" vem do histórico.
function updateBanner(results) {
  const faixa = document.getElementById('banner');
  const icone = document.getElementById('banner-icone');
  const text  = document.getElementById('banner-text');
  const sub   = document.getElementById('banner-sub');
  const ruins = results.filter(r => r.status === 'down' || r.status === 'degraded')
    .sort((a, b) => (a.status === 'down' ? 0 : 1) - (b.status === 'down' ? 0 : 1));
  const desde = (nome) => {
    const inc = historicoAtual && historicoAtual.services && historicoAtual.services[nome] && historicoAtual.services[nome].lastIncident;
    return inc && !inc.resolved ? ' ' + t('ago', fmtAge(inc.durationMs)) : '';
  };
  let estado, titulo, detalhe;
  if (!ruins.length) {
    estado = 'up'; titulo = t('all_up');
    detalhe = t('n_checked', results.length);
  } else if (ruins.length === results.length) {
    estado = 'down'; titulo = t('all_down');
    detalhe = t('all_down_sub');
  } else if (ruins.length === 1) {
    const r = ruins[0];
    estado = r.status; titulo = `${r.name} ${statusLabel(r.status)}${desde(r.name)}`;
    detalhe = (r.problems && r.problems[0]) || '';
  } else {
    estado = ruins.some(r => r.status === 'down') ? 'down' : 'degraded';
    titulo = t('n_bad', ruins.length);
    detalhe = ruins.map(r => `${r.name} ${statusLabel(r.status)}${desde(r.name)}`).join(' · ');
  }
  faixa.className = `faixa estado-${estado}`;
  icone.textContent = estadoDe(estado).ic;
  text.textContent = titulo;
  sub.textContent = detalhe;
  anunciar(titulo);
}

function showBannerUnknown() {
  document.getElementById('banner').className = 'faixa estado-unknown';
  document.getElementById('banner-icone').textContent = '?';
  document.getElementById('banner-text').textContent = t('no_answer');
  document.getElementById('banner-sub').textContent = t('no_answer_sub');
  anunciar(t('no_answer'));
}

// Leitor de tela ouve a MUDANÇA, não cada atualização silenciosa.
function anunciar(texto) {
  if (texto === ultimoAnuncio) return;
  ultimoAnuncio = texto;
  const el = document.getElementById('anuncio');
  if (el) el.textContent = texto;
}

// Idade do dado, não hora do pedido. Atualizado a cada 30 s, sem rede.
function updateLastChecked() {
  const el = document.getElementById('last-checked');
  if (!el) return;
  const agora = Date.now();
  const partes = [];
  if (ultimaVarredura != null) {
    // Relógio do navegador adiantado não pode produzir idade negativa.
    const idade = Math.max(0, agora - ultimaVarredura);
    partes.push(esc(t('checked')) + ' ' + timeTag(ultimaVarredura, idade < 60000 ? t('just_now') : t('ago', fmtAge(idade))));
  } else {
    partes.push(esc(t('never_checked')));
  }
  if (falhasSeguidas > 0) partes.push(`<span class="stale">${esc(t('server_silent'))}</span>`);
  else if (retratoAtrasado) partes.push(`<span class="stale">${esc(t('scheduler_late'))}</span>`);
  if (proximaEm != null) {
    const falta = Math.max(0, proximaEm - agora);
    partes.push(esc(t('next_in', falta < 60000 ? t('lt_1min') : fmtAge(falta))));
  } else if (document.hidden) {
    partes.push(esc(t('paused')));
  }
  el.innerHTML = partes.join(' · ');
}

// ── Incidentes ──────────────────────────────────────────────────────────
// Transições (mais nova primeiro) viram incidentes: começa quando sai de
// "operacional", termina quando volta; piora no meio (degradado → fora do ar)
// fica no mesmo incidente, com o pior estado.
function montaIncidentes(entries) {
  const abertos = new Map();
  const lista = [];
  for (const e of entries.slice().reverse()) {
    const em = Date.parse(e.at);
    if (!Number.isFinite(em)) continue;
    const aberto = abertos.get(e.name);
    if (e.to !== 'up') {
      if (aberto) {
        if (e.to === 'down') aberto.pior = 'down';
      } else {
        abertos.set(e.name, { nome: e.name, inicio: em, fim: null, pior: e.to, causa: (e.problems || [])[0] || '' });
      }
    } else if (aberto) {
      aberto.fim = em;
      lista.push(aberto);
      abertos.delete(e.name);
    }
  }
  for (const a of abertos.values()) lista.push(a);
  return lista.sort((a, b) => (b.fim == null) - (a.fim == null) || b.inicio - a.inicio);
}

function renderIncidentes(historico) {
  const el = document.getElementById('incidentes');
  if (!el) return;
  if (!historico || historico.erro || historico.available === false) {
    el.innerHTML = `<p class="vazio">${esc(t('hist_unavailable'))}${historico && historico.detail ? ' — ' + esc(historico.detail) : ''}</p>`;
    return;
  }
  const incs = montaIncidentes(historico.entries || []);
  const flap = (historico.flapping || []).length
    ? `<p class="vazio aviso">${esc(t('unstable', historico.flapping.map(f => `${f.name} (${t('n_changes', f.changes)})`).join(' · ')))}</p>` : '';
  if (!incs.length) {
    el.innerHTML = `<p class="vazio">${esc(t('no_incidents'))}</p>${flap}`;
    return;
  }
  const hoje = new Date().toDateString();
  const ontem = new Date(Date.now() - 86400000).toDateString();
  const grupos = new Map();
  for (const inc of incs) {
    const d = new Date(inc.inicio).toDateString();
    const rot = d === hoje ? t('today') : d === ontem ? t('yesterday') : dia(inc.inicio);
    if (!grupos.has(rot)) grupos.set(rot, []);
    grupos.get(rot).push(inc);
  }
  el.innerHTML = [...grupos.entries()].map(([rot, lista]) => `
    <div class="dia">
      <h3 class="dia-titulo">${esc(rot)}</h3>
      <ul class="dia-lista">
        ${lista.map(inc => {
          const e = estadoDe(inc.pior);
          const quando = inc.fim == null
            ? `<span class="inc-aberto">${esc(t('ongoing'))}</span> · ${esc(t('since'))} ${timeTag(inc.inicio, hora(inc.inicio))} (${esc(fmtDur(Date.now() - inc.inicio))})`
            : `${timeTag(inc.inicio, hora(inc.inicio))} → ${timeTag(inc.fim, hora(inc.fim))} · ${esc(t('lasted'))} ${esc(fmtDur(inc.fim - inc.inicio))}`;
          return `
          <li class="inc ${esc(inc.pior)}">
            <span class="inc-ic" aria-hidden="true">${e.ic}</span>
            <div>
              <div class="inc-titulo"><strong>${esc(inc.nome)}</strong> ${esc(e.txt)}</div>
              <div class="inc-quando">${quando}</div>
              ${inc.causa ? `<div class="inc-causa">${esc(inc.causa)}</div>` : ''}
            </div>
          </li>`;
        }).join('')}
      </ul>
    </div>`).join('') + flap;
}

// ── Latência ────────────────────────────────────────────────────────────
// Sparkline em SVG puro, com o deploy marcado: a causa mais comum de uma
// regressão de latência é um deploy, e ver os dois no mesmo eixo poupa a
// investigação.
function sparkline(pontos, status, deploys) {
  const W = 72, H = 16, P = 1.5;
  if (pontos.length < 2) return '';
  const vs = pontos.map(p => p.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  // Série achatada: uma linha reta no meio é mais honesta que uma divisão por
  // zero ou um traço colado na borda de baixo.
  const span = max - min || 1;
  const t0 = pontos[0].t, t1 = pontos[pontos.length - 1].t, dt = t1 - t0 || 1;
  const x = (ms) => P + ((ms - t0) / dt) * (W - P * 2);
  const d = pontos.map(p => `${x(p.t).toFixed(1)},${(H - P - ((p.v - min) / span) * (H - P * 2)).toFixed(1)}`);
  const marcas = (deploys || []).filter(ms => ms >= t0 && ms <= t1)
    .map(ms => `<line class="deploy" x1="${x(ms).toFixed(1)}" x2="${x(ms).toFixed(1)}" y1="0" y2="${H}"/>`).join('');
  return `<svg class="lat-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${marcas}<path class="${esc(status)}" d="M${d.join('L')}"/></svg>`;
}

function renderLatency(data, implantacoes) {
  const section = document.getElementById('latency-section');
  const panel   = document.getElementById('latency-panel');
  if (!section || !panel) return;
  if (!data || !data.available || !data.samples) { section.hidden = true; return; }
  const svcs = data.services || {};
  const names = Object.keys(svcs);
  if (!names.length) { section.hidden = true; return; }
  section.hidden = false;

  // Deploys por serviço: os da série do D1 e, sem ele, a versão atual.
  const deploys = {};
  for (const d of implantacoes || []) (deploys[d.servico] ||= []).push(Date.parse(d.em));
  for (const r of resultados) {
    const v = versaoDe(r);
    if (v && v.em && !(deploys[r.name] || []).length) (deploys[r.name] ||= []).push(Date.parse(v.em));
  }

  const chrono = (data.entries || []).slice().reverse();
  const rows = names
    .sort((a, b) => {
      const ra = svcs[a].trend.direction === 'piorando' ? 0 : 1;
      const rb = svcs[b].trend.direction === 'piorando' ? 0 : 1;
      return ra - rb || svcs[b].p95 - svcs[a].p95;
    })
    .map(name => {
      const v = svcs[name];
      const pontos = chrono.filter(e => typeof e.rt[name] === 'number').map(e => ({ t: Date.parse(e.at), v: e.rt[name] }));
      const sev = v.p95 >= 2500 ? 'down' : v.p95 >= 1000 ? 'degraded' : 'up';
      const tr = v.trend;
      const arrow = tr.direction === 'piorando' ? '▲' : tr.direction === 'melhorando' ? '▼' : '·';
      const trendTxt = tr.deltaPct == null ? '·' : `${arrow} ${Math.abs(tr.deltaPct)} %`;
      const dep = (deploys[name] || []).filter(Number.isFinite);
      return `
        <div class="lat">
          <span class="lat-name">${esc(name)}${dep.length ? ' <span class="selo">deploy</span>' : ''}</span>
          ${sparkline(pontos, sev, dep)}
          <span class="lat-trend ${esc(tr.direction)}" title="${esc(t('trend_title'))}">${esc(trendTxt)}</span>
          <span class="lat-val">p50 ${v.p50} ms · p95 ${v.p95} ms</span>
        </div>`;
    }).join('');

  const worsening = (data.worsening || []).length
    ? `<div class="panel-empty aviso mt">${
        esc(t('slowing', data.worsening.map(w => `${w.name} (+${w.deltaPct} %)`).join(' · ')))}</div>`
    : '';
  panel.innerHTML = rows + worsening +
    `<div class="panel-empty mt">${esc(t('samples', data.samples, data.intervalMinutes))}</div>`;
}

// ── Terceiros ───────────────────────────────────────────────────────────
// Seção ilegível vira "sem dados" em cada linha, não "fora do ar".
function applyThirdParty(data) {
  const svcs = data && Array.isArray(data.services) ? data.services : null;
  THIRD_PARTY.forEach((s, i) => {
    const r = svcs && svcs.find(x => x.name === s.name);
    pintarEstado(document.getElementById(`tp-lbl-${i}`), r ? r.status : 'unknown');
    const desc = document.getElementById(`tp-desc-${i}`);
    if (desc && r && r.description) desc.textContent = r.description;
  });
}

// ── Cotas ───────────────────────────────────────────────────────────────
// Sem o token, a seção diz "não monitorado" em vez de sumir: uma cota que
// ninguém vigia não pode ter cara de cota que está bem.
function renderQuotas(data) {
  const section = document.getElementById('quota-section');
  const panel   = document.getElementById('quota-panel');
  if (!section || !panel) return;
  section.hidden = false;
  if (!data || data.erro) {
    panel.innerHTML = `<div class="panel-empty aviso">${esc(t('quotas_unread'))}${data && data.erro ? ' — ' + esc(data.erro) : ''}</div>`;
    return;
  }
  if (!data.configured) {
    panel.innerHTML = `<div class="panel-empty">${esc(t('not_monitored'))} — ${esc(data.detail || t('no_cf_token'))}</div>`;
    return;
  }
  const quotas = (data.quotas || []).map(q => {
    const fmt = q.bytes ? fmtBytes : fmtNum;
    // Uma barra que não pinta nada lê como "sem dado"; consumo pequeno mas
    // real ganha um fio visível.
    const width = q.pct == null ? 0 : Math.min(100, q.pct > 0 ? Math.max(q.pct, 1.5) : 0);
    const val = q.used == null ? t('st_unknown') : `${fmt(q.used)} / ${fmt(q.limit)}${q.pct != null ? ` · ${String(q.pct).replace('.', ',')} %` : ''}`;
    return `
      <div class="quota">
        <span class="quota-label">${esc(q.label)}</span>
        <span class="quota-bar" aria-hidden="true"><span class="quota-fill ${esc(q.status)}" data-largura="${width}"></span></span>
        <span class="quota-val ${esc(q.status)}">${esc(val)}</span>
      </div>`;
  }).join('');
  // Certificados não são cota: linha de verificação, não barra.
  const certs = (data.certs || []).map(c => {
    const e = estadoDe(c.status);
    return `
    <div class="check ${esc(c.status)}">
      <span class="check-ic" aria-hidden="true">${e.ic}</span>
      <span class="check-label">TLS · ${esc(c.zone)}</span>
      <span class="check-detail">${esc(c.detail)}</span>
    </div>`;
  }).join('');
  const errors = (data.errors || []).length
    ? `<div class="panel-empty aviso">${esc(t('unread', data.errors.join(' · ')))}</div>` : '';
  panel.innerHTML = quotas + certs + detalheWorkers(data) + errors +
    (data.note ? `<div class="panel-empty mt">${esc(data.note)}</div>` : '');
  // Largura das barras pelo CSSOM: atributo de estilo no HTML a CSP bloqueia.
  panel.querySelectorAll('[data-largura]').forEach(el => { el.style.width = el.dataset.largura + '%'; });
}

// O que a Cloudflare já mede de cada Worker, sem sonda nenhuma: requisições,
// invocações com erro e CPU por script, o fotos hora a hora, e as chamadas a
// Durable Objects (contadores e rate limit do fotos).
function detalheWorkers(data) {
  let html = '';
  const ws = Array.isArray(data.porWorker) ? data.porWorker : null;
  if (ws && ws.length) {
    html += `
      <table class="tabela">
        <caption>${esc(t('per_worker'))}</caption>
        <colgroup><col class="c-script" /><col /><col /><col /></colgroup>
        <thead><tr><th scope="col">${esc(t('th_script'))}</th><th scope="col">${esc(t('th_req'))}</th><th scope="col">${esc(t('th_err'))}</th><th scope="col">CPU p50 / p99</th></tr></thead>
        <tbody>${ws.map(w => `
          <tr>
            <th scope="row" title="${esc(w.script)}">${esc(w.script)}</th>
            <td>${fmtNum(w.requests)}</td>
            <td class="${w.errosPct >= 5 ? 'down' : w.errosPct >= 1 ? 'degraded' : ''}">${fmtNum(w.errors)}${w.errosPct != null ? ` (${String(w.errosPct).replace('.', ',')} %)` : ''}</td>
            <td>${w.cpuP50Ms == null ? '—' : String(w.cpuP50Ms).replace('.', ',')} / ${w.cpuP99Ms == null ? '—' : String(w.cpuP99Ms).replace('.', ',')} ms</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }
  const ph = data.workerPorHora;
  if (ph && Array.isArray(ph.horas) && ph.horas.length) {
    const tot = ph.horas.reduce((a, h) => ({ r: a.r + h.requests, e: a.e + h.errors }), { r: 0, e: 0 });
    const cpuMax = Math.max(...ph.horas.map(h => h.cpuP99Ms || 0));
    const barras = ph.horas.map(h => {
      const pct = h.requests ? (h.errors / h.requests) * 100 : 0;
      const cls = !h.requests ? 'nd' : pct >= 5 ? 'down' : pct > 0 ? 'degraded' : 'up';
      const quando = hora(Date.parse(h.hora));
      return `<span class="b ${cls}" title="${esc(t('hourly_bar', quando, fmtNum(h.requests), fmtNum(h.errors), h.cpuP99Ms ?? '—'))}"></span>`;
    }).join('');
    html += `
      <div class="por-hora">
        <p class="por-hora-titulo">${esc(t('hourly_title', ph.script))}</p>
        <div class="barras curtas" role="img" aria-label="${esc(t('hourly_aria', ph.script, fmtNum(tot.r), fmtNum(tot.e), cpuMax))}">${barras}</div>
        <p class="panel-empty">${esc(t('hourly_sum', fmtNum(tot.r), fmtNum(tot.e), lang === 'en' ? String(cpuMax) : String(cpuMax).replace('.', ',')))}</p>
      </div>`;
  }
  const dobj = data.durableObjects;
  if (dobj && dobj.requests != null) {
    html += `<div class="panel-empty mt">${esc(t('do_today', fmtNum(dobj.requests)))}${
      (dobj.porScript || []).length ? ' (' + esc(dobj.porScript.map(d => `${d.script} ${fmtNum(d.requests)}`).join(' · ')) + ')' : ''}</div>`;
  }
  return html;
}

// Cada seção do painel desenha isolada. Um erro de DESENHO — um bug nosso, não
// da rede — subia até o catch da busca: contava como falha, a página dizia
// "sem resposta do servidor" e espaçava as atualizações, e as seções depois
// da quebrada nem chegavam a desenhar. Foi assim que um `t` sombreado em
// renderLatency passou despercebido. Agora o erro fica na seção que quebrou
// e no console, onde dá para achar.
function desenharPainel(p) {
  const secoes = [
    ['terceiros', () => applyThirdParty(p.terceiros)],
    ['cotas', () => renderQuotas(p.cotas)],
    ['incidentes', () => renderIncidentes(p.historico)],
    ['barras', () => renderBarras(p.barras)],
    ['uptime', () => applyUptime(p.uptime)],
    ['notas', () => applyServiceNotes(historicoAtual)],
    ['latência', () => renderLatency(p.latencia, p.implantacoes)],
  ];
  for (const [nome, desenha] of secoes) {
    try { desenha(); } catch (e) { console.error(`painel: a seção ${nome} não desenhou`, e); }
  }
}

// ── Ciclo de atualização ────────────────────────────────────────────────
async function runChecks(manual) {
  if (checking) return;
  // Evento de clique chega como argumento: só `true` explícito é manual.
  if (manual === true && Date.now() - ultimaAtualizacao < MANUAL_PISO_MS) return;
  checking = true;
  clearTimeout(refreshTimer);

  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  btn.textContent = t('refreshing');

  let ok = true;

  function aplicarStatus(data) {
    resultados = data.services;
    resultados.forEach(r => updateServiceRow(SERVICES.findIndex(s => s.name === r.name), r));
    updateBanner(resultados);
    const em = Date.parse(data.checkedAt);
    ultimaVarredura = Number.isFinite(em) ? em : null;
    retratoAtrasado = !!(data.retrato && data.retrato.atrasado);
  }

  async function lerStatus() {
    try {
      aplicarStatus(await fetchStatus());
    } catch (e) {
      ok = false;
      // Sem resposta NÃO é "tudo offline": as linhas mantêm o último estado
      // conhecido e a idade dele segue visível. Se nunca houve estado, a
      // faixa diz que não sabe — em vez de pintar treze serviços de vermelho.
      if (ultimaVarredura == null) showBannerUnknown();
    }
  }

  function aplicarPainel(painel) {
    ultimoPainel = painel;
    historicoAtual = painel.historico && !painel.historico.erro ? painel.historico : null;
    desenharPainel(painel);
    if (resultados.length) updateBanner(resultados);
  }

  // Com o retrato compartilhado (D1), o painel já traz o status LIDO — uma
  // chamada só, e nenhuma varredura. Sem ele, o status vem do /api/status
  // ANTES do painel: é a varredura que grava a transição, então o painel lido
  // depois já a contém.
  if (modoRetrato !== false) {
    try {
      const painel = await fetchPainel();
      modoRetrato = !!painel.retratoCompartilhado;
      if (modoRetrato && painel.status && Array.isArray(painel.status.services)) aplicarStatus(painel.status);
      else await lerStatus();
      aplicarPainel(painel);
    } catch (e) {
      ok = false;
      if (ultimaVarredura == null) showBannerUnknown();
    }
  } else {
    await lerStatus();
    try { aplicarPainel(await fetchPainel()); } catch (e) { ok = false; }
  }

  falhasSeguidas = ok ? 0 : falhasSeguidas + 1;
  ultimaAtualizacao = Date.now();

  btn.disabled = false;
  btn.textContent = t('refresh');
  checking = false;

  agendar();
  updateLastChecked();
}

// ── Tema, idioma e inscrição ────────────────────────────────────────────
function rotuloTema(atual) { return atual === 'dark' ? t('theme_light') : t('theme_dark'); }

function pintaBotaoTema() {
  const atual = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const btn = document.getElementById('btn-theme');
  btn.textContent = rotuloTema(atual);
  btn.setAttribute('aria-label', t('theme_aria', rotuloTema(atual)));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = atual === 'light' ? '#f4efe6' : '#0d0c0a';
}

function salvaPref(k, v) {
  if (window.lfPrefs && window.lfPrefs.save) window.lfPrefs.save(k, v);
}

function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  salvaPref('theme', next);
  pintaBotaoTema();
}

// Trocar o idioma redesenha a partir do estado que já está na memória: nada
// de rede, e a próxima atualização segue no horário marcado.
function toggleLang() {
  lang = lang === 'en' ? 'pt' : 'en';
  salvaPref('lang', lang);
  aplicarIdiomaHtml();
  pintaBotaoTema();
  renderSkeletons();
  renderThirdPartySkeletons();
  resultados.forEach(r => updateServiceRow(SERVICES.findIndex(s => s.name === r.name), r));
  if (ultimoPainel) desenharPainel(ultimoPainel);
  if (resultados.length) updateBanner(resultados);
  else if (ultimaVarredura == null && falhasSeguidas > 0) showBannerUnknown();
  const btn = document.getElementById('btn-refresh');
  if (btn && !checking) btn.textContent = t('refresh');
  const ok = document.getElementById('sub-ok-btn');
  if (ok && !ok.disabled) ok.textContent = t('sub_button');
  updateLastChecked();
}

// Turnstile só existe quando o servidor diz que está configurado (GET
// /api/subscribe). O script da Cloudflare é carregado sob demanda, na primeira
// vez que alguém abre a inscrição.
let turnstileSiteKey = null;
let turnstileWidget = null;
let turnstilePronto = null;
function prepararTurnstile() {
  if (turnstilePronto) return turnstilePronto;
  turnstilePronto = getJson('/api/subscribe').then((cfg) => {
    turnstileSiteKey = cfg && typeof cfg.turnstile === 'string' ? cfg.turnstile : null;
    if (!turnstileSiteKey) return;
    return new Promise((resolve) => {
      const sc = document.createElement('script');
      sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      sc.async = true;
      sc.setAttribute('data-cfasync', 'false');
      sc.onload = () => {
        const alvo = document.getElementById('sub-turnstile');
        if (window.turnstile && alvo) {
          alvo.hidden = false;
          turnstileWidget = window.turnstile.render(alvo, { sitekey: turnstileSiteKey, theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark', language: lang === 'en' ? 'en' : 'pt-br' });
        }
        resolve();
      };
      sc.onerror = () => resolve();
      document.head.appendChild(sc);
    });
  }).catch(() => { turnstilePronto = null; });
  return turnstilePronto;
}

function showSubscribe() {
  mostra('inscricao', true);
  mostra('sub-form', true);
  mostra('sub-consent', true);
  ['sub-done', 'sub-error'].forEach(id => mostra(id, false));
  document.getElementById('btn-inscrever').setAttribute('aria-expanded', 'true');
  document.getElementById('sub-email').focus();
  prepararTurnstile();
}

function hideSubscribe() {
  mostra('inscricao', false);
  document.getElementById('btn-inscrever').setAttribute('aria-expanded', 'false');
  document.getElementById('sub-email').value = '';
  document.getElementById('btn-inscrever').focus();
}

function showSubError(msg) {
  const el = document.getElementById('sub-error-msg');
  if (el) el.textContent = msg || t('sub_error');
  mostra('sub-error', true);
}

async function doSubscribe() {
  const input = document.getElementById('sub-email');
  const email = input.value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showSubError(t('sub_bad_email'));
    input.focus();
    return;
  }
  let turnstile;
  if (turnstileSiteKey) {
    turnstile = window.turnstile && turnstileWidget != null ? window.turnstile.getResponse(turnstileWidget) : '';
    if (!turnstile) { showSubError(t('sub_captcha')); return; }
  }
  const btn = document.getElementById('sub-ok-btn');
  btn.disabled = true;
  btn.textContent = '…';
  mostra('sub-error', false);
  try {
    const res = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, turnstile }),
    });
    const data = await res.json();
    if (data.ok) {
      mostra('sub-form', false);
      mostra('sub-consent', false);
      mostra('sub-done', true);
    } else {
      // A mensagem do servidor é em português; em inglês, a genérica.
      showSubError(lang === 'pt' ? data.error : t('sub_error'));
      if (window.turnstile && turnstileWidget != null) window.turnstile.reset(turnstileWidget);
    }
  } catch (e) {
    showSubError(t('sub_network'));
  } finally {
    btn.disabled = false;
    btn.textContent = t('sub_button');
  }
}

// ── Início ──────────────────────────────────────────────────────────────
aplicarIdiomaHtml();
pintaBotaoTema();

// Um listener só, por delegação (como no fotos): atributo `onclick` no HTML
// é script inline, e a CSP não aceita. O botão diz o que faz em data-action.
const ACOES = {
  tema: () => toggleTheme(),
  idioma: () => toggleLang(),
  atualizar: () => runChecks(true),
  'inscrever-abrir': () => { if (document.getElementById('inscricao').hidden) showSubscribe(); else hideSubscribe(); },
  'inscrever-fechar': () => hideSubscribe(),
  checks: (el) => toggleChecks(Number(el.dataset.i)),
  barra: (el) => mostraBarra(el),
};
document.addEventListener('click', (ev) => {
  const el = ev.target instanceof Element ? ev.target.closest('[data-action]') : null;
  if (!el || !ACOES[el.dataset.action]) return;
  ev.preventDefault();
  ACOES[el.dataset.action](el);
});
// Passar o mouse numa barra mostra o período, como o toque.
document.addEventListener('pointerover', (ev) => {
  const el = ev.target instanceof Element ? ev.target.closest('.b[data-action="barra"]') : null;
  if (el) mostraBarra(el);
});
// Formulário de verdade: Enter envia, e o navegador trata o campo como tal.
document.getElementById('sub-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  doSubscribe();
});
document.getElementById('sub-email').addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') hideSubscribe();
});

// Aba escondida: nada de rede. Ao voltar, atualiza na hora se o último dado
// já tem mais que o intervalo mínimo; senão só retoma o agendamento.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    proximaEm = null;
    clearInterval(ageTimer);
    ageTimer = null;
    updateLastChecked();
    return;
  }
  if (!ageTimer) ageTimer = setInterval(updateLastChecked, 30000);
  if (Date.now() - ultimaAtualizacao >= ATUALIZA_MIN_MS) runChecks();
  else { agendar(); updateLastChecked(); }
});

renderSkeletons();
renderThirdPartySkeletons();
ageTimer = setInterval(updateLastChecked, 30000);
runChecks();
