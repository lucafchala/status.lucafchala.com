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
const GRUPOS = [['principal', 'Principais'], ['apps', 'Aplicativos']];

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
let ultimoAnuncio = '';        // o que a região aria-live disse por último
let resultados = [];           // última varredura aplicada
let historicoAtual = null;     // último /api/painel → historico
let barrasAtuais = null;       // último /api/painel → barras

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
  up:       { ic: '✓', txt: 'operacional' },
  degraded: { ic: '!', txt: 'degradado' },
  down:     { ic: '✕', txt: 'fora do ar' },
  unknown:  { ic: '?', txt: 'sem dados' },
  checking: { ic: '…', txt: 'verificando' },
};
const estadoDe = (s) => ESTADOS[s] || ESTADOS.unknown;
function statusLabel(s) { return estadoDe(s).txt; }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function fmtNum(n) { return n == null ? '—' : n.toLocaleString('pt-BR'); }

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
  return (p === 100 ? '100' : p.toFixed(p >= 99.95 ? 3 : 2)).replace('.', ',') + ' %';
}

const FMT_HORA = { hour: '2-digit', minute: '2-digit' };
const FMT_DIA = { day: '2-digit', month: 'short' };
function hora(ms) { return new Date(ms).toLocaleTimeString('pt-BR', FMT_HORA); }
function dia(ms) { return new Date(ms).toLocaleDateString('pt-BR', FMT_DIA).replace('.', ''); }
function timeTag(ms, texto) {
  return `<time datetime="${new Date(ms).toISOString()}" title="${esc(new Date(ms).toLocaleString('pt-BR'))}">${esc(texto)}</time>`;
}

function rtLabel(rt, status) {
  if (status === 'down' || rt == null) return '';
  if (rt >= 1000) return (rt / 1000).toFixed(1).replace('.', ',') + ' s';
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
  list.innerHTML = GRUPOS.map(([g, titulo]) => `
    <div class="grupo">
      <h3 class="grupo-titulo">${esc(titulo)}</h3>
      <ul class="componentes">
        ${SERVICES.map((svc, i) => svc.group !== g ? '' : `
        <li class="componente" id="svc-${i}">
          <div class="comp-linha">
            <div class="comp-nome">
              <a href="${esc(svc.url)}" target="_blank" rel="noopener">${esc(svc.name)}</a>
              <span class="comp-url">${esc(svc.url.replace('https://', ''))}</span>
            </div>
            <span class="estado checking" id="lbl-${i}"><span class="estado-ic" aria-hidden="true">…</span><span>verificando</span></span>
          </div>
          <p class="comp-nota" id="hist-${i}"></p>
          <div class="barras" id="barras-${i}" role="img" aria-label="histórico de ${esc(svc.name)} ainda não carregado"></div>
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
          <ul class="checks" id="checks-${i}" aria-label="verificações de ${esc(svc.name)}"></ul>
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
        <span class="estado checking" id="tp-lbl-${i}"><span class="estado-ic" aria-hidden="true">…</span><span>verificando</span></span>
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
      ? ` <span class="check-quando">· conferido ${timeTag(Date.parse(c.verificadoEm), 'às ' + hora(Date.parse(c.verificadoEm)))}</span>` : '';
    return `
    <li class="check ${esc(c.status)}">
      <span class="check-ic" aria-hidden="true">${e.ic}</span>
      <span class="check-label"><span class="sr-only">${esc(e.txt)}: </span>${esc(c.label)}${quando}</span>
      <span class="check-detail">${esc(c.detail || (c.status === 'up' ? 'ok' : e.txt))}</span>
    </li>`;
  }).join('');

  const problems = checks.filter(c => c.status !== 'up').length;
  toggle.hidden = false;
  toggle.classList.toggle('has-problems', problems > 0);
  const aberto = problems > 0 || panel.classList.contains('show');
  panel.classList.toggle('show', aberto);
  toggle.setAttribute('aria-expanded', aberto ? 'true' : 'false');
  toggle.dataset.rotulo = problems > 0
    ? `${problems} problema${problems > 1 ? 's' : ''}`
    : `${checks.length} verificaç${checks.length > 1 ? 'ões' : 'ão'} ok`;
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
        ? `esteve ${esc(statusLabel(inc.severity))} ${timeTag(Date.parse(inc.endedAt), 'há ' + fmtAge(inc.agoMs))} · durou ${esc(fmtDur(inc.durationMs))}`
        : `<span class="${esc(inc.severity)}">${esc(statusLabel(inc.severity))} ${timeTag(Date.parse(inc.startedAt), 'há ' + fmtAge(inc.durationMs))}</span>`);
    }
    const r = resultados.find(x => x.name === s.name);
    const v = versaoDe(r);
    const em = v && Date.parse(v.em);
    if (v && Number.isFinite(em) && Date.now() - em < 48 * 3600000) {
      partes.push(`<span class="selo" title="versão ${esc(v.id)}">deploy ${esc(v.tag || v.id.slice(0, 8))} ${timeTag(em, 'há ' + fmtAge(Date.now() - em))}</span>`);
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
    return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).replace('.', '');
  }
  const ini = Date.parse(p.inicio);
  return `${dia(ini)}, ${hora(ini)}–${hora(ini + 3600000)}`;
}

