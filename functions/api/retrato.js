// Retrato compartilhado da última varredura — e a série que sai dele — em D1.
//
// POR QUÊ. Sem um lugar compartilhado entre colos, cada visitante que errava o
// cache de borda disparava uma varredura inteira: ~38 subrequests e 17
// requisições no Worker do fotos. O custo do monitor crescia com o público —
// um amplificador contra a infraestrutura que ele existe para vigiar. Com o
// retrato em D1, quem abre a página LÊ uma linha; quem varre é o agendador.
//
// POR QUE D1 E NÃO KV. Uma varredura a cada 10 min são 144 gravações/dia. No
// KV isso é 14 % da cota de escrita da conta INTEIRA (1000/dia, dividida com o
// fotos) — inviável. No D1 são linhas: o teto é de 100 mil escritas/dia, e
// este módulo grava ~16 linhas por varredura (≈2,3 mil/dia, ~2 %).
//
// OPCIONAL. O binding `STATUS_DB` é criado pelo dono no painel. Sem ele, nada
// aqui roda e o /api/status segue como sempre foi (visitante varre, com cache
// de 30 s e piso por isolate). Com ele, o esquema se cria sozinho no primeiro
// uso — não há migração para rodar à mão.
//
// O QUE MORA AQUI, e só aqui (o /api/status e o /api/painel importam):
//   varredura — uma linha por varredura: o retrato inteiro (payload) e, à
//               parte, status e tempo de resposta por serviço, compactos, para
//               a série de 48 h não precisar abrir o payload;
//   dia       — contagem por serviço por dia (fuso de São Paulo): é o que
//               desenha as barras de 90 dias sem ler 13 mil linhas;
//   trava     — a vez de varrer, global entre colos (ver tomarVez).

export const JANELA_MS = 48 * 3600_000;          // série e retratos guardados
export const DIAS_BARRAS = 90;                    // barras diárias por serviço
// Retrato mais velho que isso quer dizer agendador atrasado ou morto: a
// página avisa, e o próximo pedido pode varrer (uma vez, pela trava).
export const RETRATO_TTL_MS = 20 * 60_000;
// Intervalo mínimo entre varreduras, para a conta INTEIRA, não por isolate: é
// o que torna seguro deixar qualquer um pedir uma varredura — no máximo uma a
// cada 4 min, quantos pedidos vierem. O agendador (10 min) nunca esbarra.
export const VARREDURA_MIN_INTERVALO_MS = 4 * 60_000;
// America/Sao_Paulo não tem horário de verão desde 2019: o dia do dono e do
// público é UTC−3, fixo.
const FUSO_MS = -3 * 3600_000;

export function diaLocal(ms) {
  return new Date(ms + FUSO_MS).toISOString().slice(0, 10);
}

const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS varredura (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     em INTEGER NOT NULL,
     origem TEXT NOT NULL,
     payload TEXT NOT NULL,
     st TEXT NOT NULL,
     rt TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS varredura_em ON varredura(em)',
  `CREATE TABLE IF NOT EXISTS dia (
     servico TEXT NOT NULL,
     dia TEXT NOT NULL,
     total INTEGER NOT NULL DEFAULT 0,
     up INTEGER NOT NULL DEFAULT 0,
     degraded INTEGER NOT NULL DEFAULT 0,
     down INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (servico, dia)
   )`,
  'CREATE INDEX IF NOT EXISTS dia_dia ON dia(dia)',
  'CREATE TABLE IF NOT EXISTS trava (nome TEXT PRIMARY KEY, ate INTEGER NOT NULL)',
];

// Por isolate: depois da primeira vez, nenhuma consulta a mais por pedido.
let _esquemaPronto = null;
export async function garantirEsquema(DB) {
  if (_esquemaPronto === DB) return;
  await DB.batch(ESQUEMA.map((sql) => DB.prepare(sql)));
  _esquemaPronto = DB;
}

