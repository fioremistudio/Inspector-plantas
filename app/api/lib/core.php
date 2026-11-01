<?php
// Núcleo: configuración, base de datos, utilidades HTTP.

declare(strict_types=1);

final class HttpError extends Exception
{
    public function __construct(public int $status, string $message)
    {
        parent::__construct($message);
    }
}

function app_config(): array
{
    static $config = null;
    if ($config !== null) {
        return $config;
    }
    $root = dirname(__DIR__, 2);
    $config = [
        'data_dir' => getenv('DATA_DIR') ?: $root . '/data',
        'anthropic_api_key' => getenv('ANTHROPIC_API_KEY') ?: '',
        'model' => getenv('ANTHROPIC_MODEL') ?: '',
        'daily_limit' => getenv('DAILY_DIAGNOSIS_LIMIT'),
        'session_days' => 30,
    ];
    // config.php (opcional) permite fijar valores sin usar el panel.
    $file = dirname(__DIR__) . '/config.php';
    if (is_file($file)) {
        $override = require $file;
        if (is_array($override)) {
            $config = array_merge($config, array_filter($override, fn ($v) => $v !== null && $v !== ''));
        }
    }
    return $config;
}

function data_dir(): string
{
    $dir = app_config()['data_dir'];
    if (!is_dir($dir . '/uploads')) {
        mkdir($dir . '/uploads', 0750, true);
    }
    // Protección por si la carpeta queda dentro de la web.
    if (!is_file($dir . '/.htaccess')) {
        file_put_contents($dir . '/.htaccess', "Require all denied\nDeny from all\n");
    }
    if (!is_file($dir . '/index.html')) {
        file_put_contents($dir . '/index.html', '');
    }
    return $dir;
}