function descreveBarra(barras, nome, k) {
  const b = (barras.servicos[nome] || [])[k] || { estado: null };
  const quando = rotuloPeriodo(barras, k);
  if (!b.estado) return `${quando}: sem dado`;
  const partes = [`${quando}: ${statusLabel(b.estado)}`];
  if (b.pct != null) partes.push(`${fmtPct(b.pct)} disponível`);
  if (b.fora) partes.push(`${b.fora} varredura${b.fora > 1 ? 's' : ''} fora do ar`);
  if (b.lentas) partes.push(`${b.lentas} degradada${b.lentas > 1 ? 's' : ''}`);
  if (b.varreduras) partes.push(`de ${b.varreduras}`);
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
    legenda.textContent = !barrasAtuais ? 'histórico indisponível'
      : diario ? `${n} dias · 1 barra por dia` : `${n} h · 1 barra por hora (sem banco: reconstruído das transições)`;
  }
  SERVICES.forEach((s, i) => {
    const el = document.getElementById(`barras-${i}`);
    if (!el) return;
    const ini = document.getElementById(`barras-ini-${i}`);
    const fim = document.getElementById(`barras-fim-${i}`);
    const up = document.getElementById(`uptime-${i}`);
    if (!barrasAtuais) {
      el.innerHTML = ''; el.className = 'barras';
      el.setAttribute('aria-label', `histórico de ${s.name} indisponível`);
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
    const unidade = diario ? 'dias' : 'h';
    el.setAttribute('aria-label',
      `${s.name}, últimos ${n} ${unidade}: ${pct == null ? 'sem dados' : fmtPct(pct) + ' disponível'}` +
      `${conta.down ? `; ${conta.down} ${diario ? 'dias' : 'horas'} com queda` : ''}` +
      `${conta.degraded ? `; ${conta.degraded} ${diario ? 'dias degradados' : 'horas degradadas'}` : ''}` +
      `${conta.nd ? `; ${conta.nd} sem dado` : ''}`);
    if (ini) ini.innerHTML = diario
      ? `<span class="so-largo">${n} dias atrás</span><span class="so-estreito">30 dias atrás</span>`
      : `<span class="so-largo">${n} h atrás</span><span class="so-estreito">24 h atrás</span>`;
    if (fim) fim.textContent = diario ? 'hoje' : 'agora';
    if (up) up.textContent = pct == null ? 'sem dados ainda' : `${fmtPct(pct)} disponível`;
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
    return inc && !inc.resolved ? ` há ${fmtAge(inc.durationMs)}` : '';
  };
  let estado, titulo, detalhe;
  if (!ruins.length) {
    estado = 'up'; titulo = 'Todos os sistemas operacionais';
    detalhe = `${results.length} serviços verificados`;
  } else if (ruins.length === results.length) {
    estado = 'down'; titulo = 'Interrupção generalizada';
    detalhe = 'nenhum serviço respondeu como deveria';
  } else if (ruins.length === 1) {
    const r = ruins[0];
    estado = r.status; titulo = `${r.name} ${statusLabel(r.status)}${desde(r.name)}`;
    detalhe = (r.problems && r.problems[0]) || '';
  } else {
    estado = ruins.some(r => r.status === 'down') ? 'down' : 'degraded';
    titulo = `${ruins.length} serviços com problema`;
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
  document.getElementById('banner-text').textContent = 'Sem resposta do servidor de status';
  document.getElementById('banner-sub').textContent = 'estado desconhecido — nova tentativa automática';
  anunciar('Sem resposta do servidor de status');
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
    partes.push('verificado ' + timeTag(ultimaVarredura, idade < 60000 ? 'agora há pouco' : 'há ' + fmtAge(idade)));
  } else {
    partes.push('ainda sem verificação');
  }
  if (falhasSeguidas > 0) partes.push('<span class="stale">sem resposta do servidor</span>');
  else if (retratoAtrasado) partes.push('<span class="stale">agendador atrasado</span>');
  if (proximaEm != null) {
    const falta = Math.max(0, proximaEm - agora);
    partes.push('próxima atualização em ' + (falta < 60000 ? 'menos de 1 min' : fmtAge(falta)));
  } else if (document.hidden) {
    partes.push('pausado (aba em segundo plano)');
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
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    const aberto = abertos.get(e.name);
    if (e.to !== 'up') {
      if (aberto) {
        if (e.to === 'down') aberto.pior = 'down';
      } else {
        abertos.set(e.name, { nome: e.name, inicio: t, fim: null, pior: e.to, causa: (e.problems || [])[0] || '' });
      }
    } else if (aberto) {
      aberto.fim = t;
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
    el.innerHTML = `<p class="vazio">histórico indisponível${historico && historico.detail ? ' — ' + esc(historico.detail) : ''}</p>`;
    return;
  }
  const incs = montaIncidentes(historico.entries || []);
  const flap = (historico.flapping || []).length
    ? `<p class="vazio aviso">instável: ${esc(historico.flapping.map(f => `${f.name} (${f.changes} mudanças)`).join(' · '))}</p>` : '';
  if (!incs.length) {
    el.innerHTML = `<p class="vazio">Nenhum incidente nas últimas 48 h.</p>${flap}`;
    return;
  }
  const hoje = new Date().toDateString();
  const ontem = new Date(Date.now() - 86400000).toDateString();
  const grupos = new Map();
  for (const inc of incs) {
    const d = new Date(inc.inicio).toDateString();
    const rot = d === hoje ? 'hoje' : d === ontem ? 'ontem' : dia(inc.inicio);
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
            ? `<span class="inc-aberto">em andamento</span> · desde ${timeTag(inc.inicio, hora(inc.inicio))} (${esc(fmtDur(Date.now() - inc.inicio))})`
            : `${timeTag(inc.inicio, hora(inc.inicio))} → ${timeTag(inc.fim, hora(inc.fim))} · durou ${esc(fmtDur(inc.fim - inc.inicio))}`;
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
  const x = (t) => P + ((t - t0) / dt) * (W - P * 2);
  const d = pontos.map(p => `${x(p.t).toFixed(1)},${(H - P - ((p.v - min) / span) * (H - P * 2)).toFixed(1)}`);
  const marcas = (deploys || []).filter(t => t >= t0 && t <= t1)
    .map(t => `<line class="deploy" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="0" y2="${H}"/>`).join('');
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
      const t = v.trend;
      const arrow = t.direction === 'piorando' ? '▲' : t.direction === 'melhorando' ? '▼' : '·';
      const trendTxt = t.deltaPct == null ? '·' : `${arrow} ${Math.abs(t.deltaPct)} %`;
      const dep = (deploys[name] || []).filter(Number.isFinite);
      return `
        <div class="lat">
          <span class="lat-name">${esc(name)}${dep.length ? ' <span class="selo">deploy</span>' : ''}</span>
          ${sparkline(pontos, sev, dep)}
          <span class="lat-trend ${esc(t.direction)}" title="mediana recente vs. anterior">${esc(trendTxt)}</span>
          <span class="lat-val">p50 ${v.p50} ms · p95 ${v.p95} ms</span>
        </div>`;
    }).join('');

  const worsening = (data.worsening || []).length
    ? `<div class="panel-empty aviso mt">ficando mais lento: ${
        esc(data.worsening.map(w => `${w.name} (+${w.deltaPct} %)`).join(' · '))}</div>`
    : '';
  panel.innerHTML = rows + worsening +
    `<div class="panel-empty mt">${data.samples} amostras · ${data.intervalMinutes ? `1 a cada ${data.intervalMinutes} min` : '1 por varredura'} · linha tracejada = deploy</div>`;
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
    panel.innerHTML = `<div class="panel-empty aviso">cotas não lidas agora${data && data.erro ? ' — ' + esc(data.erro) : ''}</div>`;
    return;
  }
  if (!data.configured) {
    panel.innerHTML = `<div class="panel-empty">não monitorado — ${esc(data.detail || 'sem token da API da Cloudflare')}</div>`;
    return;
  }
  const quotas = (data.quotas || []).map(q => {
    const fmt = q.bytes ? fmtBytes : fmtNum;
    // Uma barra que não pinta nada lê como "sem dado"; consumo pequeno mas
    // real ganha um fio visível.
    const width = q.pct == null ? 0 : Math.min(100, q.pct > 0 ? Math.max(q.pct, 1.5) : 0);
    const val = q.used == null ? 'sem dados' : `${fmt(q.used)} / ${fmt(q.limit)}${q.pct != null ? ` · ${String(q.pct).replace('.', ',')} %` : ''}`;
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
    ? `<div class="panel-empty aviso">não lido: ${esc(data.errors.join(' · '))}</div>` : '';
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
        <caption>Por Worker, hoje</caption>
        <colgroup><col class="c-script" /><col /><col /><col /></colgroup>
        <thead><tr><th scope="col">script</th><th scope="col">requisições</th><th scope="col">erros</th><th scope="col">CPU p50 / p99</th></tr></thead>
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
      return `<span class="b ${cls}" title="${esc(`${quando}: ${fmtNum(h.requests)} requisições · ${fmtNum(h.errors)} erros · CPU p99 ${h.cpuP99Ms ?? '—'} ms`)}"></span>`;
    }).join('');
    html += `
      <div class="por-hora">
        <p class="por-hora-titulo">${esc(ph.script)} · últimas 24 h, por hora</p>
        <div class="barras curtas" role="img" aria-label="${esc(`${ph.script}, últimas 24 horas: ${fmtNum(tot.r)} requisições, ${fmtNum(tot.e)} com erro, CPU p99 máxima ${cpuMax} ms`)}">${barras}</div>
        <p class="panel-empty">${fmtNum(tot.r)} requisições · ${fmtNum(tot.e)} com erro · CPU p99 máx. ${String(cpuMax).replace('.', ',')} ms</p>
      </div>`;
  }
  const dobj = data.durableObjects;
  if (dobj && dobj.requests != null) {
    html += `<div class="panel-empty mt">Durable Objects hoje: ${fmtNum(dobj.requests)} requisições${
      (dobj.porScript || []).length ? ' (' + esc(dobj.porScript.map(d => `${d.script} ${fmtNum(d.requests)}`).join(' · ')) + ')' : ''}</div>`;
  }
  return html;
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
  btn.textContent = '↻ atualizando…';

  let ok = true;

  function aplicarStatus(data) {
    resultados = data.services;
    resultados.forEach(r => updateServiceRow(SERVICES.findIndex(s => s.name === r.name), r));
    updateBanner(resultados);
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
      // conhecido e a idade dele segue visível. Se nunca houve estado, a
      // faixa diz que não sabe — em vez de pintar treze serviços de vermelho.
      if (ultimaVarredura == null) showBannerUnknown();
    }
  }

  function aplicarPainel(painel) {
    historicoAtual = painel.historico && !painel.historico.erro ? painel.historico : null;
    applyThirdParty(painel.terceiros);
    renderQuotas(painel.cotas);
    renderIncidentes(painel.historico);
    renderBarras(painel.barras);
    applyUptime(painel.uptime);
    applyServiceNotes(historicoAtual);
    renderLatency(painel.latencia, painel.implantacoes);
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
  btn.textContent = '↻ atualizar';
  checking = false;

  agendar();
  updateLastChecked();
}

