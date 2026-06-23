// api/pick-line.js
// POST /api/pick-line
// body: { orderId, sku, qtyPicked }
//
// Marks a line as picked (fully or partially) and decrements stock in
// the Etiquetas sheet by the quantity picked. Logs both changes.

const { updateLinePicked } = require('../lib/orders');
const { findItemBySku, updateItemFields, appendLogEntry } = require('../lib/sheets');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { orderId, sku, qtyPicked } = req.body || {};
    if (!orderId || !sku) { res.status(400).json({ error: 'orderId and sku are required' }); return; }
    if (qtyPicked === undefined || qtyPicked === null) { res.status(400).json({ error: 'qtyPicked is required' }); return; }

    const qty = parseFloat(qtyPicked);
    if (isNaN(qty) || qty < 0) { res.status(400).json({ error: 'qtyPicked must be a non-negative number' }); return; }

    // Update the picked quantity on the order line
    await updateLinePicked(orderId, sku, qty);

    // Decrement stock in the Etiquetas sheet
    const item = await findItemBySku(sku);
    if (item) {
      const currentStock = item.stock || 0;
      const newStock = currentStock - qty;
      await updateItemFields(item.rowNumber, { stock: newStock });
      await appendLogEntry({
        sku,
        descricao: item.descricao,
        field: 'STOCK',
        oldValue: currentStock,
        newValue: newStock,
        note: `Separação encomenda ${orderId}`
      });
    }

    res.status(200).json({ ok: true, orderId, sku, qtyPicked: qty });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
