// api/update-item.js
//
// POST /api/update-item
// body: { rowNumber, sku, stock?, preco?, unidade?, note? }

const { findItemBySku, updateItemFields, appendLogEntry, parsePtNumber } = require('../lib/sheets');
const { maybeSendLowStockAlert } = require('../lib/stockAlerts');

const VALID_UNIDADES = ['un', 'm²', 'ml', 'm³', 'lt'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { rowNumber, sku, stock, preco, unidade, note } = req.body || {};

    if (!rowNumber || !sku) {
      res.status(400).json({ error: 'rowNumber and sku are required' });
      return;
    }
    if (stock === undefined && preco === undefined && unidade === undefined) {
      res.status(400).json({ error: 'Provide at least one of stock, preco, or unidade to update' });
      return;
    }
    if (unidade !== undefined && !VALID_UNIDADES.includes(unidade)) {
      res.status(400).json({ error: `Invalid unidade. Must be one of: ${VALID_UNIDADES.join(', ')}` });
      return;
    }

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
      logEntries.push({ sku, descricao: current.descricao, field: 'STOCK', oldValue: current.stock, newValue: newStock, note });
    }
    if (preco !== undefined) {
      const newPreco = parsePtNumber(preco);
      updates.preco = newPreco;
      logEntries.push({ sku, descricao: current.descricao, field: 'PRECO', oldValue: current.preco, newValue: newPreco, note });
    }
    if (unidade !== undefined) {
      updates.unidade = unidade;
      logEntries.push({ sku, descricao: current.descricao, field: 'UNIDADE', oldValue: current.unidade, newValue: unidade, note });
    }

    await updateItemFields(current.rowNumber, updates);

    for (const entry of logEntries) {
      await appendLogEntry(entry).catch((err) => console.error('Log write failed:', err));
    }

    // A manual stock edit (physical recount, correction) is the one other
    // place "available" (STOCK - RESERVADO) can drop — RESERVADO itself
    // isn't touched here, so just compare stock before/after against it.
    if (updates.stock !== undefined) {
      const reservado = current.reservado || 0;
      await maybeSendLowStockAlert({
        sku: current.sku,
        descricao: current.descricao,
        oldAvailable: (current.stock || 0) - reservado,
        newAvailable: (updates.stock || 0) - reservado,
        stockMinimo: current.stockMinimo
      }).catch((err) => console.error('low-stock alert failed:', err));
    }

    res.status(200).json({ ok: true, item: { ...current, ...updates } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update the item' });
  }
};

