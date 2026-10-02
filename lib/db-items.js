// lib/db-items.js
//
// Postgres implementation of the item/stock/log functions that used to live
// only in lib/sheets.js. Same names, same arguments, same return shapes —
// lib/sheets.js re-exports these instead of its own Sheets versions when
// USE_POSTGRES=1, so no caller (api/items.js, api/pick-line.js,
// api/sync-prices.js, lib/orders.js) needs to change.
//
// "rowNumber" on an item is now the artigos.id primary key rather than a
// sheet row. Every caller only ever passes it straight back into these
// functions, so the meaning change is invisible to them.
//
// The big win over Sheets: stock/reservation changes are single atomic
// UPDATEs (`reservado = reservado + x`) — no read-write-verify-retry loop,
// no lost updates under concurrency, no quota.

const { getSql } = require('./db');

function parsePtNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value;
  const cleaned = String(value).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

function formatPtNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return String(value).replace('.', ',');
}

function rowToItem(r) {
  return {
    rowNumber: Number(r.id),
    sku: r.sku || '',
    familia: r.familia || '',
    descricao: r.descricao || '',
    comprimento: r.comprimento,
    largura: r.largura,
    espessura: r.espessura,
    dimensaoM2: r.dimensao_m2,
    valorCompra: r.valor_compra,
    preco: r.preco,
    unidade: r.unidade || 'un',
    stock: r.stock,
    observacoes: r.observacoes || '',
    reservado: r.reservado || 0,
    stockMinimo: r.stock_minimo,
    get disponivel() { return (this.stock || 0) - (this.reservado || 0); }
  };
}

const ITEM_COLS = 'id, sku, familia, descricao, comprimento, largura, espessura, dimensao_m2, valor_compra, preco, unidade, stock, observacoes, reservado, stock_minimo';

// No cache needed any more — a full read is one indexed query, not a
// quota-limited API call. `fresh` is accepted and ignored for compatibility.
async function getAllItems() {
  const sql = getSql();
  const rows = await sql.unsafe(`select ${ITEM_COLS} from artigos order by ordem nulls last, id`);
  return rows.map(rowToItem);
}

