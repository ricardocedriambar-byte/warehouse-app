// api/resources.js
//
// GET /api/resources -> list of price-list/catalog PDFs, auto-discovered
// from the Drive folder structure Recursos/<Fornecedor>/<documento>.pdf,
// plus optional manual logo overrides for suppliers where automatic
// lookup by name doesn't find a match (see LogosFornecedores tab).

const { getResources } = require('../lib/resources');
const { getFornecedorLogos } = require('../lib/sheets');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const [resources, logos] = await Promise.all([
      getResources(),
      getFornecedorLogos().catch(() => ({})) // optional — never block the list on this
    ]);
    res.status(200).json({ resources, logos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load resources from the sheet' });
  }
};
