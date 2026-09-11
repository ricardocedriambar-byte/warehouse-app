// lib/orders.js
//
// Data layer for the order management system. Uses two new tabs in the
// existing Google Sheet:
//
//   Clientes  — one row per client
//   Encomendas — one row per order LINE (flat structure, Sheets-friendly)
//
// Order IDs are generated as ENC-YYYYMMDD-XXXX (e.g. ENC-20240617-0042).
// All monetary values use the Portuguese comma-decimal format via
// formatPtNumber/parsePtNumber from sheets.js.

const { sheetsFetch, parsePtNumber, formatPtNumber, appendLogEntry, findItemBySku, adjustStock, adjustReservado } = require('./sheets');
const { maybeSendLowStockAlert } = require('./stockAlerts');

const CLIENTS_TAB = 'Clientes';
const ORDERS_TAB = 'Encomendas';

// ─── Column layouts ────────────────────────────────────────────────────────

const CLIENT_COLS = {
  ID: 0,       // A
  NAME: 1,     // B
  ADDRESS: 2,  // C  (Morada)
  PHONE: 3,    // D  (Telefone)
  EMAIL: 4,    // E
  NOTES: 5     // F  (Notas — often contains "NIF: 123456789" embedded as text,
               //     sometimes with extra info appended, e.g.
               //     "NIF: 501958053 · Fax: 259336659")
};

// Pulls a NIF out of the Notas text if one is present. Handles "NIF: X",
// "NIF X", and NIF followed by other appended info (only the digit run
// right after "NIF" is taken, so trailing " · Fax: ..." etc. is ignored).
function extractNif(notes) {
  if (!notes) return '';
  const m = String(notes).match(/NIF[:\s]*([0-9][0-9.\s]*[0-9]|[0-9])/i);
  return m ? m[1].replace(/[.\s]/g, '') : '';
}

const ORDER_COLS = {
  ORDER_ID: 0,       // A
  CLIENT_ID: 1,      // B
  CLIENT_NAME: 2,    // C (denormalized for readability)
  STATUS: 3,         // D
  CREATED_AT: 4,     // E
  SALESPERSON: 5,    // F
  ORDER_NOTES: 6,    // G
  SKU: 7,            // H
  DESCRICAO: 8,      // I
  COMPRIMENTO: 9,    // J
  LARGURA: 10,       // K
  ESPESSURA: 11,     // L
  UNIDADE: 12,       // M — unit of measure (un / m² / ml / m³ / lt)
  QTY_ORDERED: 13,   // N
  QTY_PICKED: 14,    // O
  UNIT_PRICE: 15,    // P
  LINE_TOTAL: 16,    // Q
  LINE_NOTES: 17,    // R
  DISCOUNT_PCT: 18,  // S — per-line discount percentage (0-100)
  ORDER_TYPE: 19,    // T — 'Normal' | 'Portas'
  DOORS_DATA: 20,    // U — JSON blob with the full door-order spec (Portas only)
  EDITED_BY: 21,     // V — name of whoever last edited an already-created order (blank if never edited)
  EDITED_AT: 22      // W — ISO timestamp of that last edit
};

// ─── Status values ─────────────────────────────────────────────────────────
const STATUS = {
  DRAFT: 'Rascunho',
  SENT: 'Enviado',
  PICKING: 'Em separação',
  COMPLETE: 'Concluído',
  CANCELLED: 'Cancelado'
};

// An order's content (measurements, lines, notes) can only be corrected
// while it's still a Rascunho or freshly Enviado — once the warehouse has
// actually started pulling materials (Em separação) or finished
// (Concluído), the ficha is frozen. Cancelled orders are simply gone.
const EDITABLE_STATUSES = [STATUS.DRAFT, STATUS.SENT];

// ─── Stock reservation ──────────────────────────────────────────────────────
// While an order sits in Enviado or Em separação, its ordered-but-not-yet-
// picked quantity is held in each item's RESERVADO column so a second
// vendedor can't send a separate order for units that are already
// committed. "Available" everywhere is STOCK - RESERVADO, never raw STOCK.
//
// The reservation for a line is released piece-by-piece as it gets picked
// (see api/pick-line.js, which decrements RESERVADO in lockstep with
// STOCK), and any remainder is released in one shot here whenever an order
// leaves an active state (cancelled, or reverted) — see
// applyReservationForLines below, driven by comparing old vs. new status.
const RESERVING_STATUSES = [STATUS.SENT, STATUS.PICKING];

