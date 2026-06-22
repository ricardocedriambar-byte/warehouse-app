// lib/priceList.js
//
// Fetches the price list xlsx from Google Drive and parses it into a clean
// { sku: preco } map. Uses the same Google service account already set up
// for Sheets access — no new credentials needed.
//
// The file layout (verified against a real export):
//   - No header row. Columns: A=SKU, B=Descrição, C=tipo,
//     D=comprimento, E=largura, F=espessura, G=valor compra (sparse),
//     H=Preço, I=derived €/m² (not used).
//   - Category section labels ("AGLOMERADO", "MELAMINA", ...) appear as
//     single-cell rows merged across A:I — skipped, not treated as products.
//   - Some rows are pure spacers (every cell blank).
//   - A few rows have a price but NO SKU — reported, not silently dropped.
//   - SKU cells are inconsistently typed (str or int) but all confirmed
//     8-digit values — zero-padded to 8 chars for consistent matching.

const XLSX = require('xlsx');
const { getAuthToken } = require('./sheets');

const DRIVE_FILE_ID = process.env.PRICE_LIST_DRIVE_FILE_ID || '1LGXh0o9pBYTupkRNz4YemSQRNzYRkq5b';
const SKU_COLUMN = 0;
const DESC_COLUMN = 1;
const VALOR_COMPRA_G_COLUMN = 6; // column G — cost of purchase (preferred)
const VALOR_COMPRA_H_COLUMN = 7; // column H — cost of purchase fallback when G is blank
const PRECO_COLUMN = 8;          // column I — final client price (always use this for Preço)

async function fetchPriceListBuffer() {
  const accessToken = await getAuthToken();

  // Google Drive API: download file content directly by file ID.
  // This is the officially supported, stable path — no share-link tricks needed.
  const url = `https://www.googleapis.com/drive/v3/files/${DRIVE_FILE_ID}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Failed to fetch price list from Google Drive (${res.status}). ` +
      `Make sure the file is shared with the service account ` +
      `wharehouse-bot@webiste-gmail-smtp.iam.gserviceaccount.com with ` +
      `at least Viewer access. Response: ${body.slice(0, 300)}`
    );
  }

  return Buffer.from(await res.arrayBuffer());
}

// Zero-pads a SKU cell value (string or number, as read by the xlsx
// parser) to the 8-digit format used in the Google Sheet.
function normalizeSku(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  const str = String(rawValue).trim();
  if (str === '') return null;
  if (!/^\d+$/.test(str)) return null; // not a plausible numeric SKU
  return str.padStart(8, '0');
}

function parsePriceCell(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  if (typeof rawValue === 'number') return rawValue;
  const cleaned = String(rawValue).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

// Parses the workbook buffer into:
//   - prices: Map of normalized 8-digit SKU -> price
//   - unmatched: array of { row, descricao, preco } for priced rows with
//     no usable SKU, so these can be surfaced rather than silently lost
//   - duplicates: array of { sku, occurrences: [{row, preco}, ...] } for
//     SKUs that appear more than once. The source file has at least one
//     known case of this (same SKU reused for two cut sizes). When prices
//     agree it's harmless; when they disagree, only the last-seen price
//     would otherwise be applied silently — these are reported either way
//     so a human can verify duplicates aren't a data entry mistake.
function parsePriceListWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error('Price list workbook has no sheets');

  // Identify merged single-row category header ranges (e.g. "AGLOMERADO"),
  // which span the full row width as one merged cell. These are section
  // labels, not products, and must be skipped.
  const mergedHeaderRows = new Set();
  (sheet['!merges'] || []).forEach((range) => {
    if (range.s.r === range.e.r && range.s.c === 0 && range.e.c >= 7) {
      mergedHeaderRows.add(range.s.r); // 0-indexed row
    }
  });

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });

  const prices = new Map();
  const unmatched = [];
  const occurrencesBySku = new Map();

  rows.forEach((row, idx) => {
    if (mergedHeaderRows.has(idx)) return; // category section label
    const allBlank = row.every((cell) => cell === null || cell === '');
    if (allBlank) return; // spacer row

    const sku = normalizeSku(row[SKU_COLUMN]);
    // Column I is always the final client price → synced to Preço in the Sheet.
    // Column G is cost of purchase; H is fallback when G is blank → synced to VALOR COMPRA.
    const preco = parsePriceCell(row[PRECO_COLUMN]);
    const rawValorCompra = (row[VALOR_COMPRA_G_COLUMN] !== null && row[VALOR_COMPRA_G_COLUMN] !== undefined && row[VALOR_COMPRA_G_COLUMN] !== '')
      ? row[VALOR_COMPRA_G_COLUMN]
      : row[VALOR_COMPRA_H_COLUMN];
    const valorCompra = parsePriceCell(rawValorCompra);
    const descricao = row[DESC_COLUMN] || '';

    if (preco === null) return; // no price on this row, nothing to sync

    if (sku === null) {
      unmatched.push({ row: idx + 1, descricao, preco });
      return;
    }

    if (!occurrencesBySku.has(sku)) occurrencesBySku.set(sku, []);
    occurrencesBySku.get(sku).push({ row: idx + 1, preco });

    prices.set(sku, { preco, valorCompra }); // last occurrence wins if duplicates
  });

  const duplicates = [];
  for (const [sku, occurrences] of occurrencesBySku) {
    if (occurrences.length > 1) {
      const distinctPrices = new Set(occurrences.map((o) => o.preco));
      duplicates.push({ sku, occurrences, conflicting: distinctPrices.size > 1 });
    }
  }

  return { prices, unmatched, duplicates };
}

async function getPriceListUpdates() {
  const buffer = await fetchPriceListBuffer();
  return parsePriceListWorkbook(buffer);
}

module.exports = {
  getPriceListUpdates,
  parsePriceListWorkbook, // exported for testing without a live fetch
  normalizeSku
};
