// lib/db-fase2.js
//
// Postgres implementations for fase 2 of the Sheets → Supabase migration:
// clientes, utilizadores, push subscriptions and the small config tabs
// (MateriaisPortas, LogosFornecedores, PriceSyncStatus, J5F_Ignorar).
// Each function has the same name, arguments and return shape as the Sheets
// version it replaces; lib/orders.js, lib/users.js, lib/push.js,
// lib/sheets.js, lib/j5f.js and api/clients.js switch to these when
// USE_POSTGRES_FASE2=1.

const { getSql } = require('./db');

function extractNif(notes) {
  if (!notes) return '';
  const m = String(notes).match(/NIF[:\s]*([0-9][0-9.\s]*[0-9]|[0-9])/i);
  return m ? m[1].replace(/[.\s]/g, '') : '';
}

// ─── Clientes ───────────────────────────────────────────────────────────────
function rowToClient(r) {
  return {
    id: r.id,
    name: r.nome || '',
    nif: extractNif(r.notas),
    address: r.morada || '',
    phone: r.telefone || '',
    email: r.email || '',
    notes: r.notas || ''
  };
}

async function getAllClients() {
  const sql = getSql();
  const rows = await sql`select * from clientes order by ordem nulls last, criado_em, id`;
  return rows.map(rowToClient);
}

async function createClient({ name, nif, address, phone, email, notes }) {
  const sql = getSql();
  const id = `CLI-${Date.now()}`;
  const combinedNotes = nif ? `NIF: ${nif}${notes ? ' · ' + notes : ''}` : (notes || '');
  await sql`insert into clientes ${sql({
    id, nome: name || '', morada: address || '', telefone: phone || '', email: email || '', notas: combinedNotes
  })}`;
  return { id, name, nif, address, phone, email, notes: combinedNotes };
}

// Bulk insert of [id, nome, morada, telefone, email, notas] rows (DOS CSV
// import in api/clients.js). Existing ids are left untouched.
async function importClientRows(rows) {
  const sql = getSql();
  const recs = rows
    .map((r) => ({ id: String(r[0] || '').trim(), nome: r[1] || '', morada: r[2] || '', telefone: r[3] || '', email: r[4] || '', notas: r[5] || '' }))
    .filter((r) => r.id);
  let inserted = 0;
  for (let i = 0; i < recs.length; i += 500) {
    const res = await sql`insert into clientes ${sql(recs.slice(i, i + 500))} on conflict (id) do nothing returning id`;
    inserted += res.length;
  }
  return inserted;
}

// Same rules as lib/j5f.js's Sheets version: new J5F codes are added;
// existing clients only get EMPTY fields filled in; nothing is deleted.
async function syncJ5fClients(body, { dryRun = false } = {}) {
  const list = Array.isArray(body && body.clients) ? body.clients : null;
  if (!list) throw new Error('Body must be { clients: [...] }');

  const sql = getSql();
  const existingRows = await sql`select * from clientes`;
  const byId = new Map(existingRows.map((r) => [String(r.id).trim(), r]));

  const summary = { total: 0, added: 0, filled: 0, unchanged: 0, skipped: 0, sampleAdded: [], sampleFilled: [] };
  const toInsert = [];
  const toUpdate = [];
  const seen = new Set();

  for (const c of list) {
    const id = String(c.codigo || '').trim();
    const name = String(c.nome || '').trim();
    if (!id || id.startsWith('*') || !name || seen.has(id)) { summary.skipped++; continue; }
    seen.add(id);
    summary.total++;

    const address = String(c.morada || '').trim();
    const phone = String(c.telefone || '').trim();
    const email = String(c.email || '').trim();
    const nif = String(c.nif || '').replace(/\D/g, '');

    const ex = byId.get(id);
    if (!ex) {
      toInsert.push({ id, nome: name, morada: address, telefone: phone, email, notas: nif ? `NIF: ${nif}` : '' });
      summary.added++;
      if (summary.sampleAdded.length < 20) summary.sampleAdded.push(`${id} · ${name}`);
      continue;
    }

    const cur = (k) => String(ex[k] || '').trim();
    const patch = {};
    if (!cur('nome') && name) patch.nome = name;
    if (!cur('morada') && address) patch.morada = address;
    if (!cur('telefone') && phone) patch.telefone = phone;
    if (!cur('email') && email) patch.email = email;
    if (nif && !extractNif(cur('notas'))) patch.notas = cur('notas') ? `NIF: ${nif} · ${cur('notas')}` : `NIF: ${nif}`;
    if (Object.keys(patch).length === 0) { summary.unchanged++; continue; }
    summary.filled++;
    if (summary.sampleFilled.length < 20) summary.sampleFilled.push(`${id} · ${cur('nome') || name}`);
    toUpdate.push({ id, patch });
  }

  if (!dryRun) {
    await sql.begin(async (tx) => {
      for (const { id, patch } of toUpdate) {
        await tx`update clientes set ${tx(patch)} where id = ${id}`;
      }
      for (let i = 0; i < toInsert.length; i += 500) {
        await tx`insert into clientes ${tx(toInsert.slice(i, i + 500))} on conflict (id) do nothing`;
      }
    });
  }
  return { ok: true, dryRun, ...summary };
}