// A vez de varrer. `UPDATE … WHERE ate <= agora` é atômico no D1 (SQLite com
// um escritor só): de dois pedidos simultâneos, um muda a linha e o outro
// encontra `ate` já no futuro e muda zero. Custa uma linha escrita por
// varredura e dispensa segredo compartilhado — quem pede demais só recebe o
// retrato que já existe.
export async function tomarVez(DB, agora = Date.now(), intervalo = VARREDURA_MIN_INTERVALO_MS) {
  await garantirEsquema(DB);
  const upd = await DB.prepare("UPDATE trava SET ate = ? WHERE nome = 'varredura' AND ate <= ?")
    .bind(agora + intervalo, agora).run();
  if (upd?.meta?.changes === 1) return true;
  // Primeira varredura da vida do banco: a linha ainda não existe.
  const ins = await DB.prepare("INSERT OR IGNORE INTO trava (nome, ate) VALUES ('varredura', ?)")
    .bind(agora + intervalo).run();
  return ins?.meta?.changes === 1;
}

export async function lerRetrato(DB) {
  await garantirEsquema(DB);
  const row = await DB.prepare('SELECT em, origem, payload FROM varredura ORDER BY em DESC LIMIT 1').first();
  if (!row) return null;
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch { return null; }
  if (!payload || !Array.isArray(payload.services)) return null;
  return { em: Number(row.em), origem: row.origem, payload };
}

// Uma varredura vira uma linha em `varredura` + uma por serviço em `dia`,
// num lote só (uma ida ao banco, uma transação). A poda vai junto: o que
// passou da janela sai na mesma ida, e o custo fica constante.
export async function gravarVarredura(DB, payload, origem, agora = Date.now()) {
  await garantirEsquema(DB);
  const st = {};
  const rt = {};
  for (const s of payload.services || []) {
    st[s.name] = s.status;
    // Mesma regra de latency-trends.buildSample: um serviço fora do ar tem
    // tempo de resposta que mede o NOSSO timeout, não o serviço.
    if (typeof s.rt === 'number' && Number.isFinite(s.rt) && s.status !== 'down') rt[s.name] = Math.round(s.rt);
  }
  const hoje = diaLocal(agora);
  const stmts = [
    DB.prepare('INSERT INTO varredura (em, origem, payload, st, rt) VALUES (?, ?, ?, ?, ?)')
      .bind(agora, origem, JSON.stringify(payload), JSON.stringify(st), JSON.stringify(rt)),
  ];
  for (const [nome, estado] of Object.entries(st)) {
    const up = estado === 'up' ? 1 : 0;
    const deg = estado === 'degraded' ? 1 : 0;
    const down = estado === 'down' ? 1 : 0;
    stmts.push(DB.prepare(
      `INSERT INTO dia (servico, dia, total, up, degraded, down) VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT (servico, dia) DO UPDATE SET
         total = total + 1, up = up + excluded.up,
         degraded = degraded + excluded.degraded, down = down + excluded.down`,
    ).bind(nome, hoje, up, deg, down));
  }
  stmts.push(DB.prepare('DELETE FROM varredura WHERE em < ?').bind(agora - JANELA_MS));
  stmts.push(DB.prepare('DELETE FROM dia WHERE dia < ?').bind(diaLocal(agora - DIAS_BARRAS * 86400_000)));
  await DB.batch(stmts);
}

// Série de 48 h: uma entrada por varredura, no formato que latency-trends
// resume (`{ at, rt }`), mais o status de cada serviço para o uptime.
export async function lerSerie(DB, agora = Date.now()) {
  await garantirEsquema(DB);
  const { results } = await DB.prepare('SELECT em, st, rt FROM varredura WHERE em >= ? ORDER BY em DESC')
    .bind(agora - JANELA_MS).all();
  const out = [];
  for (const r of results || []) {
    try {
      out.push({ at: new Date(Number(r.em)).toISOString(), st: JSON.parse(r.st), rt: JSON.parse(r.rt) });
    } catch { /* linha ilegível não derruba a série */ }
  }
  return out;
}

