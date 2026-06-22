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
  STOCK: 9,               // J - STOCK
  OBSERVACOES: 10,         // K - OBSERVAÇÕES
  QR: 11                    // L - QR
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
    rowNumber: rowIndex, // 1-based sheet row, needed for targeted updates
    sku: row[COLUMNS.SKU] || '',
    familia: row[COLUMNS.FAMILIA] || '',
    descricao: row[COLUMNS.DESCRICAO] || '',
    comprimento: parsePtNumber(row[COLUMNS.COMPRIMENTO]),
    largura: parsePtNumber(row[COLUMNS.LARGURA]),
    espessura: parsePtNumber(row[COLUMNS.ESPESSURA]),
    dimensaoM2: parsePtNumber(row[COLUMNS.DIMENSAO_M2]),
    valorCompra: parsePtNumber(row[COLUMNS.VALOR_COMPRA]),
    preco: parsePtNumber(row[COLUMNS.PRECO]),
    stock: parsePtNumber(row[COLUMNS.STOCK]),
    observacoes: row[COLUMNS.OBSERVACOES] || '',
  };
}

async function getAllItems() {
  const range = `${SHEET_TAB}!A2:L`;
  const data = await sheetsFetch(`/values/${encodeURIComponent(range)}`);
  const rows = data.values || [];
  return rows.map((row, i) => rowToItem(row, i + FIRST_DATA_ROW));
}

async function findItemBySku(sku) {
  const items = await getAllItems();
  const target = String(sku).trim();
  return items.find((item) => item.sku.trim() === target) || null;
}

// Updates STOCK and/or PRECO for a specific row. Pass only the fields
// that changed; omit a field to leave it untouched.
async function updateItemFields(rowNumber, { stock, preco }) {
  const data = [];

  if (stock !== undefined) {
    data.push({
      range: `${SHEET_TAB}!J${rowNumber}`,
      values: [[formatPtNumber(stock)]]
    });
  }
  if (preco !== undefined) {
    data.push({
      range: `${SHEET_TAB}!I${rowNumber}`,
      values: [[formatPtNumber(preco)]]
    });
  }

  if (data.length === 0) return;

  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data
    })
  });
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

module.exports = {
  getAllItems,
  findItemBySku,
  updateItemFields,
  bulkUpdatePrices,
  appendLogEntry,
  appendLogEntries,
  getAuthToken,
  parsePtNumber,
  formatPtNumber
};
