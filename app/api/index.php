<?php
// Punto de entrada de la API: /api/...

declare(strict_types=1);

ini_set('display_errors', '0');
date_default_timezone_set('UTC');

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('X-Frame-Options: DENY');
header('Cache-Control: no-store');

// Comprobación de requisitos del servidor, con mensajes claros.
if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Esta app necesita PHP 8.1 o superior. Cámbialo en hPanel → Avanzado → Configuración de PHP.']);
    exit;
}
foreach (['pdo_sqlite', 'curl', 'mbstring'] as $ext) {
    if (!extension_loaded($ext)) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => "Falta la extensión PHP \"$ext\". Actívala en hPanel → Avanzado → Configuración de PHP → Extensiones."]);
        exit;
    }
}

require dirname(__DIR__) . '/vendor/autoload.php';
require __DIR__ . '/lib/core.php';
require __DIR__ . '/lib/auth.php';
require __DIR__ . '/lib/ai.php';
require __DIR__ . '/lib/reminders.php';
require __DIR__ . '/lib/routes.php';

use Anthropic\Core\Exceptions\APIConnectionException;
use Anthropic\Core\Exceptions\APIException;
use Anthropic\Core\Exceptions\AuthenticationException;
use Anthropic\Core\Exceptions\PermissionDeniedException;
use Anthropic\Core\Exceptions\RateLimitException;

// Ruta solicitada, relativa a /api (funciona en la raíz o en una subcarpeta).
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$pos = strpos($uri, '/api/');
$path = $pos === false ? '/' : substr($uri, $pos + 4);
$path = '/' . trim($path, '/');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    // Las peticiones que cambian datos deben ser JSON (protección básica contra CSRF).
    if (in_array($method, ['POST', 'PATCH', 'PUT', 'DELETE'], true)) {
        $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        $type = $_SERVER['CONTENT_TYPE'] ?? '';
        if ($len > 0 && stripos($type, 'application/json') !== 0) {
            throw new HttpError(415, 'Formato no admitido.');
        }
    }

    foreach (routes() as [$m, $pattern, $handler]) {
        if (preg_match($pattern, $path, $matches)) {
            if ($m !== $method) {
                continue;
            }
            $handler(...array_slice($matches, 1));
        }
    }
    throw new HttpError(404, 'No encontrado.');
} catch (HttpError $e) {
    json_out(['error' => $e->getMessage()], $e->status);
} catch (AuthenticationException | PermissionDeniedException) {
    json_out(['error' => 'La clave de Anthropic no es válida o no tiene permisos. Revísala en el panel de administración.'], 502);
} catch (RateLimitException) {
    json_out(['error' => 'El servicio de IA está saturado o te has quedado sin saldo. Inténtalo en un minuto o revisa tu saldo en Anthropic.'], 503);
} catch (APIConnectionException) {
    json_out(['error' => 'No se pudo conectar con el servicio de IA. Inténtalo de nuevo.'], 503);
} catch (APIException $e) {
    error_log('[inspector] Anthropic: ' . $e->getMessage());
    $msg = str_contains($e->getMessage(), 'credit balance')
        ? 'Tu cuenta de Anthropic no tiene saldo. Añade crédito en console.anthropic.com → Billing.'
        : 'El servicio de IA devolvió un error. Inténtalo de nuevo.';
    json_out(['error' => $msg], 502);
} catch (Throwable $e) {
    error_log('[inspector] ' . $e);
    json_out(['error' => 'Ha ocurrido un error inesperado.'], 500);
}
