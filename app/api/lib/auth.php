<?php
// Cuentas, sesiones y permisos.

declare(strict_types=1);

const SESSION_COOKIE = 'ip_session';

function validate_password(mixed $p): ?string
{
    return (!is_string($p) || mb_strlen($p) < 8) ? 'La contraseña debe tener al menos 8 caracteres.' : null;
}

function validate_email(mixed $e): ?string
{
    return (!is_string($e) || !filter_var(trim($e), FILTER_VALIDATE_EMAIL)) ? 'Escribe un correo electrónico válido.' : null;
}

function create_user(array $b, string $role): int
{
    if ($err = validate_email($b['email'] ?? null)) {
        throw new HttpError(400, $err);
    }
    if ($err = validate_password($b['password'] ?? null)) {
        throw new HttpError(400, $err);
    }
    $name = clean_text($b['name'] ?? null, 80);
    if (!$name) {
        throw new HttpError(400, 'Escribe tu nombre.');
    }
    $email = strtolower(trim($b['email']));
    if (row('SELECT 1 FROM users WHERE email = ?', [$email])) {
        throw new HttpError(409, 'Ya existe una cuenta con ese correo.');
    }
    q('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)', [
        $email, $name, password_hash($b['password'], PASSWORD_DEFAULT), $role,
    ]);
    return insert_id();
}

function start_session(int $userId): void
{
    $token = bin2hex(random_bytes(32));
    $expires = time() + app_config()['session_days'] * 86400;
    q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [$token, $userId, gmdate('Y-m-d H:i:s', $expires)]);
    q("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [$userId]);
    setcookie(SESSION_COOKIE, $token, [
        'expires' => $expires,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => is_https(),
    ]);
}

function end_session(): void
{
    $token = $_COOKIE[SESSION_COOKIE] ?? null;
    if ($token) {
        q('DELETE FROM sessions WHERE token = ?', [$token]);
    }
    setcookie(SESSION_COOKIE, '', ['expires' => time() - 3600, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax', 'secure' => is_https()]);
}

function end_user_sessions(int $userId): void
{
    q('DELETE FROM sessions WHERE user_id = ?', [$userId]);
}

function current_user(): ?array
{
    static $loaded = false;
    static $user = null;
    if ($loaded) {
        return $user;
    }
    $loaded = true;
    $token = $_COOKIE[SESSION_COOKIE] ?? null;
    if (!is_string($token) || $token === '') {
        return null;
    }
    $r = row('SELECT u.id, u.email, u.name, u.role, u.active, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', [$token]);
    if ($r && $r['active'] && $r['expires_at'] > gmdate('Y-m-d H:i:s')) {
        $user = ['id' => (int) $r['id'], 'email' => $r['email'], 'name' => $r['name'], 'role' => $r['role']];
    } elseif ($r) {
        q('DELETE FROM sessions WHERE token = ?', [$token]);
    }
    return $user;
}

function require_user(): array
{
    $u = current_user();
    if (!$u) {
        throw new HttpError(401, 'Tienes que iniciar sesión.');
    }
    return $u;
}

function require_admin(): array
{
    $u = require_user();
    if ($u['role'] !== 'admin') {
        throw new HttpError(403, 'Solo para administradores.');
    }
    return $u;
}

// Máximo 20 intentos cada 15 minutos por IP.
function login_rate_limit(): void
{
    $ip = client_ip();
    $now = time();
    $r = row('SELECT * FROM login_attempts WHERE ip = ?', [$ip]);
    if (!$r || $now - (int) $r['since'] > 900) {
        q('INSERT INTO login_attempts (ip, count, since) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET count = 1, since = excluded.since', [$ip, $now]);
        return;
    }
    q('UPDATE login_attempts SET count = count + 1 WHERE ip = ?', [$ip]);
    if ((int) $r['count'] + 1 > 20) {
        throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
    }
}
