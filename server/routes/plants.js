import { Router } from 'express';
import { db } from '../db.js';
import { HttpError, cleanText, deleteImage, getOwnedPlant, positiveInt, saveImage } from '../util.js';
import { logCare, syncWateringReminder } from '../reminders.js';

const router = Router();

const CARE_TYPES = ['riego', 'abono', 'tratamiento', 'poda', 'trasplante', 'revision', 'nota'];

const PLANT_LIST_SQL = `
  SELECT p.*,
         (SELECT health_score FROM diagnoses d WHERE d.plant_id = p.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS last_health,
         (SELECT status       FROM diagnoses d WHERE d.plant_id = p.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS last_status,
         (SELECT created_at   FROM diagnoses d WHERE d.plant_id = p.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS last_diagnosis_at,
         (SELECT COUNT(*)     FROM diagnoses d WHERE d.plant_id = p.id) AS diagnosis_count,
         (SELECT MIN(due_date) FROM reminders r WHERE r.plant_id = p.id AND r.done_at IS NULL) AS next_reminder
    FROM plants p
   WHERE p.user_id = ?`;

router.get('/', (req, res) => {
  const archived = req.query.archived === '1' ? 1 : 0;
  const plants = db
    .prepare(`${PLANT_LIST_SQL} AND p.archived = ? ORDER BY p.name COLLATE NOCASE`)
    .all(req.user.id, archived);
  res.json(plants);
});

function readPlantFields(body, partial = false) {
  const fields = {};
  if (!partial || 'name' in body) {
    fields.name = cleanText(body.name, 80);
    if (!fields.name) throw new HttpError(400, 'Ponle un nombre a la planta.');
  }
  for (const key of ['species', 'location']) if (!partial || key in body) fields[key] = cleanText(body[key], 120);
  if (!partial || 'notes' in body) fields.notes = cleanText(body.notes, 2000);
  if (!partial || 'water_every_days' in body) fields.water_every_days = positiveInt(body.water_every_days, 90);
  if ('archived' in body) fields.archived = body.archived ? 1 : 0;
  return fields;
}

router.post('/', (req, res) => {
  const f = readPlantFields(req.body || {});
  const photo = req.body.photo ? saveImage(req.body.photo).filename : null;
  const info = db
    .prepare(
      'INSERT INTO plants (user_id, name, species, location, notes, water_every_days, photo) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(req.user.id, f.name, f.species, f.location, f.notes, f.water_every_days, photo);
  const plant = getOwnedPlant(req.user.id, info.lastInsertRowid);
  syncWateringReminder(req.user.id, plant);
  res.status(201).json(plant);
});

router.get('/:id', (req, res) => {
  getOwnedPlant(req.user.id, req.params.id);
  const plant = db.prepare(`${PLANT_LIST_SQL} AND p.id = ?`).get(req.user.id, Number(req.params.id));
  const diagnoses = db
    .prepare(
      `SELECT id, photo, symptoms, health_score, status, demo, created_at, result_json
         FROM diagnoses WHERE plant_id = ? ORDER BY created_at DESC, id DESC`
    )
    .all(plant.id)
    .map(({ result_json, ...d }) => {
      const r = JSON.parse(result_json);
      return { ...d, resumen: r.resumen, problemas: r.problemas.map((p) => p.nombre) };
    });
  const care = db
    .prepare('SELECT * FROM care_log WHERE plant_id = ? ORDER BY created_at DESC, id DESC LIMIT 100')
    .all(plant.id);
  const reminders = db
    .prepare('SELECT * FROM reminders WHERE plant_id = ? AND done_at IS NULL ORDER BY due_date')
    .all(plant.id);
  res.json({ plant, diagnoses, care, reminders });
});

router.patch('/:id', (req, res) => {
  const plant = getOwnedPlant(req.user.id, req.params.id);
  const f = readPlantFields(req.body || {}, true);
  if (req.body.photo) {
    f.photo = saveImage(req.body.photo).filename;
  }
  const keys = Object.keys(f);
  if (keys.length) {
    db.prepare(`UPDATE plants SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => f[k]),
      plant.id
    );
  }
  if (f.photo && plant.photo) deleteImage(plant.photo);
  const updated = getOwnedPlant(req.user.id, plant.id);
  if ('water_every_days' in f || 'name' in f) syncWateringReminder(req.user.id, updated);
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const plant = getOwnedPlant(req.user.id, req.params.id);
  const photos = db.prepare('SELECT photo FROM diagnoses WHERE plant_id = ?').all(plant.id);
  db.prepare('DELETE FROM diagnoses WHERE plant_id = ?').run(plant.id);
  db.prepare('DELETE FROM plants WHERE id = ?').run(plant.id);
  for (const p of [...photos.map((x) => x.photo), plant.photo]) deleteImage(p);
  res.json({ ok: true });
});

// Diario de cuidados: "la regué", "la aboné", notas...
router.post('/:id/care', (req, res) => {
  const plant = getOwnedPlant(req.user.id, req.params.id);
  const type = String(req.body?.type || '');
  if (!CARE_TYPES.includes(type)) throw new HttpError(400, 'Tipo de cuidado no válido.');
  logCare(req.user.id, plant.id, type, cleanText(req.body.note, 1000));
  res.status(201).json({ ok: true });
});

router.delete('/:id/care/:careId', (req, res) => {
  const plant = getOwnedPlant(req.user.id, req.params.id);
  db.prepare('DELETE FROM care_log WHERE id = ? AND plant_id = ?').run(Number(req.params.careId), plant.id);
  res.json({ ok: true });
});

export default router;
