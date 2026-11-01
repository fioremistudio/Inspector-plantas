import { Router } from 'express';
import { db, getSetting, setSetting } from '../db.js';
import { destroyUserSessions, hashPassword, validatePassword } from '../auth.js';
import { HttpError, cleanText, deleteImage } from '../util.js';
import { createUser } from './auth.js';
import { config, demoMode } from '../config.js';

const router = Router();

router.get('/overview', (req, res) => {
  const count = (sql) => db.prepare(sql).get().n;
  res.json({
    stats: {
      users: count('SELECT COUNT(*) AS n FROM users'),
      plants: count('SELECT COUNT(*) AS n FROM plants'),
      diagnoses: count('SELECT COUNT(*) AS n FROM diagnoses'),
      diagnosesToday: count("SELECT COUNT(*) AS n FROM diagnoses WHERE created_at >= datetime('now', '-1 day')"),
    },
    settings: {
      allowRegistration: getSetting('allow_registration', 'false') === 'true',
    },
    system: { demoMode: demoMode(), model: config.model, dailyLimit: config.dailyDiagnosisLimit },
  });
});

router.get('/users', (req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.active, u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM plants p WHERE p.user_id = u.id) AS plants,
              (SELECT COUNT(*) FROM diagnoses d WHERE d.user_id = u.id) AS diagnoses
         FROM users u ORDER BY u.created_at DESC`
    )
    .all();
  res.json(users);
});

router.post('/users', (req, res) => {
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  const id = createUser({ ...req.body, role });
  res.status(201).json({ id });
});

const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;

router.patch('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) throw new HttpError(404, 'Usuario no encontrado.');
  const b = req.body || {};
  const updates = {};
  if ('name' in b) {
    updates.name = cleanText(b.name, 80);
    if (!updates.name) throw new HttpError(400, 'El nombre no puede estar vacío.');
  }
  if ('role' in b) updates.role = b.role === 'admin' ? 'admin' : 'user';
  if ('active' in b) updates.active = b.active ? 1 : 0;
  if (b.password) {
    const err = validatePassword(b.password);
    if (err) throw new HttpError(400, err);
    updates.password_hash = hashPassword(b.password);
  }
  const losesAdmin =
    user.role === 'admin' && user.active && (updates.role === 'user' || updates.active === 0);
  if (losesAdmin && activeAdmins() <= 1) {
    throw new HttpError(400, 'Debe quedar al menos un administrador activo.');
  }
  const keys = Object.keys(updates);
  if (keys.length) {
    db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => updates[k]),
      user.id
    );
  }
  if (updates.active === 0 || updates.password_hash) {
    if (user.id !== req.user.id) destroyUserSessions(user.id);
  }
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) throw new HttpError(404, 'Usuario no encontrado.');
  if (user.id === req.user.id) throw new HttpError(400, 'No puedes borrar tu propia cuenta.');
  if (user.role === 'admin' && user.active && activeAdmins() <= 1) {
    throw new HttpError(400, 'Debe quedar al menos un administrador activo.');
  }
  const photos = db
    .prepare('SELECT photo FROM plants WHERE user_id = ? UNION SELECT photo FROM diagnoses WHERE user_id = ?')
    .all(user.id, user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  for (const { photo } of photos) deleteImage(photo);
  res.json({ ok: true });
});

router.patch('/settings', (req, res) => {
  if ('allowRegistration' in (req.body || {})) {
    setSetting('allow_registration', req.body.allowRegistration ? 'true' : 'false');
  }
  res.json({ ok: true });
});

export default router;
