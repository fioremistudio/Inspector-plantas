<?php
// Router para el servidor de desarrollo de PHP (emula el .htaccess).
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/(data|vendor|api/lib)(/|$)#', $path)) {
    http_response_code(403);
    return true;
}
if (str_starts_with($path, '/api/') || $path === '/api') {
    require (getenv('APP_DIR') ?: __DIR__ . '/../app') . '/api/index.php';
    return true;
}
return false;
