// api/clients.js
// GET  /api/clients             -> list all clients
// POST /api/clients             -> create a new client
// POST /api/clients?import=1    -> one-shot bulk import of the DOS CSV export (body: { csv })
//
// import-clients.js was merged into this file to stay under Vercel's
// 12-serverless-function limit on the Hobby plan — behavior unchanged,
// just reached through a query param instead of its own path.

const { getAllClients, createClient } = require('../lib/orders');
const { sheetsFetch } = require('../lib/sheets');

const CLIENTS_TAB = 'Clientes';
const BATCH_SIZE = 500; // Sheets API limit per batchUpdate call

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    rows.push(line.split(';').map(f => f.trim()));
  }
  return rows;
}

async function importClients(req, res) {
  const { csv } = req.body || {};
  if (!csv) { res.status(400).json({ error: 'csv field is required in body' }); return; }

  const rows = parseCSV(csv);
  const header = rows[0];

  if (!header[0]?.toUpperCase().includes('CODIGO')) {
    res.status(400).json({ error: 'CSV does not look like CLIENTES.csv — first column should be CODIGO' });
    return;
  }

  const dataRows = rows.slice(1); // skip header
  const sheetRows = [];
  let skipped = 0;

  for (const r of dataRows) {
    const codigo   = r[0]  || '';
    const nome     = r[1]  || '';
    const morada1  = r[2]  || '';
    const morada2  = r[3]  || '';
    const postal   = r[4]  || '';
    const localidade = r[5] || '';
    const contrib  = r[6]  || '';
    const telefone = r[7]  || '';
    const telemovel = r[8] || '';
    const fax      = r[9]  || '';
    const email    = r[10] || '';

    if (!codigo || codigo.startsWith('*') || !nome) { skipped++; continue; }

    const address = [morada1, morada2, postal, localidade].filter(Boolean).join(', ');
    const phone = telemovel || telefone;
    const notes = [contrib ? `NIF: ${contrib}` : '', fax ? `Fax: ${fax}` : ''].filter(Boolean).join(' · ');

    sheetRows.push([codigo, nome, address, phone, email, notes]);
  }

  if (sheetRows.length === 0) {
    res.status(200).json({ ok: true, imported: 0, skipped });
    return;
  }

  for (let i = 0; i < sheetRows.length; i += BATCH_SIZE) {
    const chunk = sheetRows.slice(i, i + BATCH_SIZE);
    await sheetsFetch(
      `/values/${encodeURIComponent(`${CLIENTS_TAB}!A:F`)}:append?valueInputOption=USER_ENTERED`,
      { method: 'POST', body: JSON.stringify({ values: chunk }) }
    );
  }

  res.status(200).json({
    ok: true,
    imported: sheetRows.length,
    skipped,
    message: `${sheetRows.length} clientes importados, ${skipped} ignorados`
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const clients = await getAllClients();
      res.status(200).json({ clients });
      return;
    }

    if (req.method === 'POST') {
      if (req.query && req.query.import !== undefined) {
        await importClients(req, res);
        return;
      }
      const { name, nif, address, phone, email, notes } = req.body || {};
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const client = await createClient({ name, nif, address, phone, email, notes });
      res.status(201).json({ client });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
