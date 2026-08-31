// api/resources.js
//
// GET /api/resources -> list of price-list/catalog PDFs for the
// "Recursos" tab. Source of truth is the "Recursos" tab in Sheets
// (Fornecedor, Nome, URL, Tipo, Atualizado) — Ricardo edits it
// directly there, pasting Drive share links.

const { getResources } = require('../lib/sheets');

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
