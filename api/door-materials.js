// api/door-materials.js
//
// GET  /api/door-materials -> list of material/finish names for the
//   "Portas" dropdown. Source of truth is the "MateriaisPortas" tab in
//   Sheets (one name per row, column A) — Ricardo can edit it directly
//   there, or through the Admin panel's materials editor (POST below).
// POST /api/door-materials -> replaces the whole list. Body: { materials: [...] }

const { getDoorMaterials, setDoorMaterials } = require('../lib/sheets');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const materials = await getDoorMaterials();
      res.status(200).json({ materials });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (!Array.isArray(body.materials)) {
        res.status(400).json({ error: 'materials deve ser uma lista' });
        return;
      }
      const materials = await setDoorMaterials(body.materials);
      res.status(200).json({ materials });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update door materials' });
  }
};