// Same pricing-unit → physical-piece conversion used in api/pick-line.js
// and the CANCELLED stock-restore below: STOCK (and now RESERVADO) always
// counts physical pieces, but order lines carry qty in the item's pricing
// unit (e.g. m²).
function toPieces(item, qtyInPricingUnit) {
  return (item.unidade && item.unidade !== 'un' && item.dimensaoM2)
    ? qtyInPricingUnit / item.dimensaoM2
    : qtyInPricingUnit;
}

// direction: +1 to reserve (order becoming active), -1 to release (order
// leaving an active state). Only the unpicked remainder of each line is
// affected — whatever's already been picked was already released by
// pick-line.js as it happened. Lines whose SKU isn't a real Etiquetas item
// (e.g. "PORTA-..." door BOM components, or ad-hoc products added only to
// one order) are skipped silently — there's nothing to reserve for them.
async function applyReservationForLines(lines, direction, contextNote) {
  for (const line of lines) {
    const sku = (line.sku || '').replace(/^'/, ''); // strip leading-zero-preserving apostrophe
    if (!sku) continue;
    const remaining = (line.qtyOrdered || 0) - (line.qtyPicked || 0);
    if (remaining <= 0) continue;

    try {
      const item = await findItemBySku(sku);
      if (!item) continue;
      const pieces = toPieces(item, remaining);
      const result = await adjustReservado(item, direction * pieces);
      await maybeSendLowStockAlert(result).catch((err) =>
        console.error(`low-stock alert failed for ${sku} (${contextNote}):`, err)
      );
    } catch (err) {
      console.error(`Failed to ${direction > 0 ? 'reserve' : 'release'} stock for ${sku} (${contextNote}):`, err);
    }
  }
}

// ─── ID generation ─────────────────────────────────────────────────────────
function generateOrderId() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = String(Math.floor(Math.random() * 9000) + 1000);
  return `ENC-${date}-${rand}`;
}

function generateClientId() {
  return `CLI-${Date.now()}`;
}

// ─── Tab creation ──────────────────────────────────────────────────────────
async function ensureTabExists(tabName, headers) {
  try {
    await sheetsFetch(`/values/${encodeURIComponent(`${tabName}!A1`)}`, {});
  } catch (err) {
    if (String(err.message).includes('400') || String(err.message).includes('Unable to parse')) {
      // Tab doesn't exist — create it with headers
      await sheetsFetch(':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: tabName } } }]
        })
      }).catch(() => {});
      await sheetsFetch(
        `/values/${encodeURIComponent(`${tabName}!A1`)}:append?valueInputOption=USER_ENTERED`,
        { method: 'POST', body: JSON.stringify({ values: [headers] }) }
      );
    }
  }
}

// Module-level cache: once we've confirmed the tabs exist during this
// warm serverless instance's lifetime, never check again. Previously every
// single read/write (getAllClients, getAllOrderLines, createOrder, etc.)
// paid for 2 extra Sheets API round-trips just to verify tabs that almost
// always already exist — doubling latency on every request for no reason.
let tabsEnsured = false;

async function ensureOrdersTabExists() {
  if (tabsEnsured) return;
  await ensureTabExists(CLIENTS_TAB, [
    'ID', 'Nome', 'Morada', 'Telefone', 'Email', 'Notas'
  ]);
  await ensureTabExists(ORDERS_TAB, [
    'ID Encomenda', 'ID Cliente', 'Nome Cliente', 'Estado', 'Criado em',
    'Vendedor', 'Notas Encomenda', 'SKU', 'Descrição',
    'Comprimento', 'Largura', 'Espessura', 'Unidade',
    'Qtd Encomendada', 'Qtd Separada', 'Preço Unitário', 'Total Linha', 'Notas Linha', 'Desconto %',
    'Tipo', 'Dados Portas (JSON)', 'Editado por', 'Editado em'
  ]);
  tabsEnsured = true;
}

