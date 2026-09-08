// lib/sheets.js
//
// Thin wrapper around the Google Sheets API. Every serverless function
// in /api imports this instead of talking to Google directly, so there's
// one place that knows about auth, column layout, and number parsing.

const { JWT } = require('google-auth-library');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || 'Folha1';
const LOG_TAB = process.env.LOG_TAB || 'StockLog';

// Column layout, matching the live "Etiquetas" sheet exactly.
// If the sheet's columns ever change, this is the only place to update.
const COLUMNS = {
  SKU: 0,          // A - SKU
  FAMILIA: 1,       // B - FAMÍLIA
  DESCRICAO: 2,      // C - DESCRIÇÃO
  COMPRIMENTO: 3,     // D - COMPRIMENTO
  LARGURA: 4,        // E - LARGURA
  ESPESSURA: 5,       // F - ESPESSURA
  DIMENSAO_M2: 6,      // G - DIMENSÃO M²/UNIDADE
  VALOR_COMPRA: 7,      // H - VALOR COMPRA
  PRECO: 8,             // I - Preço
  // J is blank
  STOCK: 10,              // K - STOCK
  OBSERVACOES: 11,         // L - OBSERVAÇÕES
  QR: 12,                   // M - QR
  UNIDADE: 13,               // N - Unidade de medida (un / m² / ml / m³ / lt)
  RESERVADO: 14,              // O - stock committed to active orders (Enviado/Em
                               //     separação) but not yet picked. Maintained by
                               //     lib/orders.js and api/pick-line.js.
  STOCK_MINIMO: 15             // P - reorder threshold. Ricardo edits this column
                                //     directly in the sheet (same pattern as
                                //     MateriaisPortas) — blank means "no alert".
};

const FIRST_DATA_ROW = 2; // row 1 is the header

let cachedClient = null;

function getAuthClient() {
  if (cachedClient) return cachedClient;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  }

  const credentials = JSON.parse(raw);
  cachedClient = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly'
    ]
  });
  return cachedClient;
}

