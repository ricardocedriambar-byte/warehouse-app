// api/order-preview-pdf.js
//
// POST /api/order-preview-pdf
// body: { order: {...}, client: {...} }
//
// Generates the SAME "Nota de Encomenda" PDF that gets attached to the
// warehouse notification email — using the exact same lib/pdf-order-note.js
// — but from data the person hasn't submitted yet. Nothing is written to
// Sheets here; it's purely a "what will this actually look like" preview
// shown before they confirm sending the order.

const { buildOrderNotePdf } = require('../lib/pdf-order-note');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { order, client } = req.body || {};
    if (!order || !Array.isArray(order.lines)) {
      res.status(400).json({ error: 'Missing order data' });
      return;
    }

    const pdfBytes = await buildOrderNotePdf(order, client || {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate preview PDF' });
  }
};
