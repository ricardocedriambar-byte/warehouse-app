// api/sync-prices.js
//
// GET/POST /api/sync-prices
//
// Pulls the price list from OneDrive, compares it against the live Google
// Sheet, and updates Preço for every SKU whose price actually changed.
// Designed to be called by a Vercel Cron Job on a schedule, but also
// callable directly (e.g. from a browser) for manual runs and testing.
//
// Every change is logged to the same StockLog tab the app already uses.
// Rows in the price list that couldn't be matched (no SKU, or a SKU not
// found in the Sheet) are reported in the response rather than silently
// ignored, so a stale/broken sync is visible rather than quietly wrong.

const { getAllItems, bulkUpdatePrices, appendLogEntries, parsePtNumber } = require('../lib/sheets');
const { getPriceListUpdates } = require('../lib/priceList');

// Require a shared secret for cron-triggered calls so this endpoint can't
// be hit by anyone who finds the URL and used to spam writes to the sheet.
// Vercel Cron Jobs automatically send an Authorization: Bearer <token>
// header using CRON_SECRET if that env var is set — see
// https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
// Manual calls can pass the same value as ?secret=... or an Authorization
// header. If no secret is configured at all, the endpoint is left open
// (acceptable for solo/single-user use, but worth tightening later).
function isAuthorized(req) {
  const secret = process.env.CRON_SECRET || process.env.SYNC_SECRET;
  if (!secret) return true;
  const authHeader = req.headers['authorization'];
  const queryParam = req.query.secret;
  return authHeader === `Bearer ${secret}` || queryParam === secret;
}

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const summary = {
    startedAt: new Date().toISOString(),
    matched: 0,
    changed: 0,
    unchanged: 0,
    notFoundInSheet: [],
    unmatchedInPriceList: [],
    duplicatesInPriceList: [],
    errors: []
  };

  let priceListResult;
  try {
    priceListResult = await getPriceListUpdates();
  } catch (err) {
    console.error('Price list fetch/parse failed:', err);
    res.status(502).json({
      error: 'Could not fetch or parse the OneDrive price list',
      detail: err.message,
      summary
    });
    return;
  }

  const { prices, unmatched, duplicates } = priceListResult;
  summary.unmatchedInPriceList = unmatched;
  summary.duplicatesInPriceList = duplicates.filter((d) => d.conflicting);

  let sheetItems;
  try {
    sheetItems = await getAllItems();
  } catch (err) {
    console.error('Sheet read failed:', err);
    res.status(502).json({ error: 'Could not read the Google Sheet', detail: err.message, summary });
    return;
  }

  const sheetBySku = new Map(sheetItems.map((item) => [item.sku.trim(), item]));

  const toUpdate = [];
  const logEntries = [];

  for (const [sku, newPreco] of prices) {
    const item = sheetBySku.get(sku);
    if (!item) {
      summary.notFoundInSheet.push(sku);
      continue;
    }
    summary.matched++;

    const currentPreco = item.preco;
    // Treat as unchanged if within a tiny epsilon, to avoid rewriting
    // identical values due to floating point noise.
    if (currentPreco !== null && Math.abs(currentPreco - newPreco) < 0.0005) {
      summary.unchanged++;
      continue;
    }

    summary.changed++;
    toUpdate.push({ rowNumber: item.rowNumber, preco: newPreco });
    logEntries.push({
      sku,
      descricao: item.descricao,
      field: 'PRECO (sync OneDrive)',
      oldValue: currentPreco,
      newValue: newPreco,
      note: 'Sincronização automática TABELA_PLACAS'
    });
  }

  try {
    await bulkUpdatePrices(toUpdate);
  } catch (err) {
    console.error('Bulk price update failed:', err);
    summary.errors.push('Failed to write some or all price updates: ' + err.message);
    res.status(500).json({ error: 'Failed while writing updates', summary });
    return;
  }

  try {
    await appendLogEntries(logEntries);
  } catch (err) {
    // Logging failure shouldn't fail the whole sync — the actual price
    // updates already succeeded by this point.
    console.error('Log write failed:', err);
    summary.errors.push('Price updates succeeded but logging failed: ' + err.message);
  }

  summary.finishedAt = new Date().toISOString();
  res.status(200).json({ ok: true, summary });
};
