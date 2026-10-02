// lib/migrate.js
//
// One-shot copy of the Google Sheet into Postgres (fase 1): Etiquetas →
// artigos, Encomendas → encomendas + encomenda_linhas, StockLog → stock_log.
// Triggered from api/sync-prices.js:
//
//   GET /api/sync-prices?migrate=1&secret=<CRON_SECRET>            → dry run (counts + problems, writes nothing)
//   GET /api/sync-prices?migrate=1&secret=<CRON_SECRET>&confirm=1  → import
//   … &confirm=1&replace=1  → wipe the four tables first (re-run after a test import)
//
// Always reads the SHEET (via the sheetsOnly readers), whatever USE_POSTGRES
// says, so it can be run before the switch is turned on. Refuses to import
// into non-empty tables unless replace=1, so it can't silently duplicate.
// The whole import is a single transaction: all or nothing.

const { sheetsFetch, sheetsOnly } = require('./sheets');
const ordersLib = require('./orders');
const { getSql } = require('./db');

const VALID_STATUS = ['Rascunho', 'Enviado', 'Em separação', 'Concluído', 'Cancelado'];
const VALID_LINE_STATUS = ['', 'Encomendado', 'Em produção', 'Recebido'];

function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  let d = new Date(s);
  if (!Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}/.test(s)) return d;
  // "02/10/2026 14:03:22" or "02/10/2026" (pt-PT display format)
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Sheets serial date number
  const n = Number(s.replace(',', '.'));
  if (Number.isFinite(n) && n > 20000 && n < 80000) return new Date(Math.round((n - 25569) * 86400000));
  return null;
}

