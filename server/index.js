import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, demoMode } from './config.js';
import { db } from './db.js';
import { HttpError } from './util.js';
import { loadUser, requireAdmin, requireAuth } from './auth.js';
import authRoutes from './routes/auth.js';
import plantRoutes from './routes/plants.js';
import diagnosisRoutes from './routes/diagnoses.js';
import reminderRoutes from './routes/reminders.js';
import adminRoutes from './routes/admin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use(express.json({ limit: '8mb' }));
  app.use(loadUser);

  // Las peticiones que cambian datos deben ser JSON (protección básica contra CSRF).
  app.use('/api', (req, res, next) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && req.headers['content-length'] !== '0') {
      if (req.headers['content-length'] && !req.is('application/json')) {
        return res.status(415).json({ error: 'Formato no admitido.' });
      }
    }
    next();
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/plants', requireAuth, plantRoutes);
  app.use('/api/diagnoses', requireAuth, diagnosisRoutes);
  app.use('/api/reminders', requireAuth, reminderRoutes);
  app.use('/api/admin', requireAdmin, adminRoutes);

  // Fotos: solo las ve su dueño.
  app.get('/api/photos/:name', requireAuth, (req, res) => {
    const name = req.params.name;
    if (!/^[\w-]+\.(jpg|png|webp|gif)$/.test(name)) return res.status(404).end();
    const owned = db
      .prepare(
        'SELECT 1 FROM plants WHERE photo = ? AND user_id = ? UNION SELECT 1 FROM diagnoses WHERE photo = ? AND user_id = ?'
      )
      .get(name, req.user.id, name, req.user.id);
    const file = path.join(config.uploadsDir, name);
    if (!owned || !fs.existsSync(file)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(file);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));

  app.use(express.static(publicDir, { index: 'index.html' }));
  app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = 500;
    let message = 'Ha ocurrido un error inesperado.';
    if (err instanceof HttpError) {
      status = err.status;
      message = err.message;
    } else if (err.type === 'entity.too.large') {
      status = 413;
      message = 'La foto es demasiado grande.';
    } else if (err.type === 'entity.parse.failed') {
      status = 400;
      message = 'Petición no válida.';
    } else if (err instanceof Anthropic.AuthenticationError) {
      message = 'La clave de Anthropic no es válida. Revisa ANTHROPIC_API_KEY.';
    } else if (err instanceof Anthropic.RateLimitError) {
      status = 503;
      message = 'El servicio de IA está saturado. Inténtalo en un minuto.';
    } else if (err instanceof Anthropic.APIConnectionError) {
      status = 503;
      message = 'No se pudo conectar con el servicio de IA. Revisa la conexión a internet.';
    } else if (err instanceof Anthropic.APIError) {
      status = 502;
      message = 'El servicio de IA devolvió un error. Inténtalo de nuevo.';
    }
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  });

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().listen(config.port, () => {
    console.log(`🌿 Inspector de Plantas funcionando en http://localhost:${config.port}`);
    if (demoMode()) {
      console.log('⚠️  Sin ANTHROPIC_API_KEY: la app funciona en MODO DEMOSTRACIÓN (diagnósticos de ejemplo).');
    } else {
      console.log(`🤖 Análisis con IA activado (modelo ${config.model}).`);
    }
  });
}