function uploads_dir(): string
{
    return data_dir() . '/uploads';
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $pdo = new PDO('sqlite:' . data_dir() . '/inspector.db', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $pdo): void
{
    $pdo->exec(<<<SQL
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip    TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      since INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plants (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      species          TEXT,
      location         TEXT,
      notes            TEXT,
      photo            TEXT,
      water_every_days INTEGER,
      last_watered_at  TEXT,
      archived         INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS diagnoses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plant_id      INTEGER REFERENCES plants(id) ON DELETE SET NULL,
      photo         TEXT NOT NULL,
      symptoms      TEXT,
      result_json   TEXT NOT NULL,
      health_score  INTEGER,
      status        TEXT,
      model         TEXT,
      demo          INTEGER NOT NULL DEFAULT 0,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plant_id    INTEGER REFERENCES plants(id) ON DELETE CASCADE,
      type        TEXT NOT NULL DEFAULT 'otro',
      title       TEXT NOT NULL,
      due_date    TEXT NOT NULL,
      repeat_days INTEGER,
      done_at     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS care_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plant_id   INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_plants_user    ON plants(user_id);
    CREATE INDEX IF NOT EXISTS idx_diag_plant     ON diagnoses(plant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_diag_user      ON diagnoses(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id, done_at, due_date);
    CREATE INDEX IF NOT EXISTS idx_care_plant     ON care_log(plant_id, created_at);
    SQL);
}

// --- Consultas cortas ---

function q(string $sql, array $params = []): PDOStatement
{
    $stmt = db()->prepare($sql);
    $stmt->execute($params);
    return $stmt;
}

function row(string $sql, array $params = []): ?array
{
    $r = q($sql, $params)->fetch();
    return $r === false ? null : $r;
}

function rows(string $sql, array $params = []): array
{
    return q($sql, $params)->fetchAll();
}

function scalar(string $sql, array $params = []): mixed
{
    return q($sql, $params)->fetchColumn();
}

function insert_id(): int
{
    return (int) db()->lastInsertId();
}

function transaction(callable $fn): mixed
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $result = $fn();
        $pdo->commit();
        return $result;
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

function get_setting(string $key, ?string $default = null): ?string
{
    $v = scalar('SELECT value FROM settings WHERE key = ?', [$key]);
    return $v === false ? $default : (string) $v;
}

function set_setting(string $key, string $value): void
{
    q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [$key, $value]);
}

// --- Ajustes efectivos (config.php / variables de entorno tienen prioridad sobre el panel) ---

const MODELS = [
    'claude-opus-5-5' => ['label' => 'Claude Opus 5.5 (máxima precisión)', 'in' => 4.0, 'out' => 20.0],
    'claude-sonnet-5-5' => ['label' => 'Claude Sonnet 5.5 (más económico)', 'in' => 2.0, 'out' => 10.0],
];

function api_key(): string
{
    return app_config()['anthropic_api_key'] ?: (get_setting('anthropic_api_key') ?? '');
}

function api_key_locked(): bool
{
    return app_config()['anthropic_api_key'] !== '';
}

function current_model(): string
{
    $m = app_config()['model'] ?: (get_setting('model') ?? 'claude-opus-5-5');
    return $m ?: 'claude-opus-5-5';
}

function daily_limit(): int
{
    $c = app_config()['daily_limit'];
    if ($c !== null && $c !== false && $c !== '') {
        return max(0, (int) $c);
    }
    return max(0, (int) (get_setting('daily_limit') ?? '20'));
}

function demo_mode(): bool
{
    return api_key() === '';
}

function estimate_cost(string $model, int $in, int $out): float
{
    $p = MODELS[$model] ?? MODELS['claude-opus-5-5'];
    return round(($in * $p['in'] + $out * $p['out']) / 1_000_000, 6);
}

// --- HTTP ---

function json_out(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function body(): array
{
    static $body = null;
    if ($body !== null) {
        return $body;
    }
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return $body = [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new HttpError(400, 'Petición no válida.');
    }
    return $body = $data;
}

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || (($_SERVER['SERVER_PORT'] ?? '') === '443');
}

function client_ip(): string
{
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

// --- Validación ---

function clean_text(mixed $value, int $max = 500): ?string
{
    if ($value === null || is_array($value)) {
        return null;
    }
    $s = trim(mb_substr((string) $value, 0, $max));
    return $s === '' ? null : $s;
}

function positive_int(mixed $value, int $max = 365): ?int
{
    if ($value === null || $value === '' || is_array($value) || !is_numeric($value)) {
        return null;
    }
    $n = (int) round((float) $value);
    return $n <= 0 ? null : min($n, $max);
}

function is_date(mixed $v): bool
{
    return is_string($v) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) === 1 && strtotime($v) !== false;
}

function today(): string
{
    return gmdate('Y-m-d');
}

function add_days(string $date, int $days): string
{
    return gmdate('Y-m-d', strtotime($date . ' 12:00:00 UTC') + $days * 86400);
}

// --- Imágenes ---

const IMAGE_TYPES = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Guarda un data URL en disco. Devuelve [filename, mediaType, base64]. */
function save_image(mixed $dataUrl): array
{
    if (!is_string($dataUrl) || !preg_match('#^data:(image/[a-z]+);base64,([A-Za-z0-9+/=]+)$#', $dataUrl, $m) || !isset(IMAGE_TYPES[$m[1]])) {
        throw new HttpError(400, 'La imagen no es válida. Usa una foto JPG, PNG o WEBP.');
    }
    $bytes = base64_decode($m[2], true);
    if ($bytes === false) {
        throw new HttpError(400, 'La imagen no es válida.');
    }
    if (strlen($bytes) > MAX_IMAGE_BYTES) {
        throw new HttpError(413, 'La foto es demasiado grande (máximo 5 MB).');
    }
    $name = bin2hex(random_bytes(16)) . '.' . IMAGE_TYPES[$m[1]];
    file_put_contents(uploads_dir() . '/' . $name, $bytes);
    return [$name, $m[1], $m[2]];
}

function valid_photo_name(?string $name): bool
{
    return is_string($name) && preg_match('/^[a-f0-9]{32}\.(jpg|png|webp|gif)$/', $name) === 1;
}

function delete_image(?string $name): void
{
    if (!valid_photo_name($name)) {
        return;
    }
    $used = row('SELECT 1 FROM plants WHERE photo = ? UNION SELECT 1 FROM diagnoses WHERE photo = ?', [$name, $name]);
    if ($used) {
        return;
    }
    @unlink(uploads_dir() . '/' . $name);
}

function owned_plant(int $userId, mixed $plantId): array
{
    $p = row('SELECT * FROM plants WHERE id = ? AND user_id = ?', [(int) $plantId, $userId]);
    if (!$p) {
        throw new HttpError(404, 'No se encontró la planta.');
    }
    return $p;
}
