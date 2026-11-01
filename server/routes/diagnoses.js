import { Router } from 'express';
import { db, transaction } from '../db.js';
import { config } from '../config.js';
import { analyzePlant } from '../ai.js';
import { HttpError, addDays, cleanText, deleteImage, getOwnedPlant, saveImage, today, wrap } from '../util.js';
import { REMINDER_TYPES, syncWateringReminder } from '../reminders.js';

const router = Router();

function checkDailyLimit(user) {
  if (user.role === 'admin' || !config.dailyDiagnosisLimit) return;
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM diagnoses WHERE user_id = ? AND created_at >= datetime('now', '-1 day')")
    .get(user.id);
  if (n >= config.dailyDiagnosisLimit) {
    throw new HttpError(429, `Has llegado al límite de ${config.dailyDiagnosisLimit} análisis por día. Vuelve mañana.`);
  }
}

// Analiza una foto. Si se indica plant_id, se guarda en el historial de esa planta.
// Si se envía new_plant_name, se crea la planta a partir del diagnóstico.
router.post(
  '/',
  wrap(async (req, res) => {
    checkDailyLimit(req.user);
    const body = req.body || {};
    let plant = body.plant_id ? getOwnedPlant(req.user.id, body.plant_id) : null;
    const symptoms = cleanText(body.symptoms, 2000);
    const image = saveImage(body.photo);

    let previous = null;
    if (plant) {
      const prev = db
        .prepare('SELECT result_json, created_at FROM diagnoses WHERE plant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
        .get(plant.id);
      if (prev) previous = { date: prev.created_at, result: JSON.parse(prev.result_json) };
    }

    let analysis;
    try {
      analysis = await analyzePlant({
        imageBase64: image.base64,
        mediaType: image.mediaType,
        plant,
        symptoms,
        previous,
      });
    } catch (err) {
      deleteImage(image.filename);
      throw err;
    }
    const { result, model, demo } = analysis;

    const id = transaction(() => {
      const newPlantName = cleanText(body.new_plant_name, 80);
      if (!plant && newPlantName && result.es_planta) {
        const info = db
          .prepare('INSERT INTO plants (user_id, name, species, photo, water_every_days) VALUES (?, ?, ?, ?, ?)')
          .run(
            req.user.id,
            newPlantName,
            result.planta_identificada.nombre_comun,
            image.filename,
            result.riego_cada_dias
          );
        plant = getOwnedPlant(req.user.id, info.lastInsertRowid);
        syncWateringReminder(req.user.id, plant);
      }
      const info = db
        .prepare(
          `INSERT INTO diagnoses (user_id, plant_id, photo, symptoms, result_json, health_score, status, model, demo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          req.user.id,
          plant?.id ?? null,
          image.filename,
          symptoms,
          JSON.stringify(result),
          result.es_planta ? result.puntuacion_salud : null,
          result.es_planta ? result.estado_general : null,
          model,
          demo ? 1 : 0
        );
      if (plant) db.prepare('UPDATE plants SET photo = ? WHERE id = ?').run(image.filename, plant.id);
      return Number(info.lastInsertRowid);
    });

    res.status(201).json(getDiagnosis(req.user.id, id));
  })
);

function getDiagnosis(userId, id) {
  const row = db
    .prepare(
      `SELECT d.*, p.name AS plant_name FROM diagnoses d LEFT JOIN plants p ON p.id = d.plant_id
        WHERE d.id = ? AND d.user_id = ?`
    )
    .get(Number(id), userId);
  if (!row) throw new HttpError(404, 'No se encontró el diagnóstico.');
  const { result_json, ...rest } = row;
  return { ...rest, result: JSON.parse(result_json) };
}

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.id, d.plant_id, d.photo, d.health_score, d.status, d.demo, d.created_at, d.result_json, p.name AS plant_name
         FROM diagnoses d LEFT JOIN plants p ON p.id = d.plant_id
        WHERE d.user_id = ? ORDER BY d.created_at DESC, d.id DESC LIMIT 200`
    )
    .all(req.user.id)
    .map(({ result_json, ...d }) => {
      const r = JSON.parse(result_json);
      return { ...d, species: r.planta_identificada.nombre_comun, resumen: r.resumen };
    });
  res.json(rows);
});

router.get('/:id', (req, res) => res.json(getDiagnosis(req.user.id, req.params.id)));

// Vincular un diagnóstico suelto a una planta existente o a una nueva.
router.patch('/:id', (req, res) => {
  const d = getDiagnosis(req.user.id, req.params.id);
  if (!d.result.es_planta) throw new HttpError(400, 'Esta foto no muestra una planta.');
  transaction(() => {
    let plant;
    if (req.body?.new_plant) {
      const name = cleanText(req.body.name, 80) || d.result.planta_identificada.nombre_comun.slice(0, 80);
      const info = db
        .prepare('INSERT INTO plants (user_id, name, species, photo, water_every_days) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, name, d.result.planta_identificada.nombre_comun, d.photo, d.result.riego_cada_dias);
      plant = getOwnedPlant(req.user.id, info.lastInsertRowid);
      syncWateringReminder(req.user.id, plant);
    } else {
      plant = getOwnedPlant(req.user.id, req.body?.plant_id);
      if (!plant.photo) db.prepare('UPDATE plants SET photo = ? WHERE id = ?').run(d.photo, plant.id);
    }
    db.prepare('UPDATE diagnoses SET plant_id = ? WHERE id = ?').run(plant.id, d.id);
  });
  res.json(getDiagnosis(req.user.id, d.id));
});

router.delete('/:id', (req, res) => {
  const d = getDiagnosis(req.user.id, req.params.id);
  db.prepare('DELETE FROM diagnoses WHERE id = ?').run(d.id);
  deleteImage(d.photo);
  res.json({ ok: true });
});

// Crea los recordatorios sugeridos por la IA que el usuario haya elegido.
router.post('/:id/apply', (req, res) => {
  const d = getDiagnosis(req.user.id, req.params.id);
  if (!d.plant_id) throw new HttpError(400, 'Primero guarda este diagnóstico en una planta.');
  const plant = getOwnedPlant(req.user.id, d.plant_id);
  const indexes = Array.isArray(req.body?.reminders) ? req.body.reminders.map(Number) : [];
  let created = 0;
  transaction(() => {
    for (const i of indexes) {
      const s = d.result.recordatorios_sugeridos[i];
      if (!s) continue;
      if (s.tipo === 'riego' && s.repetir_cada_dias) {
        db.prepare('UPDATE plants SET water_every_days = ? WHERE id = ?').run(s.repetir_cada_dias, plant.id);
        syncWateringReminder(req.user.id, getOwnedPlant(req.user.id, plant.id));
      } else {
        db.prepare(
          'INSERT INTO reminders (user_id, plant_id, type, title, due_date, repeat_days) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(
          req.user.id,
          plant.id,
          REMINDER_TYPES.includes(s.tipo) ? s.tipo : 'otro',
          s.titulo.slice(0, 200),
          addDays(today(), s.en_dias),
          s.repetir_cada_dias
        );
      }
      created += 1;
    }
    if (req.body?.apply_watering && d.result.riego_cada_dias) {
      db.prepare('UPDATE plants SET water_every_days = ? WHERE id = ?').run(d.result.riego_cada_dias, plant.id);
      syncWateringReminder(req.user.id, getOwnedPlant(req.user.id, plant.id));
    }
  });
  res.json({ ok: true, created });
});

export default router;
