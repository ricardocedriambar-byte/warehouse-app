// lib/users.js
//
// Data layer for the Utilizadores tab. Started as a 4-column tab
// (ID, Nome, Role, Ativo) just for the login picker; this adds columns for
// per-user settings and notification opt-in without disturbing the
// original four — existing rows read the new columns as blank/false until
// someone edits them through Settings or the Admin panel.
//
//   A=ID  B=Nome  C=Role  D=Ativo  E=Email
//   F=NotificarEncomendas  G=NotificarStockBaixo  H=SeparadorInicial  I=CorAvatar
//
// Role is one of: vendedor | armazém | admin

const { sheetsFetch } = require('./sheets');

const USERS_TAB = 'Utilizadores';

const COLS = {
  ID: 0, NOME: 1, ROLE: 2, ATIVO: 3, EMAIL: 4,
  NOTIFY_ORDERS: 5, NOTIFY_LOWSTOCK: 6, DEFAULT_TAB: 7, AVATAR_COLOR: 8
};

const VALID_ROLES = ['vendedor', 'armazém', 'admin'];

let tabEnsured = false;

async function ensureUsersTab() {
  if (tabEnsured) return;
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
              ['ID', 'Nome', 'Role', 'Ativo', 'Email', 'NotificarEncomendas', 'NotificarStockBaixo', 'SeparadorInicial', 'CorAvatar'],
              ['U001', 'Ricardo', 'admin', 'TRUE', '', '', '', '', ''],
              ['U002', 'Armazém', 'armazém', 'TRUE', '', '', '', '', '']
            ]
          })
        }
      );
    } else {
      throw err;
    }
  }
  tabEnsured = true;
}

function truthy(v) { return String(v || '').trim().toUpperCase() === 'TRUE'; }

function rowToUser(row, rowNumber) {
  return {
    rowNumber,
    id: row[COLS.ID] || '',
    name: row[COLS.NOME] || '',
    role: (row[COLS.ROLE] || 'vendedor').toLowerCase(),
    ativo: truthy(row[COLS.ATIVO]),
    email: (row[COLS.EMAIL] || '').trim(),
    notifyOrders: truthy(row[COLS.NOTIFY_ORDERS]),
    notifyLowStock: truthy(row[COLS.NOTIFY_LOWSTOCK]),
    defaultTab: (row[COLS.DEFAULT_TAB] || '').trim(),
    avatarColor: (row[COLS.AVATAR_COLOR] || '').trim()
  };
}

async function getAllUsers({ includeInactive = false } = {}) {
  await ensureUsersTab();
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${USERS_TAB}!A2:I`)}`);
  const rows = data.values || [];
  return rows
    .map((row, i) => rowToUser(row, i + 2))
    .filter(u => u.id && u.name && (includeInactive || u.ativo));
}

async function findUserById(id) {
  const users = await getAllUsers({ includeInactive: true });
  return users.find(u => u.id === id) || null;
}

function generateUserId() {
  return `U${Date.now()}`;
}

// Appends a new user row using the same explicit-row batchUpdate pattern
// as createOrder/createClient — avoids the :append endpoint's table-
// detection quirk documented in lib/orders.js.
async function createUser({ name, role, email, notifyOrders, notifyLowStock, defaultTab, avatarColor }) {
  await ensureUsersTab();
  const id = generateUserId();
  const finalRole = VALID_ROLES.includes(role) ? role : 'vendedor';

  const existing = await sheetsFetch(`/values/${encodeURIComponent(`${USERS_TAB}!A2:A`)}`);
  const usedRows = (existing.values || []).length;
  const rowNumber = usedRows + 2;

  const row = [
    id, name || '', finalRole, 'TRUE', email || '',
    notifyOrders ? 'TRUE' : '', notifyLowStock ? 'TRUE' : '', defaultTab || '', avatarColor || ''
  ];

  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [{ range: `${USERS_TAB}!A${rowNumber}:I${rowNumber}`, values: [row] }]
    })
  });

  return rowToUser(row, rowNumber);
}

// Partial update — only writes the columns present in `fields`, so
// Settings (a normal user editing their own email/notify/defaultTab/color)
// and the Admin panel (editing role/ativo) can share one function without
// clobbering fields they don't know about.
const FIELD_TO_COL = {
  role: COLS.ROLE, ativo: COLS.ATIVO, email: COLS.EMAIL,
  notifyOrders: COLS.NOTIFY_ORDERS, notifyLowStock: COLS.NOTIFY_LOWSTOCK,
  defaultTab: COLS.DEFAULT_TAB, avatarColor: COLS.AVATAR_COLOR
};
const BOOL_FIELDS = new Set(['ativo', 'notifyOrders', 'notifyLowStock']);
const COL_LETTERS = 'ABCDEFGHI';

async function updateUser(id, fields) {
  const user = await findUserById(id);
  if (!user) throw new Error(`Utilizador ${id} não encontrado`);
  if (fields.role !== undefined && !VALID_ROLES.includes(fields.role)) {
    throw new Error(`Role inválida: ${fields.role}`);
  }

  const data = [];
  for (const [key, value] of Object.entries(fields)) {
    const colIndex = FIELD_TO_COL[key];
    if (colIndex === undefined) continue;
    const written = BOOL_FIELDS.has(key) ? (value ? 'TRUE' : 'FALSE') : (value ?? '');
    data.push({ range: `${USERS_TAB}!${COL_LETTERS[colIndex]}${user.rowNumber}`, values: [[written]] });
  }
  if (data.length === 0) return user;

  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
  });

  return { ...user, ...fields };
}

// Everyone with the matching opt-in flag and a saved email — kept for
// anything that still wants email addresses, though notify-order.js and
// stockAlerts.js now use getNotifyRecipientUserIds (push) instead.
async function getNotifyRecipients(kind) {
  const users = await getAllUsers({ includeInactive: false });
  const flag = kind === 'orders' ? 'notifyOrders' : 'notifyLowStock';
  return users.filter(u => u.email && u[flag]).map(u => u.email);
}

// Same opt-in flags as getNotifyRecipients, but returns user IDs instead of
// emails — push notifications are sent to a user's stored subscriptions
// (lib/push.js), not an email address, so no email is required here.
async function getNotifyRecipientUserIds(kind) {
  const users = await getAllUsers({ includeInactive: false });
  const flag = kind === 'orders' ? 'notifyOrders' : 'notifyLowStock';
  return users.filter(u => u[flag]).map(u => u.id);
}

module.exports = {
  VALID_ROLES,
  getAllUsers,
  findUserById,
  createUser,
  updateUser,
  getNotifyRecipients,
  getNotifyRecipientUserIds,
  ensureUsersTab
};