async function readSheet() {
  const { rowToItem, SHEET_TAB, LOG_TAB, FIRST_DATA_ROW } = sheetsOnly;
  const problems = [];

  // ── Etiquetas ──
  const raw = await sheetsFetch(`/values/${encodeURIComponent(`${SHEET_TAB}!A2:P`)}`);
  const seen = new Map();
  const artigos = [];
  (raw.values || []).forEach((row, i) => {
    const it = rowToItem(row, i + FIRST_DATA_ROW);
    const sku = String(it.sku || '').replace(/^'/, '').trim();
    if (!sku) return;
    if (seen.has(sku)) {
      problems.push(`SKU ${sku} repetido na linha ${it.rowNumber} (primeira ocorrência na linha ${seen.get(sku)}) — só a primeira foi importada`);
      return;
    }
    seen.set(sku, it.rowNumber);
    artigos.push({
      sku,
      familia: it.familia || '',
      descricao: it.descricao || '',
      comprimento: it.comprimento,
      largura: it.largura,
      espessura: it.espessura,
      dimensao_m2: it.dimensaoM2,
      valor_compra: it.valorCompra,
      preco: it.preco,
      stock: it.stock,
      observacoes: it.observacoes || '',
      qr: row[12] || '',
      unidade: it.unidade || 'un',
      reservado: Math.max(0, it.reservado || 0),
      stock_minimo: it.stockMinimo,
      ordem: it.rowNumber
    });
  });

  // ── Encomendas ──
  const lines = await ordersLib.sheetsOnly.getAllOrderLines();
  const encomendas = new Map();
  const linhas = [];
  const pos = new Map();
  for (const l of lines) {
    if (!encomendas.has(l.orderId)) {
      let doors = null;
      if (l.doorsDataRaw) { try { doors = JSON.parse(l.doorsDataRaw); } catch { problems.push(`Encomenda ${l.orderId}: dados de portas ilegíveis (ignorados)`); } }
      let status = l.status;
      if (!VALID_STATUS.includes(status)) { problems.push(`Encomenda ${l.orderId}: estado desconhecido "${status}" — importada como Rascunho`); status = 'Rascunho'; }
      const created = toDate(l.createdAt);
      if (!created) problems.push(`Encomenda ${l.orderId}: data de criação ilegível "${l.createdAt}" — usada a data de hoje`);
      encomendas.set(l.orderId, {
        order_id: l.orderId,
        client_id: l.clientId || '',
        client_name: l.clientName || '',
        status,
        created_at: created || new Date(),
        salesperson: l.salesperson || '',
        order_notes: l.orderNotes || '',
        order_type: l.orderType === 'Portas' ? 'Portas' : 'Normal',
        doors_data: doors,
        edited_by: l.editedBy || '',
        edited_at: toDate(l.editedAt)
      });
    }
    const p = pos.get(l.orderId) || 0;
    pos.set(l.orderId, p + 1);
    linhas.push({
      order_id: l.orderId,
      posicao: p,
      sku: String(l.sku || '').replace(/^'/, '').trim(),
      descricao: l.descricao || '',
      comprimento: l.comprimento,
      largura: l.largura,
      espessura: l.espessura,
      unidade: l.unidade || 'un',
      qty_ordered: l.qtyOrdered || 0,
      qty_picked: l.qtyPicked || 0,
      unit_price: l.unitPrice,
      line_total: l.lineTotal,
      line_notes: l.lineNotes || '',
      discount_pct: l.discountPct || 0,
      qty_mode: l.qtyMode || '',
      qty_entered: l.qtyEntered,
      line_status: VALID_LINE_STATUS.includes(l.lineStatus || '') ? (l.lineStatus || '') : '',
      line_status_at: l.lineStatus ? toDate(l.lineStatusAt) : null
    });
  }

  // ── StockLog ──
  let logRows = [];
  try {
    const lg = await sheetsFetch(`/values/${encodeURIComponent(`${LOG_TAB}!A2:G`)}`);
    logRows = (lg.values || []).filter((r) => r.some((c) => c !== '' && c !== undefined));
  } catch (err) {
    problems.push(`Histórico (${LOG_TAB}) não lido: ${err.message}`);
  }
  let badDates = 0;
  const log = logRows.map((r) => {
    const ts = toDate(r[0]);
    if (!ts) badDates++;
    return {
      ts: ts || new Date(0),
      sku: String(r[1] || '').replace(/^'/, ''),
      descricao: r[2] || '',
      campo: r[3] || '',
      valor_anterior: r[4] === undefined ? '' : String(r[4]),
      valor_novo: r[5] === undefined ? '' : String(r[5]),
      nota: r[6] || ''
    };
  });
  if (badDates) problems.push(`Histórico: ${badDates} linha(s) com data ilegível (guardadas com data 1970-01-01)`);

  // Reservation sanity check: RESERVADO in the sheet should equal what the
  // active orders still need. Reported, never auto-fixed.
  const expected = new Map();
  const bySku = new Map(artigos.map((a) => [a.sku, a]));
  const active = new Set([...encomendas.values()].filter((e) => e.status === 'Enviado' || e.status === 'Em separação').map((e) => e.order_id));
  for (const l of linhas) {
    if (!active.has(l.order_id)) continue;
    const a = bySku.get(l.sku);
    const rem = (l.qty_ordered || 0) - (l.qty_picked || 0);
    if (!a || rem <= 0) continue;
    const pieces = (a.unidade && a.unidade !== 'un' && a.dimensao_m2) ? rem / a.dimensao_m2 : rem;
    expected.set(l.sku, (expected.get(l.sku) || 0) + pieces);
  }
  const mismatches = [];
  for (const a of artigos) {
    const exp = expected.get(a.sku) || 0;
    if (Math.abs(exp - (a.reservado || 0)) > 0.001) mismatches.push(`${a.sku}: RESERVADO na folha = ${a.reservado || 0}, encomendas ativas pedem ${Number(exp.toFixed(3))}`);
  }
  if (mismatches.length) problems.push(`${mismatches.length} artigo(s) com RESERVADO diferente do que as encomendas ativas pedem (importado tal como está): ` + mismatches.slice(0, 20).join('; ') + (mismatches.length > 20 ? '; …' : ''));

  return { artigos, encomendas: [...encomendas.values()], linhas, log, problems };
}

async function runMigration({ confirm = false, replace = false } = {}) {
  const data = await readSheet();
  const summary = {
    artigos: data.artigos.length,
    encomendas: data.encomendas.length,
    linhas: data.linhas.length,
    historico: data.log.length,
    problemas: data.problems
  };
  if (!confirm) return { dryRun: true, ...summary };

  const sql = getSql();
  await sql.begin(async (tx) => {
    const [{ n }] = await tx`select (select count(*) from artigos) + (select count(*) from encomendas) + (select count(*) from stock_log) as n`;
    if (Number(n) > 0) {
      if (!replace) throw new Error('A base de dados já tem dados. Use &replace=1 para apagar e importar de novo.');
      await tx`truncate encomenda_linhas, encomendas, stock_log, artigos restart identity`;
    }
    const chunk = async (table, rows, size = 500) => {
      for (let i = 0; i < rows.length; i += size) {
        const part = rows.slice(i, i + size);
        await tx`insert into ${tx(table)} ${tx(part)}`;
      }
    };
    await chunk('artigos', data.artigos);
    await chunk('encomendas', data.encomendas.map((e) => ({ ...e, doors_data: e.doors_data ? tx.json(e.doors_data) : null })));
    await chunk('encomenda_linhas', data.linhas);
    await chunk('stock_log', data.log, 1000);
  });
  return { dryRun: false, imported: true, ...summary };
}

module.exports = { runMigration, readSheet, toDate };