// ─── Clients ───────────────────────────────────────────────────────────────
function rowToClient(row) {
  const notes = row[CLIENT_COLS.NOTES] || '';
  return {
    id: row[CLIENT_COLS.ID] || '',
    name: row[CLIENT_COLS.NAME] || '',
    nif: extractNif(notes),
    address: row[CLIENT_COLS.ADDRESS] || '',
    phone: row[CLIENT_COLS.PHONE] || '',
    email: row[CLIENT_COLS.EMAIL] || '',
    notes
  };
}

async function getAllClients() {
  await ensureOrdersTabExists();
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${CLIENTS_TAB}!A2:F`)}`);
  const rows = data.values || [];
  return rows.filter(r => r[0]).map(rowToClient);
}

async function createClient({ name, nif, address, phone, email, notes }) {
  await ensureOrdersTabExists();
  const id = generateClientId();
  // There's no separate NIF column in the sheet — it's kept as text inside
  // Notas (e.g. "NIF: 123456789"), consistent with the existing rows.
  const combinedNotes = nif ? `NIF: ${nif}${notes ? ' · ' + notes : ''}` : (notes || '');
  const row = [id, name || '', address || '', phone || '', email || '', combinedNotes];
  await sheetsFetch(
    `/values/${encodeURIComponent(`${CLIENTS_TAB}!A:F`)}:append?valueInputOption=USER_ENTERED`,
    { method: 'POST', body: JSON.stringify({ values: [row] }) }
  );
  return { id, name, nif, address, phone, email, notes: combinedNotes };
}

// ─── Orders ────────────────────────────────────────────────────────────────
function rowToOrderLine(row) {
  return {
    orderId: row[ORDER_COLS.ORDER_ID] || '',
    clientId: row[ORDER_COLS.CLIENT_ID] || '',
    clientName: row[ORDER_COLS.CLIENT_NAME] || '',
    status: row[ORDER_COLS.STATUS] || STATUS.DRAFT,
    createdAt: row[ORDER_COLS.CREATED_AT] || '',
    salesperson: row[ORDER_COLS.SALESPERSON] || '',
    orderNotes: row[ORDER_COLS.ORDER_NOTES] || '',
    sku: row[ORDER_COLS.SKU] || '',
    descricao: row[ORDER_COLS.DESCRICAO] || '',
    comprimento: parsePtNumber(row[ORDER_COLS.COMPRIMENTO]),
    largura: parsePtNumber(row[ORDER_COLS.LARGURA]),
    espessura: parsePtNumber(row[ORDER_COLS.ESPESSURA]),
    unidade: row[ORDER_COLS.UNIDADE] || 'un',
    qtyOrdered: parsePtNumber(row[ORDER_COLS.QTY_ORDERED]) || 0,
    qtyPicked: parsePtNumber(row[ORDER_COLS.QTY_PICKED]) || 0,
    unitPrice: parsePtNumber(row[ORDER_COLS.UNIT_PRICE]),
    lineTotal: parsePtNumber(row[ORDER_COLS.LINE_TOTAL]),
    lineNotes: row[ORDER_COLS.LINE_NOTES] || '',
    discountPct: parsePtNumber(row[ORDER_COLS.DISCOUNT_PCT]) || 0,
    orderType: row[ORDER_COLS.ORDER_TYPE] || 'Normal',
    doorsDataRaw: row[ORDER_COLS.DOORS_DATA] || '',
    editedBy: row[ORDER_COLS.EDITED_BY] || '',
    editedAt: row[ORDER_COLS.EDITED_AT] || ''
  };
}

// Groups flat order lines into order objects for the UI
function groupOrderLines(lines) {
  const orders = new Map();
  for (const line of lines) {
    if (!line.orderId) continue;
    if (!orders.has(line.orderId)) {
      let doorsData = null;
      if (line.doorsDataRaw) {
        try { doorsData = JSON.parse(line.doorsDataRaw); } catch { doorsData = null; }
      }
      orders.set(line.orderId, {
        orderId: line.orderId,
        clientId: line.clientId,
        clientName: line.clientName,
        status: line.status,
        createdAt: line.createdAt,
        salesperson: line.salesperson,
        orderNotes: line.orderNotes,
        orderType: line.orderType || 'Normal',
        doorsData,
        editedBy: line.editedBy || '',
        editedAt: line.editedAt || '',
        lines: []
      });
    }
    // doorsDataRaw/editedBy/editedAt are order-level facts duplicated on
    // every physical row — only needed once above, stripped from each
    // individual line so they don't get echoed back per-line.
    const { doorsDataRaw, editedBy, editedAt, ...lineWithoutRaw } = line;
    orders.get(line.orderId).lines.push(lineWithoutRaw);
  }
  return Array.from(orders.values());
}

