// api/orders.js
// GET  /api/orders             -> all orders (grouped)
// GET  /api/orders?id=ENC-...  -> single order by ID
// POST /api/orders             -> create new order
// PATCH /api/orders            -> update order status

const { getAllOrders, getOrderById, createOrder, updateOrderStatus, STATUS } = require('../lib/orders');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const { id } = req.query;
      if (id) {
        const order = await getOrderById(id);
        if (!order) { res.status(404).json({ error: `Order ${id} not found` }); return; }
        res.status(200).json({ order });
        return;
      }
      const orders = await getAllOrders();
      res.status(200).json({ orders });
      return;
    }

    if (req.method === 'POST') {
      const { clientId, clientName, salesperson, orderNotes, lines } = req.body || {};
      if (!clientId) { res.status(400).json({ error: 'clientId is required' }); return; }
      if (!lines || lines.length === 0) { res.status(400).json({ error: 'lines cannot be empty' }); return; }
      const order = await createOrder({ clientId, clientName, salesperson, orderNotes, lines });
      res.status(201).json({ order });
      return;
    }

    if (req.method === 'PATCH') {
      const { orderId, status } = req.body || {};
      if (!orderId) { res.status(400).json({ error: 'orderId is required' }); return; }
      if (!Object.values(STATUS).includes(status)) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${Object.values(STATUS).join(', ')}` });
        return;
      }
      await updateOrderStatus(orderId, status);
      res.status(200).json({ ok: true, orderId, status });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
