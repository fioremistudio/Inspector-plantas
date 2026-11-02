<?php
// Directorio de plantas ("memoria"): fichas de especies con cuidados verificables.
// La IA identifica la planta y su estado; los cuidados generales salen de la ficha.

declare(strict_types=1);

const SPECIES_TEXT_FIELDS = ['nombre_comun', 'nombre_cientifico', 'familia', 'origen', 'descripcion', 'riego', 'luz', 'humedad', 'temperatura', 'abono', 'sustrato', 'toxicidad'];
const DIFFICULTIES = ['facil', 'media', 'dificil'];

function species_migrate(PDO $pdo): void
{
    $pdo->exec(<<<SQL
    CREATE TABLE IF NOT EXISTS species (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre_comun      TEXT NOT NULL,
      nombre_cientifico TEXT,
      familia           TEXT,
      otros_nombres     TEXT NOT NULL DEFAULT '[]',
      origen            TEXT,
      dificultad        TEXT,
      descripcion       TEXT,
      riego             TEXT,
      riego_cada_dias   INTEGER,
      luz               TEXT,
      humedad           TEXT,
      temperatura       TEXT,
      abono             TEXT,
      sustrato          TEXT,
      toxica_mascotas   INTEGER,
      toxicidad         TEXT,
      problemas_comunes TEXT NOT NULL DEFAULT '[]',
      claves            TEXT NOT NULL DEFAULT '',
      fuente            TEXT NOT NULL DEFAULT 'ficha',
      verificada        INTEGER NOT NULL DEFAULT 0,
      imagen_url        TEXT,
      wikipedia_url     TEXT,
      gbif_key          INTEGER,
      enriquecida       INTEGER NOT NULL DEFAULT 0,
      veces_vista       INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_species_name ON species(nombre_comun);
    SQL);
    foreach (['diagnoses', 'plants'] as $table) {
        $cols = array_column($pdo->query("PRAGMA table_info($table)")->fetchAll(), 'name');
        if (!in_array('species_id', $cols, true)) {
            $pdo->exec("ALTER TABLE $table ADD COLUMN species_id INTEGER REFERENCES species(id) ON DELETE SET NULL");
        }
    }
    if ((int) $pdo->query('SELECT COUNT(*) FROM species')->fetchColumn() === 0) {
        species_seed($pdo);
    }
}

function species_seed(PDO $pdo): void
{
    $file = __DIR__ . '/species-seed.json';
    $list = is_file($file) ? json_decode((string) file_get_contents($file), true) : [];
    $pdo->beginTransaction();
    foreach ($list ?: [] as $s) {
        species_insert($pdo, $s + ['fuente' => 'Ficha inicial de Fioremi Inspector']);
    }
    $pdo->commit();
}

/** Normaliza un nombre para comparar: minúsculas, sin acentos, sin comillas ni marcas de híbrido. */
function name_key(?string $s): string
{
    $s = mb_strtolower(trim((string) $s));
    $s = strtr($s, ['á' => 'a', 'é' => 'e', 'í' => 'i', 'ó' => 'o', 'ú' => 'u', 'ü' => 'u', 'ñ' => 'n', '×' => ' ']);
    $s = preg_replace("/['\"‘’“”].*?['\"‘’“”]/u", ' ', $s); // cultivares 'Nana'
    $s = preg_replace('/\b(x|var\.?|subsp\.?|spp?\.?|cv\.?)\b/u', ' ', $s);
    $s = preg_replace('/[^a-z0-9 ]+/', ' ', $s);
    return trim(preg_replace('/\s+/', ' ', $s));
}

/** Clave científica: género + especie (las dos primeras palabras). */
function sci_key(?string $s): string
{
    $parts = explode(' ', name_key($s));
    return implode(' ', array_slice($parts, 0, 2));
}

function species_build_keys(array $s): string
{
    $keys = [sci_key($s['nombre_cientifico'] ?? ''), name_key($s['nombre_comun'] ?? '')];
    foreach ($s['otros_nombres'] ?? [] as $n) {
        $keys[] = name_key($n);
        $keys[] = sci_key($n);
    }
    $keys = array_values(array_unique(array_filter($keys)));
    return '|' . implode('|', $keys) . '|';
}

function species_insert(PDO $pdo, array $s): int
{
    $otros = array_values(array_filter(array_map('strval', (array) ($s['otros_nombres'] ?? []))));
    $problemas = array_values(array_filter(array_map('strval', (array) ($s['problemas_comunes'] ?? []))));
    $stmt = $pdo->prepare('INSERT INTO species (nombre_comun, nombre_cientifico, familia, otros_nombres, origen, dificultad, descripcion, riego, riego_cada_dias, luz, humedad, temperatura, abono, sustrato, toxica_mascotas, toxicidad, problemas_comunes, claves, fuente, verificada)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        mb_substr((string) $s['nombre_comun'], 0, 120),
        $s['nombre_cientifico'] ?? null,
        $s['familia'] ?? null,
        json_encode($otros, JSON_UNESCAPED_UNICODE),
        $s['origen'] ?? null,
        in_array($s['dificultad'] ?? '', DIFFICULTIES, true) ? $s['dificultad'] : null,
        $s['descripcion'] ?? null,
        $s['riego'] ?? null,
        isset($s['riego_cada_dias']) && $s['riego_cada_dias'] ? (int) $s['riego_cada_dias'] : null,
        $s['luz'] ?? null,
        $s['humedad'] ?? null,
        $s['temperatura'] ?? null,
        $s['abono'] ?? null,
        $s['sustrato'] ?? null,
        isset($s['toxica_mascotas']) && $s['toxica_mascotas'] !== null ? ($s['toxica_mascotas'] ? 1 : 0) : null,
        $s['toxicidad'] ?? null,
        json_encode($problemas, JSON_UNESCAPED_UNICODE),
        species_build_keys(['nombre_cientifico' => $s['nombre_cientifico'] ?? '', 'nombre_comun' => $s['nombre_comun'], 'otros_nombres' => $otros]),
        $s['fuente'] ?? 'ficha',
        !empty($s['verificada']) ? 1 : 0,
    ]);
    return (int) $pdo->lastInsertId();
}

