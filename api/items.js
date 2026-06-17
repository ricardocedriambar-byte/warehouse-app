// api/items.js
//
// GET /api/items            -> all items
// GET /api/items?sku=01101100 -> single item by SKU (used right after a scan)

const { getAllItems, findItemBySku } = require('../lib/sheets');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { sku } = req.query;

    if (sku) {
      const item = await findItemBySku(sku);
      if (!item) {
        res.status(404).json({ error: `No item found for SKU "${sku}"` });
        return;
      }
      res.status(200).json({ item });
      return;
    }

    const items = await getAllItems();
    res.status(200).json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load items from the sheet' });
  }
};
