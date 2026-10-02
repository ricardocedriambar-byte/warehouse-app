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

const { getAllItems, bulkUpdatePrices, appendItemRows, deleteItemRows, setItemObservations, appendLogEntries, parsePtNumber, savePriceSyncStatus, getPriceSyncStatus } = require('../lib/sheets');
const { getPriceListUpdates } = require('../lib/priceList');
const { isJ5fAuthorized, parseJ5fProducts, buildNewItemRow, getJ5fIgnoreSet } = require('../lib/j5f');

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

  // One-shot Sheets → Postgres import (see lib/migrate.js). Needs a secret
  // to be configured — never runs on an open endpoint.
  if (req.query.migrate === '1') {
    // Disabled once the migration was done: an accidental &replace=1 would
    // overwrite live data with the frozen Google Sheet. Set
    // MIGRATION_ENABLED=1 in Vercel (and redeploy) only if it's ever needed again.
    if (!['1', 'true', 'yes'].includes(String(process.env.MIGRATION_ENABLED || '').trim().toLowerCase())) {
      res.status(403).json({ error: 'Importação desativada. Defina MIGRATION_ENABLED=1 no Vercel para a voltar a usar.' });
      return;
    }
    if (!(process.env.CRON_SECRET || process.env.SYNC_SECRET)) {
      res.status(403).json({ error: 'Defina CRON_SECRET no Vercel antes de migrar' });
      return;
    }
    try {
      const { runMigration, runMigrationFase2 } = require('../lib/migrate');
      const run = req.query.fase === '2' ? runMigrationFase2 : runMigration;
      const result = await run({ confirm: req.query.confirm === '1', replace: req.query.replace === '1' });
      res.status(200).json({ ok: true, ...result });
    } catch (err) {
      console.error('Migration failed:', err);
      res.status(500).json({ error: err.message });
    }
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
  if (isJ5f) { summary.notInApp = 0; summary.added = 0; }
  const newRows = [];      // J5F products not in the app yet -> new Etiquetas rows
  const newPreview = [];
  const ignoreSkus = isJ5f ? await getJ5fIgnoreSet({ dryRun }) : new Set();
  if (isJ5f) summary.ignored = 0;
  const conflictingSkus = new Set((priceListResult.duplicates || []).filter((d) => d.conflicting).map((d) => d.sku));
  const syncNote = isJ5f ? 'Sincronização automática J5F' : 'Sincronização automática TABELA';

  for (const [sku, product] of prices) {
    const { preco: newPreco, valorCompra: newValorCompra } = product;
    const item = sheetBySku.get(sku);
    if (!item) {
      if (!isJ5f) { summary.notFoundInSheet.push(sku); continue; }
      // Only add products whose J5F code already IS an 8-digit SKU (no
      // padding: "73568" would become a different code from J5F's), and
      // skip codes that appear twice with different prices.
      // (An older PC script that doesn't send familia/unidade never creates items.)
      if (ignoreSkus.has(sku) || !String(product.descricao || '').trim()) {
        summary.ignored++;   // on the J5F_Ignorar list, or a blank J5F record
      } else if (/^\d{8}$/.test(product.codigo || '') && product.unidade && !conflictingSkus.has(sku)) {
        const row = buildNewItemRow(sku, product);
        newRows.push(row);
        summary.added++;
        if (newPreview.length < 50) {
          newPreview.push({ sku, descricao: row[2], familia: row[1], unidade: row[13],
            comp: row[3], larg: row[4], esp: row[5], m2: row[6], preco: row[8], compra: row[7] });
        }
        logEntries.push({ sku, descricao: row[2], field: 'NOVO ARTIGO (J5F)', oldValue: '', newValue: newPreco ?? '', note: syncNote });
      } else {
        summary.notInApp++;
      }
      continue;
    }
    if (item.preco && newPreco !== null) ratios.push(newPreco / item.preco);
    summary.matched++;

    const precoChanged = newPreco !== null && newPreco !== undefined &&
      (item.preco === null || Math.abs(item.preco - newPreco) >= 0.0005);
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

  // ── Products deleted in J5F (the PC script sends only codes that existed
  // in J5F before and are gone now). Items still reserved on an active
  // order are kept and flagged instead, so no open order loses its line.
  const rowsToDelete = [];
  const flagOnly = [];
  const deletedPreview = [];
  if (isJ5f) { summary.deleted = 0; summary.deleteSkipped = 0; }
  const deletedList = isJ5f && Array.isArray(req.body && req.body.deleted) ? req.body.deleted : [];
  for (const raw of deletedList) {
    const code = String(raw || '').trim();
    if (!/^\d{8}$/.test(code)) continue;
    const item = sheetBySku.get(code);
    if (!item) continue;
    const reserved = (item.reservado || 0) > 0;
    if (reserved) {
      summary.deleteSkipped++;
      flagOnly.push(item);
    } else {
      summary.deleted++;
      rowsToDelete.push(item.rowNumber);
      logEntries.push({ sku: code, descricao: item.descricao, field: 'APAGADO (J5F)',
        oldValue: item.stock ?? '', newValue: '', note: 'Artigo apagado no J5F — linha removida (valor anterior = stock)' });
    }
    if (deletedPreview.length < 50) {
      deletedPreview.push({ sku: code, descricao: item.descricao, stock: item.stock, reservado: item.reservado,
        acao: reserved ? 'mantido (encomenda ativa)' : 'apagar' });
    }
  }

  if (dryRun) {
    ratios.sort((a, b) => a - b);
    const medianRatio = ratios.length ? Number(ratios[Math.floor(ratios.length / 2)].toFixed(4)) : null;
    summary.ok = true;
    await finish(200, { ok: true, summary, medianRatio, preview, newItems: newPreview, deletedItems: deletedPreview });
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

  if (newRows.length > 0) {
    try {
      await appendItemRows(newRows);
    } catch (err) {
      console.error('Adding new items failed:', err);
      summary.errors.push('Preços atualizados, mas falhou a criação de artigos novos: ' + err.message);
      summary.added = 0;
    }
  }

  // Deletions last: they shift row numbers, and every row-number-based
  // write above has already happened.
  if (flagOnly.length > 0) {
    await setItemObservations(flagOnly.map((it) => it.rowNumber), 'Apagado no J5F — remover depois da encomenda')
      .catch((err) => summary.errors.push('Falhou marcar artigos apagados: ' + err.message));
  }
  if (rowsToDelete.length > 0) {
    try {
      await deleteItemRows(rowsToDelete);
    } catch (err) {
      console.error('Deleting items failed:', err);
      summary.errors.push('Falhou apagar artigos removidos do J5F: ' + err.message);
      summary.deleted = 0;
    }
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