// ─── Utilizadores ───────────────────────────────────────────────────────────
const VALID_ROLES = ['vendedor', 'armazém', 'admin'];
const AVATAR_PHOTO_MAX_CHARS = 45000;

function rowToUser(r) {
  return {
    rowNumber: r.ordem != null ? Number(r.ordem) : null,
    id: r.id,
    name: r.nome || '',
    role: (r.role || 'vendedor').toLowerCase(),
    ativo: !!r.ativo,
    email: (r.email || '').trim(),
    notifyOrders: !!r.notify_orders,
    notifyLowStock: !!r.notify_lowstock,
    defaultTab: (r.default_tab || '').trim(),
    avatarColor: (r.avatar_color || '').trim(),
    avatarPhoto: (r.avatar_photo || '').trim()
  };
}

async function getAllUsers({ includeInactive = false } = {}) {
  const sql = getSql();
  const rows = includeInactive
    ? await sql`select * from utilizadores order by ordem nulls last, criado_em, id`
    : await sql`select * from utilizadores where ativo order by ordem nulls last, criado_em, id`;
  return rows.map(rowToUser).filter((u) => u.id && u.name);
}

async function findUserById(id) {
  const sql = getSql();
  const [r] = await sql`select * from utilizadores where id = ${id}`;
  return r ? rowToUser(r) : null;
}

async function createUser({ name, role, email, notifyOrders, notifyLowStock, defaultTab, avatarColor, avatarPhoto }) {
  if (avatarPhoto && avatarPhoto.length > AVATAR_PHOTO_MAX_CHARS) throw new Error('Foto de perfil demasiado grande');
  const sql = getSql();
  const [r] = await sql`insert into utilizadores ${sql({
    id: `U${Date.now()}`,
    nome: name || '',
    role: VALID_ROLES.includes(role) ? role : 'vendedor',
    ativo: true,
    email: email || '',
    notify_orders: !!notifyOrders,
    notify_lowstock: !!notifyLowStock,
    default_tab: defaultTab || '',
    avatar_color: avatarColor || '',
    avatar_photo: avatarPhoto || ''
  })} returning *`;
  return rowToUser(r);
}

const FIELD_TO_COL = {
  role: 'role', ativo: 'ativo', email: 'email', notifyOrders: 'notify_orders', notifyLowStock: 'notify_lowstock',
  defaultTab: 'default_tab', avatarColor: 'avatar_color', avatarPhoto: 'avatar_photo'
};
const BOOL_FIELDS = new Set(['ativo', 'notifyOrders', 'notifyLowStock']);

async function updateUser(id, fields) {
  if (fields.role !== undefined && !VALID_ROLES.includes(fields.role)) throw new Error(`Role inválida: ${fields.role}`);
  if (fields.avatarPhoto && fields.avatarPhoto.length > AVATAR_PHOTO_MAX_CHARS) throw new Error('Foto de perfil demasiado grande');
  const patch = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const col = FIELD_TO_COL[key];
    if (!col) continue;
    patch[col] = BOOL_FIELDS.has(key) ? !!value : (value ?? '');
  }
  const sql = getSql();
  if (Object.keys(patch).length === 0) {
    const u = await findUserById(id);
    if (!u) throw new Error(`Utilizador ${id} não encontrado`);
    return u;
  }
  const [r] = await sql`update utilizadores set ${sql(patch)} where id = ${id} returning *`;
  if (!r) throw new Error(`Utilizador ${id} não encontrado`);
  return rowToUser(r);
}

async function getNotifyRecipients(kind) {
  const users = await getAllUsers({ includeInactive: false });
  const flag = kind === 'orders' ? 'notifyOrders' : 'notifyLowStock';
  return users.filter((u) => u.email && u[flag]).map((u) => u.email);
}

async function getNotifyRecipientUserIds(kind) {
  const users = await getAllUsers({ includeInactive: false });
  const flag = kind === 'orders' ? 'notifyOrders' : 'notifyLowStock';
  return users.filter((u) => u[flag]).map((u) => u.id);
}

async function ensureUsersTab() { /* table created by db/schema-fase2.sql */ }

// ─── Push subscriptions ─────────────────────────────────────────────────────
// Returned in the same array-per-row shape lib/push.js already works with
// (ID, UserId, Endpoint, P256dh, Auth, UserAgent, CreatedAt), so its send /
// test / cleanup logic is reused unchanged.
async function listSubscriptionRows() {
  const sql = getSql();
  const rows = await sql`select * from push_subscriptions order by created_at`;
  return rows.map((r) => [r.id, r.user_id, r.endpoint, r.p256dh, r.auth, r.user_agent, r.created_at ? new Date(r.created_at).toISOString() : '']);
}

