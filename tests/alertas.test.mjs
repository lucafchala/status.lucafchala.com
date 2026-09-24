// Fase 2: o caminho dos alertas, a inscrição com confirmação e o que os
// endpoints públicos deixam de contar.
//
// Mesma regra das outras suítes: o que falha em SILÊNCIO precisa de teste. Um
// lote recusado pelo Resend, um cooldown gasto num envio que não saiu, uma
// recuperação engolida pelo cooldown da queda — nada disso aparece em tela.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const status = await import('../functions/api/status.js');
const terceiros = await import('../functions/api/third-party-status.js');
const subscribe = await import('../functions/api/subscribe.js');
const confirm = await import('../functions/api/confirm.js');
const healthz = await import('../functions/api/healthz.js');

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = new Map();
  return {
    writesOf(k) { return writes.get(k) || 0; },
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { writes.set(k, (writes.get(k) || 0) + 1); store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

const realNow = Date.now;
const realFetch = globalThis.fetch;
let clock = 0;
beforeEach(() => { clock = new Date('2026-09-24T12:00:00Z').getTime(); Date.now = () => clock; });
afterEach(() => { Date.now = realNow; globalThis.fetch = realFetch; });

const ORIGIN = 'https://status.lucafchala.com';
const ENV = (kv, extra = {}) => ({ STATUS_KV: kv, RESEND_API_KEY: 'k', NOTIFY_TO: 'dono@x.co', ...extra });
const svc = (name, st) => ({ name, status: st, rt: 200, url: `https://${name.toLowerCase()}.lucafchala.com`, problems: st === 'up' ? [] : ['caiu'] });

/** fetch falso: quota-stats responde `quota`, o Resend responde `resend(lote)`. */
function mundo({ quota = { configured: false }, resend = () => new Response('{}') } = {}) {
  const lotes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    if (url.endsWith('/api/quota-stats')) {
      return typeof quota === 'function' ? quota() : new Response(JSON.stringify(quota));
    }
    if (url === 'https://api.resend.com/emails/batch') {
      const lote = JSON.parse(init.body);
      lotes.push(lote);
      return resend(lote);
    }
    return new Response('{}');
  };
  return { lotes, destinatarios: () => lotes.flat().map((m) => m.to[0]) };
}

describe('cooldown por serviço e destino', () => {
  test('a recuperação dentro da hora passa; a mesma queda repetida não', async () => {
    const kv = fakeKV({ last_status: JSON.stringify({ Paste: 'up' }) });
    const m = mundo();
    await status.detectAndNotify(ENV(kv), [svc('Paste', 'down')], ORIGIN);
    clock += 5 * 60_000;
    await status.detectAndNotify(ENV(kv), [svc('Paste', 'up')], ORIGIN);
    clock += 5 * 60_000;
    await status.detectAndNotify(ENV(kv), [svc('Paste', 'down')], ORIGIN);
    assert.equal(m.lotes.length, 2, 'queda + recuperação; a segunda queda na mesma hora fica no cooldown');
    assert.match(m.lotes[1][0].subject, /RECUPERADO/);
  });

  test('piorar de degradado para fora do ar dentro da hora também passa', async () => {
    const kv = fakeKV({ last_status: JSON.stringify({ Keys: 'up' }) });
    const m = mundo();
    await status.detectAndNotify(ENV(kv), [svc('Keys', 'degraded')], ORIGIN);
    clock += 60_000;
    await status.detectAndNotify(ENV(kv), [svc('Keys', 'down')], ORIGIN);
    assert.equal(m.lotes.length, 2);
  });
});

describe('envio', () => {
  test('mais de 100 destinatários: lotes de no máximo 100, dono no primeiro', async () => {
    const subs = Array.from({ length: 150 }, (_, i) => ({ email: `u${i}@x.co`, token: `${String(i).padStart(8, '0')}-2222-3333-4444-555555555555` }));
    const kv = fakeKV({ last_status: JSON.stringify({ URL: 'up' }), subscribers: JSON.stringify(subs) });
    const m = mundo();
    await status.detectAndNotify(ENV(kv), [svc('URL', 'down')], ORIGIN);
    assert.deepEqual(m.lotes.map((l) => l.length), [100, 51]);
    assert.equal(m.lotes[0][0].to[0], 'dono@x.co');
  });

  test('envio recusado não gasta o cooldown, e a próxima varredura tenta de novo', async () => {
    const kv = fakeKV({ last_status: JSON.stringify({ Proof: 'up' }) });
    let recusa = true;
    const m = mundo({ resend: () => (recusa ? new Response('quota', { status: 429 }) : new Response('{}')) });
    await status.detectAndNotify(ENV(kv), [svc('Proof', 'down')], ORIGIN);
    assert.equal(kv._store.has('notify_sent:Proof:down'), false, 'cooldown só depois de um envio aceito');
    assert.ok(kv._store.has('alert_pending'));
    recusa = false;
    clock += 10 * 60_000;
    // Estado igual: sem transição nova, é a fila que reenvia.
    await status.detectAndNotify(ENV(kv), [svc('Proof', 'down')], ORIGIN);
    assert.equal(m.lotes.length, 2);
    assert.ok(kv._store.has('notify_sent:Proof:down'));
    assert.equal(kv._store.has('alert_pending'), false, 'fila limpa depois do envio');
  });

  test('a fila desiste depois de algumas tentativas', async () => {
    const kv = fakeKV({ last_status: JSON.stringify({ Dash: 'up' }) });
    const m = mundo({ resend: () => new Response('bad', { status: 422 }) });
    await status.detectAndNotify(ENV(kv), [svc('Dash', 'down')], ORIGIN);
    for (let i = 0; i < 5; i++) { clock += 10 * 60_000; await status.detectAndNotify(ENV(kv), [svc('Dash', 'down')], ORIGIN); }
    assert.equal(m.lotes.length, 3);
  });

  test('a fila não reenvia o que deixou de ser verdade', async () => {
    const kv = fakeKV({ last_status: JSON.stringify({ Pays: 'up' }) });
    let recusa = true;
    const m = mundo({ resend: () => (recusa ? new Response('', { status: 500 }) : new Response('{}')) });
    await status.detectAndNotify(ENV(kv), [svc('Pays', 'down')], ORIGIN);
    recusa = false;
    clock += 10 * 60_000;
    await status.detectAndNotify(ENV(kv), [svc('Pays', 'up')], ORIGIN);
    assert.equal(m.lotes.length, 2);
    const assuntos = m.lotes[1].map((x) => x.subject);
    assert.ok(assuntos.every((a) => /RECUPERADO/.test(a)), 'só a recuperação, não a queda velha');
  });
});

describe('primeira aparição', () => {
  test('serviço novo já quebrado alerta (sai do verde implícito)', async () => {
    const kv = fakeKV({ last_status: JSON.stringify({ Paste: 'up' }) });
    const m = mundo();
    await status.detectAndNotify(ENV(kv), [svc('Paste', 'up'), svc('Novo', 'down')], ORIGIN);
    assert.equal(m.lotes.length, 1);
    assert.match(m.lotes[0][0].subject, /Novo/);
  });

  test('instalação nova (last_status vazio) não vira rajada', async () => {
    const kv = fakeKV();
    const m = mundo();
    await status.detectAndNotify(ENV(kv), [svc('A', 'down'), svc('B', 'down')], ORIGIN);
    assert.equal(m.lotes.length, 0);
    assert.ok(kv._store.has('last_status'));
  });
});

describe('cotas e TLS', () => {
  const quotaRuim = { configured: true, quotas: [{ label: 'KV escritas', status: 'degraded', pct: 85, period: 'dia' }], certs: [] };

  test('alerta de cota vai só para o dono', async () => {
    const kv = fakeKV({ last_status: JSON.stringify({ Paste: 'up', 'cota · KV escritas': 'up' }), subscribers: JSON.stringify([{ email: 'publico@x.co', token: '11111111-2222-3333-4444-555555555555' }]) });
    const m = mundo({ quota: quotaRuim });
    await status.detectAndNotify(ENV(kv), [svc('Paste', 'up')], ORIGIN);
    assert.deepEqual(m.destinatarios(), ['dono@x.co']);
  });

  // Nomes próprios por teste: o espelho do cooldown em memória é estado de
  // módulo e sobrevive entre testes.
  test('queda pública + cota juntas: inscrito recebe só a queda', async () => {
    const kv = fakeKV({ last_status: JSON.stringify({ Rádio: 'up', 'cota · D1 leituras': 'up' }), subscribers: JSON.stringify([{ email: 'publico@x.co', token: '11111111-2222-3333-4444-555555555555' }]) });
    const m = mundo({ quota: { ...quotaRuim, quotas: [{ ...quotaRuim.quotas[0], label: 'D1 leituras' }] } });
    await status.detectAndNotify(ENV(kv), [svc('Rádio', 'down')], ORIGIN);
    const msg = m.lotes[0].find((x) => x.to[0] === 'publico@x.co');
    assert.doesNotMatch(msg.html, /cota/);
    assert.match(m.lotes[0].find((x) => x.to[0] === 'dono@x.co').html, /cota/);
  });

  test('quota-stats fora do ar não apaga as linhas de cota (nem as re-alerta na volta)', async () => {
    const kv = fakeKV({ last_status: JSON.stringify({ Paste: 'up', 'cota · KV escritas': 'degraded' }) });
    mundo({ quota: () => new Response('', { status: 503 }) });
    await status.detectAndNotify(ENV(kv), [svc('Paste', 'up')], ORIGIN);
    assert.equal(kv.writesOf('last_status'), 0, 'nada mudou de verdade');
    const m = mundo({ quota: quotaRuim });
    await status.detectAndNotify(ENV(kv), [svc('Paste', 'up')], ORIGIN);
    assert.equal(m.lotes.length, 0);
  });
});

describe('isolamento da varredura', () => {
  test('uma verificação que lança vira linha degradada, não um 500', async () => {
    const original = status.SERVICES.find((s) => s.name === 'Keys');
    const salvo = original.checks;
    original.checks = () => [Promise.reject(new Error('boom')), Promise.resolve({ label: 'ok', status: 'up', detail: '' })];
    globalThis.fetch = async () => new Response('<html>Chaves Luca Painel Paste url.lucafchala.com subs Hevy fotos Radio monitoramento de serviços Acesso restrito</html>', { headers: { 'content-type': 'text/html' } });
    try {
      const p = await status.varrer({});
      const keys = p.services.find((s) => s.name === 'Keys');
      assert.ok(keys.checks.some((c) => c.detail === 'erro interno na verificação'));
      assert.equal(keys.status, 'degraded');
    } finally { original.checks = salvo; }
  });

  test('healthInfra aguenta corpo nulo', () => {
    assert.equal(status.healthInfra('saúde', null).status, 'down');
    assert.equal(status.healthInfra('saúde', { json: null }).status, 'down');
  });
});

describe('terceiros', () => {
  test('Google: incidente com `end` é passado, não conta', () => {
    const r = terceiros.googleStatus([{ end: '2026-01-01T00:00:00Z', affected_products: [{ title: 'Google Drive' }], status_impact: 'SERVICE_OUTAGE' }], 'Google Drive');
    assert.equal(r.status, 'up');
  });
  test('Google: incidente aberto no produto certo conta; em outro, não', () => {
    const inc = { affected_products: [{ title: 'Google Drive' }], status_impact: 'SERVICE_DISRUPTION', external_desc: '**Title:**\nDrive lento\n**Description:** x' };
    assert.deepEqual(terceiros.googleStatus([inc], 'Google Drive'), { status: 'degraded', description: 'Drive lento' });
    assert.equal(terceiros.googleStatus([{ ...inc, affected_products: [{ title: 'Gmail' }] }], 'Google Drive').status, 'up');
  });
  test('Statuspage: manutenção é degradado; indicador desconhecido é sem dados', () => {
    assert.equal(terceiros.atlassianStatus({ status: { indicator: 'maintenance' } }).status, 'degraded');
    assert.equal(terceiros.atlassianStatus({}).status, 'unknown');
  });
  test('403 e JSON ilegível são "sem dados", não verde', async () => {
    globalThis.fetch = async () => new Response('nope', { status: 403 });
    assert.equal((await terceiros.checkOne({ name: 'X', api: 'https://x/api', page: 'https://x' })).status, 'unknown');
    globalThis.fetch = async () => new Response('<html>');
    assert.equal((await terceiros.checkOne({ name: 'X', api: 'https://x/api', page: 'https://x' })).status, 'unknown');
  });
});

describe('inscrição com confirmação (double opt-in)', () => {
  const post = (body) => new Request(`${ORIGIN}/api/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': `198.51.100.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify(body),
  });

  test('POST guarda um pendente e manda o link — ninguém entra na lista ainda', async () => {
    const kv = fakeKV({ subscribers: '[]' });
    const mails = [];
    globalThis.fetch = async (u, init) => { mails.push(JSON.parse(init.body)); return new Response('{}'); };
    const res = await subscribe.onRequestPost({ request: post({ email: 'Nova@X.co' }), env: ENV(kv) });
    assert.deepEqual(await res.json(), { ok: true, pending: true });
    assert.equal(JSON.parse(kv._store.get('subscribers')).length, 0);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /Confirme/);
    const link = mails[0].html.match(/href="([^"]+api\/confirm[^"]+)"/)[1].replace(/&amp;/g, '&');

    // Segundo POST para o mesmo endereço: sem outro e-mail.
    await subscribe.onRequestPost({ request: post({ email: 'nova@x.co' }), env: ENV(kv) });
    assert.equal(mails.length, 1, 'um link por endereço a cada 24 h');

    // GET só mostra o botão.
    const get = await confirm.onRequestGet({ request: new Request(link), env: ENV(kv) });
    assert.match(await get.text(), /method="POST"/);
    assert.equal(JSON.parse(kv._store.get('subscribers')).length, 0, 'GET não confirma');

    // POST confirma.
    const u = new URL(link);
    const fd = new FormData();
    fd.append('id', u.searchParams.get('id'));
    fd.append('token', u.searchParams.get('token'));
    const ok = await confirm.onRequestPost({ request: new Request(`${ORIGIN}/api/confirm`, { method: 'POST', body: fd }), env: ENV(kv) });
    assert.equal(ok.status, 200);
    const lista = JSON.parse(kv._store.get('subscribers'));
    assert.equal(lista.length, 1);
    assert.equal(lista[0].email, 'nova@x.co');
    assert.equal(lista[0].token, u.searchParams.get('token'));
    assert.match(mails.at(-1).subject, /confirmada/);
    assert.ok(mails.at(-1).headers['List-Unsubscribe']);
  });

  test('token errado não confirma nada', async () => {
    const id = await subscribe.emailId('a@x.co');
    const kv = fakeKV({ subscribers: '[]', [subscribe.pendingKey(id)]: JSON.stringify({ email: 'a@x.co', token: '11111111-2222-3333-4444-555555555555' }) });
    const fd = new FormData();
    fd.append('id', id);
    fd.append('token', '99999999-2222-3333-4444-555555555555');
    const res = await confirm.onRequestPost({ request: new Request(`${ORIGIN}/api/confirm`, { method: 'POST', body: fd }), env: ENV(kv) });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(kv._store.get('subscribers')).length, 0);
  });

  test('Turnstile configurado: sem token, recusa antes de tocar no KV', async () => {
    const kv = fakeKV({ subscribers: '[]' });
    const res = await subscribe.onRequestPost({ request: post({ email: 'b@x.co' }), env: ENV(kv, { TURNSTILE_SECRET_KEY: 's' }) });
    assert.equal(res.status, 403);
    assert.equal(kv.writesOf(subscribe.pendingKey(await subscribe.emailId('b@x.co'))), 0);
  });
});

