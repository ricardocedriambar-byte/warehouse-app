// api/update-item.js
//
// POST /api/update-item
// body: { rowNumber, sku, stock?, preco?, note? }
//
// Only updates the fields that are present in the body. Every change
// gets a line in the StockLog tab with old/new values, so mistakes can
// be traced and undone by hand if needed.

const { findItemBySku, updateItemFields, appendLogEntry, parsePtNumber } = require('../lib/sheets');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { rowNumber, sku, stock, preco, note } = req.body || {};

    if (!rowNumber || !sku) {
      res.status(400).json({ error: 'rowNumber and sku are required' });
      return;
    }
    if (stock === undefined && preco === undefined) {
      res.status(400).json({ error: 'Provide at least one of stock or preco to update' });
      return;
    }

    // Re-fetch current values right before writing, so the log records
    // what was actually overwritten (in case someone else changed it
    // since this device last loaded the item).
    const current = await findItemBySku(sku);
    if (!current) {
      res.status(404).json({ error: `No item found for SKU "${sku}"` });
      return;
    }

    const updates = {};
    const logEntries = [];

    if (stock !== undefined) {
      const newStock = parsePtNumber(stock);
      updates.stock = newStock;
      logEntries.push({
        sku,
        descricao: current.descricao,
        field: 'STOCK',
        oldValue: current.stock,
        newValue: newStock,
        note
      });
    }

    if (preco !== undefined) {
      const newPreco = parsePtNumber(preco);
      updates.preco = newPreco;
      logEntries.push({
        sku,
        descricao: current.descricao,
        field: 'PRECO',
        oldValue: current.preco,
        newValue: newPreco,
        note
      });
    }

    await updateItemFields(current.rowNumber, updates);

    // Log entries are best-effort: if logging fails, the actual update
    // already succeeded, so we don't fail the request over it.
    for (const entry of logEntries) {
      await appendLogEntry(entry).catch((err) => console.error('Log write failed:', err));
    }

    res.status(200).json({
      ok: true,
      item: { ...current, ...updates }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update the item' });
  }
};
