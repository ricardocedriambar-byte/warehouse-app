// lib/db-orders.js
//
// Postgres implementation of the order functions in lib/orders.js (same
// names, arguments and return shapes). lib/orders.js re-exports these when
// USE_POSTGRES=1; clients (getAllClients/createClient) stay on Sheets in
// this phase.
//
// Differences that matter versus the Sheets version:
//   - An order and its stock reservations are written in ONE transaction:
//     either the order exists with its stock reserved, or nothing changed.
//     (On Sheets a reservation failure was only logged, leaving the order
//     sent but its stock unreserved.)
//   - No claim/verify dance for row numbers, no cleared row blocks on edit,
//     no quota.

const { getSql, isoOrEmpty } = require('./db');
const { adjustReservadoBatch, adjustStockBatch, appendLogEntries } = require('./db-items');
const { maybeSendLowStockAlert } = require('./stockAlerts');
const { toPieces } = require('./units');

const STATUS = {
  DRAFT: 'Rascunho',
  SENT: 'Enviado',
  PICKING: 'Em separação',
  COMPLETE: 'Concluído',
  CANCELLED: 'Cancelado'
};
const EDITABLE_STATUSES = [STATUS.DRAFT, STATUS.SENT];
const RESERVING_STATUSES = [STATUS.SENT, STATUS.PICKING];
const LINE_STATUSES = ['Encomendado', 'Em produção', 'Recebido'];
const LINE_STATUS_EDITABLE = [STATUS.DRAFT, STATUS.SENT, STATUS.PICKING];

function normalizeLineStatus(v) { return LINE_STATUSES.includes(v) ? v : ''; }
function cleanSku(s) { return String(s || '').replace(/^'/, '').trim(); }

function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).trim().replace(/\./g, '').replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

function generateOrderId() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = String(Math.floor(Math.random() * 9000) + 1000);
  return `ENC-${date}-${rand}`;
}

// ─── Reading ────────────────────────────────────────────────────────────────
function buildOrder(h, lineRows) {
  const base = {
    orderId: h.order_id,
    clientId: h.client_id || '',
    clientName: h.client_name || '',
    status: h.status,
    createdAt: isoOrEmpty(h.created_at),
    salesperson: h.salesperson || '',
    orderNotes: h.order_notes || ''
  };
  return {
    ...base,
    orderType: h.order_type || 'Normal',
    doorsData: h.doors_data || null,
    editedBy: h.edited_by || '',
    editedAt: isoOrEmpty(h.edited_at),
    lines: lineRows.map((l) => ({
      ...base,
      sku: l.sku || '',
      descricao: l.descricao || '',
      comprimento: l.comprimento,
      largura: l.largura,
      espessura: l.espessura,
      unidade: l.unidade || 'un',
      qtyOrdered: l.qty_ordered || 0,
      qtyPicked: l.qty_picked || 0,
      unitPrice: l.unit_price,
      lineTotal: l.line_total,
      lineNotes: l.line_notes || '',
      discountPct: l.discount_pct || 0,
      orderType: h.order_type || 'Normal',
      qtyMode: l.qty_mode || '',
      qtyEntered: l.qty_entered,
      lineStatus: normalizeLineStatus(l.line_status),
      lineStatusAt: isoOrEmpty(l.line_status_at)
    }))
  };
}

async function loadOrders(sql, orderId) {
  const headers = orderId
    ? await sql`select * from encomendas where order_id = ${orderId}`
    : await sql`select * from encomendas order by created_at, order_id`;
  if (headers.length === 0) return [];
  const lines = orderId
    ? await sql`select * from encomenda_linhas where order_id = ${orderId} order by posicao`
    : await sql`select * from encomenda_linhas order by order_id, posicao`;
  const byOrder = new Map();
  for (const l of lines) {
    if (!byOrder.has(l.order_id)) byOrder.set(l.order_id, []);
    byOrder.get(l.order_id).push(l);
  }
  return headers.map((h) => buildOrder(h, byOrder.get(h.order_id) || []));
}

async function getAllOrders() { return loadOrders(getSql()); }

async function getOrderById(orderId) {
  const [o] = await loadOrders(getSql(), orderId);
  return o || null;
}

async function ensureOrdersTabExists() { /* tables are created by db/schema.sql */ }

