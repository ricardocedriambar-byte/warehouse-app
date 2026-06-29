// api/users.js
// GET /api/users — returns all active users from the Utilizadores tab.
// The tab has columns: A=ID, B=Nome, C=Role (vendedor/armazém), D=Ativo (TRUE/FALSE)
// If the tab doesn't exist yet, it's created with a seed set of example rows.

const { sheetsFetch } = require('../lib/sheets');

const USERS_TAB = 'Utilizadores';

async function ensureUsersTab() {
  try {
    await sheetsFetch(`/values/${encodeURIComponent(`${USERS_TAB}!A1`)}`);
  } catch (err) {
    if (String(err.message).includes('400') || String(err.message).includes('Unable to parse')) {
      await sheetsFetch(':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: USERS_TAB } } }] })
      }).catch(() => {});
      await sheetsFetch(
        `/values/${encodeURIComponent(`${USERS_TAB}!A1`)}:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          body: JSON.stringify({
            values: [
              ['ID', 'Nome', 'Role', 'Ativo'],
              ['U001', 'Ricardo', 'vendedor', 'TRUE'],
              ['U002', 'Armazém', 'armazém', 'TRUE']
            ]
          })
        }
      );
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    await ensureUsersTab();
    const data = await sheetsFetch(`/values/${encodeURIComponent(`${USERS_TAB}!A2:D`)}`);
    const rows = data.values || [];
    const users = rows
      .filter(r => r[0] && r[1] && r[3]?.toUpperCase() === 'TRUE')
      .map(r => ({ id: r[0], name: r[1], role: (r[2] || 'vendedor').toLowerCase() }));
    res.status(200).json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
