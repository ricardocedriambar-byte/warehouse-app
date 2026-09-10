// api/resources.js
//
// GET /api/resources -> list of price-list/catalog PDFs, auto-discovered
// from the Drive folder structure Recursos/<Fornecedor>/<documento>.pdf,
// plus optional manual logo overrides for suppliers where automatic
// lookup by name doesn't find a match (see LogosFornecedores tab).
//
// GET /api/resources?fileId=<drive file id> -> that file's raw PDF bytes
// from Drive. The in-app viewer (pdf.js, see resources.js) renders those
// bytes itself instead of embedding Drive's own /preview page — that
// embed always draws its own toolbar (page/zoom controls) with no
// supported way to turn it off.
//
// Forwards the browser's Range header straight to Drive and passes its
// 206 Partial Content response straight back. This is the actual fix for
// "takes too long to load a PDF": without Range support, pdf.js has no
// choice but to wait for the ENTIRE file before it can show even page 1
// — no amount of streaming vs. buffering on our side changes that, since
// the wait is for the file to finish arriving, not for how it's
// plumbed through this function. With Range support, pdf.js fetches only
// the small pieces it actually needs (the header/xref table, then just
// the page(s) being looked at), so opening even a large multi-page
// catalog only has to wait for a few small requests instead of the whole
// file. Each of those requests is still small enough that buffering it
// in this function before sending is effectively instant — this isn't
// the full-file buffering that used to be the problem.

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
      const driveRes = await fetchFileMedia(fileId, req.headers.range);
      if (!driveRes.ok) {
        const body = await driveRes.text().catch(() => '');
        console.error(`Drive media fetch failed for ${fileId}: ${driveRes.status} ${body.slice(0, 300)}`);
        res.status(driveRes.status === 404 ? 404 : 502).json({ error: 'Failed to load the PDF from Drive' });
        return;
      }

      const buf = Buffer.from(await driveRes.arrayBuffer());
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Accept-Ranges', 'bytes');
      // Computed from the actual bytes we're about to send, never
      // trusted from Drive's own header — that sidesteps any risk of a
      // stale/mismatched Content-Length like the one the streaming
      // attempt ran into.
      res.setHeader('Content-Length', String(buf.length));
      const contentRange = driveRes.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      // Cacheable at Vercel's edge, not just the requesting browser — a
      // "Tabela de Preços" doesn't change intraday, so repeat opens (by
      // anyone, not just the same person) can be served straight from
      // the CDN instead of re-downloading from Drive and re-running the
      // service-account auth every time. stale-while-revalidate means a
      // slightly-stale copy still opens instantly while a fresh one is
      // fetched in the background, so a real update in Drive still
      // shows up within the hour.
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
      // driveRes.status is 200 for a full fetch or 206 for a range —
      // forwarded as-is so pdf.js can tell the difference and knows
      // range requests are actually supported.
      res.status(driveRes.status).send(buf);
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
