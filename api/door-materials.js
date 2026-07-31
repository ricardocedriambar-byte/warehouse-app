// api/door-materials.js
//
// GET /api/door-materials -> list of material/finish names for the
// "Portas" dropdown. Source of truth is the "MateriaisPortas" tab in
// Sheets (one name per row, column A) — Ricardo edits it directly there.

const { getDoorMaterials } = require('../lib/sheets');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const materials = await getDoorMaterials();
    res.status(200).json({ materials });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load door materials from the sheet' });
  }
};