async function sheetsFetch(path, options = {}) {
  const client = getAuthClient();
  const token = await client.authorize();

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets API ${res.status}: ${body}`);
  }
  return res.json();
}

// Exported so other modules (e.g. priceList.js) can make their own
// authenticated Google API calls without duplicating auth logic.
async function getAuthToken() {
  const client = getAuthClient();
  const token = await client.authorize();
  return token.access_token;
}

// Parses a European-formatted number string ("5,985" -> 5.985, "1.234,5" -> 1234.5).
// Returns null for empty/unparseable values rather than 0, so we can tell
// "no value" apart from "value is zero".
function parsePtNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value;
  const cleaned = String(value).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

// Formats a number back into the sheet's European style for writing/display.
function formatPtNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return String(value).replace('.', ',');
}

function rowToItem(row, rowIndex) {
  return {
    rowNumber: rowIndex,
    sku: row[COLUMNS.SKU] || '',
    familia: row[COLUMNS.FAMILIA] || '',
    descricao: row[COLUMNS.DESCRICAO] || '',
    comprimento: parsePtNumber(row[COLUMNS.COMPRIMENTO]),
    largura: parsePtNumber(row[COLUMNS.LARGURA]),
    espessura: parsePtNumber(row[COLUMNS.ESPESSURA]),
    dimensaoM2: parsePtNumber(row[COLUMNS.DIMENSAO_M2]),
    valorCompra: parsePtNumber(row[COLUMNS.VALOR_COMPRA]),
    preco: parsePtNumber(row[COLUMNS.PRECO]),
    unidade: row[COLUMNS.UNIDADE] || 'un', // un / m² / ml / m³ / lt
    stock: parsePtNumber(row[COLUMNS.STOCK]),
    observacoes: row[COLUMNS.OBSERVACOES] || '',
    // reservado defaults to 0 (not null) — an empty cell means "nothing
    // reserved yet", not "unknown", unlike stock/preco.
    reservado: parsePtNumber(row[COLUMNS.RESERVADO]) || 0,
    // stockMinimo stays null when blank so callers can tell "no threshold
    // set" apart from "threshold is zero" and skip alerting entirely.
    stockMinimo: parsePtNumber(row[COLUMNS.STOCK_MINIMO]),
    // Convenience field: what's actually left to promise to a new order.
    get disponivel() { return (this.stock || 0) - (this.reservado || 0); }
  };
}

async function getAllItems() {
  const range = `${SHEET_TAB}!A2:P`;
  const data = await sheetsFetch(`/values/${encodeURIComponent(range)}`);
  const rows = data.values || [];
  return rows.map((row, i) => rowToItem(row, i + FIRST_DATA_ROW));
}

async function findItemBySku(sku) {
  const items = await getAllItems();
  const target = String(sku).trim();
  return items.find((item) => item.sku.trim() === target) || null;
}

// Updates STOCK, PRECO, and/or UNIDADE for a specific row.
async function updateItemFields(rowNumber, { stock, preco, unidade }) {
  const data = [];

  if (stock !== undefined) {
    data.push({ range: `${SHEET_TAB}!K${rowNumber}`, values: [[formatPtNumber(stock)]] });
  }
  if (preco !== undefined) {
    data.push({ range: `${SHEET_TAB}!I${rowNumber}`, values: [[formatPtNumber(preco)]] });
  }
  if (unidade !== undefined) {
    data.push({ range: `${SHEET_TAB}!N${rowNumber}`, values: [[unidade]] });
  }

  if (data.length === 0) return;

  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
  });
}

// Adjusts a single item's RESERVADO by `deltaPieces` (positive to reserve
// more, negative to release). `item` must be a freshly-read item (as from
// findItemBySku) so oldReservado reflects the current sheet value — Sheets
// has no atomic increment, so this is a read-then-write like everything
// else in this file, not a true compare-and-swap. Clamped at 0 so a
// bookkeeping slip never leaves a negative reservation sitting around.
//
// Returns before/after "available" (stock - reservado) numbers so callers
// can feed them to stockAlerts.maybeSendLowStockAlert without a second
// read.
async function adjustReservado(item, deltaPieces) {
  const oldReservado = item.reservado || 0;
  const newReservado = Math.max(0, oldReservado + deltaPieces);
  const stock = item.stock || 0;

  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [{ range: `${SHEET_TAB}!O${item.rowNumber}`, values: [[formatPtNumber(newReservado)]] }]
    })
  });

  return {
    sku: item.sku,
    descricao: item.descricao,
    oldReservado,
    newReservado,
    oldAvailable: stock - oldReservado,
    newAvailable: stock - newReservado,
    stockMinimo: item.stockMinimo
  };
}

// Updates Preço and optionally VALOR COMPRA for many rows in a single
// API call. updates is an array of { rowNumber, preco, valorCompra? }.
async function bulkUpdatePrices(updates) {
  if (updates.length === 0) return;

  const data = [];
  for (const { rowNumber, preco, valorCompra } of updates) {
    data.push({ range: `${SHEET_TAB}!I${rowNumber}`, values: [[formatPtNumber(preco)]] });
    if (valorCompra !== undefined && valorCompra !== null) {
      data.push({ range: `${SHEET_TAB}!H${rowNumber}`, values: [[formatPtNumber(valorCompra)]] });
    }
  }

  // Chunk to avoid very large single requests timing out.
  for (let i = 0; i < data.length; i += 500) {
    const chunk = data.slice(i, i + 500);
    await sheetsFetch('/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: chunk })
    });
  }
}

// Appends many rows to the audit log tab in one call, same fallback
// tab-creation behavior as appendLogEntry.
async function appendLogEntries(entries) {
  if (entries.length === 0) return;
  const timestamp = new Date().toISOString();
  const rows = entries.map(({ sku, descricao, field, oldValue, newValue, note }) =>
    [timestamp, sku, descricao || '', field, oldValue ?? '', newValue ?? '', note || '']
  );

  try {
    await sheetsFetch(
      `/values/${encodeURIComponent(`${LOG_TAB}!A:G`)}:append?valueInputOption=USER_ENTERED`,
      { method: 'POST', body: JSON.stringify({ values: rows }) }
    );
  } catch (err) {
    if (String(err.message).includes('Unable to parse range') || String(err.message).includes('400')) {
      await sheetsFetch(':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: LOG_TAB } } }] })
      }).catch(() => {});

      await sheetsFetch(
        `/values/${encodeURIComponent(`${LOG_TAB}!A:G`)}:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          body: JSON.stringify({
            values: [['Timestamp', 'SKU', 'Descrição', 'Campo', 'Valor anterior', 'Valor novo', 'Nota'], ...rows]
          })
        }
      );
    } else {
      throw err;
    }
  }
}