async function findItemBySku(sku) {
  const sql = getSql();
  const target = String(sku ?? '').replace(/^'/, '').trim();
  if (!target) return null;
  const rows = await sql.unsafe(`select ${ITEM_COLS} from artigos where sku = $1`, [target]);
  return rows[0] ? rowToItem(rows[0]) : null;
}

function invalidateItemsCache() { /* nothing cached */ }

async function updateItemFields(rowNumber, { stock, preco, unidade }) {
  const sql = getSql();
  const set = {};
  if (stock !== undefined) set.stock = stock;
  if (preco !== undefined) set.preco = preco;
  if (unidade !== undefined) set.unidade = unidade;
  if (Object.keys(set).length === 0) return;
  await sql`update artigos set ${sql(set)} where id = ${rowNumber}`;
}

// ─── Atomic stock / reservation adjustments ─────────────────────────────────
function sumDeltasBySku(deltas) {
  const bySku = new Map();
  for (const { sku, deltaPieces } of deltas) {
    const key = String(sku || '').replace(/^'/, '').trim();
    const d = Number(deltaPieces);
    if (!key || !Number.isFinite(d) || d === 0) continue;
    bySku.set(key, (bySku.get(key) || 0) + d);
  }
  return bySku;
}

// One statement for every SKU: lock the rows, remember the old value,
// apply the delta. Concurrent calls on the same SKU queue on the row lock
// and each one applies on top of the other — nothing is ever lost.
// `tx` (optional): run inside a caller's transaction (see lib/db-orders.js).
async function adjustReservadoBatch(deltas, tx) {
  const bySku = sumDeltasBySku(deltas);
  if (bySku.size === 0) return [];
  const sql = tx || getSql();
  const skus = [...bySku.keys()];
  const vals = skus.map((s) => bySku.get(s));
  const rows = await sql`
    with d as (
      select * from unnest(${skus}::text[], ${vals}::numeric[]) as t(sku, delta)
    ), old as (
      select a.id, a.reservado from artigos a join d on d.sku = a.sku for update of a
    )
    update artigos a
       set reservado = greatest(0, a.reservado + d.delta)
      from d, old
     where a.sku = d.sku and old.id = a.id
    returning a.sku, a.descricao, a.stock, a.stock_minimo, old.reservado as old_reservado, a.reservado as new_reservado`;
  return rows.map((r) => ({
    sku: r.sku,
    descricao: r.descricao,
    oldReservado: r.old_reservado,
    newReservado: r.new_reservado,
    oldAvailable: (r.stock || 0) - r.old_reservado,
    newAvailable: (r.stock || 0) - r.new_reservado,
    stockMinimo: r.stock_minimo
  }));
}

async function adjustStockBatch(deltas, tx) {
  const bySku = sumDeltasBySku(deltas);
  if (bySku.size === 0) return [];
  const sql = tx || getSql();
  const skus = [...bySku.keys()];
  const vals = skus.map((s) => bySku.get(s));
  const rows = await sql.unsafe(`
    with d as (
      select * from unnest($1::text[], $2::numeric[]) as t(sku, delta)
    ), old as (
      select a.id, a.stock from artigos a join d on d.sku = a.sku for update of a
    )
    update artigos a
       set stock = coalesce(a.stock, 0) + d.delta
      from d, old
     where a.sku = d.sku and old.id = a.id
    returning ${ITEM_COLS.split(', ').map((c) => 'a.' + c).join(', ')}, old.stock as old_stock`, [skus, vals]);
  return rows.map((r) => ({ sku: r.sku, item: rowToItem(r), oldStock: r.old_stock || 0, newStock: r.stock }));
}

// Single-SKU versions, same return shapes as the Sheets originals.
async function adjustReservado(item, deltaPieces) {
  const res = await adjustReservadoBatch([{ sku: item.sku, deltaPieces }]);
  if (res.length === 0) throw new Error(`Artigo ${item.sku} não encontrado ao atualizar RESERVADO`);
  return res[0];
}

async function adjustStock(sku, deltaPieces) {
  const res = await adjustStockBatch([{ sku, deltaPieces }]);
  return res[0] || null;
}

// ─── Price sync (TABELA / J5F) ──────────────────────────────────────────────
async function bulkUpdatePrices(updates) {
  const list = (updates || []).filter((u) =>
    (u.preco !== undefined && u.preco !== null) || (u.valorCompra !== undefined && u.valorCompra !== null));
  if (list.length === 0) return;
  const sql = getSql();
  const ids = list.map((u) => u.rowNumber);
  const precos = list.map((u) => (u.preco === undefined ? null : u.preco));
  const compras = list.map((u) => (u.valorCompra === undefined ? null : u.valorCompra));
  // null = "no value from this source" → leave the column alone.
  await sql`
    update artigos a
       set preco = coalesce(u.preco, a.preco),
           valor_compra = coalesce(u.compra, a.valor_compra)
      from unnest(${ids}::bigint[], ${precos}::numeric[], ${compras}::numeric[]) as u(id, preco, compra)
     where a.id = u.id`;
}

// Accepts the same 16-cell Etiquetas row arrays lib/j5f.js's buildNewItemRow
// produces for Sheets (SKU prefixed with ', numbers in pt format), so the
// J5F sync code doesn't change. Returns the first new id, or null.
async function appendItemRows(rows) {
  if (!rows || rows.length === 0) return null;
  const sql = getSql();
  const records = rows.map((r) => ({
    sku: String(r[0] || '').replace(/^'/, '').trim(),
    familia: r[1] || '',
    descricao: r[2] || '',
    comprimento: parsePtNumber(r[3]),
    largura: parsePtNumber(r[4]),
    espessura: parsePtNumber(r[5]),
    dimensao_m2: parsePtNumber(r[6]),
    valor_compra: parsePtNumber(r[7]),
    preco: parsePtNumber(r[8]),
    stock: parsePtNumber(r[10]),
    observacoes: r[11] || '',
    qr: r[12] || '',
    unidade: r[13] || 'un',
    reservado: parsePtNumber(r[14]) || 0,
    stock_minimo: parsePtNumber(r[15])
  })).filter((r) => r.sku);
  if (records.length === 0) return null;
  const inserted = await sql`
    insert into artigos ${sql(records)}
    on conflict (sku) do nothing
    returning id`;
  // New items go to the end of the list, like an appended sheet row.
  await sql`update artigos set ordem = id + 1000000000 where ordem is null`;
  return inserted[0] ? Number(inserted[0].id) : null;
}

async function setItemObservations(rowNumbers, text) {
  if (!rowNumbers || rowNumbers.length === 0) return;
  const sql = getSql();
  await sql`update artigos set observacoes = ${text} where id = any(${rowNumbers}::bigint[])`;
}

async function deleteItemRows(rowNumbers) {
  if (!rowNumbers || rowNumbers.length === 0) return;
  const sql = getSql();
  await sql`delete from artigos where id = any(${[...new Set(rowNumbers)]}::bigint[])`;
}

// ─── Histórico ──────────────────────────────────────────────────────────────
function logText(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? formatPtNumber(v) : String(v);
}

async function appendLogEntries(entries, tx) {
  if (!entries || entries.length === 0) return;
  const sql = tx || getSql();
  const rows = entries.map(({ sku, descricao, field, oldValue, newValue, note }) => ({
    sku: String(sku || ''),
    descricao: descricao || '',
    campo: field || '',
    valor_anterior: logText(oldValue),
    valor_novo: logText(newValue),
    nota: note || ''
  }));
  await sql`insert into stock_log ${sql(rows)}`;
}

async function appendLogEntry(entry) {
  return appendLogEntries([entry]);
}

module.exports = {
  getAllItems,
  findItemBySku,
  invalidateItemsCache,
  updateItemFields,
  adjustReservado,
  adjustStock,
  adjustReservadoBatch,
  adjustStockBatch,
  bulkUpdatePrices,
  appendItemRows,
  setItemObservations,
  deleteItemRows,
  appendLogEntries,
  appendLogEntry,
  // exported for the import script / tests
  rowToItem,
  parsePtNumber,
  formatPtNumber
};
