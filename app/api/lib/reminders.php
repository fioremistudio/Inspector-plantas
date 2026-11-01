<?php
// Recordatorios y diario de cuidados.

declare(strict_types=1);

const REMINDER_TYPES = ['riego', 'abono', 'tratamiento', 'revision', 'poda', 'trasplante', 'otro'];
const CARE_TYPES = ['riego', 'abono', 'tratamiento', 'poda', 'trasplante', 'revision', 'nota'];

function log_care(int $userId, int $plantId, string $type, ?string $note = null): void
{
    q('INSERT INTO care_log (user_id, plant_id, type, note) VALUES (?, ?, ?, ?)', [$userId, $plantId, $type, $note]);
    if ($type === 'riego') {
        q("UPDATE plants SET last_watered_at = datetime('now') WHERE id = ?", [$plantId]);
        // El riego pendiente se mueve a la próxima fecha.
        $pending = row("SELECT * FROM reminders WHERE plant_id = ? AND type = 'riego' AND done_at IS NULL", [$plantId]);
        if ($pending && $pending['repeat_days']) {
            q('UPDATE reminders SET due_date = ? WHERE id = ?', [add_days(today(), (int) $pending['repeat_days']), $pending['id']]);
        }
    }
}

function complete_reminder(int $userId, array $r): void
{
    if ($r['type'] === 'riego' && $r['plant_id']) {
        log_care($userId, (int) $r['plant_id'], 'riego', $r['title']);
        if (!$r['repeat_days']) {
            q("UPDATE reminders SET done_at = datetime('now') WHERE id = ?", [$r['id']]);
        }
        return;
    }
    q("UPDATE reminders SET done_at = datetime('now') WHERE id = ?", [$r['id']]);
    if ($r['plant_id'] && in_array($r['type'], CARE_TYPES, true)) {
        log_care($userId, (int) $r['plant_id'], $r['type'], $r['title']);
    }
    if ($r['repeat_days']) {
        q('INSERT INTO reminders (user_id, plant_id, type, title, due_date, repeat_days) VALUES (?, ?, ?, ?, ?, ?)', [
            $userId, $r['plant_id'], $r['type'], $r['title'], add_days(today(), (int) $r['repeat_days']), $r['repeat_days'],
        ]);
    }
}

// Mantiene un único recordatorio de riego pendiente según la frecuencia de la planta.
function sync_watering_reminder(int $userId, array $plant): void
{
    $pending = row("SELECT * FROM reminders WHERE plant_id = ? AND type = 'riego' AND done_at IS NULL", [$plant['id']]);
    if (!$plant['water_every_days']) {
        if ($pending) {
            q('DELETE FROM reminders WHERE id = ?', [$pending['id']]);
        }
        return;
    }
    $every = (int) $plant['water_every_days'];
    $due = $plant['last_watered_at'] ? add_days(substr($plant['last_watered_at'], 0, 10), $every) : today();
    $title = 'Regar ' . $plant['name'];
    if ($pending) {
        q('UPDATE reminders SET repeat_days = ?, due_date = ?, title = ? WHERE id = ?', [$every, $due, $title, $pending['id']]);
    } else {
        q("INSERT INTO reminders (user_id, plant_id, type, title, due_date, repeat_days) VALUES (?, ?, 'riego', ?, ?, ?)", [
            $userId, $plant['id'], $title, $due, $every,
        ]);
    }
}