// Appends a row to the audit log tab. Creates the tab on first use if
// it doesn't exist yet, so this never blocks the main flow.
async function appendLogEntry({ sku, descricao, field, oldValue, newValue, note }) {
  const timestamp = new Date().toISOString();
  const row = [timestamp, sku, descricao || '', field, oldValue ?? '', newValue ?? '', note || ''];

  try {
    await sheetsFetch(
      `/values/${encodeURIComponent(`${LOG_TAB}!A:G`)}:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        body: JSON.stringify({ values: [row] })
      }
    );
  } catch (err) {
    // If the log tab doesn't exist, create it and retry once.
    if (String(err.message).includes('Unable to parse range') || String(err.message).includes('400')) {
      await sheetsFetch(':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: LOG_TAB } } }]
        })
      }).catch(() => {}); // ignore if it already exists / race condition

      await sheetsFetch(
        `/values/${encodeURIComponent(`${LOG_TAB}!A:G`)}:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          body: JSON.stringify({ values: [['Timestamp', 'SKU', 'Descrição', 'Campo', 'Valor anterior', 'Valor novo', 'Nota'], row] })
        }
      );
    } else {
      throw err;
    }
  }
}

const DOOR_MATERIALS_TAB = process.env.DOOR_MATERIALS_TAB || 'MateriaisPortas';

// Reads the list of door materials/finishes from a small dedicated tab
// (one name per row, column A). Ricardo edits this tab directly in
// Sheets to control what shows up in the "Portas" dropdown. If the tab
// doesn't exist yet, it's created with a couple of starter rows.
async function getDoorMaterials() {
  try {
    const data = await sheetsFetch(`/values/${encodeURIComponent(`${DOOR_MATERIALS_TAB}!A2:A`)}`);
    const rows = data.values || [];
    return rows.map(r => (r[0] || '').trim()).filter(Boolean);
  } catch (err) {
    if (String(err.message).includes('Unable to parse range') || String(err.message).includes('400')) {
      const seed = ['CTP CARVALHO', 'CPL BRANCO'];
      await sheetsFetch(':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: DOOR_MATERIALS_TAB } } }] })
      }).catch(() => {});
      await sheetsFetch(
        `/values/${encodeURIComponent(`${DOOR_MATERIALS_TAB}!A1:A`)}:append?valueInputOption=USER_ENTERED`,
        { method: 'POST', body: JSON.stringify({ values: [['Material'], ...seed.map(s => [s])] }) }
      );
      return seed;
    }
    throw err;
  }
}

// Overwrites the whole MateriaisPortas list (used by the Admin panel's
// materials editor). Clears the column first so a shorter replacement
// list doesn't leave stale rows behind, then writes the new set.
async function setDoorMaterials(list) {
  const clean = (list || []).map(s => String(s || '').trim()).filter(Boolean);
  await sheetsFetch(`/values/${encodeURIComponent(`${DOOR_MATERIALS_TAB}!A2:A`)}:clear`, { method: 'POST' });
  if (clean.length) {
    await sheetsFetch(
      `/values/${encodeURIComponent(`${DOOR_MATERIALS_TAB}!A2:A`)}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', body: JSON.stringify({ values: clean.map(s => [s]) }) }
    );
  }
  return clean;
}

const LOGOS_FORNECEDORES_TAB = process.env.LOGOS_FORNECEDORES_TAB || 'LogosFornecedores';

// Optional manual overrides for the Recursos tab's supplier icons
// (Fornecedor, LogoURL — one row per supplier that needs a manual
// logo). Only needed when the automatic lookup by name doesn't find
// a match. Ricardo edits this tab directly; a supplier with no row
// here just falls back to automatic lookup. Self-creates an empty
// tab with a header row on first use, same as MateriaisPortas.
async function getFornecedorLogos() {
  try {
    const data = await sheetsFetch(`/values/${encodeURIComponent(`${LOGOS_FORNECEDORES_TAB}!A2:B`)}`);
    const rows = data.values || [];
    const logos = {};
    for (const r of rows) {
      const fornecedor = (r[0] || '').trim();
      const url = (r[1] || '').trim();
      if (fornecedor && url) logos[fornecedor] = url;
    }
    return logos;
  } catch (err) {
    if (String(err.message).includes('Unable to parse range') || String(err.message).includes('400')) {
      await sheetsFetch(':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: LOGOS_FORNECEDORES_TAB } } }] })
      }).catch(() => {});
      await sheetsFetch(
        `/values/${encodeURIComponent(`${LOGOS_FORNECEDORES_TAB}!A1:B1`)}:append?valueInputOption=USER_ENTERED`,
        { method: 'POST', body: JSON.stringify({ values: [['Fornecedor', 'LogoURL']] }) }
      );
      return {};
    }
    throw err;
  }
}

module.exports = {
  getAllItems,
  findItemBySku,
  updateItemFields,
  adjustReservado,
  bulkUpdatePrices,
  appendLogEntry,
  appendLogEntries,
  getDoorMaterials,
  setDoorMaterials,
  getFornecedorLogos,
  getAuthToken,
  sheetsFetch,
  parsePtNumber,
  formatPtNumber
};