// Disponibilidade por serviço numa janela: fração das varreduras em que ele
// NÃO estava offline. "Lento" conta como disponível — é o critério da
// indústria (o Statuspage só desconta indisponibilidade), e o que está lento
// já tem linha própria e barra amarela.
export function uptimeDe(serie, desde) {
  const conta = {};
  for (const e of serie) {
    if (new Date(e.at).getTime() < desde) continue;
    for (const [nome, estado] of Object.entries(e.st || {})) {
      const c = (conta[nome] ||= { total: 0, fora: 0 });
      c.total++;
      if (estado === 'down') c.fora++;
    }
  }
  const out = {};
  for (const [nome, c] of Object.entries(conta)) {
    out[nome] = { varreduras: c.total, pct: c.total ? Math.round(((c.total - c.fora) / c.total) * 10000) / 100 : null };
  }
  return out;
}

// Barras diárias (90 dias). Dia sem linha é dia sem dado — nunca verde por
// omissão: a página pinta de cinza.
export async function lerBarrasDiarias(DB, agora = Date.now()) {
  await garantirEsquema(DB);
  const desde = diaLocal(agora - (DIAS_BARRAS - 1) * 86400_000);
  const { results } = await DB.prepare('SELECT servico, dia, total, up, degraded, down FROM dia WHERE dia >= ?')
    .bind(desde).all();
  const porDia = {};
  for (const r of results || []) {
    (porDia[r.servico] ||= {})[r.dia] = {
      total: Number(r.total), up: Number(r.up), degraded: Number(r.degraded), down: Number(r.down),
    };
  }
  return barrasDiarias(porDia, agora);
}

// Formato normalizado, o mesmo de status-history.barrasHorarias: a página
// desenha os dois sem saber de onde vieram.
export function barrasDiarias(porDia, agora = Date.now()) {
  const periodos = [];
  for (let i = DIAS_BARRAS - 1; i >= 0; i--) {
    const dia = diaLocal(agora - i * 86400_000);
    periodos.push({ inicio: dia, fim: dia });
  }
  const servicos = {};
  for (const [nome, dias] of Object.entries(porDia)) {
    servicos[nome] = periodos.map(({ inicio: dia }) => {
      const c = dias[dia];
      if (!c || !c.total) return { estado: null, pct: null };
      const estado = c.down ? 'down' : c.degraded ? 'degraded' : 'up';
      return {
        estado,
        pct: Math.round(((c.total - c.down) / c.total) * 10000) / 100,
        varreduras: c.total, lentas: c.degraded, fora: c.down,
      };
    });
  }
  return { tipo: 'diario', fonte: 'd1', periodos, servicos };
}

// /api/retrato — só a idade do retrato. É o que um vigia de fora (o cron do
// GitHub, o cron diário do fotos) consulta para saber se o agendador morreu,
// sem varrer nada e sem baixar o retrato inteiro.
export async function onRequestGet(context) {
  const DB = context.env.STATUS_DB;
  const headers = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
  if (!DB) {
    return new Response(JSON.stringify({ configurado: false, detalhe: 'STATUS_DB não configurado — sem retrato compartilhado' }), { headers });
  }
  try {
    const r = await lerRetrato(DB);
    const agora = Date.now();
    const idadeMs = r ? agora - r.em : null;
    return new Response(JSON.stringify({
      configurado: true,
      em: r ? new Date(r.em).toISOString() : null,
      origem: r ? r.origem : null,
      idadeMs,
      atrasado: idadeMs == null || idadeMs > RETRATO_TTL_MS,
      ttlMs: RETRATO_TTL_MS,
    }), { headers });
  } catch (e) {
    console.error('retrato: leitura falhou', e);
    return new Response(JSON.stringify({ configurado: true, erro: 'D1 não respondeu' }), { status: 503, headers });
  }
}