async function getAllOrderLines() {
  await ensureOrdersTabExists();
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${ORDERS_TAB}!A2:W`)}`);
  const rows = data.values || [];
  return rows.filter(r => r[0]).map(rowToOrderLine);
}

async function getAllOrders() {
  const lines = await getAllOrderLines();
  return groupOrderLines(lines);
}

async function getOrderById(orderId) {
  const lines = await getAllOrderLines();
  const orderLines = lines.filter(l => l.orderId === orderId);
  if (orderLines.length === 0) return null;
  return groupOrderLines(orderLines)[0];
}

// Picks a starting row for orderId's lines and writes them there. Sheets
// has no atomic "give me the next free row" or compare-and-set, so the
// naive version of this (read how many rows are used, write to the row
// after that) is a real race: two orders created in the same moment can
// both compute the SAME target row from a stale read, and whichever
// finishes writing last silently overwrites the other's lines.
//
// This narrows that window: claim the row with a single small write to
// just its Order ID cell, verify that claim actually stuck, THEN write the
// real data, then verify once more that nothing landed on top in between.
// If either check fails, someone else won the race for this row — retry
// one row further down rather than corrupting either order.
async function writeOrderRows(orderId, rows, attempt = 0) {
  const MAX_ATTEMPTS = 6;

  const existing = await sheetsFetch(`/values/${encodeURIComponent(`${ORDERS_TAB}!A2:A`)}`);
  const usedRows = (existing.values || []).length;
  const startRow = usedRows + 2; // +1 for the header row, +1 to move past the last used row

  const readClaimCell = async () => {
    const r = await sheetsFetch(`/values/${encodeURIComponent(`${ORDERS_TAB}!A${startRow}`)}`);
    return (r.values && r.values[0] && r.values[0][0]) || '';
  };

  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [{ range: `${ORDERS_TAB}!A${startRow}`, values: [[orderId]] }]
    })
  });

  if ((await readClaimCell()) !== orderId) {
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`Não foi possível gravar a encomenda ${orderId} — demasiadas escritas em simultâneo`);
    }
    return writeOrderRows(orderId, rows, attempt + 1);
  }

  const data = rows.map((row, i) => ({
    range: `${ORDERS_TAB}!A${startRow + i}:W${startRow + i}`,
    values: [row]
  }));
  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
  });

  if ((await readClaimCell()) !== orderId) {
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`Não foi possível gravar a encomenda ${orderId} — demasiadas escritas em simultâneo`);
    }
    return writeOrderRows(orderId, rows, attempt + 1);
  }

  return startRow;
}