function species_row(int $id): ?array
{
    $r = row('SELECT * FROM species WHERE id = ?', [$id]);
    return $r ? species_public($r) : null;
}

function species_public(array $r): array
{
    $r['otros_nombres'] = json_decode($r['otros_nombres'] ?: '[]', true) ?: [];
    $r['problemas_comunes'] = json_decode($r['problemas_comunes'] ?: '[]', true) ?: [];
    $r['toxica_mascotas'] = $r['toxica_mascotas'] === null ? null : (bool) $r['toxica_mascotas'];
    $r['verificada'] = (bool) $r['verificada'];
    unset($r['claves']);
    return $r;
}

/** Busca la ficha que corresponde a la planta identificada por la IA. */
function species_find(array $ident): ?int
{
    $sci = sci_key($ident['nombre_cientifico'] ?? '');
    $candidates = array_filter([$sci, name_key($ident['nombre_comun'] ?? '')]);
    foreach ($ident['otros_nombres'] ?? [] as $n) {
        $candidates[] = name_key($n);
    }
    foreach (array_unique($candidates) as $key) {
        if (strlen($key) < 3) continue;
        $id = scalar('SELECT id FROM species WHERE claves LIKE ? ORDER BY verificada DESC, id LIMIT 1', ['%|' . $key . '|%']);
        if ($id) {
            return (int) $id;
        }
    }
    return null;
}

/** Crea una ficha nueva a partir del análisis de la IA (queda pendiente de revisar). */
function species_create_from_ai(array $result): int
{
    $p = $result['planta_identificada'];
    return species_insert(db(), [
        'nombre_comun' => $p['nombre_comun'],
        'nombre_cientifico' => $p['nombre_cientifico'],
        'familia' => $p['familia'] ?? null,
        'otros_nombres' => $p['otros_nombres'] ?? [],
        'riego' => $result['cuidados']['riego'] ?? null,
        'riego_cada_dias' => $result['riego_cada_dias'] ?? null,
        'luz' => $result['cuidados']['luz'] ?? null,
        'humedad' => $result['cuidados']['humedad'] ?? null,
        'abono' => $result['cuidados']['abono'] ?? null,
        'toxicidad' => $result['aviso'] ?? null,
        'problemas_comunes' => array_slice(array_column($result['problemas'] ?? [], 'nombre'), 0, 3),
        'fuente' => 'Creada por la IA (pendiente de revisar)',
    ]);
}

