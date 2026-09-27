// Vigia do agendador — roda no cron do GitHub Actions (monitor.yml).
//
// Quem avisa quando o próprio alarme morre? O agendador (Worker com Cron
// Trigger, agendador/) é quem varre. Se ele parar, nenhuma varredura roda,
// nenhuma transição é detectada, nenhum e-mail sai — e nada acusa isso.
//
// Este vigia mora FORA da Cloudflare de propósito: é o único observador que
// sobrevive a um problema na conta. O GitHub avisa o dono por e-mail quando
// um workflow agendado falha; é esse e-mail o alarme do alarme.
//
// Decisão, a partir do /api/retrato (só a idade; não varre nada):
//
//   • sem STATUS_DB (retrato não configurado): não há como saber a idade da
//     última varredura. Faz o que o cron sempre fez — pede uma varredura.
//   • agendador da Cloudflare nunca visto na janela de 48 h: ele ainda não
//     foi implantado. O cron do GitHub É o agendador: varre se o retrato
//     tiver mais que alguns minutos. Falha só se a varredura falhar.
//   • agendador visto e em dia: nada a fazer. Nenhuma varredura extra.
//   • agendador visto e parado há mais de LIMITE_MS: varre (socorro) E
//     falha o job, com o motivo — é o e-mail que o dono precisa receber.
//   • /api/retrato não responde: tenta varrer; se nem isso, falha.

export const BASE = process.env.STATUS_BASE || 'https://status.lucafchala.com';
// Três disparos perdidos seguidos do agendador de 10 min.
export const LIMITE_MS = 30 * 60_000;
// Sem o agendador da Cloudflare, o GitHub é o agendador: retrato mais novo
// que isso não precisa de outra varredura (a trava do D1 recusaria mesmo).
export const RETRATO_FRESCO_MS = 9 * 60_000;

async function comRetentativa(fn, tentativas = 3, espera = 10_000) {
  let ultimo;
  for (let i = 1; i <= tentativas; i++) {
    try { return await fn(); } catch (e) { ultimo = e; }
    if (i < tentativas) await new Promise((r) => setTimeout(r, espera));
  }
  throw ultimo;
}

export async function lerRetrato(fetchImpl, base = BASE) {
  const res = await fetchImpl(`${base}/api/retrato`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`/api/retrato respondeu HTTP ${res.status}`);
  return res.json();
}

export async function pedirVarredura(fetchImpl, base = BASE, runId = '') {
  const url = `${base}/api/status?source=gha-cron&t=${encodeURIComponent(runId)}-${Date.now()}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`/api/status respondeu HTTP ${res.status}`);
  return { status: res.status, origem: res.headers.get('X-Sweep-Source'), idadeMs: res.headers.get('X-Sweep-Age-Ms') };
}

const min = (ms) => `${Math.round(ms / 60_000)} min`;

// Devolve { acao, falha, mensagem } — sem efeito colateral além do fetch, para
// o teste poder percorrer cada ramo.
export async function vigiar({ fetchImpl = fetch, base = BASE, runId = '', espera = 10_000 } = {}) {
  let r;
  try {
    r = await comRetentativa(() => lerRetrato(fetchImpl, base), 3, espera);
  } catch (e) {
    try {
      await comRetentativa(() => pedirVarredura(fetchImpl, base, runId), 2, espera);
      return { acao: 'varreu', falha: false, mensagem: `/api/retrato não respondeu (${e.message}), mas a varredura saiu` };
    } catch (e2) {
      return { acao: 'nada', falha: true, mensagem: `status.lucafchala.com não responde: ${e.message}; varredura: ${e2.message}` };
    }
  }

  const varrer = async (motivo, falhaMesmoSeVarrer = false) => {
    try {
      const v = await comRetentativa(() => pedirVarredura(fetchImpl, base, runId), 3, espera);
      return { acao: 'varreu', falha: falhaMesmoSeVarrer, mensagem: `${motivo} — varredura ok (origem ${v.origem || '?'})` };
    } catch (e) {
      return { acao: 'varreu', falha: true, mensagem: `${motivo} — e a varredura falhou: ${e.message}` };
    }
  };

  if (!r.configurado) return varrer('sem retrato compartilhado (STATUS_DB): o cron do GitHub é o agendador');

  const ag = r.agendador || {};
  if (ag.ultimaEm == null) {
    if (r.idadeMs != null && r.idadeMs < RETRATO_FRESCO_MS) {
      return { acao: 'nada', falha: false, mensagem: `agendador da Cloudflare não implantado; retrato de ${min(r.idadeMs)} (origem ${r.origem}) ainda serve` };
    }
    return varrer('agendador da Cloudflare não implantado: o cron do GitHub é o agendador');
  }
  if (ag.idadeMs > LIMITE_MS) {
    return varrer(`AGENDADOR PARADO: o último pedido dele foi há ${min(ag.idadeMs)} (limite ${min(LIMITE_MS)}). Ver Workers & Pages → status-agendador → Logs / Cron Events`, true);
  }
  return { acao: 'nada', falha: false, mensagem: `agendador em dia: último pedido há ${min(ag.idadeMs)}` };
}

// Execução no Actions.
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await vigiar({ runId: process.env.GITHUB_RUN_ID || '' });
  console.log(`${r.falha ? '::error::' : ''}${r.mensagem}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Vigia:** ${r.falha ? '❌' : '✅'} ${r.mensagem}\n`);
  }
  process.exit(r.falha ? 1 : 0);
}
