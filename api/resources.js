// api/resources.js
//
// GET /api/resources -> list of price-list/catalog PDFs, auto-discovered
// from the Drive folder structure Recursos/<Fornecedor>/<documento>.pdf,
// plus optional manual logo overrides for suppliers where automatic
// lookup by name doesn't find a match (see LogosFornecedores tab).
//
// GET /api/resources?fileId=<drive file id> -> streams that file's raw
// PDF bytes straight from Drive. The in-app viewer (pdf.js, see
// resources.js) renders those bytes itself instead of embedding Drive's
// own /preview page — that embed always draws its own toolbar (page/zoom
// controls) with no supported way to turn it off.

const { getResources, fetchFileMedia } = require('../lib/resources');
const { getFornecedorLogos } = require('../lib/sheets');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { fileId } = req.query;
  if (fileId) {
    try {
      const driveRes = await fetchFileMedia(fileId);
      if (!driveRes.ok) {
        const body = await driveRes.text().catch(() => '');
        console.error(`Drive media fetch failed for ${fileId}: ${driveRes.status} ${body.slice(0, 300)}`);
        res.status(driveRes.status === 404 ? 404 : 502).json({ error: 'Failed to load the PDF from Drive' });
        return;
      }
      const buf = Buffer.from(await driveRes.arrayBuffer());
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.status(200).send(buf);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load the PDF from Drive' });
    }
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