// Creates a new order — writes one row per line item, all sharing the same
// order ID, status, client info, and order-level metadata.
async function createOrder({ clientId, clientName, salesperson, orderNotes, lines, status: requestedStatus, orderType, doorsData }) {
  await ensureOrdersTabExists();
  const orderId = generateOrderId();
  const createdAt = new Date().toISOString();
  // Accept a target status up front (e.g. 'Enviado') so the order can be
  // written in its final state in one shot. Previously the caller always
  // created as DRAFT then immediately PATCHed the status right after —
  // that second call reads the sheet back to find the row it just wrote,
  // and occasionally lost the race against Sheets' own read-after-write
  // propagation, failing with "Order not found" on a brand new order.
  const status = Object.values(STATUS).includes(requestedStatus) ? requestedStatus : STATUS.DRAFT;
  const type = orderType === 'Portas' ? 'Portas' : 'Normal';
  const doorsDataJson = (type === 'Portas' && doorsData) ? JSON.stringify(doorsData) : '';

  const rows = lines.map(line => {
    const discountPct = Number(line.discountPct) || 0;
    const gross        = (line.qtyOrdered || 0) * (line.unitPrice || 0);
    const lineTotal     = gross * (1 - discountPct / 100);
    return [
      orderId, clientId, clientName, status, createdAt, salesperson || '', orderNotes || '',
      `'${line.sku}`, line.descricao || '',
      line.comprimento || '', line.largura || '', line.espessura || '',
      line.unidade || 'un',
      formatPtNumber(line.qtyOrdered || 1),
      '0',
      formatPtNumber(line.unitPrice || 0),
      formatPtNumber(lineTotal),
      line.lineNotes || '',
      formatPtNumber(discountPct),
      type,
      doorsDataJson,
      '', '' // Editado por / Editado em — blank until this order is edited
    ];
  });

  // Write to an EXPLICITLY computed row range using batchUpdate, the proven
  // and reliable Sheets API pattern used everywhere else in the codebase.
  // This avoids the :append endpoint's "table detection" quirk that was
  // shifting new rows sideways to column S instead of A.
  await writeOrderRows(orderId, rows);

  // If the order is created already-active (the common case — vendedor
  // hits "Enviar" directly), reserve its stock now. A plain Rascunho
  // doesn't reserve anything until it's actually sent.
  if (RESERVING_STATUSES.includes(status)) {
    const lineObjs = lines.map(l => ({ sku: l.sku, qtyOrdered: Number(l.qtyOrdered) || 1, qtyPicked: 0 }));
    await applyReservationForLines(lineObjs, +1, `nova encomenda ${orderId}`);
  }

  return { orderId, status, createdAt, clientId, clientName, orderType: type, doorsData: doorsData || null, lines };
}

// Updates the status of every line belonging to an order.
// We have to read all rows first to find which sheet rows belong to this
// order, then batch-update just the status column on those rows.
async function updateOrderStatus(orderId, newStatus) {
  // Read full rows (not just column A) — cancellation needs each line's
  // SKU and qtyPicked to restore stock, not just which rows belong to
  // this order.
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${ORDERS_TAB}!A2:S`)}`);
  const rows = data.values || [];

  const matchedRows = [];
  const updates = [];
  rows.forEach((row, idx) => {
    if (row[ORDER_COLS.ORDER_ID] === orderId) {
      matchedRows.push(row);
      // +2: 1-indexed rows, plus header row offset
      updates.push({
        range: `${ORDERS_TAB}!D${idx + 2}`,
        values: [[newStatus]]
      });
    }
  });

  if (updates.length === 0) throw new Error(`Order ${orderId} not found`);

  // Reserve or release stock depending on whether this status change is
  // entering or leaving an "active" (Enviado/Em separação) state. Compares
  // the OLD status (read above, before we've written anything) against the
  // new one, so this works for every transition — first send, cancel from
  // either active state, skipping straight from Enviado to Concluído,
  // even a manual revert — without special-casing each one.
  const oldStatus = matchedRows[0] ? matchedRows[0][ORDER_COLS.STATUS] : null;
  const wasReserving = RESERVING_STATUSES.includes(oldStatus);
  const willReserve = RESERVING_STATUSES.includes(newStatus);
  if (wasReserving !== willReserve) {
    const lineObjs = matchedRows.map(row => ({
      sku: row[ORDER_COLS.SKU] || '',
      qtyOrdered: parsePtNumber(row[ORDER_COLS.QTY_ORDERED]) || 0,
      qtyPicked: parsePtNumber(row[ORDER_COLS.QTY_PICKED]) || 0
    }));
    await applyReservationForLines(lineObjs, willReserve ? +1 : -1, `encomenda ${orderId} → ${newStatus}`);
  }

  // Cancelling an order that already had picked quantities means that
  // stock was decremented for those lines (see api/pick-line.js) — give it
  // back. Only lines with qtyPicked > 0 are affected; never-picked lines
  // never touched stock in the first place.
  if (newStatus === STATUS.CANCELLED) {
    for (const row of matchedRows) {
      const sku = (row[ORDER_COLS.SKU] || '').replace(/^'/, ''); // strip the leading-zero-preserving apostrophe
      const qtyPicked = parsePtNumber(row[ORDER_COLS.QTY_PICKED]) || 0;
      if (!sku || qtyPicked <= 0) continue;

      try {
        const item = await findItemBySku(sku);
        if (!item) continue; // item may have been removed from inventory since
        // Same conversion as pick-line.js: qtyPicked here is stored in the
        // item's PRICING unit (e.g. m²), but STOCK counts physical pieces.
        const piecesPicked = (item.unidade && item.unidade !== 'un' && item.dimensaoM2)
          ? qtyPicked / item.dimensaoM2
          : qtyPicked;
        // adjustStock re-reads and verifies internally (see lib/sheets.js)
        // so this can't clobber — or be clobbered by — a concurrent pick or
        // another cancellation touching the same SKU.
        const stockResult = await adjustStock(sku, piecesPicked);
        const currentStock  = stockResult ? stockResult.oldStock : (item.stock || 0);
        const restoredStock = stockResult ? stockResult.newStock : currentStock + piecesPicked;
        await appendLogEntry({
          sku,
          descricao: item.descricao,
          field: 'STOCK',
          oldValue: currentStock,
          newValue: restoredStock,
          note: `Cancelamento encomenda ${orderId} — stock reposto (${qtyPicked} ${item.unidade || 'un'} = ${piecesPicked.toFixed(3)} un)`
        });
      } catch (err) {
        // Don't let a single line's stock-restore failure block the whole
        // cancellation — log it and continue with the rest.
        console.error(`Failed to restore stock for ${sku} on cancel of ${orderId}:`, err);
      }
    }
  }

  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates })
  });
}

