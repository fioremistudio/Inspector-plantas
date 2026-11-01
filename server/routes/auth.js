import { Router } from 'express';
import { db, getSetting } from '../db.js';
import {
  createSession,
  destroySession,
  hashPassword,
  loginRateLimit,
  requireAuth,
  validateEmail,
  validatePassword,
  verifyPassword,
} from '../auth.js';
import { config, demoMode } from '../config.js';
import { HttpError, cleanText } from '../util.js';

const router = Router();

const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

// Estado general: ¿hay que crear el primer admin? ¿se permite registrarse?
router.get('/status', (req, res) => {
  res.json({
    needsSetup: userCount() === 0,
    allowRegistration: getSetting('allow_registration', 'false') === 'true',
    demoMode: demoMode(),
    user: req.user || null,
    dailyLimit: config.dailyDiagnosisLimit,
  });
});

function createUser({ email, name, password, role }) {
  const emailErr = validateEmail(email);
  if (emailErr) throw new HttpError(400, emailErr);
  const passErr = validatePassword(password);
  if (passErr) throw new HttpError(400, passErr);
  const cleanName = cleanText(name, 80);
  if (!cleanName) throw new HttpError(400, 'Escribe tu nombre.');
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.trim());
  if (exists) throw new HttpError(409, 'Ya existe una cuenta con ese correo.');
  const info = db
    .prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(email.trim().toLowerCase(), cleanName, hashPassword(password), role);
  return Number(info.lastInsertRowid);
}
export { createUser };

// Primera vez: crea la cuenta de administrador.
router.post('/setup', (req, res) => {
  if (userCount() > 0) throw new HttpError(403, 'La app ya está configurada.');
  const id = createUser({ ...req.body, role: 'admin' });
  createSession(res, id);
  res.status(201).json({ ok: true });
});

router.post('/register', loginRateLimit, (req, res) => {
  if (getSetting('allow_registration', 'false') !== 'true') {
    throw new HttpError(403, 'El registro está cerrado. Pide una cuenta al administrador.');
  }
  const id = createUser({ ...req.body, role: 'user' });
  createSession(res, id);
  res.status(201).json({ ok: true });
});

router.post('/login', loginRateLimit, (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim()) : null;
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    throw new HttpError(401, 'Correo o contraseña incorrectos.');
  }
  if (!user.active) throw new HttpError(403, 'Tu cuenta está desactivada. Contacta con el administrador.');
  createSession(res, user.id);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

router.post('/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(current || ''), user.password_hash)) {
    throw new HttpError(400, 'La contraseña actual no es correcta.');
  }
  const err = validatePassword(next);
  if (err) throw new HttpError(400, err);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});

export default router;
