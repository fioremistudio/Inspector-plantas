import { db } from './db.js';
import { addDays, today } from './util.js';

export const REMINDER_TYPES = ['riego', 'abono', 'tratamiento', 'revision', 'poda', 'trasplante', 'otro'];

// Al completar estos recordatorios se apunta en el diario de cuidados de la planta.
const CARE_FROM_REMINDER = {
  riego: 'riego',
  abono: 'abono',
  tratamiento: 'tratamiento',
  poda: 'poda',
  trasplante: 'trasplante',
  revision: 'revision',
};

export function logCare(userId, plantId, type, note = null) {
  db.prepare('INSERT INTO care_log (user_id, plant_id, type, note) VALUES (?, ?, ?, ?)').run(
    userId,
    plantId,
    type,
    note
  );
  if (type === 'riego') {
    db.prepare("UPDATE plants SET last_watered_at = datetime('now') WHERE id = ?").run(plantId);
    // Si hay un recordatorio de riego pendiente, se mueve a la próxima fecha.
    const pending = db
      .prepare("SELECT * FROM reminders WHERE plant_id = ? AND type = 'riego' AND done_at IS NULL")
      .get(plantId);
    if (pending?.repeat_days) {
      db.prepare('UPDATE reminders SET due_date = ? WHERE id = ?').run(addDays(today(), pending.repeat_days), pending.id);
    }
  }
}

export function completeReminder(userId, reminder) {
  if (reminder.type === 'riego' && reminder.plant_id) {
    // logCare reprograma el riego pendiente; aquí solo hay que registrarlo.
    logCare(userId, reminder.plant_id, 'riego', reminder.title);
    if (!reminder.repeat_days) {
      db.prepare("UPDATE reminders SET done_at = datetime('now') WHERE id = ?").run(reminder.id);
    }
    return;
  }

  db.prepare("UPDATE reminders SET done_at = datetime('now') WHERE id = ?").run(reminder.id);
  if (reminder.plant_id && CARE_FROM_REMINDER[reminder.type]) {
    logCare(userId, reminder.plant_id, CARE_FROM_REMINDER[reminder.type], reminder.title);
  }
  if (reminder.repeat_days) {
    db.prepare(
      'INSERT INTO reminders (user_id, plant_id, type, title, due_date, repeat_days) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, reminder.plant_id, reminder.type, reminder.title, addDays(today(), reminder.repeat_days), reminder.repeat_days);
  }
}

// Mantiene un único recordatorio de riego pendiente acorde a la frecuencia de la planta.
export function syncWateringReminder(userId, plant) {
  const pending = db
    .prepare("SELECT * FROM reminders WHERE plant_id = ? AND type = 'riego' AND done_at IS NULL")
    .get(plant.id);
  if (!plant.water_every_days) {
    if (pending) db.prepare('DELETE FROM reminders WHERE id = ?').run(pending.id);
    return;
  }
  const base = plant.last_watered_at ? plant.last_watered_at.slice(0, 10) : today();
  let due = addDays(base, plant.water_every_days);
  if (!plant.last_watered_at) due = today();
  const title = `Regar ${plant.name}`;
  if (pending) {
    db.prepare('UPDATE reminders SET repeat_days = ?, due_date = ?, title = ? WHERE id = ?').run(
      plant.water_every_days,
      due,
      title,
      pending.id
    );
  } else {
    db.prepare(
      "INSERT INTO reminders (user_id, plant_id, type, title, due_date, repeat_days) VALUES (?, ?, 'riego', ?, ?, ?)"
    ).run(userId, plant.id, title, due, plant.water_every_days);
  }
}
