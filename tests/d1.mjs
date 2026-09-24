// D1 em cima de SQLite de verdade (node:sqlite), para os testes.
//
// Mesma escolha do fotos (tests/helpers/d1.js): o D1 é SQLite, e o que se
// quer afirmar aqui — a trava por UPDATE condicional, o upsert do agregado
// diário, a poda — depende do SQL que roda, não de um dublê que o imitasse.
// A superfície é só a que functions/ usa: prepare().bind().run()/first()/all()
// e batch() (numa transação, como no D1).

import { DatabaseSync } from 'node:sqlite';

export function d1Sqlite() {
  const db = new DatabaseSync(':memory:');
  let consultas = 0;
  function stmt(sql) {
    let valores = [];
    const s = {
      sql,
      bind(...v) { valores = v; return s; },
      _run() {
        const r = db.prepare(sql).run(...valores);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      async run() { consultas++; return s._run(); },
      async first() { consultas++; return db.prepare(sql).get(...valores) ?? null; },
      async all() { consultas++; return { success: true, results: db.prepare(sql).all(...valores) }; },
    };
    return s;
  }
  return {
    sqlite: db,
    get consultas() { return consultas; },
    prepare: stmt,
    async batch(stmts) {
      consultas++;
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
