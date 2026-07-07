// api/orders.js  ⚠️ THIS FILE GOES IN THE `api/` FOLDER, NOT `lib/`
//
// HTTP endpoint for orders. Dispatches by method:
//   GET    /api/orders             → list all orders
//   GET    /api/orders?id=ENC-...  → a single order (used to refresh one
//                                    order after a pick-line update)
//   POST   /api/orders             → create a new order (draft)
//   PATCH  /api/orders             → update an order's status
//                                    body: { orderId, status }
//
// The actual data-layer logic (talking to Google Sheets) lives in
// lib/orders.js — this file only handles the HTTP request/response and
// calls into that.

const {
  getAllOrders,
  getOrderById,
  createOrder,
  updateOrderStatus
} = require('../lib/orders');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const { id } = req.query || {};
      if (id) {
        const order = await getOrderById(id);
        if (!order) { res.status(404).json({ error: 'Encomenda não encontrada' }); return; }
        res.status(200).json({ order });
        return;
      }
      const orders = await getAllOrders();
      res.status(200).json({ orders });
      return;
    }

    if (req.method === 'POST') {
      const order = await createOrder(req.body || {});
      res.status(200).json({ order });
      return;
    }

    if (req.method === 'PATCH') {
      const { orderId, status } = req.body || {};
      if (!orderId || !status) {
        res.status(400).json({ error: 'orderId e status são obrigatórios' });
        return;
      }
      await updateOrderStatus(orderId, status);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('api/orders failed:', err);
    res.status(500).json({ error: err.message });
  }
};