/** Enlaza el resultado de un análisis con su ficha (la busca o la crea). */
function species_link_result(array $result): ?int
{
    if (empty($result['es_planta']) || ($result['planta_identificada']['confianza'] ?? '') === 'baja'
        && empty($result['planta_identificada']['nombre_cientifico'])) {
        return null;
    }
    $id = species_find($result['planta_identificada']);
    if (!$id && !empty($result['planta_identificada']['nombre_cientifico'])) {
        $id = species_create_from_ai($result);
    }
    if ($id) {
        q("UPDATE species SET veces_vista = veces_vista + 1 WHERE id = ?", [$id]);
    }
    return $id;
}

// --- Enriquecimiento con fuentes abiertas (Wikipedia en español y GBIF) ---

function http_json(string $url): ?array
{
    try {
        $res = (new GuzzleHttp\Client(['timeout' => 8, 'connect_timeout' => 5, 'http_errors' => false]))->get($url, [
            'headers' => ['User-Agent' => 'FioremiInspector/1.0 (https://plantas.fioremi.com)', 'Accept' => 'application/json'],
        ]);
        if ($res->getStatusCode() !== 200) {
            return null;
        }
        $data = json_decode((string) $res->getBody(), true);
        return is_array($data) ? $data : null;
    } catch (Throwable $e) {
        log_error('Enriquecer ficha: ' . $e->getMessage());
        return null;
    }
}

function wikipedia_summary(string $title): ?array
{
    $base = rtrim(getenv('WIKIPEDIA_BASE_URL') ?: 'https://es.wikipedia.org', '/');
    $data = http_json($base . '/api/rest_v1/page/summary/' . rawurlencode(str_replace(' ', '_', $title)));
    if (!$data || ($data['type'] ?? '') === 'disambiguation' || empty($data['extract'])) {
        return null;
    }
    return $data;
}

/** Completa una ficha con Wikipedia (descripción, foto) y GBIF (familia, nombre aceptado). Se hace una sola vez. */
function species_enrich(int $id): void
{
    $s = row('SELECT * FROM species WHERE id = ?', [$id]);
    if (!$s || $s['enriquecida']) {
        return;
    }
    @set_time_limit(60);
    $updates = ['enriquecida' => 1];

    $wiki = null;
    foreach (array_filter([$s['nombre_cientifico'], $s['nombre_comun']]) as $title) {
        $clean = trim(preg_replace("/['\"‘’].*?['\"‘’]/u", '', str_replace('×', '', (string) $title)));
        if ($wiki = wikipedia_summary($clean)) break;
    }
    if ($wiki) {
        $updates['wikipedia_url'] = $wiki['content_urls']['desktop']['page'] ?? null;
        $updates['imagen_url'] = $wiki['thumbnail']['source'] ?? null;
        if (!$s['descripcion']) {
            $updates['descripcion'] = mb_substr((string) $wiki['extract'], 0, 700);
        }
    }

    if ($s['nombre_cientifico']) {
        $base = rtrim(getenv('GBIF_BASE_URL') ?: 'https://api.gbif.org', '/');
        $gbif = http_json($base . '/v1/species/match?name=' . rawurlencode((string) $s['nombre_cientifico']));
        if ($gbif && ($gbif['matchType'] ?? 'NONE') !== 'NONE') {
            $updates['gbif_key'] = isset($gbif['usageKey']) ? (int) $gbif['usageKey'] : null;
            if (!$s['familia'] && !empty($gbif['family'])) {
                $updates['familia'] = $gbif['family'];
            }
        }
    }

    $sets = implode(', ', array_map(fn ($k) => "$k = ?", array_keys($updates)));
    q("UPDATE species SET $sets WHERE id = ?", [...array_values($updates), $id]);
}

// --- Rutas ---