// ─── Reservations ───────────────────────────────────────────────────────────
// Converts each line's unpicked remainder (pricing unit, e.g. m²) to
// physical pieces and applies it to RESERVADO, all inside `tx`. Lines whose
// SKU isn't a real item (door BOM "PORTA-…", ad-hoc products) are skipped.
// Returns the per-SKU results so low-stock alerts can be sent after commit.
async function applyReservation(tx, lines, direction) {
  const wanted = lines
    .map((l) => ({ sku: cleanSku(l.sku), remaining: (Number(l.qtyOrdered) || 0) - (Number(l.qtyPicked) || 0) }))
    .filter((l) => l.sku && l.remaining > 0);
  if (wanted.length === 0) return [];
  const skus = [...new Set(wanted.map((w) => w.sku))];
  const items = await tx`select sku, unidade, dimensao_m2, comprimento, largura, espessura from artigos where sku = any(${skus}::text[])`;
  const bySku = new Map(items.map((i) => [i.sku, i]));
  const deltas = [];
  for (const { sku, remaining } of wanted) {
    const it = bySku.get(sku);
    if (!it) continue;
    const pieces = toPieces(it, remaining);
    deltas.push({ sku, deltaPieces: direction * pieces });
  }
  return adjustReservadoBatch(deltas, tx);
}

async function sendAlerts(results, context) {
  for (const r of results || []) {
    await maybeSendLowStockAlert(r).catch((err) =>
      console.error(`low-stock alert failed for ${r.sku} (${context}):`, err));
  }
}

// ─── Writing ────────────────────────────────────────────────────────────────
function lineRecords(orderId, lines, now, carried) {
  return lines.map((line, i) => {
    const discountPct = Number(line.discountPct) || 0;
    const qtyOrdered = toNum(line.qtyOrdered) || 1;
    const unitPrice = toNum(line.unitPrice) || 0;
    const mode = line.qtyMode || '';
    const unidade = line.unidade || 'un';
    const entered = Number(line.qtyEntered);
    const keepEntry = mode && mode !== unidade && Number.isFinite(entered) && entered > 0;
    const st = carried ? carried(line) : { lineStatus: normalizeLineStatus(line.lineStatus), lineStatusAt: line.lineStatusAt || '' };
    return {
      order_id: orderId,
      posicao: i,
      sku: cleanSku(line.sku),
      descricao: line.descricao || '',
      comprimento: toNum(line.comprimento),
      largura: toNum(line.largura),
      espessura: toNum(line.espessura),
      unidade,
      qty_ordered: qtyOrdered,
      qty_picked: 0,
      unit_price: unitPrice,
      line_total: qtyOrdered * unitPrice * (1 - discountPct / 100),
      line_notes: line.lineNotes || '',
      discount_pct: discountPct,
      qty_mode: keepEntry ? mode : '',
      qty_entered: keepEntry ? entered : null,
      line_status: st.lineStatus || '',
      line_status_at: st.lineStatus ? (st.lineStatusAt || now) : null
    };
  });
}

async function createOrder({ clientId, clientName, salesperson, orderNotes, lines, status: requestedStatus, orderType, doorsData }) {
  const sql = getSql();
  const status = Object.values(STATUS).includes(requestedStatus) ? requestedStatus : STATUS.DRAFT;
  const type = orderType === 'Portas' ? 'Portas' : 'Normal';
  const createdAt = new Date().toISOString();
  const lineList = Array.isArray(lines) ? lines : [];

  let orderId;
  let alerts = [];
  for (let attempt = 0; ; attempt++) {
    orderId = generateOrderId();
    try {
      alerts = await sql.begin(async (tx) => {
        await tx`insert into encomendas ${tx({
          order_id: orderId,
          client_id: clientId || '',
          client_name: clientName || '',
          status,
          created_at: createdAt,
          salesperson: salesperson || '',
          order_notes: orderNotes || '',
          order_type: type,
          doors_data: type === 'Portas' && doorsData ? tx.json(doorsData) : null
        })}`;
        const recs = lineRecords(orderId, lineList, createdAt);
        if (recs.length) await tx`insert into encomenda_linhas ${tx(recs)}`;
        if (RESERVING_STATUSES.includes(status)) {
          return applyReservation(tx, lineList.map((l) => ({ sku: l.sku, qtyOrdered: Number(l.qtyOrdered) || 1, qtyPicked: 0 })), +1);
        }
        return [];
      });
      break;
    } catch (err) {
      // Random 4-digit suffix collided with an existing order today — retry.
      if (err.code === '23505' && /encomendas_pkey/.test(err.constraint_name || err.message) && attempt < 5) continue;
      throw err;
    }
  }
  await sendAlerts(alerts, `nova encomenda ${orderId}`);
  return { orderId, status, createdAt, clientId, clientName, orderType: type, doorsData: doorsData || null, lines: lineList };
}

