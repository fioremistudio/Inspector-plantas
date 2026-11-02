<?php
// Rutas de la API. Cada ruta: [método, patrón, función].

declare(strict_types=1);

function routes(): array
{
    return [
        // --- Acceso ---
        ['GET', '#^/auth/status$#', 'auth_status'],
        ['POST', '#^/auth/setup$#', 'auth_setup'],
        ['POST', '#^/auth/register$#', 'auth_register'],
        ['POST', '#^/auth/login$#', 'auth_login'],
        ['POST', '#^/auth/logout$#', 'auth_logout'],
        ['POST', '#^/auth/password$#', 'auth_password'],
        // --- Plantas ---
        ['GET', '#^/plants$#', 'plants_list'],
        ['POST', '#^/plants$#', 'plants_create'],
        ['GET', '#^/plants/(\d+)$#', 'plants_get'],
        ['PATCH', '#^/plants/(\d+)$#', 'plants_update'],
        ['DELETE', '#^/plants/(\d+)$#', 'plants_delete'],
        ['POST', '#^/plants/(\d+)/care$#', 'plants_add_care'],
        ['DELETE', '#^/plants/(\d+)/care/(\d+)$#', 'plants_delete_care'],
        // --- Diagnósticos ---
        ['GET', '#^/diagnoses$#', 'diagnoses_list'],
        ['POST', '#^/diagnoses$#', 'diagnoses_create'],
        ['GET', '#^/diagnoses/(\d+)$#', 'diagnoses_get'],
        ['PATCH', '#^/diagnoses/(\d+)$#', 'diagnoses_link'],
        ['DELETE', '#^/diagnoses/(\d+)$#', 'diagnoses_delete'],
        ['POST', '#^/diagnoses/(\d+)/apply$#', 'diagnoses_apply'],
        // --- Recordatorios ---
        ['GET', '#^/reminders$#', 'reminders_list'],
        ['POST', '#^/reminders$#', 'reminders_create'],
        ['POST', '#^/reminders/(\d+)/done$#', 'reminders_done'],
        ['POST', '#^/reminders/(\d+)/snooze$#', 'reminders_snooze'],
        ['DELETE', '#^/reminders/(\d+)$#', 'reminders_delete'],
        // --- Fotos ---
        ['GET', '#^/photos/([a-f0-9]{32}\.(?:jpg|png|webp|gif))$#', 'photo_get'],
        // --- Administración ---
        ['GET', '#^/admin/overview$#', 'admin_overview'],
        ['GET', '#^/admin/users$#', 'admin_users'],
        ['POST', '#^/admin/users$#', 'admin_create_user'],
        ['PATCH', '#^/admin/users/(\d+)$#', 'admin_update_user'],
        ['DELETE', '#^/admin/users/(\d+)$#', 'admin_delete_user'],
        ['PATCH', '#^/admin/settings$#', 'admin_settings'],
        ['POST', '#^/admin/test-key$#', 'admin_test_key'],
    ];
}

// ================= Acceso =================

function auth_status(): never
{
    json_out([
        'needsSetup' => (int) scalar('SELECT COUNT(*) FROM users') === 0,
        'allowRegistration' => get_setting('allow_registration', 'false') === 'true',
        'demoMode' => demo_mode(),
        'user' => current_user(),
        'dailyLimit' => daily_limit(),
    ]);
}

function auth_setup(): never
{
    if ((int) scalar('SELECT COUNT(*) FROM users') > 0) {
        throw new HttpError(403, 'La app ya está configurada.');
    }
    start_session(create_user(body(), 'admin'));
    json_out(['ok' => true], 201);
}

function auth_register(): never
{
    login_rate_limit();
    if (get_setting('allow_registration', 'false') !== 'true') {
        throw new HttpError(403, 'El registro está cerrado. Pide una cuenta al administrador.');
    }
    start_session(create_user(body(), 'user'));
    json_out(['ok' => true], 201);
}

function auth_login(): never
{
    login_rate_limit();
    $b = body();
    $email = is_string($b['email'] ?? null) ? strtolower(trim($b['email'])) : '';
    $user = $email ? row('SELECT * FROM users WHERE email = ?', [$email]) : null;
    if (!$user || !password_verify((string) ($b['password'] ?? ''), $user['password_hash'])) {
        throw new HttpError(401, 'Correo o contraseña incorrectos.');
    }
    if (!$user['active']) {
        throw new HttpError(403, 'Tu cuenta está desactivada. Contacta con el administrador.');
    }
    start_session((int) $user['id']);
    json_out(['ok' => true]);
}

