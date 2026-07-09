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

const { sheetsFetch, parsePtNumber, formatPtNumber, appendLogEntry } = require('./sheets');

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
  DISCOUNT_PCT: 18   // S — per-line discount percentage (0-100)
};

// ─── Status values ─────────────────────────────────────────────────────────
const STATUS = {
  DRAFT: 'Rascunho',
  SENT: 'Enviado',
  PICKING: 'Em separação',
  COMPLETE: 'Concluído',
  CANCELLED: 'Cancelado'
};

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
    'Qtd Encomendada', 'Qtd Separada', 'Preço Unitário', 'Total Linha', 'Notas Linha', 'Desconto %'
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
    discountPct: parsePtNumber(row[ORDER_COLS.DISCOUNT_PCT]) || 0
  };
}

// Groups flat order lines into order objects for the UI
function groupOrderLines(lines) {
  const orders = new Map();
  for (const line of lines) {
    if (!line.orderId) continue;
    if (!orders.has(line.orderId)) {
      orders.set(line.orderId, {
        orderId: line.orderId,
        clientId: line.clientId,
        clientName: line.clientName,
        status: line.status,
        createdAt: line.createdAt,
        salesperson: line.salesperson,
        orderNotes: line.orderNotes,
        lines: []
      });
    }
    orders.get(line.orderId).lines.push(line);
  }
  return Array.from(orders.values());
}

async function getAllOrderLines() {
  await ensureOrdersTabExists();
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${ORDERS_TAB}!A2:S`)}`);
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

// Creates a new order — writes one row per line item, all sharing the same
// order ID, status, client info, and order-level metadata.
async function createOrder({ clientId, clientName, salesperson, orderNotes, lines }) {
  await ensureOrdersTabExists();
  const orderId = generateOrderId();
  const createdAt = new Date().toISOString();
  const status = STATUS.DRAFT;

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
      formatPtNumber(discountPct)
    ];
  });

  await sheetsFetch(
    `/values/${encodeURIComponent(`${ORDERS_TAB}!A:S`)}:append?valueInputOption=USER_ENTERED`,
    { method: 'POST', body: JSON.stringify({ values: rows }) }
  );

  return { orderId, status, createdAt, clientId, clientName, lines };
}

// Updates the status of every line belonging to an order.
// We have to read all rows first to find which sheet rows belong to this
// order, then batch-update just the status column on those rows.
async function updateOrderStatus(orderId, newStatus) {
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${ORDERS_TAB}!A2:A`)}`);
  const rows = data.values || [];

  const updates = [];
  rows.forEach((row, idx) => {
    if (row[0] === orderId) {
      // +2: 1-indexed rows, plus header row offset
      updates.push({
        range: `${ORDERS_TAB}!D${idx + 2}`,
        values: [[newStatus]]
      });
    }
  });

  if (updates.length === 0) throw new Error(`Order ${orderId} not found`);

  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates })
  });
}

// Updates qtyPicked for a specific line within an order (identified by SKU).
// Also updates lineTotal based on new qty picked.
async function updateLinePicked(orderId, sku, qtyPicked) {
  // Read order ID column and SKU column together to find the exact row
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${ORDERS_TAB}!A2:S`)}`);
  const rows = data.values || [];

  let targetRowIndex = -1;
  let unitPrice = 0;

  rows.forEach((row, idx) => {
    if (row[ORDER_COLS.ORDER_ID] === orderId && row[ORDER_COLS.SKU] === sku) {
      targetRowIndex = idx + 2;
      unitPrice = parsePtNumber(row[ORDER_COLS.UNIT_PRICE]) || 0;
    }
  });

  if (targetRowIndex === -1) throw new Error(`Line ${sku} not found in order ${orderId}`);

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
  updateLinePicked,
  ensureOrdersTabExists
};