async function updateOrderStatus(orderId, newStatus) {
  if (!Object.values(STATUS).includes(newStatus)) throw new Error(`Estado inválido: ${newStatus}`);
  const sql = getSql();
  const alerts = await sql.begin(async (tx) => {
    const [h] = await tx`select status from encomendas where order_id = ${orderId} for update`;
    if (!h) throw new Error(`Order ${orderId} not found`);
    const oldStatus = h.status;
    const lines = await tx`select sku, qty_ordered, qty_picked from encomenda_linhas where order_id = ${orderId} order by posicao`;
    const lineObjs = lines.map((l) => ({ sku: l.sku, qtyOrdered: l.qty_ordered || 0, qtyPicked: l.qty_picked || 0 }));

    let results = [];
    const wasReserving = RESERVING_STATUSES.includes(oldStatus);
    const willReserve = RESERVING_STATUSES.includes(newStatus);
    if (wasReserving !== willReserve) {
      results = await applyReservation(tx, lineObjs, willReserve ? +1 : -1);
    }

    // Cancelling gives back whatever was already picked (pick-line.js took
    // it off STOCK). Only once — a repeated cancel finds nothing to restore
    // because the status check below blocks it.
    if (newStatus === STATUS.CANCELLED && oldStatus !== STATUS.CANCELLED) {
      const picked = lineObjs.filter((l) => cleanSku(l.sku) && l.qtyPicked > 0);
      if (picked.length) {
        const skus = [...new Set(picked.map((l) => cleanSku(l.sku)))];
        const items = await tx`select sku, unidade, dimensao_m2, comprimento, largura, espessura from artigos where sku = any(${skus}::text[])`;
        const bySku = new Map(items.map((i) => [i.sku, i]));
        const deltas = [];
        const notes = new Map();
        for (const l of picked) {
          const sku = cleanSku(l.sku);
          const it = bySku.get(sku);
          if (!it) continue;
          const pieces = toPieces(it, l.qtyPicked);
          deltas.push({ sku, deltaPieces: pieces });
          if (!notes.has(sku)) notes.set(sku, []);
          notes.get(sku).push(`${l.qtyPicked} ${it.unidade || 'un'} = ${pieces.toFixed(3)} un`);
        }
        const restored = await adjustStockBatch(deltas, tx);
        await appendLogEntries(restored.map((r) => ({
          sku: r.sku, descricao: r.item.descricao, field: 'STOCK',
          oldValue: r.oldStock, newValue: r.newStock,
          note: `Cancelamento encomenda ${orderId} — stock reposto (${(notes.get(r.sku) || []).join(' + ')})`
        })), tx);
      }
    }

    await tx`update encomendas set status = ${newStatus} where order_id = ${orderId}`;
    return results;
  });
  await sendAlerts(alerts, `encomenda ${orderId} → ${newStatus}`);
}