describe('o que os endpoints públicos contam', () => {
  test('healthz sem token: só ok', async () => {
    const res = await healthz.onRequestGet({ request: new Request(`${ORIGIN}/api/healthz`), env: ENV(fakeKV({ subscribers: '[]' }), { STATUS_ADMIN_TOKEN: 'segredo' }) });
    assert.deepEqual(await res.json(), { ok: true });
  });
  test('healthz com o token certo: booleanos e contagens', async () => {
    const req = new Request(`${ORIGIN}/api/healthz`, { headers: { 'X-Status-Token': 'segredo' } });
    const body = await (await healthz.onRequestGet({ request: req, env: ENV(fakeKV({ subscribers: '[{"email":"a"}]' }), { STATUS_ADMIN_TOKEN: 'segredo' }) })).json();
    assert.equal(body.subscribers, 1);
    assert.equal(body.kv, true);
  });
  test('healthz com token errado ou sem segredo configurado: só ok', async () => {
    const req = new Request(`${ORIGIN}/api/healthz`, { headers: { 'X-Status-Token': 'x' } });
    assert.deepEqual(await (await healthz.onRequestGet({ request: req, env: ENV(fakeKV()) })).json(), { ok: true });
  });
  test('linha de configuração do Status não nomeia segredos', async () => {
    const st = status.SERVICES.find((s) => s.name === 'Status');
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }));
    const rows = await Promise.all(st.checks('https://status.lucafchala.com', {}));
    const cfg = rows.find((r) => r.label === 'configuração de alertas');
    assert.equal(cfg.status, 'degraded');
    assert.doesNotMatch(cfg.detail, /RESEND|KV|NOTIFY|inscrit/i);
  });
});
