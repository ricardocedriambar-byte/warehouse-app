// api/sync-prices.js
//
// GET/POST /api/sync-prices
//
// Pulls the price list from Google Drive, compares it against the live Google
// Sheet, and updates Preço for every SKU whose price actually changed.
// Designed to be called by a Vercel Cron Job on a schedule, but also
// callable directly (e.g. from a browser) for manual runs and testing.
//
// Every change is logged to the same StockLog tab the app already uses.
// Rows in the price list that couldn't be matched (no SKU, or a SKU not
// found in the Sheet) are reported in the response rather than silently
// ignored, so a stale/broken sync is visible rather than quietly wrong.
// The outcome of every run (whichever path it takes below) is also saved
// via savePriceSyncStatus() — see lib/sheets.js — so the Admin screen can
// show "last synced X ago" without needing to trigger a new sync itself.
//
// GET/POST /api/sync-prices?status=1 -> skips running a sync entirely and
// just returns the last saved status. Used by the Admin screen on load —
// opening that screen shouldn't silently kick off a live Drive fetch and
// Sheet writes. Vercel Cron always calls this endpoint with a plain GET
// and no query string (see vercel.json), so that path is untouched.

const { getAllItems, bulkUpdatePrices, appendLogEntries, parsePtNumber, savePriceSyncStatus, getPriceSyncStatus } = require('../lib/sheets');
const { getPriceListUpdates } = require('../lib/priceList');
const { isJ5fAuthorized, parseJ5fProducts } = require('../lib/j5f');

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

// J5F source (POST ?source=j5f): prices come from the request body, sent by
// the read-only sync script on the office PC (tools/j5f-sync). Same
// compare-and-write logic as TABELA below; ?dryRun=1 computes everything
// but writes nothing and returns a preview of what would change.
module.exports = async (req, res) => {
  const isJ5f = req.query.source === 'j5f';
  const dryRun = req.query.dryRun === '1';

  if (isJ5f) {
    if (!isJ5fAuthorized(req)) {
      res.status(401).json({ error: 'Unauthorized (J5F_SYNC_SECRET missing or wrong)' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Use POST with { products: [...] }' });
      return;
    }
  } else if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (req.query.status === '1') {
    try {
      const status = await getPriceSyncStatus();
      res.status(200).json({ ok: true, status });
    } catch (err) {
      console.error('Failed to read price sync status:', err);
      res.status(500).json({ error: 'Failed to read sync status' });
    }
    return;
  }

  const summary = {
    startedAt: new Date().toISOString(),
    ok: false,
    source: isJ5f ? 'j5f' : 'tabela',
    matched: 0,
    changed: 0,
    unchanged: 0,
    notFoundInSheet: [],
    unmatchedInPriceList: [],
    duplicatesInPriceList: [],
    errors: []
  };

  // Whatever happens below, the outcome gets saved before responding —
  // this is what makes "last sync" visible even for a run nobody actually
  // watched (the 6am cron, most days).
  async function finish(statusCode, body) {
    if (dryRun) { res.status(statusCode).json({ ...body, dryRun: true }); return; }
    summary.finishedAt = new Date().toISOString();
    await savePriceSyncStatus(summary).catch((err) => console.error('Failed to save sync status:', err));
    res.status(statusCode).json(body);
  }

  let priceListResult;
  try {
    priceListResult = isJ5f ? parseJ5fProducts(req.body) : await getPriceListUpdates();
  } catch (err) {
    console.error('Price list fetch/parse failed:', err);
    summary.errors.push((isJ5f ? 'Dados J5F inválidos: ' : 'Não foi possível obter a lista de preços do Drive: ') + err.message);
    await finish(502, {
      error: 'Could not fetch or parse the Google Drive price list',
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
    summary.errors.push('Não foi possível ler a folha de cálculo: ' + err.message);
    await finish(502, { error: 'Could not read the Google Sheet', detail: err.message, summary });
    return;
  }

  const sheetBySku = new Map(sheetItems.map((item) => [item.sku.trim(), item]));

  const toUpdate = [];
  const logEntries = [];
  const preview = [];      // dry run: first changes, to eyeball before going live
  const ratios = [];       // new/old price for matched items — ~1.23 would mean an IVA mismatch
  if (isJ5f) summary.notInApp = 0;
  const syncNote = isJ5f ? 'Sincronização automática J5F' : 'Sincronização automática TABELA';

  for (const [sku, { preco: newPreco, valorCompra: newValorCompra }] of prices) {
    const item = sheetBySku.get(sku);
    if (!item) {
      // J5F holds thousands of products the app doesn't stock — expected,
      // so just count them instead of flagging each one for review.
      if (isJ5f) summary.notInApp++;
      else summary.notFoundInSheet.push(sku);
      continue;
    }
    if (item.preco) ratios.push(newPreco / item.preco);
    summary.matched++;

    const precoChanged = item.preco === null || Math.abs(item.preco - newPreco) >= 0.0005;
    const valorCompraChanged = newValorCompra !== null &&
      (item.valorCompra === null || Math.abs(item.valorCompra - newValorCompra) >= 0.0005);

    if (!precoChanged && !valorCompraChanged) {
      summary.unchanged++;
      continue;
    }

    summary.changed++;
    if (preview.length < 50) {
      preview.push({ sku, descricao: item.descricao, precoAtual: item.preco, precoNovo: newPreco,
        compraAtual: item.valorCompra, compraNova: newValorCompra });
    }
    toUpdate.push({ rowNumber: item.rowNumber, preco: newPreco, valorCompra: newValorCompra });

    if (precoChanged) {
      logEntries.push({
        sku, descricao: item.descricao, field: 'PRECO (sync)',
        oldValue: item.preco, newValue: newPreco,
        note: syncNote
      });
    }
    if (valorCompraChanged) {
      logEntries.push({
        sku, descricao: item.descricao, field: 'VALOR COMPRA (sync)',
        oldValue: item.valorCompra, newValue: newValorCompra,
        note: syncNote
      });
    }
  }

  if (dryRun) {
    ratios.sort((a, b) => a - b);
    const medianRatio = ratios.length ? Number(ratios[Math.floor(ratios.length / 2)].toFixed(4)) : null;
    summary.ok = true;
    await finish(200, { ok: true, summary, medianRatio, preview });
    return;
  }

  try {
    await bulkUpdatePrices(toUpdate);
  } catch (err) {
    console.error('Bulk price update failed:', err);
    summary.errors.push('Failed to write some or all price updates: ' + err.message);
    await finish(500, { error: 'Failed while writing updates', summary });
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

  summary.ok = true;
  await finish(200, { ok: true, summary });
};
