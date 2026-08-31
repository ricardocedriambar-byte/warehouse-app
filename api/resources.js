// api/resources.js
//
// GET /api/resources -> list of price-list/catalog PDFs for the
// "Recursos" tab, auto-discovered from the Drive folder structure
// Recursos/<Fornecedor>/<documento>.pdf.

const { getResources } = require('../lib/resources');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const resources = await getResources();
    res.status(200).json({ resources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load resources from the sheet' });
  }
};