// Rewrites the content (lines, notes, doors ficha) of an EXISTING order —
// used to correct a Rascunho or an already-Enviado order (e.g. a wrong
// measurement noticed before production starts). Only allowed while the
// order is still in an editable status (see EDITABLE_STATUSES) — once the
// warehouse has started separating it, the ficha is frozen and this
// throws instead of silently rewriting materials that may already be cut.
//
// Rather than trying to shift rows in place (risky with Sheets' lack of
// atomic multi-row moves, and this order's line count can grow or shrink
// on edit), this clears the order's current row block outright and
// re-appends the new lines at the end via the same claim-verify
// writeOrderRows used by createOrder. Every reader already treats a blank
// Order ID cell as "nothing here" (see getAllOrderLines' `filter(r => r[0])`),
// so leaving the old block empty is safe and far simpler than renumbering
// every row below it.
async function updateOrderContent(orderId, { orderNotes, lines, orderType, doorsData, editedBy }) {
  await ensureOrdersTabExists();
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${ORDERS_TAB}!A2:W`)}`);
  const rows = data.values || [];

  const matchedIdx = [];
  rows.forEach((row, idx) => { if (row[ORDER_COLS.ORDER_ID] === orderId) matchedIdx.push(idx); });
  if (matchedIdx.length === 0) throw new Error(`Encomenda ${orderId} não encontrada`);

  const firstRow = rows[matchedIdx[0]];
  const status = firstRow[ORDER_COLS.STATUS] || STATUS.DRAFT;
  if (!EDITABLE_STATUSES.includes(status)) {
    throw new Error(`A encomenda ${orderId} já não pode ser editada (estado atual: ${status})`);
  }

  const clientId     = firstRow[ORDER_COLS.CLIENT_ID];
  const clientName   = firstRow[ORDER_COLS.CLIENT_NAME];
  const createdAt    = firstRow[ORDER_COLS.CREATED_AT];
  const salesperson  = firstRow[ORDER_COLS.SALESPERSON];
  // Client and order type are locked in the edit UI — this just carries
  // the original value forward if the caller doesn't pass one.
  const type = orderType === 'Portas' ? 'Portas' : (firstRow[ORDER_COLS.ORDER_TYPE] || 'Normal');

  // Release the reservation held by the CURRENT lines before they're
  // replaced, exactly as if the order were leaving an active state — only
  // relevant while it's already Enviado (a Rascunho never reserved
  // anything in the first place).
  if (RESERVING_STATUSES.includes(status)) {
    const oldLineObjs = matchedIdx.map(idx => {
      const row = rows[idx];
      return {
        sku: (row[ORDER_COLS.SKU] || '').replace(/^'/, ''),
        qtyOrdered: parsePtNumber(row[ORDER_COLS.QTY_ORDERED]) || 0,
        qtyPicked: parsePtNumber(row[ORDER_COLS.QTY_PICKED]) || 0
      };
    });
    await applyReservationForLines(oldLineObjs, -1, `edição encomenda ${orderId} (linhas antigas)`);
  }

  // Blank out the old row block (contiguous — every write, including a
  // previous edit, always lays an order's rows down as one block).
  const minRow = Math.min(...matchedIdx) + 2;
  const maxRow = Math.max(...matchedIdx) + 2;
  await sheetsFetch(`/values/${encodeURIComponent(`${ORDERS_TAB}!A${minRow}:W${maxRow}`)}:clear`, { method: 'POST' });

  const editedAt = new Date().toISOString();
  const doorsDataJson = (type === 'Portas' && doorsData) ? JSON.stringify(doorsData) : '';

  const newRows = lines.map(line => {
    const discountPct = Number(line.discountPct) || 0;
    const gross        = (line.qtyOrdered || 0) * (line.unitPrice || 0);
    const lineTotal     = gross * (1 - discountPct / 100);
    return [
      orderId, clientId, clientName, status, createdAt, salesperson || '', orderNotes || '',
      `'${line.sku}`, line.descricao || '',
      line.comprimento || '', line.largura || '', line.espessura || '',
      line.unidade || 'un',
      formatPtNumber(line.qtyOrdered || 1),
      '0',
      formatPtNumber(line.unitPrice || 0),
      formatPtNumber(lineTotal),
      line.lineNotes || '',
      formatPtNumber(discountPct),
      type,
      doorsDataJson,
      editedBy || '',
      editedAt
    ];
  });

  await writeOrderRows(orderId, newRows);

  // Re-reserve the new lines the same way createOrder does for a
  // freshly-sent order.
  if (RESERVING_STATUSES.includes(status)) {
    const newLineObjs = lines.map(l => ({ sku: l.sku, qtyOrdered: Number(l.qtyOrdered) || 1, qtyPicked: 0 }));
    await applyReservationForLines(newLineObjs, +1, `edição encomenda ${orderId} (linhas novas)`);
  }

  return getOrderById(orderId);
}

