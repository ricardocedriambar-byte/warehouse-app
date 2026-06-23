// api/clients.js
// GET  /api/clients       -> list all clients
// POST /api/clients       -> create a new client

const { getAllClients, createClient } = require('../lib/orders');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const clients = await getAllClients();
      res.status(200).json({ clients });
      return;
    }

    if (req.method === 'POST') {
      const { name, address, phone, email, notes } = req.body || {};
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const client = await createClient({ name, address, phone, email, notes });
      res.status(201).json({ client });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
