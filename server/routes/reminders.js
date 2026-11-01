import { Router } from 'express';
import { db } from '../db.js';
import { HttpError, addDays, cleanText, getOwnedPlant, isDate, positiveInt, today } from '../util.js';
import { REMINDER_TYPES, completeReminder } from '../reminders.js';

const router = Router();

function getOwnedReminder(userId, id) {
  const r = db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!r) throw new HttpError(404, 'No se encontró el recordatorio.');
  return r;
}

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, p.name AS plant_name, p.photo AS plant_photo
         FROM reminders r LEFT JOIN plants p ON p.id = r.plant_id
        WHERE r.user_id = ? AND r.done_at IS NULL AND (p.id IS NULL OR p.archived = 0)
        ORDER BY r.due_date, r.id`
    )
    .all(req.user.id);
  res.json({ today: today(), reminders: rows });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const title = cleanText(b.title, 200);
  if (!title) throw new HttpError(400, 'Escribe qué hay que hacer.');
  const plantId = b.plant_id ? getOwnedPlant(req.user.id, b.plant_id).id : null;
  const type = REMINDER_TYPES.includes(b.type) ? b.type : 'otro';
  const due = isDate(b.due_date) ? b.due_date : today();
  const info = db
    .prepare('INSERT INTO reminders (user_id, plant_id, type, title, due_date, repeat_days) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, plantId, type, title, due, positiveInt(b.repeat_days));
  res.status(201).json(getOwnedReminder(req.user.id, info.lastInsertRowid));
});

router.post('/:id/done', (req, res) => {
  const r = getOwnedReminder(req.user.id, req.params.id);
  if (r.done_at) throw new HttpError(400, 'Este recordatorio ya estaba hecho.');
  completeReminder(req.user.id, r);
  res.json({ ok: true });
});

router.post('/:id/snooze', (req, res) => {
  const r = getOwnedReminder(req.user.id, req.params.id);
  const days = positiveInt(req.body?.days, 30) || 1;
  db.prepare('UPDATE reminders SET due_date = ? WHERE id = ?').run(addDays(today(), days), r.id);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const r = getOwnedReminder(req.user.id, req.params.id);
  db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id);
  if (r.type === 'riego' && r.plant_id) {
    db.prepare('UPDATE plants SET water_every_days = NULL WHERE id = ?').run(r.plant_id);
  }
  res.json({ ok: true });
});

export default router;