async function updateOrderContent(orderId, { orderNotes, lines, orderType, doorsData, editedBy }) {
  const sql = getSql();
  const alerts = await sql.begin(async (tx) => {
    const [h] = await tx`select * from encomendas where order_id = ${orderId} for update`;
    if (!h) throw new Error(`Encomenda ${orderId} não encontrada`);
    if (!EDITABLE_STATUSES.includes(h.status)) {
      throw new Error(`A encomenda ${orderId} já não pode ser editada (estado atual: ${h.status})`);
    }
    const type = orderType === 'Portas' ? 'Portas' : (h.order_type || 'Normal');
    const old = await tx`select * from encomenda_linhas where order_id = ${orderId} order by posicao`;

    if (RESERVING_STATUSES.includes(h.status)) {
      await applyReservation(tx, old.map((l) => ({ sku: l.sku, qtyOrdered: l.qty_ordered, qtyPicked: l.qty_picked })), -1);
    }

    // Keep each line's Encomendado/Em produção/Recebido marking across the
    // edit, matched by SKU + descrição (door BOM lines are regenerated).
    const oldStatusByKey = new Map();
    for (const l of old) {
      const st = normalizeLineStatus(l.line_status);
      if (!st) continue;
      const key = `${cleanSku(l.sku)}|${String(l.descricao || '').trim()}`;
      if (!oldStatusByKey.has(key)) oldStatusByKey.set(key, []);
      oldStatusByKey.get(key).push({ lineStatus: st, lineStatusAt: isoOrEmpty(l.line_status_at) });
    }
    const carried = (line) => {
      const q = oldStatusByKey.get(`${cleanSku(line.sku)}|${String(line.descricao || '').trim()}`);
      return (q && q.length) ? q.shift() : { lineStatus: '', lineStatusAt: '' };
    };

    const editedAt = new Date().toISOString();
    const lineList = Array.isArray(lines) ? lines : [];
    await tx`delete from encomenda_linhas where order_id = ${orderId}`;
    const recs = lineRecords(orderId, lineList, editedAt, carried);
    if (recs.length) await tx`insert into encomenda_linhas ${tx(recs)}`;
    await tx`update encomendas set ${tx({
      order_notes: orderNotes || '',
      order_type: type,
      doors_data: type === 'Portas' && doorsData ? tx.json(doorsData) : null,
      edited_by: editedBy || '',
      edited_at: editedAt
    })} where order_id = ${orderId}`;

    if (RESERVING_STATUSES.includes(h.status)) {
      return applyReservation(tx, lineList.map((l) => ({ sku: l.sku, qtyOrdered: Number(l.qtyOrdered) || 1, qtyPicked: 0 })), +1);
    }
    return [];
  });
  await sendAlerts(alerts, `edição encomenda ${orderId}`);
  return getOrderById(orderId);
}

async function updateLinePicked(orderId, sku, qtyPicked, lineIndex) {
  const sql = getSql();
  let rows = [];
  if (Number.isInteger(lineIndex)) {
    rows = await sql`
      update encomenda_linhas set qty_picked = ${qtyPicked}, line_total = ${qtyPicked} * coalesce(unit_price, 0)
       where order_id = ${orderId} and posicao = ${lineIndex} returning id`;
  }
  if (rows.length === 0) {
    rows = await sql`
      update encomenda_linhas set qty_picked = ${qtyPicked}, line_total = ${qtyPicked} * coalesce(unit_price, 0)
       where id = (select id from encomenda_linhas where order_id = ${orderId} and sku = ${cleanSku(sku)} order by posicao desc limit 1)
      returning id`;
  }
  if (rows.length === 0) throw new Error(`Line ${sku} not found in order ${orderId}`);
}

async function updateLineStatus(orderId, lineIndex, lineStatus) {
  const st = lineStatus ? normalizeLineStatus(lineStatus) : '';
  if (lineStatus && !st) throw new Error(`Estado de linha inválido: ${lineStatus}`);
  if (!Number.isInteger(lineIndex) || lineIndex < 0) throw new Error('lineIndex inválido');
  const sql = getSql();
  const [h] = await sql`select status from encomendas where order_id = ${orderId}`;
  if (!h) throw new Error(`Encomenda ${orderId} não encontrada`);
  if (!LINE_STATUS_EDITABLE.includes(h.status)) {
    throw new Error(`Não é possível alterar linhas de uma encomenda ${h.status.toLowerCase()}`);
  }
  const at = st ? new Date().toISOString() : null;
  const rows = await sql`
    update encomenda_linhas set line_status = ${st}, line_status_at = ${at}
     where order_id = ${orderId} and posicao = ${lineIndex} returning id`;
  if (rows.length === 0) throw new Error(`Linha ${lineIndex} não encontrada na encomenda ${orderId}`);
  return { lineIndex, lineStatus: st, lineStatusAt: at || '' };
}

module.exports = {
  STATUS,
  LINE_STATUSES,
  getAllOrders,
  getOrderById,
  createOrder,
  updateOrderStatus,
  updateOrderContent,
  updateLinePicked,
  updateLineStatus,
  ensureOrdersTabExists
};
