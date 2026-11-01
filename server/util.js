import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Envuelve un manejador async para que los errores lleguen al middleware de errores.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

export function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function cleanText(value, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().slice(0, max);
  return s || null;
}

export function positiveInt(value, max = 365) {
  if (value === undefined || value === null || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, max);
}

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Recibe un data URL ("data:image/jpeg;base64,...") y lo guarda en disco.
export function saveImage(dataUrl) {
  const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match || !IMAGE_TYPES[match[1]]) {
    throw new HttpError(400, 'La imagen no es válida. Usa una foto JPG, PNG o WEBP.');
  }
  const [, mediaType, base64] = match;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'La foto es demasiado grande (máximo 5 MB).');
  const filename = `${crypto.randomUUID()}.${IMAGE_TYPES[mediaType]}`;
  fs.writeFileSync(path.join(config.uploadsDir, filename), buffer);
  return { filename, mediaType, base64 };
}

export function deleteImage(filename) {
  if (!filename || !/^[\w-]+\.(jpg|png|webp|gif)$/.test(filename)) return;
  const stillUsed =
    db.prepare('SELECT 1 FROM plants WHERE photo = ? UNION SELECT 1 FROM diagnoses WHERE photo = ?').get(filename, filename);
  if (stillUsed) return;
  fs.rm(path.join(config.uploadsDir, filename), { force: true }, () => {});
}

export function getOwnedPlant(userId, plantId) {
  const plant = db.prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?').get(Number(plantId), userId);
  if (!plant) throw new HttpError(404, 'No se encontró la planta.');
  return plant;
}