function auth_logout(): never
{
    end_session();
    json_out(['ok' => true]);
}

function auth_password(): never
{
    $u = require_user();
    $b = body();
    $hash = scalar('SELECT password_hash FROM users WHERE id = ?', [$u['id']]);
    if (!password_verify((string) ($b['current'] ?? ''), (string) $hash)) {
        throw new HttpError(400, 'La contraseña actual no es correcta.');
    }
    if ($err = validate_password($b['next'] ?? null)) {
        throw new HttpError(400, $err);
    }
    q('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash($b['next'], PASSWORD_DEFAULT), $u['id']]);
    json_out(['ok' => true]);
}

// ================= Plantas =================

const PLANT_LIST_SQL = <<<SQL
  SELECT p.*,
         (SELECT health_score FROM diagnoses d WHERE d.plant_id = p.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS last_health,
         (SELECT status       FROM diagnoses d WHERE d.plant_id = p.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS last_status,
         (SELECT created_at   FROM diagnoses d WHERE d.plant_id = p.id ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS last_diagnosis_at,
         (SELECT COUNT(*)     FROM diagnoses d WHERE d.plant_id = p.id) AS diagnosis_count,
         (SELECT MIN(due_date) FROM reminders r WHERE r.plant_id = p.id AND r.done_at IS NULL) AS next_reminder
    FROM plants p
   WHERE p.user_id = ?
SQL;

function plants_list(): never
{
    $u = require_user();
    $archived = ($_GET['archived'] ?? '') === '1' ? 1 : 0;
    json_out(rows(PLANT_LIST_SQL . ' AND p.archived = ? ORDER BY p.name COLLATE NOCASE', [$u['id'], $archived]));
}

function read_plant_fields(array $b, bool $partial): array
{
    $f = [];
    if (!$partial || array_key_exists('name', $b)) {
        $f['name'] = clean_text($b['name'] ?? null, 80);
        if (!$f['name']) {
            throw new HttpError(400, 'Ponle un nombre a la planta.');
        }
    }
    foreach (['species', 'location'] as $k) {
        if (!$partial || array_key_exists($k, $b)) $f[$k] = clean_text($b[$k] ?? null, 120);
    }
    if (!$partial || array_key_exists('notes', $b)) $f['notes'] = clean_text($b['notes'] ?? null, 2000);
    if (!$partial || array_key_exists('water_every_days', $b)) $f['water_every_days'] = positive_int($b['water_every_days'] ?? null, 90);
    if (array_key_exists('archived', $b)) $f['archived'] = $b['archived'] ? 1 : 0;
    return $f;
}

function plants_create(): never
{
    $u = require_user();
    $b = body();
    $f = read_plant_fields($b, false);
    $photo = !empty($b['photo']) ? save_image($b['photo'])[0] : null;
    q('INSERT INTO plants (user_id, name, species, location, notes, water_every_days, photo) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        $u['id'], $f['name'], $f['species'], $f['location'], $f['notes'], $f['water_every_days'], $photo,
    ]);
    $plant = owned_plant($u['id'], insert_id());
    sync_watering_reminder($u['id'], $plant);
    json_out($plant, 201);
}

function plants_get(string $id): never
{
    $u = require_user();
    owned_plant($u['id'], $id);
    $plant = row(PLANT_LIST_SQL . ' AND p.id = ?', [$u['id'], (int) $id]);
    $diagnoses = array_map(function ($d) {
        $r = json_decode($d['result_json'], true);
        unset($d['result_json']);
        $d['resumen'] = $r['resumen'];
        $d['problemas'] = array_column($r['problemas'], 'nombre');
        return $d;
    }, rows('SELECT id, photo, symptoms, health_score, status, demo, created_at, result_json FROM diagnoses WHERE plant_id = ? ORDER BY created_at DESC, id DESC', [$plant['id']]));
    json_out([
        'plant' => $plant,
        'diagnoses' => $diagnoses,
        'care' => rows('SELECT * FROM care_log WHERE plant_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', [$plant['id']]),
        'reminders' => rows('SELECT * FROM reminders WHERE plant_id = ? AND done_at IS NULL ORDER BY due_date', [$plant['id']]),
    ]);
}

function plants_update(string $id): never
{
    $u = require_user();
    $plant = owned_plant($u['id'], $id);
    $b = body();
    $f = read_plant_fields($b, true);
    if (!empty($b['photo'])) {
        $f['photo'] = save_image($b['photo'])[0];
    }
    if ($f) {
        $sets = implode(', ', array_map(fn ($k) => "$k = ?", array_keys($f)));
        q("UPDATE plants SET $sets WHERE id = ?", [...array_values($f), $plant['id']]);
    }
    if (isset($f['photo']) && $plant['photo']) {
        delete_image($plant['photo']);
    }
    $updated = owned_plant($u['id'], $plant['id']);
    if (array_key_exists('water_every_days', $f) || array_key_exists('name', $f)) {
        sync_watering_reminder($u['id'], $updated);
    }
    json_out($updated);
}

function plants_delete(string $id): never
{
    $u = require_user();
    $plant = owned_plant($u['id'], $id);
    $photos = array_column(rows('SELECT photo FROM diagnoses WHERE plant_id = ?', [$plant['id']]), 'photo');
    q('DELETE FROM diagnoses WHERE plant_id = ?', [$plant['id']]);
    q('DELETE FROM plants WHERE id = ?', [$plant['id']]);
    foreach ([...$photos, $plant['photo']] as $p) {
        delete_image($p);
    }
    json_out(['ok' => true]);
}

function plants_add_care(string $id): never
{
    $u = require_user();
    $plant = owned_plant($u['id'], $id);
    $type = (string) (body()['type'] ?? '');
    if (!in_array($type, CARE_TYPES, true)) {
        throw new HttpError(400, 'Tipo de cuidado no válido.');
    }
    log_care($u['id'], (int) $plant['id'], $type, clean_text(body()['note'] ?? null, 1000));
    json_out(['ok' => true], 201);
}

function plants_delete_care(string $id, string $careId): never
{
    $u = require_user();
    $plant = owned_plant($u['id'], $id);
    q('DELETE FROM care_log WHERE id = ? AND plant_id = ?', [(int) $careId, $plant['id']]);
    json_out(['ok' => true]);
}

// ================= Diagnósticos =================

function get_diagnosis(int $userId, mixed $id): array
{
    $r = row('SELECT d.*, p.name AS plant_name FROM diagnoses d LEFT JOIN plants p ON p.id = d.plant_id WHERE d.id = ? AND d.user_id = ?', [(int) $id, $userId]);
    if (!$r) {
        throw new HttpError(404, 'No se encontró el diagnóstico.');
    }
    $r['result'] = json_decode($r['result_json'], true);
    unset($r['result_json'], $r['input_tokens'], $r['output_tokens'], $r['cost_usd']);
    return $r;
}

function check_daily_limit(array $u): void
{
    $limit = daily_limit();
    if ($u['role'] === 'admin' || $limit === 0) {
        return;
    }
    $n = (int) scalar("SELECT COUNT(*) FROM diagnoses WHERE user_id = ? AND created_at >= datetime('now', '-1 day')", [$u['id']]);
    if ($n >= $limit) {
        throw new HttpError(429, "Has llegado al límite de $limit análisis por día. Vuelve mañana.");
    }
}

function diagnoses_create(): never
{
    $u = require_user();
    check_daily_limit($u);
    $b = body();
    $plant = !empty($b['plant_id']) ? owned_plant($u['id'], $b['plant_id']) : null;
    $symptoms = clean_text($b['symptoms'] ?? null, 2000);
    [$file, $mediaType, $base64] = save_image($b['photo'] ?? null);

    $previous = null;
    if ($plant) {
        $prev = row('SELECT result_json, created_at FROM diagnoses WHERE plant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [$plant['id']]);
        if ($prev) {
            $previous = ['date' => $prev['created_at'], 'result' => json_decode($prev['result_json'], true)];
        }
    }

    try {
        $a = analyze_plant($base64, $mediaType, $plant, $symptoms, $previous);
    } catch (Throwable $e) {
        delete_image($file);
        throw $e;
    }
    $result = $a['result'];

    $id = transaction(function () use ($u, $b, &$plant, $file, $symptoms, $a, $result) {
        $newName = clean_text($b['new_plant_name'] ?? null, 80);
        if (!$newName && !empty($b['new_plant'])) {
            $newName = mb_substr($result['planta_identificada']['nombre_comun'], 0, 80);
        }
        if (!$plant && $newName && $result['es_planta']) {
            q('INSERT INTO plants (user_id, name, species, photo, water_every_days) VALUES (?, ?, ?, ?, ?)', [
                $u['id'], $newName, $result['planta_identificada']['nombre_comun'], $file, $result['riego_cada_dias'],
            ]);
            $plant = owned_plant($u['id'], insert_id());
            sync_watering_reminder($u['id'], $plant);
        }
        q('INSERT INTO diagnoses (user_id, plant_id, photo, symptoms, result_json, health_score, status, model, demo, input_tokens, output_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
            $u['id'], $plant['id'] ?? null, $file, $symptoms,
            json_encode($result, JSON_UNESCAPED_UNICODE),
            $result['es_planta'] ? $result['puntuacion_salud'] : null,
            $result['es_planta'] ? $result['estado_general'] : null,
            $a['model'], $a['demo'] ? 1 : 0, $a['input_tokens'], $a['output_tokens'],
            $a['demo'] ? 0 : estimate_cost($a['model'], $a['input_tokens'], $a['output_tokens']),
        ]);
        $id = insert_id();
        if ($plant) {
            q('UPDATE plants SET photo = ? WHERE id = ?', [$file, $plant['id']]);
        }
        return $id;
    });

    json_out(get_diagnosis($u['id'], $id), 201);
}

function diagnoses_list(): never
{
    $u = require_user();
    $list = array_map(function ($d) {
        $r = json_decode($d['result_json'], true);
        unset($d['result_json']);
        $d['species'] = $r['planta_identificada']['nombre_comun'];
        $d['resumen'] = $r['resumen'];
        return $d;
    }, rows('SELECT d.id, d.plant_id, d.photo, d.health_score, d.status, d.demo, d.created_at, d.result_json, p.name AS plant_name
               FROM diagnoses d LEFT JOIN plants p ON p.id = d.plant_id
              WHERE d.user_id = ? ORDER BY d.created_at DESC, d.id DESC LIMIT 200', [$u['id']]));
    json_out($list);
}

function diagnoses_get(string $id): never
{
    $u = require_user();
    json_out(get_diagnosis($u['id'], $id));
}

// Guardar un análisis suelto en una planta existente o nueva.
function diagnoses_link(string $id): never
{
    $u = require_user();
    $d = get_diagnosis($u['id'], $id);
    if (!$d['result']['es_planta']) {
        throw new HttpError(400, 'Esta foto no muestra una planta.');
    }
    $b = body();
    transaction(function () use ($u, $d, $b) {
        if (!empty($b['new_plant'])) {
            $name = clean_text($b['name'] ?? null, 80) ?: mb_substr($d['result']['planta_identificada']['nombre_comun'], 0, 80);
            q('INSERT INTO plants (user_id, name, species, photo, water_every_days) VALUES (?, ?, ?, ?, ?)', [
                $u['id'], $name, $d['result']['planta_identificada']['nombre_comun'], $d['photo'], $d['result']['riego_cada_dias'],
            ]);
            $plant = owned_plant($u['id'], insert_id());
            sync_watering_reminder($u['id'], $plant);
        } else {
            $plant = owned_plant($u['id'], $b['plant_id'] ?? 0);
            if (!$plant['photo']) {
                q('UPDATE plants SET photo = ? WHERE id = ?', [$d['photo'], $plant['id']]);
            }
        }
        q('UPDATE diagnoses SET plant_id = ? WHERE id = ?', [$plant['id'], $d['id']]);
    });
    json_out(get_diagnosis($u['id'], $d['id']));
}

function diagnoses_delete(string $id): never
{
    $u = require_user();
    $d = get_diagnosis($u['id'], $id);
    q('DELETE FROM diagnoses WHERE id = ?', [$d['id']]);
    delete_image($d['photo']);
    json_out(['ok' => true]);
}

// Activa los recordatorios sugeridos que el usuario eligió.
function diagnoses_apply(string $id): never
{
    $u = require_user();
    $d = get_diagnosis($u['id'], $id);
    if (!$d['plant_id']) {
        throw new HttpError(400, 'Primero guarda este diagnóstico en una planta.');
    }
    $plant = owned_plant($u['id'], $d['plant_id']);
    $b = body();
    $indexes = is_array($b['reminders'] ?? null) ? array_map('intval', $b['reminders']) : [];
    $created = 0;
    transaction(function () use ($u, $d, $plant, $b, $indexes, &$created) {
        foreach ($indexes as $i) {
            $s = $d['result']['recordatorios_sugeridos'][$i] ?? null;
            if (!$s) continue;
            if ($s['tipo'] === 'riego' && $s['repetir_cada_dias']) {
                q('UPDATE plants SET water_every_days = ? WHERE id = ?', [$s['repetir_cada_dias'], $plant['id']]);
                sync_watering_reminder($u['id'], owned_plant($u['id'], $plant['id']));
            } else {
                q('INSERT INTO reminders (user_id, plant_id, type, title, due_date, repeat_days) VALUES (?, ?, ?, ?, ?, ?)', [
                    $u['id'], $plant['id'], in_array($s['tipo'], REMINDER_TYPES, true) ? $s['tipo'] : 'otro',
                    mb_substr($s['titulo'], 0, 200), add_days(today(), (int) $s['en_dias']), $s['repetir_cada_dias'],
                ]);
            }
            $created++;
        }
        if (!empty($b['apply_watering']) && $d['result']['riego_cada_dias']) {
            q('UPDATE plants SET water_every_days = ? WHERE id = ?', [$d['result']['riego_cada_dias'], $plant['id']]);
            sync_watering_reminder($u['id'], owned_plant($u['id'], $plant['id']));
        }
    });
    json_out(['ok' => true, 'created' => $created]);
}

// ================= Recordatorios =================

function owned_reminder(int $userId, mixed $id): array
{
    $r = row('SELECT * FROM reminders WHERE id = ? AND user_id = ?', [(int) $id, $userId]);
    if (!$r) {
        throw new HttpError(404, 'No se encontró el recordatorio.');
    }
    return $r;
}

function reminders_list(): never
{
    $u = require_user();
    json_out([
        'today' => today(),
        'reminders' => rows('SELECT r.*, p.name AS plant_name, p.photo AS plant_photo
                               FROM reminders r LEFT JOIN plants p ON p.id = r.plant_id
                              WHERE r.user_id = ? AND r.done_at IS NULL AND (p.id IS NULL OR p.archived = 0)
                              ORDER BY r.due_date, r.id', [$u['id']]),
    ]);
}

function reminders_create(): never
{
    $u = require_user();
    $b = body();
    $title = clean_text($b['title'] ?? null, 200);
    if (!$title) {
        throw new HttpError(400, 'Escribe qué hay que hacer.');
    }
    $plantId = !empty($b['plant_id']) ? owned_plant($u['id'], $b['plant_id'])['id'] : null;
    $type = in_array($b['type'] ?? '', REMINDER_TYPES, true) ? $b['type'] : 'otro';
    $due = is_date($b['due_date'] ?? null) ? $b['due_date'] : today();
    q('INSERT INTO reminders (user_id, plant_id, type, title, due_date, repeat_days) VALUES (?, ?, ?, ?, ?, ?)', [
        $u['id'], $plantId, $type, $title, $due, positive_int($b['repeat_days'] ?? null),
    ]);
    json_out(owned_reminder($u['id'], insert_id()), 201);
}

function reminders_done(string $id): never
{
    $u = require_user();
    $r = owned_reminder($u['id'], $id);
    if ($r['done_at']) {
        throw new HttpError(400, 'Este recordatorio ya estaba hecho.');
    }
    complete_reminder($u['id'], $r);
    json_out(['ok' => true]);
}

function reminders_snooze(string $id): never
{
    $u = require_user();
    $r = owned_reminder($u['id'], $id);
    $days = positive_int(body()['days'] ?? null, 30) ?? 1;
    q('UPDATE reminders SET due_date = ? WHERE id = ?', [add_days(today(), $days), $r['id']]);
    json_out(['ok' => true]);
}

function reminders_delete(string $id): never
{
    $u = require_user();
    $r = owned_reminder($u['id'], $id);
    q('DELETE FROM reminders WHERE id = ?', [$r['id']]);
    if ($r['type'] === 'riego' && $r['plant_id']) {
        q('UPDATE plants SET water_every_days = NULL WHERE id = ?', [$r['plant_id']]);
    }
    json_out(['ok' => true]);
}

// ================= Fotos =================

function photo_get(string $name): never
{
    $u = require_user();
    $owned = row('SELECT 1 FROM plants WHERE photo = ? AND user_id = ? UNION SELECT 1 FROM diagnoses WHERE photo = ? AND user_id = ?', [$name, $u['id'], $name, $u['id']]);
    $file = uploads_dir() . '/' . $name;
    if (!$owned || !is_file($file)) {
        throw new HttpError(404, 'No encontrado.');
    }
    $types = array_flip(IMAGE_TYPES);
    header('Content-Type: ' . $types[pathinfo($name, PATHINFO_EXTENSION)]);
    header('Content-Length: ' . filesize($file));
    header('Cache-Control: private, max-age=31536000, immutable');
    readfile($file);
    exit;
}

// ================= Administración =================

function mask_key(string $k): string
{
    return $k === '' ? '' : substr($k, 0, 7) . '…' . substr($k, -4);
}

function admin_overview(): never
{
    require_admin();
    $month = gmdate('Y-m-01 00:00:00');
    json_out([
        'stats' => [
            'users' => (int) scalar('SELECT COUNT(*) FROM users'),
            'plants' => (int) scalar('SELECT COUNT(*) FROM plants'),
            'diagnoses' => (int) scalar('SELECT COUNT(*) FROM diagnoses'),
            'diagnosesToday' => (int) scalar("SELECT COUNT(*) FROM diagnoses WHERE created_at >= datetime('now', '-1 day')"),
            'diagnosesMonth' => (int) scalar('SELECT COUNT(*) FROM diagnoses WHERE created_at >= ? AND demo = 0', [$month]),
            'costMonth' => round((float) scalar('SELECT COALESCE(SUM(cost_usd), 0) FROM diagnoses WHERE created_at >= ?', [$month]), 4),
            'costTotal' => round((float) scalar('SELECT COALESCE(SUM(cost_usd), 0) FROM diagnoses'), 4),
        ],
        'settings' => [
            'allowRegistration' => get_setting('allow_registration', 'false') === 'true',
            'provider' => ai_provider(),
            'apiKeyMasked' => mask_key(api_key()),
            'apiKeyLocked' => api_key_locked(),
            'model' => current_model(),
            'geminiKeyMasked' => mask_key(gemini_api_key()),
            'geminiKeyLocked' => gemini_key_locked(),
            'geminiModel' => gemini_api_key() !== '' ? gemini_model() : null,
            'dailyLimit' => daily_limit(),
        ],
        'models' => array_map(fn ($id, $m) => ['id' => $id, 'label' => $m['label']], array_keys(MODELS), MODELS),
        'system' => ['demoMode' => demo_mode(), 'provider' => ai_provider(), 'model' => active_model(), 'dailyLimit' => daily_limit()],
    ]);
}

function admin_users(): never
{
    require_admin();
    $month = gmdate('Y-m-01 00:00:00');
    json_out(rows('SELECT u.id, u.email, u.name, u.role, u.active, u.created_at, u.last_login_at,
                          (SELECT COUNT(*) FROM plants p WHERE p.user_id = u.id) AS plants,
                          (SELECT COUNT(*) FROM diagnoses d WHERE d.user_id = u.id) AS diagnoses,
                          (SELECT COALESCE(SUM(cost_usd), 0) FROM diagnoses d WHERE d.user_id = u.id AND d.created_at >= ?) AS cost_month
                     FROM users u ORDER BY u.created_at DESC', [$month]));
}

function admin_create_user(): never
{
    require_admin();
    $b = body();
    $id = create_user($b, ($b['role'] ?? '') === 'admin' ? 'admin' : 'user');
    json_out(['id' => $id], 201);
}

function active_admins(): int
{
    return (int) scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1");
}

function admin_update_user(string $id): never
{
    $me = require_admin();
    $user = row('SELECT * FROM users WHERE id = ?', [(int) $id]);
    if (!$user) {
        throw new HttpError(404, 'Usuario no encontrado.');
    }
    $b = body();
    $up = [];
    if (array_key_exists('name', $b)) {
        $up['name'] = clean_text($b['name'], 80);
        if (!$up['name']) throw new HttpError(400, 'El nombre no puede estar vacío.');
    }
    if (array_key_exists('role', $b)) $up['role'] = $b['role'] === 'admin' ? 'admin' : 'user';
    if (array_key_exists('active', $b)) $up['active'] = $b['active'] ? 1 : 0;
    if (!empty($b['password'])) {
        if ($err = validate_password($b['password'])) throw new HttpError(400, $err);
        $up['password_hash'] = password_hash($b['password'], PASSWORD_DEFAULT);
    }
    $losesAdmin = $user['role'] === 'admin' && $user['active'] && (($up['role'] ?? null) === 'user' || ($up['active'] ?? null) === 0);
    if ($losesAdmin && active_admins() <= 1) {
        throw new HttpError(400, 'Debe quedar al menos un administrador activo.');
    }
    if ($up) {
        $sets = implode(', ', array_map(fn ($k) => "$k = ?", array_keys($up)));
        q("UPDATE users SET $sets WHERE id = ?", [...array_values($up), $user['id']]);
    }
    if ((($up['active'] ?? 1) === 0 || isset($up['password_hash'])) && (int) $user['id'] !== $me['id']) {
        end_user_sessions((int) $user['id']);
    }
    json_out(['ok' => true]);
}

function admin_delete_user(string $id): never
{
    $me = require_admin();
    $user = row('SELECT * FROM users WHERE id = ?', [(int) $id]);
    if (!$user) throw new HttpError(404, 'Usuario no encontrado.');
    if ((int) $user['id'] === $me['id']) throw new HttpError(400, 'No puedes borrar tu propia cuenta.');
    if ($user['role'] === 'admin' && $user['active'] && active_admins() <= 1) {
        throw new HttpError(400, 'Debe quedar al menos un administrador activo.');
    }
    $photos = array_column(rows('SELECT photo FROM plants WHERE user_id = ? UNION SELECT photo FROM diagnoses WHERE user_id = ?', [$user['id'], $user['id']]), 'photo');
    q('DELETE FROM users WHERE id = ?', [$user['id']]);
    foreach ($photos as $p) delete_image($p);
    json_out(['ok' => true]);
}

function admin_settings(): never
{
    require_admin();
    $b = body();
    if (array_key_exists('allowRegistration', $b)) {
        set_setting('allow_registration', $b['allowRegistration'] ? 'true' : 'false');
    }
    if (array_key_exists('model', $b)) {
        if (!isset(MODELS[$b['model']])) throw new HttpError(400, 'Modelo no válido.');
        set_setting('model', $b['model']);
    }
    if (array_key_exists('dailyLimit', $b)) {
        set_setting('daily_limit', (string) max(0, min(1000, (int) $b['dailyLimit'])));
    }
    if (array_key_exists('provider', $b)) {
        if (!in_array($b['provider'], PROVIDERS, true)) throw new HttpError(400, 'Proveedor de IA no válido.');
        set_setting('ai_provider', $b['provider']);
    }
    if (array_key_exists('geminiKey', $b)) {
        $key = trim((string) $b['geminiKey']);
        // Google usa claves "AIza…" y también el formato nuevo "AQ.…" (con punto).
        if ($key !== '' && !preg_match('/^[A-Za-z0-9_.\-]{20,}$/', $key)) {
            throw new HttpError(400, 'Esa clave de Gemini no parece válida. Cópiala completa desde Google AI Studio.');
        }
        if ($key !== '') {
            set_setting('gemini_model', gemini_pick_model($key));
        }
        set_setting('gemini_api_key', $key);
    }
    if (array_key_exists('apiKey', $b)) {
        $key = trim((string) $b['apiKey']);
        if ($key !== '' && !preg_match('/^sk-ant-[A-Za-z0-9_\-]{20,}$/', $key)) {
            throw new HttpError(400, 'Esa clave no parece válida. Debe empezar por "sk-ant-".');
        }
        if ($key !== '') {
            test_api_key($key);
        }
        set_setting('anthropic_api_key', $key);
    }
    json_out(['ok' => true]);
}

function admin_test_key(): never
{
    require_admin();
    if (demo_mode()) throw new HttpError(400, 'Todavía no has guardado la clave de la IA elegida.');
    if (ai_provider() === 'gemini') {
        set_setting('gemini_model', gemini_pick_model(gemini_api_key()));
    } else {
        test_api_key(api_key());
    }
    json_out(['ok' => true]);
}
