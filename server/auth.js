import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

const COOKIE = 'ip_session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'La contraseña debe tener al menos 8 caracteres.';
  }
  return null;
}

export function validateEmail(email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return 'Escribe un correo electrónico válido.';
  }
  return null;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.sessionDays * 86400000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expires.toISOString()
  );
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    expires,
    path: '/',
  });
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE, { path: '/' });
}

export function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Adjunta req.user si hay una sesión válida.
export function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, u.active, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ?`
      )
      .get(token);
    if (row && row.active && new Date(row.expires_at) > new Date()) {
      req.user = { id: row.id, email: row.email, name: row.name, role: row.role };
    } else if (row) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Tienes que iniciar sesión.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Tienes que iniciar sesión.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo para administradores.' });
  next();
}

// Limitador muy simple de intentos de inicio de sesión por IP.
const attempts = new Map();
export function loginRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, since: now };
  if (now - entry.since > 15 * 60000) {
    entry.count = 0;
    entry.since = now;
  }
  entry.count += 1;
  attempts.set(key, entry);
  if (entry.count > 20) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  }
  next();
}
