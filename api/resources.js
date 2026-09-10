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

      // This used to pipe Drive's response straight through
      // (Readable.fromWeb(driveRes.body).pipe(res)) hoping to cut
      // latency by not waiting for the full file before sending
      // anything — but this is a classic Vercel Node serverless
      // function (no edge/streaming runtime opted into), and Vercel
      // buffers a function's entire response before it starts going to
      // the client either way. So the piping bought nothing, while
      // forwarding Drive's own Content-Length header alongside a body
      // that may not match it byte-for-byte (undici's fetch can
      // transparently decompress the response Drive sent) risked a
      // length mismatch that made things hang or get retried — which
      // lines up with it getting slower, not faster, after that change.
      // Buffering here and letting res.send() compute an accurate
      // Content-Length from the real bytes avoids that risk entirely.
      const buf = Buffer.from(await driveRes.arrayBuffer());
      res.setHeader('Content-Type', 'application/pdf');
      // Cacheable at Vercel's edge, not just the requesting browser — a
      // "Tabela de Preços" doesn't change intraday, so repeat opens (by
      // anyone, not just the same person) can be served straight from
      // the CDN instead of re-downloading from Drive and re-running the
      // service-account auth every time. stale-while-revalidate means a
      // slightly-stale copy still opens instantly while a fresh one is
      // fetched in the background, so a real update in Drive still
      // shows up within the hour.
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
      res.status(200).send(buf);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to load the PDF from Drive' });
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