function species_list(): never
{
    require_user();
    $rows = rows('SELECT id, nombre_comun, nombre_cientifico, familia, otros_nombres, dificultad, toxica_mascotas, verificada, imagen_url, veces_vista, fuente
                    FROM species ORDER BY nombre_comun COLLATE NOCASE');
    json_out(array_map(function ($r) {
        $r['otros_nombres'] = json_decode($r['otros_nombres'] ?: '[]', true) ?: [];
        $r['toxica_mascotas'] = $r['toxica_mascotas'] === null ? null : (bool) $r['toxica_mascotas'];
        $r['verificada'] = (bool) $r['verificada'];
        return $r;
    }, $rows));
}

function species_get(string $id): never
{
    require_user();
    if (!row('SELECT 1 FROM species WHERE id = ?', [(int) $id])) {
        throw new HttpError(404, 'No se encontró la ficha.');
    }
    species_enrich((int) $id);
    json_out(species_row((int) $id));
}

function read_species_fields(array $b, bool $partial): array
{
    $f = [];
    foreach (SPECIES_TEXT_FIELDS as $k) {
        if (!$partial || array_key_exists($k, $b)) {
            $f[$k] = clean_text($b[$k] ?? null, $k === 'descripcion' ? 2000 : 600);
        }
    }
    if (array_key_exists('nombre_comun', $f) && !$f['nombre_comun']) {
        throw new HttpError(400, 'La ficha necesita un nombre común.');
    }
    if (!$partial || array_key_exists('dificultad', $b)) {
        $f['dificultad'] = in_array($b['dificultad'] ?? '', DIFFICULTIES, true) ? $b['dificultad'] : null;
    }
    if (!$partial || array_key_exists('riego_cada_dias', $b)) {
        $f['riego_cada_dias'] = positive_int($b['riego_cada_dias'] ?? null, 60);
    }
    if (!$partial || array_key_exists('toxica_mascotas', $b)) {
        $t = $b['toxica_mascotas'] ?? null;
        $f['toxica_mascotas'] = ($t === null || $t === '') ? null : (in_array($t, [true, 1, '1', 'si', 'true'], true) ? 1 : 0);
    }
    foreach (['otros_nombres', 'problemas_comunes'] as $k) {
        if (!$partial || array_key_exists($k, $b)) {
            $list = is_array($b[$k] ?? null) ? $b[$k] : preg_split('/[,\n]/', (string) ($b[$k] ?? ''));
            $list = array_values(array_filter(array_map(fn ($x) => clean_text($x, 200), $list)));
            $f[$k] = json_encode(array_slice($list, 0, 12), JSON_UNESCAPED_UNICODE);
        }
    }
    if (array_key_exists('verificada', $b)) {
        $f['verificada'] = $b['verificada'] ? 1 : 0;
    }
    return $f;
}

function species_save_keys(int $id): void
{
    $s = species_row($id);
    q('UPDATE species SET claves = ? WHERE id = ?', [species_build_keys($s), $id]);
}

function species_create(): never
{
    $me = require_admin();
    $f = read_species_fields(body(), false);
    $id = species_insert(db(), [
        ...$f,
        'otros_nombres' => json_decode($f['otros_nombres'], true),
        'problemas_comunes' => json_decode($f['problemas_comunes'], true),
        'fuente' => 'Creada por ' . $me['name'],
        'verificada' => 1,
    ]);
    json_out(species_row($id), 201);
}

function species_update(string $id): never
{
    require_admin();
    if (!row('SELECT 1 FROM species WHERE id = ?', [(int) $id])) {
        throw new HttpError(404, 'No se encontró la ficha.');
    }
    $f = read_species_fields(body(), true);
    if ($f) {
        $f['updated_at'] = gmdate('Y-m-d H:i:s');
        $sets = implode(', ', array_map(fn ($k) => "$k = ?", array_keys($f)));
        q("UPDATE species SET $sets WHERE id = ?", [...array_values($f), (int) $id]);
        species_save_keys((int) $id);
    }
    json_out(species_row((int) $id));
}

function species_delete(string $id): never
{
    require_admin();
    q('DELETE FROM species WHERE id = ?', [(int) $id]);
    json_out(['ok' => true]);
}
