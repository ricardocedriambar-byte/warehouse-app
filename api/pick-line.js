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

    // Decrement stock in the Etiquetas sheet.
    //
    // Important: `qty` here is expressed in the item's PRICING unit (e.g.
    // m², to match unitPrice which is per m²) — that's what the order line
    // needs for correct money totals. But STOCK on the shelf is always
    // counted in physical pieces (whole panels/packages), not m². For an
    // item with, say, 5 m² per panel, picking "12 un" arrives here as
    // qty = 60 (m²) — decrementing STOCK by 60 would be wrong by a factor
    // of 5. So convert back down to piece count using the item's
    // dimensaoM2 (quantity-per-package) before touching STOCK.
    const item = await findItemBySku(sku);
    if (item) {
      const piecesPicked = (item.unidade && item.unidade !== 'un' && item.dimensaoM2)
        ? qty / item.dimensaoM2
        : qty;
      const currentStock = item.stock || 0;
      const newStock = currentStock - piecesPicked;
      await updateItemFields(item.rowNumber, { stock: newStock });
      await appendLogEntry({
        sku,
        descricao: item.descricao,
        field: 'STOCK',
        oldValue: currentStock,
        newValue: newStock,
        note: `Separação encomenda ${orderId} (${qty} ${item.unidade || 'un'} = ${piecesPicked.toFixed(3)} un)`
      });
    }

    res.status(200).json({ ok: true, orderId, sku, qtyPicked: qty });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