// Updates qtyPicked for a specific line within an order. `lineIndex` is
// that line's position within order.lines (as returned by getOrderById/
// getAllOrders — see groupOrderLines above), which pins down the exact
// sheet row even when two lines in the order share the same SKU — the
// same real catalog item added to an order twice, or two "no SKU" ad-hoc
// products (public/app.js's showNewProductForm defaults a blank SKU to
// the placeholder "—", so two of those collide too). Matching by SKU
// alone used to silently update whichever matching row happened to come
// LAST in the sheet, regardless of which line the person actually picked.
// `sku` is kept as a fallback for older callers and as a last resort when
// lineIndex doesn't resolve to a real row.
async function updateLinePicked(orderId, sku, qtyPicked, lineIndex) {
  // Read order ID column and SKU column together to find the exact row
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${ORDERS_TAB}!A2:S`)}`);
  const rows = data.values || [];

  // Every row belonging to this order, in sheet order — the same order
  // groupOrderLines() builds order.lines in, so lineIndex lines up exactly.
  const orderRows = [];
  rows.forEach((row, idx) => {
    if (row[ORDER_COLS.ORDER_ID] === orderId) orderRows.push({ row, sheetRow: idx + 2 });
  });

  let target = Number.isInteger(lineIndex) ? orderRows[lineIndex] : undefined;
  if (!target) target = orderRows.find(r => r.row[ORDER_COLS.SKU] === sku);
  if (!target) throw new Error(`Line ${sku} not found in order ${orderId}`);

  const targetRowIndex = target.sheetRow;
  const unitPrice = parsePtNumber(target.row[ORDER_COLS.UNIT_PRICE]) || 0;
  const lineTotal = qtyPicked * unitPrice;

  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `${ORDERS_TAB}!O${targetRowIndex}`, values: [[formatPtNumber(qtyPicked)]] },
        { range: `${ORDERS_TAB}!Q${targetRowIndex}`, values: [[formatPtNumber(lineTotal)]] }
      ]
    })
  });
}

module.exports = {
  STATUS,
  getAllClients,
  createClient,
  getAllOrders,
  getOrderById,
  createOrder,
  updateOrderStatus,
  updateOrderContent,
  updateLinePicked,
  ensureOrdersTabExists
};
