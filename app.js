// Painel de status — o script da página (antes inline no index.html).
// Em arquivo para a CSP poder dizer script-src 'self' sem 'unsafe-inline'.
const SERVICES = [
  { name: 'lucafchala.com',      url: 'https://lucafchala.com',                group: 'principal' },
  { name: 'Rádio',               url: 'https://radio.lucafchala.com',           group: 'principal' },
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
  { name: 'Status',              url: 'https://status.lucafchala.com',          group: 'principal' },
];

// Third-party order must match what the server returns (functions/api/third-party-status.js)
const THIRD_PARTY = [
  { name: 'GitHub',       page: 'https://www.githubstatus.com' },
  { name: 'Cloudflare',   page: 'https://www.cloudflarestatus.com' },
  { name: 'Claude',       page: 'https://status.anthropic.com' },
  { name: 'Resend',       page: 'https://status.resend.com' },
  { name: 'Google Drive', page: 'https://workspace.google.com/status' },
  { name: 'Google Fonts', page: 'https://status.cloud.google.com' },
];

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

// Terceiros, cotas, histórico e latência numa chamada (functions/api/painel.js).
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

function statusLabel(s) {
  if (s === 'up') return 'online';
  if (s === 'degraded') return 'lento';
  if (s === 'down') return 'offline';
  return 'sem dados';
}

function fmtNum(n) {
  return n == null ? '—' : n.toLocaleString('pt-BR');
}

function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

function fmtAge(ms) {
  if (ms == null) return '';
  const d = Math.floor(ms / 86400000); if (d >= 1) return d + 'd';
  const h = Math.floor(ms / 3600000);  if (h >= 1) return h + 'h';
  return Math.max(1, Math.floor(ms / 60000)) + 'min';
}

function rtLabel(rt, status) {
  if (status === 'down') return '–';
  if (rt >= 1000) return (rt / 1000).toFixed(1) + 's';
  return rt + 'ms';
}

function codeLabel(code) {
  if (!code) return '';
  if (code >= 200 && code < 400) return '';   // normal — don't clutter
  return 'HTTP ' + code;
}
function renderThirdPartySkeletons() {
  const list = document.getElementById('third-party-list');
  list.innerHTML = THIRD_PARTY.map((svc, i) => `
    <a class="service" href="${svc.page}" target="_blank" rel="noopener"
       id="tp-${i}" data-atraso="${0.28 + i * 0.05}">
      <div class="status-dot checking" id="tp-dot-${i}"></div>
      <div class="service-info">
        <span class="service-name">${svc.name}</span>
        <span class="service-url" id="tp-desc-${i}">${svc.page.replace('https://', '')}</span>
      </div>
      <div class="service-meta">
        <span class="service-status-label" id="tp-lbl-${i}">—</span>
      </div>
    </a>
  `).join('');
}

function updateThirdPartyRow(i, result) {
  const dot  = document.getElementById(`tp-dot-${i}`);
  const lbl  = document.getElementById(`tp-lbl-${i}`);
  const desc = document.getElementById(`tp-desc-${i}`);
  if (!dot) return;
  dot.className = `status-dot ${result.status}`;
  lbl.className = `service-status-label ${result.status}`;
  lbl.textContent = statusLabel(result.status);
  if (result.description) desc.textContent = result.description;
}

