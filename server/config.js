import fs from 'node:fs';
import path from 'node:path';

// Carga sencilla de un archivo .env (sin dependencias externas).
function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
}

loadDotEnv();

const dataDir = path.resolve(process.env.DATA_DIR || './data');

export const config = {
  port: Number(process.env.PORT) || 3000,
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  dbFile: path.join(dataDir, 'inspector.db'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  dailyDiagnosisLimit: Number(process.env.DAILY_DIAGNOSIS_LIMIT ?? 20),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionDays: 30,
};

export const demoMode = () => !config.anthropicApiKey;

fs.mkdirSync(config.uploadsDir, { recursive: true });
