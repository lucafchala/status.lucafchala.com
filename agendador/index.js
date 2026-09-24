// Agendador do status.lucafchala.com — um Worker que só tem Cron Trigger.
//
// POR QUÊ. A varredura (e com ela a detecção de mudança e os e-mails de
// alerta) roda dentro do /api/status. Sem ninguém com a página aberta, quem a
// disparava era o cron do GitHub Actions — agendado a cada 10 min, mas o
// GitHub não cumpre: em setembro de 2026 foram 5 a 8 disparos por dia, com
// intervalo mediano de 3 h 20 e pior de 7 h (#38). Um incidente levava horas
// para virar e-mail. E o GitHub ainda desliga o `schedule` de repositório
// público depois de 60 dias sem commit, sem avisar ninguém.
//
// O Cron Trigger da Cloudflare dispara no minuto certo. Custo: uma invocação
// deste Worker por disparo (144/dia) e a varredura que ele pede.
//
// O QUE FAZ. Pede uma varredura com `?source=cloudflare-cron`. Com o retrato
// em D1 (STATUS_DB), é essa origem que o /api/status reconhece como agendador
// — e a trava global no D1 impede que ela se some a outra varredura recente.
// Sem D1, a query fura o cache de borda, como o cron do GitHub sempre fez.
//
// Não tem rota nem workers.dev (wrangler.toml): não há o que pedir a ele de
// fora. Uma falha vira exceção, e aparece em "Cron Events" no painel da
// Cloudflare — e o vigia (monitor.yml) percebe o retrato envelhecendo.

import { varrer } from './varrer.js';

export default {
  async scheduled(controller, env, ctx) {
    const r = await varrer();
    // Uma linha por disparo, para os logs do Worker contarem a história:
    // qual alvo respondeu, se a varredura foi nova (idade 0) ou se a trava
    // devolveu uma recente (outra origem varreu há pouco).
    console.log(JSON.stringify({ evento: 'varredura', cron: controller?.cron, ...r }));
  },
};
