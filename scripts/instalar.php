<?php
// Instalador de Fioremi Inspector.
// Sube este archivo y el .zip a la misma carpeta y abre /instalar.php en el navegador.
// Descomprime la app, borra el .zip y se borra a sí mismo.

declare(strict_types=1);
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');

$dir = __DIR__;
$errors = [];
$done = false;

if (PHP_VERSION_ID < 80100) {
    $errors[] = 'La versión de PHP es ' . PHP_VERSION . '. Necesitas PHP 8.1 o superior: cámbiala en hPanel → Avanzado → Configuración de PHP y vuelve a cargar esta página.';
}
foreach (['zip' => 'zip', 'pdo_sqlite' => 'pdo_sqlite', 'curl' => 'curl', 'mbstring' => 'mbstring'] as $ext => $label) {
    if (!extension_loaded($ext)) {
        $errors[] = "Falta la extensión PHP «{$label}». Actívala en hPanel → Avanzado → Configuración de PHP → Extensiones de PHP y vuelve a cargar esta página.";
    }
}

// Busca el zip de la app (aunque el navegador lo haya renombrado, p. ej. «inspector-plantas (1).zip»).
$zipPath = null;
if (!$errors) {
    foreach (glob($dir . '/*.zip') ?: [] as $candidate) {
        $z = new ZipArchive();
        if ($z->open($candidate) === true) {
            $ok = $z->locateName('api/index.php') !== false && $z->locateName('index.html') !== false;
            $z->close();
            if ($ok) {
                $zipPath = $candidate;
                break;
            }
        }
    }
    if (!$zipPath) {
        $errors[] = 'No encuentro el archivo «inspector-plantas.zip» en esta carpeta. Súbelo (sin descomprimir) junto a este instalador y vuelve a cargar la página.';
    }
}

if (!$errors && $zipPath) {
    $z = new ZipArchive();
    if ($z->open($zipPath) !== true || !$z->extractTo($dir)) {
        $errors[] = 'No se pudo descomprimir el archivo. Comprueba que hay espacio libre en el hosting.';
    } else {
        $z->close();
        // Limpieza: el zip, la página de muestra de Hostinger y este instalador.
        @unlink($zipPath);
        foreach (['default.php', 'default.html'] as $placeholder) {
            if (is_file("$dir/$placeholder")) {
                @unlink("$dir/$placeholder");
            }
        }
        $done = true;
    }
}

$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$base = rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/') . '/';
$url = $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . $base;
?>
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Instalar Fioremi Inspector</title>
  <style>
    body { font: 17px/1.5 system-ui, sans-serif; background: #f6f4ec; color: #1f2a1f; margin: 0; padding: 24px; }
    .card { max-width: 560px; margin: 8vh auto; background: #fff; border-radius: 18px; padding: 28px; box-shadow: 0 4px 20px rgba(0,0,0,.08); }
    h1 { margin-top: 0; }
    .ok { color: #2f6b3f; }
    li { margin-bottom: 10px; }
    a.btn { display: inline-block; background: #2f6b3f; color: #fff; padding: 12px 22px; border-radius: 12px; text-decoration: none; font-weight: 600; }
    .warn { background: #fbf0d4; padding: 12px 14px; border-radius: 12px; }
  </style>
</head>
<body>
  <div class="card">
  <?php if ($done): ?>
    <h1 class="ok">🌿 ¡Instalación completada!</h1>
    <p>La app ya está en su sitio. Ahora:</p>
    <ol>
      <li>Abre la app y crea tu <b>cuenta de administración</b>.</li>
      <li>Ve a <b>Mi cuenta → Panel de administración</b> y pega tu clave de Anthropic.</li>
    </ol>
    <?php if ($scheme !== 'https'): ?>
      <p class="warn">⚠️ Estás entrando sin HTTPS. Activa el certificado SSL gratuito en hPanel → Seguridad → SSL para que funcione la cámara.</p>
    <?php endif; ?>
    <p><a class="btn" href="<?= htmlspecialchars($url) ?>">Abrir Fioremi Inspector</a></p>
  <?php else: ?>
    <h1>No se pudo instalar todavía</h1>
    <ul>
      <?php foreach ($errors as $e): ?><li><?= htmlspecialchars($e) ?></li><?php endforeach; ?>
    </ul>
    <p>Cuando lo arregles, vuelve a cargar esta página.</p>
  <?php endif; ?>
  </div>
</body>
</html>
<?php
if ($done) {
    @unlink(__FILE__);
}
