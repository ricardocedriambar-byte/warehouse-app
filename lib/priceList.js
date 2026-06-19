// lib/priceList.js
//
// Fetches the price list xlsx from OneDrive and parses it into a clean
// { sku: preco } map. The actual file ("TABELA_PLACAS.xlsx") has a layout
// that needs careful handling, verified by inspecting a real export:
//
//   - No header row. Columns are positional: A=SKU, B=Descrição, C=tipo,
//     D=comprimento, E=largura, F=espessura, G=valor compra (sparse),
//     H=Preço, I=a derived €/m² figure we don't use.
//   - Category section labels ("AGLOMERADO", "MELAMINA", ...) appear as
//     single-cell rows merged across A:I. These must be skipped, not
//     mistaken for a product row.
//   - Some rows are pure spacers (every cell blank).
//   - A few rows have a price but NO SKU (e.g. "INNOVUS M6252",
//     "KRONO K005") — these can't be matched to anything and must be
//     reported, not silently dropped, so a human knows they exist.
//   - SKU cells are inconsistently typed: most are strings ('03100106'),
//     a handful are plain numbers (28100100). All confirmed 8-digit SKUs
//     in this file are stored as either an 8-char string or an 8-digit
//     int — none are missing a leading zero — so zero-padding to 8 digits
//     after stringifying is a safe, correct normalization for both cases.

const XLSX = require('xlsx');

const ONEDRIVE_SHARE_URL = process.env.PRICE_LIST_ONEDRIVE_URL;
const SKU_COLUMN = 0;
const DESC_COLUMN = 1;
const PRECO_COLUMN = 7; // column H

function toDirectDownloadUrl(shareUrl) {
  const base64 = Buffer.from(shareUrl, 'utf8').toString('base64');
  const encoded = 'u!' + base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return `https://api.onedrive.com/v1.0/shares/${encoded}/root/content`;
}

async function fetchPriceListBuffer() {
  if (!ONEDRIVE_SHARE_URL) {
    throw new Error('PRICE_LIST_ONEDRIVE_URL is not set');
  }

  const directUrl = toDirectDownloadUrl(ONEDRIVE_SHARE_URL);
  const res = await fetch(directUrl, { redirect: 'follow' });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Failed to fetch price list from OneDrive (${res.status}). ` +
      `The share-link-to-direct-download trick this relies on is an ` +
      `unofficial Microsoft API that can stop working without notice — ` +
      `if this persists, the fix is switching to a real Microsoft Graph ` +
      `API app registration. Response: ${body.slice(0, 300)}`
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
    const preco = parsePriceCell(row[PRECO_COLUMN]);
    const descricao = row[DESC_COLUMN] || '';

    if (preco === null) return; // no price on this row, nothing to sync

    if (sku === null) {
      unmatched.push({ row: idx + 1, descricao, preco });
      return;
    }

    if (!occurrencesBySku.has(sku)) occurrencesBySku.set(sku, []);
    occurrencesBySku.get(sku).push({ row: idx + 1, preco });

    prices.set(sku, preco); // last occurrence wins if there are duplicates
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