function renderSkeletons() {
  const list = document.getElementById('services-list');
  list.innerHTML = SERVICES.map((svc, i) => `
    <div class="service-card" data-atraso="${0.20 + i * 0.06}">
      <a class="service" href="${svc.url}" target="_blank" rel="noopener" id="svc-${i}">
        <div class="status-dot checking" id="dot-${i}"></div>
        <div class="service-info">
          <span class="service-name">${svc.name}</span>
          <span class="service-url">${svc.url.replace('https://', '')}</span>
          <span class="service-hist" id="hist-${i}"></span>
        </div>
        <div class="service-meta">
          <span class="service-status-label" id="lbl-${i}">—</span>
          <span class="service-rt" id="rt-${i}"></span>
          <span class="service-rt fraco" id="code-${i}"></span>
        </div>
      </a>
      <button class="checks-toggle" id="toggle-${i}" type="button" aria-expanded="false"
              aria-controls="checks-${i}" data-action="checks" data-i="${i}" hidden></button>
      <div class="checks" id="checks-${i}" role="region"></div>
    </div>
  `).join('');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function updateServiceRow(i, result) {
  const dot  = document.getElementById(`dot-${i}`);
  const lbl  = document.getElementById(`lbl-${i}`);
  const rt   = document.getElementById(`rt-${i}`);
  const code = document.getElementById(`code-${i}`);
  if (!dot) return;
  dot.className = `status-dot ${result.status}`;
  lbl.className = `service-status-label ${result.status}`;
  lbl.textContent = statusLabel(result.status);
  rt.textContent = rtLabel(result.rt, result.status);
  if (code) code.textContent = codeLabel(result.statusCode);
  renderChecks(i, result);
}

// Renders the per-service functional breakdown. A service with any failing
// check auto-expands (so a problem is never hidden behind a click); a fully
// healthy service collapses behind a "N verificações ok" toggle.
function renderChecks(i, result) {
  const panel  = document.getElementById(`checks-${i}`);
  const toggle = document.getElementById(`toggle-${i}`);
  if (!panel || !toggle) return;

  const checks = result.checks || [];
  if (!checks.length) { toggle.hidden = true; panel.classList.remove('show'); panel.innerHTML = ''; return; }

  panel.innerHTML = checks.map(c => `
    <div class="check">
      <span class="check-dot ${c.status}"></span>
      <span class="check-label">${esc(c.label)}</span>
      <span class="check-detail ${c.status}">${esc(c.detail || (c.status === 'up' ? 'ok' : statusLabel(c.status)))}</span>
    </div>
  `).join('');

  const problems = checks.filter(c => c.status !== 'up').length;
  toggle.hidden = false;
  toggle.classList.toggle('has-problems', problems > 0);

  if (problems > 0) {
    panel.classList.add('show');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = `▾ ${problems} problema${problems > 1 ? 's' : ''}`;
  } else {
    panel.classList.remove('show');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = `▸ ${checks.length} verificaç${checks.length > 1 ? 'ões' : 'ão'} ok`;
  }
}

// Free-tier headroom. The panel stays hidden entirely when the Cloudflare API
// credentials aren't configured — a row of "—" would imply the quota is fine
// when the truth is that nobody is watching it.
function renderQuotas(data) {
  const section = document.getElementById('quota-section');
  const panel   = document.getElementById('quota-panel');
  if (!section || !panel) return;
  // Seção que o servidor não conseguiu ler aparece dizendo isso. Sumir
  // seria o painel ficar com cara de "sem problema de cota" justamente
  // quando ninguém sabe.
  if (data && data.erro) {
    section.hidden = false;
    panel.innerHTML = `<div class="panel-empty">cotas não lidas agora — ${esc(data.erro)}</div>`;
    return;
  }
  if (!data || !data.configured) { section.hidden = true; return; }
  section.hidden = false;

  const quotas = (data.quotas || []).map(q => {
    const fmt = q.bytes ? fmtBytes : fmtNum;
    // A bar that renders as literally nothing reads as "no data"; floor a
    // non-zero usage at a hairline so low-but-real consumption stays visible.
    const width = q.pct == null ? 0 : Math.min(100, q.pct > 0 ? Math.max(q.pct, 1.5) : 0);
    const val = q.used == null
      ? 'sem dados'
      : `${fmt(q.used)} / ${fmt(q.limit)}${q.pct != null ? ` · ${q.pct}%` : ''}`;
    return `
      <div class="quota">
        <span class="quota-label">${esc(q.label)}</span>
        <span class="quota-bar"><span class="quota-fill ${q.status}" data-largura="${width}"></span></span>
        <span class="quota-val ${q.status}">${esc(val)}</span>
      </div>`;
  }).join('');

  // Certificates aren't a quota, so they render as plain checks rather than
  // meters — a progress bar for "expires in 60 days" would be nonsense.
  const certs = (data.certs || []).map(c => `
    <div class="check">
      <span class="check-dot ${c.status}"></span>
      <span class="check-label">TLS · ${esc(c.zone)}</span>
      <span class="check-detail ${c.status}">${esc(c.detail)}</span>
    </div>`).join('');

  const errors = (data.errors || []).length
    ? `<div class="panel-empty aviso">não lido: ${esc(data.errors.join(' · '))}</div>`
    : '';

  panel.innerHTML = quotas + certs + errors +
    (data.note ? `<div class="panel-empty mt">${esc(data.note)}</div>` : '');
  // Largura das barras pelo CSSOM: atributo de estilo no HTML a CSP bloqueia.
  panel.querySelectorAll('[data-largura]').forEach(el => { el.style.width = el.dataset.largura + '%'; });
}

// The transition log — what a live-only dashboard structurally can't show.
function renderHistory(data) {
  const section = document.getElementById('history-section');
  const panel   = document.getElementById('history-panel');
  if (!section || !panel) return;

  const entries = (data && data.entries) || [];
  if (!entries.length) { section.hidden = true; return; }
  section.hidden = false;

  const rows = entries.slice(0, 12).map(e => {
    const ago = fmtAge(Date.now() - new Date(e.at).getTime());
    return `
      <div class="hist">
        <span class="hist-when">há ${esc(ago)}</span>
        <span class="hist-name">${esc(e.name)}</span>
        <span class="hist-to ${e.to}">${esc(statusLabel(e.from))} → ${esc(statusLabel(e.to))}</span>
      </div>`;
  }).join('');

  // Flapping is the failure a 60-second dashboard hides best: a service that
  // recovers between sweeps looks healthy at every single glance.
  const flap = (data.flapping || []).length
    ? `<div class="panel-empty aviso mt">instável: ${
        esc(data.flapping.map(f => `${f.name} (${f.changes}×)`).join(' · '))}</div>`
    : '';

  panel.innerHTML = rows + flap;
}

// Sparkline em SVG puro — sem dependência, no mesmo espírito do resto da
// página. Recebe a série em ordem cronológica (mais antigo primeiro).
function sparkline(series, status) {
  const W = 56, H = 14, P = 1.5;
  if (series.length < 2) return '';
  const min = Math.min(...series), max = Math.max(...series);
  // Série achatada: uma linha reta no meio é mais honesta que uma divisão por
  // zero ou um traço colado na borda de baixo.
  const span = max - min || 1;
  const pts = series.map((v, i) => {
    const x = P + (i / (series.length - 1)) * (W - P * 2);
    const y = H - P - ((v - min) / span) * (H - P * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="lat-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"
    ><path class="${esc(status)}" d="M${pts.join('L')}"/></svg>`;
}

// Tendência de tempo de resposta. Responde o que o dashboard ao vivo não
// consegue: não "está lento?", mas "está ficando lento?" — que é o aviso que
// chega antes de o serviço sair do verde.
function renderLatency(data) {
  const section = document.getElementById('latency-section');
  const panel   = document.getElementById('latency-panel');
  if (!section || !panel) return;
  if (!data || !data.available || !data.samples) { section.hidden = true; return; }

  const svcs = data.services || {};
  const names = Object.keys(svcs);
  if (!names.length) { section.hidden = true; return; }
  section.hidden = false;

  // entries vem mais novo primeiro; a sparkline lê da esquerda (antigo) para
  // a direita (agora), então a série é invertida antes de desenhar.
  const chrono = (data.entries || []).slice().reverse();

  const rows = names
    // Piorando primeiro: a ordem da lista é a ordem em que vale olhar.
    .sort((a, b) => {
      const ra = svcs[a].trend.direction === 'piorando' ? 0 : 1;
      const rb = svcs[b].trend.direction === 'piorando' ? 0 : 1;
      return ra - rb || svcs[b].p95 - svcs[a].p95;
    })
    .map(name => {
      const v = svcs[name];
      const series = chrono.map(e => e.rt[name]).filter(n => typeof n === 'number');
      // Reaproveita os mesmos limiares do servidor para colorir: p95 é o que
      // o usuário lento realmente sente, não a mediana.
      const sev = v.p95 >= 2500 ? 'down' : v.p95 >= 1000 ? 'degraded' : 'up';
      const t = v.trend;
      const arrow = t.direction === 'piorando' ? '▲' : t.direction === 'melhorando' ? '▼' : '·';
      const trendTxt = t.deltaPct == null ? '·' : `${arrow} ${Math.abs(t.deltaPct)}%`;
      return `
        <div class="lat">
          <span class="lat-name">${esc(name)}</span>
          ${sparkline(series, sev)}
          <span class="lat-trend ${esc(t.direction)}" title="mediana recente vs. anterior">${esc(trendTxt)}</span>
          <span class="lat-val">p50 ${v.p50}ms · p95 ${v.p95}ms</span>
        </div>`;
    }).join('');

  const worsening = (data.worsening || []).length
    ? `<div class="panel-empty aviso mt">ficando mais lento: ${
        esc(data.worsening.map(w => `${w.name} (+${w.deltaPct}%)`).join(' · '))}</div>`
    : '';

  panel.innerHTML = rows + worsening +
    `<div class="panel-empty mt">${data.samples} amostras · ${data.intervalMinutes ? `1 a cada ${data.intervalMinutes}min` : '1 por varredura'}</div>`;
}

// Per-service incident context, right under the name — this is what answers
// "is this new, or the same problem as an hour ago?" without a second look.
function applyServiceHistory(data) {
  const svcs = (data && data.services) || {};
  SERVICES.forEach((s, i) => {
    const el = document.getElementById(`hist-${i}`);
    if (!el) return;
    const inc = svcs[s.name] && svcs[s.name].lastIncident;
    if (!inc) { el.textContent = ''; el.className = 'service-hist'; return; }
    el.className = `service-hist${inc.resolved ? '' : ' ' + inc.severity}`;
    el.textContent = inc.resolved
      ? `esteve ${statusLabel(inc.severity)} há ${fmtAge(inc.agoMs)} · durou ${fmtAge(inc.durationMs)}`
      : `${statusLabel(inc.severity)} há ${fmtAge(inc.durationMs)}`;
  });
}

function toggleChecks(i) {
  const panel  = document.getElementById(`checks-${i}`);
  const toggle = document.getElementById(`toggle-${i}`);
  if (!panel || !toggle) return;
  const open = panel.classList.toggle('show');
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.textContent = (open ? '▾' : '▸') + toggle.textContent.slice(1);
}

function updateBanner(results) {
  const dot  = document.getElementById('banner-dot');
  const text = document.getElementById('banner-text');
  const sub  = document.getElementById('banner-sub');
  const down = results.filter(r => r.status === 'down').length;
  const deg  = results.filter(r => r.status === 'degraded').length;
  const up   = results.filter(r => r.status === 'up').length;

  if (down === 0 && deg === 0) {
    dot.className = 'status-dot all-up';
    text.textContent = 'Todos os sistemas operacionais';
  } else if (down === results.length) {
    dot.className = 'status-dot all-down';
    text.textContent = 'Interrupção generalizada';
  } else {
    dot.className = 'status-dot some-down';
    const issues = [];
    if (down > 0) issues.push(`${down} offline`);
    if (deg > 0)  issues.push(`${deg} lento${deg > 1 ? 's' : ''}`);
    text.textContent = `Degradação parcial — ${issues.join(', ')}`;
  }

  sub.textContent = `${up}/${results.length} ok`;
}

// Idade do dado, não hora do pedido. "verificado às 14:02:10" com a hora do
// navegador dizia quando a PÁGINA perguntou; o que importa é quando a
// varredura rodou, que pode ter sido minutos antes (cache de borda, piso por
// isolate, agendador). Atualizado localmente a cada 30 s, sem rede.
function fmtIdade(ms) {
  if (ms < 60000) return 'agora há pouco';
  return 'há ' + fmtAge(ms);
}

function updateLastChecked() {
  const el = document.getElementById('last-checked');
  if (!el) return;
  const agora = Date.now();
  const partes = [];
  if (ultimaVarredura != null) {
    // Relógio do navegador adiantado não pode produzir idade negativa.
    const idade = Math.max(0, agora - ultimaVarredura);
    const quando = new Date(ultimaVarredura);
    partes.push('verificado <time datetime="' + quando.toISOString() + '" title="' +
      esc(quando.toLocaleString('pt-BR')) + '">' + fmtIdade(idade) + '</time>');
  } else {
    partes.push('ainda sem verificação');
  }
  if (falhasSeguidas > 0) {
    partes.push('<span class="stale">sem resposta do servidor</span>');
  } else if (retratoAtrasado) {
    partes.push('<span class="stale">agendador atrasado</span>');
  }
  if (proximaEm != null) {
    const falta = Math.max(0, proximaEm - agora);
    partes.push('próxima atualização em ' + (falta < 60000 ? 'menos de 1min' : fmtAge(falta)));
  } else if (document.hidden) {
    partes.push('pausado (aba em segundo plano)');
  }
  el.innerHTML = partes.join(' · ');
}

async function runChecks(manual) {
  if (checking) return;
  // Evento de clique chega como argumento: só `true` explícito é manual.
  if (manual === true && Date.now() - ultimaAtualizacao < MANUAL_PISO_MS) return;
  checking = true;
  clearTimeout(refreshTimer);

  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  btn.textContent = '↻ atualizando…';

  let ok = true;

  function aplicarStatus(data) {
    const results = data.services;
    results.forEach(r => updateServiceRow(SERVICES.findIndex(s => s.name === r.name), r));
    updateBanner(results);
    const t = Date.parse(data.checkedAt);
    ultimaVarredura = Number.isFinite(t) ? t : null;
    retratoAtrasado = !!(data.retrato && data.retrato.atrasado);
  }

  async function lerStatus() {
    try {
      aplicarStatus(await fetchStatus());
    } catch (e) {
      ok = false;
      // Sem resposta NÃO é "tudo offline": as linhas mantêm o último estado
      // conhecido e a idade dele segue visível. Se nunca houve estado, o
      // banner diz que não sabe — em vez de pintar treze serviços de vermelho.
      if (ultimaVarredura == null) showBannerUnknown();
    }
  }

  function aplicarPainel(painel) {
    applyThirdParty(painel.terceiros);
    renderQuotas(painel.cotas);
    renderHistory(painel.historico);
    applyServiceHistory(painel.historico);
    renderLatency(painel.latencia);
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
  btn.textContent = '↻ atualizar';
  checking = false;

  agendar();
  updateLastChecked();
}

function showBannerUnknown() {
  document.getElementById('banner-dot').className = 'status-dot';
  document.getElementById('banner-text').textContent = 'Sem resposta do servidor de status';
  document.getElementById('banner-sub').textContent = 'estado desconhecido';
}

// Terceiros: seção ilegível vira "sem dados" em cada linha, não "offline".
function applyThirdParty(data) {
  const svcs = data && Array.isArray(data.services) ? data.services : null;
  THIRD_PARTY.forEach((s, i) => {
    const r = svcs && svcs.find(x => x.name === s.name);
    updateThirdPartyRow(i, r || { status: 'unknown', description: '' });
  });
}

function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch(e) {}
  document.getElementById('btn-theme').textContent = next === 'dark' ? 'light' : 'dark';
}

function mostra(id, sim) { const el = document.getElementById(id); if (el) el.hidden = !sim; }

function showSubscribe() {
  mostra('sub-idle', false);
  mostra('sub-form', true);
  document.getElementById('sub-email').focus();
}

function hideSubscribe() {
  mostra('sub-form', false);
  mostra('sub-idle', true);
  document.getElementById('sub-email').value = '';
}

function showSubError(msg) {
  const el = document.getElementById('sub-error-msg');
  if (el) el.textContent = msg || 'erro — tente novamente';
  mostra('sub-error', true);
}

async function doSubscribe() {
  const input = document.getElementById('sub-email');
  const email = input.value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    input.focus();
    return;
  }
  const btn = document.getElementById('sub-ok-btn');
  btn.disabled = true;
  btn.textContent = '…';
  mostra('sub-error', false);
  try {
    const res = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (data.already) {
      mostra('sub-form', false);
      mostra('sub-already', true);
    } else if (data.ok) {
      mostra('sub-form', false);
      mostra('sub-done', true);
    } else {
      btn.disabled = false;
      btn.textContent = 'ok';
      showSubError(data.error);
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'ok';
    showSubError('Falha de rede — tente novamente');
  }
}

// Init theme button label
try {
  const stored = localStorage.getItem('theme');
  const sysPref = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const t = stored || sysPref;
  document.getElementById('btn-theme').textContent = t === 'dark' ? 'light' : 'dark';
} catch(e) {}

// Um listener só, por delegação (como no fotos): atributo `onclick` no HTML
// é script inline, e a CSP não aceita. O botão diz o que faz em data-action.
const ACOES = {
  tema: () => toggleTheme(),
  atualizar: () => runChecks(true),
  'inscrever-abrir': () => showSubscribe(),
  'inscrever-fechar': () => hideSubscribe(),
  inscrever: () => doSubscribe(),
  checks: (el) => toggleChecks(Number(el.dataset.i)),
};
document.addEventListener('click', (ev) => {
  const el = ev.target instanceof Element ? ev.target.closest('[data-action]') : null;
  if (!el || !ACOES[el.dataset.action]) return;
  ev.preventDefault();
  ACOES[el.dataset.action](el);
});
document.getElementById('sub-email').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') doSubscribe();
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

// Render and kick off checks
renderSkeletons();
renderThirdPartySkeletons();
// Entrada escalonada das linhas pelo CSSOM (atributo de estilo a CSP barra).
document.querySelectorAll('[data-atraso]').forEach(el => {
  el.style.animation = `rise 0.9s cubic-bezier(0.16,1,0.3,1) ${el.dataset.atraso}s both`;
});
ageTimer = setInterval(updateLastChecked, 30000);
runChecks();
