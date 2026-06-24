// api/import-clients.js
//
// POST /api/import-clients
// body: { csv: "<raw csv string>" }
//
// One-shot import of the DOS client list CSV into the Clientes Sheet tab.
// Skips the header row, the "Consumidor Final" placeholder (****** code),
// and any row with no name. Maps the 12 DOS columns to the app's client
// schema: ID=CODIGO, name=NOME, address=MORADA1+MORADA2, phone=TELEFONES,
// mobile=TELEMOVEL, email=EMAIL, contrib=CONTRIB, localidade=LOCALIDADE.
//
// Safe to run multiple times — it APPENDS, it does not overwrite existing
// rows. If you want a clean import, clear the Clientes tab first manually.

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { csv } = req.body || {};
    if (!csv) { res.status(400).json({ error: 'csv field is required in body' }); return; }

    const rows = parseCSV(csv);
    const header = rows[0];

    // Confirm it looks like the expected file
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

      // Skip placeholder and empty rows
      if (!codigo || codigo.startsWith('*') || !nome) { skipped++; continue; }

      // Combine address fields
      const address = [morada1, morada2, postal, localidade].filter(Boolean).join(', ');
      // Prefer mobile over landline for the primary phone field
      const phone = telemovel || telefone;
      // Notes: contrib + fax if present
      const notes = [contrib ? `NIF: ${contrib}` : '', fax ? `Fax: ${fax}` : ''].filter(Boolean).join(' · ');

      sheetRows.push([codigo, nome, address, phone, email, notes]);
    }

    if (sheetRows.length === 0) {
      res.status(200).json({ ok: true, imported: 0, skipped });
      return;
    }

    // Write in batches via append (appends below the last row with content)
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