async function saveSubscription(userId, subscription, userAgent) {
  if (!subscription || !subscription.endpoint) throw new Error('subscription inválida');
  const sql = getSql();
  await sql`
    insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
    values (${`SUB${Date.now()}${Math.floor(Math.random() * 1000)}`}, ${userId || ''}, ${subscription.endpoint},
            ${subscription.keys?.p256dh || ''}, ${subscription.keys?.auth || ''}, ${userAgent || ''})
    on conflict (endpoint) do update set
      user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`;
}

async function removeSubscriptionByEndpoint(endpoint) {
  if (!endpoint) return;
  const sql = getSql();
  await sql`delete from push_subscriptions where endpoint = ${endpoint}`;
}

// ─── Small config tables ────────────────────────────────────────────────────
const DOOR_SEED = ['CTP CARVALHO', 'CPL BRANCO'];

async function getDoorMaterials() {
  const sql = getSql();
  const rows = await sql`select nome from materiais_portas order by posicao`;
  if (rows.length === 0) {
    await setDoorMaterials(DOOR_SEED);
    return [...DOOR_SEED];
  }
  return rows.map((r) => r.nome);
}

async function setDoorMaterials(list) {
  const clean = (list || []).map((s) => String(s || '').trim()).filter(Boolean);
  const sql = getSql();
  await sql.begin(async (tx) => {
    await tx`delete from materiais_portas`;
    if (clean.length) await tx`insert into materiais_portas ${tx(clean.map((nome, i) => ({ posicao: i, nome })))}`;
  });
  return clean;
}

async function getFornecedorLogos() {
  const sql = getSql();
  const rows = await sql`select fornecedor, logo_url from logos_fornecedores`;
  const logos = {};
  for (const r of rows) if (r.fornecedor && r.logo_url) logos[r.fornecedor] = r.logo_url;
  return logos;
}

async function saveFornecedorLogo(fornecedor, url) {
  const f = String(fornecedor || '').trim();
  const u = String(url || '').trim();
  if (!f || !u) return;
  try {
    const sql = getSql();
    await sql`insert into logos_fornecedores (fornecedor, logo_url) values (${f}, ${u}) on conflict (fornecedor) do nothing`;
  } catch (err) {
    console.error(`Failed to persist discovered logo for ${f}:`, err);
  }
}

const SYNC_STATUS_LIST_CAP = 100;
function capList(list) {
  return Array.isArray(list) && list.length > SYNC_STATUS_LIST_CAP ? list.slice(0, SYNC_STATUS_LIST_CAP) : list;
}

async function savePriceSyncStatus(summary) {
  const trimmed = {
    ...summary,
    unmatchedInPriceList: capList(summary.unmatchedInPriceList),
    notFoundInSheet: capList(summary.notFoundInSheet),
    duplicatesInPriceList: capList(summary.duplicatesInPriceList),
    errors: capList(summary.errors)
  };
  const sql = getSql();
  await sql`
    insert into price_sync_status (id, run_at, summary) values (1, now(), ${sql.json(trimmed)})
    on conflict (id) do update set run_at = excluded.run_at, summary = excluded.summary`;
}

async function getPriceSyncStatus() {
  try {
    const sql = getSql();
    const [r] = await sql`select run_at, summary from price_sync_status where id = 1`;
    if (!r) return null;
    return { runAt: new Date(r.run_at).toISOString(), summary: r.summary || null };
  } catch (err) {
    return null;
  }
}

const IGNORE_SEED = [['01000001', 'MAO DE OBRA']];

async function getJ5fIgnoreSet() {
  const sql = getSql();
  let rows = await sql`select sku from j5f_ignorar`;
  if (rows.length === 0) {
    await sql`insert into j5f_ignorar ${sql(IGNORE_SEED.map(([sku, descricao]) => ({ sku, descricao })))} on conflict do nothing`;
    rows = IGNORE_SEED.map(([sku]) => ({ sku }));
  }
  return new Set(rows
    .map((r) => String(r.sku || '').trim().replace(/^'/, ''))
    .filter(Boolean)
    .map((s) => (/^\d+$/.test(s) ? s.padStart(8, '0') : s)));
}

module.exports = {
  // clientes
  getAllClients, createClient, importClientRows, syncJ5fClients,
  // utilizadores
  VALID_ROLES, AVATAR_PHOTO_MAX_CHARS, getAllUsers, findUserById, createUser, updateUser,
  getNotifyRecipients, getNotifyRecipientUserIds, ensureUsersTab,
  // push
  listSubscriptionRows, saveSubscription, removeSubscriptionByEndpoint,
  // config
  getDoorMaterials, setDoorMaterials, getFornecedorLogos, saveFornecedorLogo,
  savePriceSyncStatus, getPriceSyncStatus, getJ5fIgnoreSet
};