// ── Tema e inscrição ────────────────────────────────────────────────────
function rotuloTema(atual) { return atual === 'dark' ? 'claro' : 'escuro'; }

function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch (e) { /* modo privado: o tema vale só nesta visita */ }
  const btn = document.getElementById('btn-theme');
  btn.textContent = rotuloTema(next);
  btn.setAttribute('aria-label', `mudar para o tema ${rotuloTema(next)}`);
}

function showSubscribe() {
  mostra('inscricao', true);
  mostra('sub-form', true);
  ['sub-done', 'sub-already', 'sub-error'].forEach(id => mostra(id, false));
  document.getElementById('btn-inscrever').setAttribute('aria-expanded', 'true');
  document.getElementById('sub-email').focus();
}

function hideSubscribe() {
  mostra('inscricao', false);
  document.getElementById('btn-inscrever').setAttribute('aria-expanded', 'false');
  document.getElementById('sub-email').value = '';
  document.getElementById('btn-inscrever').focus();
}

function showSubError(msg) {
  const el = document.getElementById('sub-error-msg');
  if (el) el.textContent = msg || 'Erro — tente novamente.';
  mostra('sub-error', true);
}

async function doSubscribe() {
  const input = document.getElementById('sub-email');
  const email = input.value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showSubError('Confira o endereço de e-mail.');
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
      showSubError(data.error);
    }
  } catch (e) {
    showSubError('Falha de rede — tente novamente.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Inscrever';
  }
}

// ── Início ──────────────────────────────────────────────────────────────
try {
  const stored = localStorage.getItem('theme');
  const sysPref = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const t = stored || sysPref;
  const btn = document.getElementById('btn-theme');
  btn.textContent = rotuloTema(t);
  btn.setAttribute('aria-label', `mudar para o tema ${rotuloTema(t)}`);
} catch (e) { /* sem localStorage: fica o rótulo padrão */ }

// Um listener só, por delegação (como no fotos): atributo `onclick` no HTML
// é script inline, e a CSP não aceita. O botão diz o que faz em data-action.
const ACOES = {
  tema: () => toggleTheme(),
  atualizar: () => runChecks(true),
  'inscrever-abrir': () => { if (document.getElementById('inscricao').hidden) showSubscribe(); else hideSubscribe(); },
  'inscrever-fechar': () => hideSubscribe(),
  inscrever: () => doSubscribe(),
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
document.getElementById('sub-email').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') doSubscribe();
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
