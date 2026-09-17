// api/users.js
//
// GET   /api/users            -> active users, minimal fields (login picker)
// GET   /api/users?all=true   -> every user (incl. inactive), full fields (Admin panel)
// POST  /api/users            -> create a user (Admin panel "add user")
// PATCH /api/users            -> update a user's fields (Settings self-service,
//                                 or Admin panel editing role/ativo/email)
//
// Note: like the rest of this app, there's no server-side session — any
// browser can call any of these endpoints. That's an accepted tradeoff for
// this internal single-business tool (see auth.js on the client); this file
// doesn't attempt to enforce who's "really" an admin, it just exposes the
// data operations the UI needs.

const { getAllUsers, findUserById, createUser, updateUser, VALID_ROLES, AVATAR_PHOTO_MAX_CHARS } = require('../lib/users');

function avatarPhotoTooLarge(body) {
  return typeof body.avatarPhoto === 'string' && body.avatarPhoto.length > AVATAR_PHOTO_MAX_CHARS;
}

function toLoginShape(u) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    defaultTab: u.defaultTab || '',
    avatarColor: u.avatarColor || '',
    avatarPhoto: u.avatarPhoto || ''
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const wantAll = String(req.query?.all || '').toLowerCase() === 'true';
      const users = await getAllUsers({ includeInactive: wantAll });
      res.status(200).json({ users: wantAll ? users : users.map(toLoginShape) });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const name = String(body.name || '').trim();
      if (!name) { res.status(400).json({ error: 'Nome é obrigatório' }); return; }
      if (body.role && !VALID_ROLES.includes(body.role)) {
        res.status(400).json({ error: `Role inválida: ${body.role}` });
        return;
      }
      if (avatarPhotoTooLarge(body)) {
        res.status(400).json({ error: 'Foto de perfil demasiado grande' });
        return;
      }
      const user = await createUser({
        name,
        role: body.role,
        email: body.email,
        notifyOrders: !!body.notifyOrders,
        notifyLowStock: !!body.notifyLowStock,
        defaultTab: body.defaultTab,
        avatarColor: body.avatarColor,
        avatarPhoto: body.avatarPhoto
      });
      res.status(201).json({ user });
      return;
    }

    if (req.method === 'PATCH') {
      const body = req.body || {};
      const id = body.id;
      if (!id) { res.status(400).json({ error: 'id é obrigatório' }); return; }

      const existing = await findUserById(id);
      if (!existing) { res.status(404).json({ error: 'Utilizador não encontrado' }); return; }

      const fields = {};
      for (const key of ['role', 'ativo', 'email', 'notifyOrders', 'notifyLowStock', 'defaultTab', 'avatarColor', 'avatarPhoto']) {
        if (Object.prototype.hasOwnProperty.call(body, key)) fields[key] = body[key];
      }
      if (fields.role !== undefined && !VALID_ROLES.includes(fields.role)) {
        res.status(400).json({ error: `Role inválida: ${fields.role}` });
        return;
      }
      if (avatarPhotoTooLarge(fields)) {
        res.status(400).json({ error: 'Foto de perfil demasiado grande' });
        return;
      }

      const user = await updateUser(id, fields);
      res.status(200).json({ user });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
