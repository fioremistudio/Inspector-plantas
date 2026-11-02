<?php
// Análisis de fotos con Claude (Anthropic).

declare(strict_types=1);

const ENUMS = [
    'confianza' => ['alta', 'media', 'baja'],
    'estado_general' => ['saludable', 'leve', 'moderado', 'grave'],
    'tipo_problema' => ['plaga', 'hongo', 'bacteria', 'virus', 'riego', 'luz', 'nutrientes', 'temperatura', 'daño_fisico', 'otro'],
    'cuando' => ['hoy', 'esta_semana', 'continuo'],
    'tipo_recordatorio' => ['riego', 'abono', 'tratamiento', 'revision', 'poda', 'trasplante', 'otro'],
];

const SYSTEM_PROMPT = <<<TXT
Eres un fitopatólogo y jardinero experto que ayuda a personas sin conocimientos técnicos a cuidar sus plantas. Analizas una foto y das un diagnóstico claro y consejos prácticos en español.

Cómo trabajar:
- Observa con detalle hojas, tallos, sustrato, maceta y entorno visibles. Basa el diagnóstico en lo que realmente se ve; si algo es incierto, dilo y baja la probabilidad.
- Considera las causas más comunes antes que las raras (el exceso de riego es la causa más frecuente de problemas en plantas de interior).
- Los tratamientos deben ser concretos y realizables en casa. Prioriza soluciones suaves y caseras (jabón potásico, aceite de neem, ajustar riego o luz, aislar la planta, podar partes dañadas) antes que productos químicos. Si recomiendas un producto, di el tipo de producto, no una marca.
- Si la planta está sana, dilo con claridad y da consejos de mantenimiento; no inventes problemas.
- Si la foto no es de una planta, marca es_planta = false y explica en el resumen qué foto se necesita.
- Si la foto es borrosa, oscura o no muestra la zona afectada, indícalo en calidad_foto y sugiere cómo tomar una mejor.
- Identifica la planta lo mejor posible: nombre común más usado en español (en nombre_comun), nombre científico, familia botánica y otros nombres populares con los que se conoce en países hispanohablantes (máximo 4). Si es un bonsái, indica la especie del árbol.
- puntuacion_salud va de 0 (muerta) a 100 (perfecta).
- Sugiere recordatorios útiles (riego, revisión del tratamiento, abono). Para un tratamiento, sugiere una revisión en 5-10 días para seguir la evolución. en_dias es dentro de cuántos días desde hoy.
- Si se te da el diagnóstico anterior de la misma planta, compara y explica si ha mejorado, empeorado o sigue igual en comparacion_anterior; si no, déjalo en null.
- En aviso incluye advertencias importantes (toxicidad para mascotas o niños, riesgo de contagio a otras plantas) o null.
- Usa un tono cercano, tranquilizador y directo. Nada de jerga sin explicar.
TXT;

function diagnosis_schema(): array
{
    $str = ['type' => 'string'];
    $nullStr = ['type' => ['string', 'null']];
    $int = ['type' => 'integer'];
    $enum = fn (string $k) => ['type' => 'string', 'enum' => ENUMS[$k]];
    $obj = fn (array $props) => [
        'type' => 'object',
        'properties' => $props,
        'required' => array_keys($props),
        'additionalProperties' => false,
    ];
    $arr = fn (array $items) => ['type' => 'array', 'items' => $items];

    return $obj([
        'es_planta' => ['type' => 'boolean'],
        'planta_identificada' => $obj([
            'nombre_comun' => $str,
            'nombre_cientifico' => $nullStr,
            'familia' => $nullStr,
            'otros_nombres' => $arr($str),
            'confianza' => $enum('confianza'),
        ]),
        'estado_general' => $enum('estado_general'),
        'puntuacion_salud' => $int,
        'resumen' => $str,
        'problemas' => $arr($obj([
            'nombre' => $str,
            'tipo' => $enum('tipo_problema'),
            'probabilidad' => $enum('confianza'),
            'sintomas_observados' => $arr($str),
            'explicacion' => $str,
        ])),
        'tratamiento' => $arr($obj([
            'paso' => $str,
            'detalle' => $str,
            'cuando' => $enum('cuando'),
        ])),
        'prevencion' => $arr($str),
        'cuidados' => $obj(['riego' => $str, 'luz' => $str, 'humedad' => $str, 'abono' => $str]),
        'riego_cada_dias' => ['type' => ['integer', 'null']],
        'recordatorios_sugeridos' => $arr($obj([
            'tipo' => $enum('tipo_recordatorio'),
            'titulo' => $str,
            'en_dias' => $int,
            'repetir_cada_dias' => ['type' => ['integer', 'null']],
        ])),
        'comparacion_anterior' => $nullStr,
        'calidad_foto' => $obj(['adecuada' => ['type' => 'boolean'], 'sugerencia' => $nullStr]),
        'aviso' => $nullStr,
    ]);
}

/**
 * Analiza la foto. Devuelve ['result' => array, 'model' => string, 'demo' => bool, 'input_tokens' => int, 'output_tokens' => int].
 */
function analyze_plant(string $base64, string $mediaType, ?array $plant, ?string $symptoms, ?array $previous): array
{
    if (demo_mode()) {
        return ['result' => demo_diagnosis($plant, $previous), 'model' => 'demo', 'demo' => true, 'input_tokens' => 0, 'output_tokens' => 0];
    }

    $ctx = [];
    if ($plant) {
        $ctx[] = "Planta registrada por el usuario: \"{$plant['name']}\"";
        if ($plant['species']) $ctx[] = "Especie indicada: {$plant['species']}";
        if ($plant['location']) $ctx[] = "Ubicación: {$plant['location']}";
        if ($plant['water_every_days']) $ctx[] = "Riego actual: cada {$plant['water_every_days']} días";
        if ($plant['last_watered_at']) $ctx[] = 'Último riego registrado: ' . substr($plant['last_watered_at'], 0, 10);
        if ($plant['notes']) $ctx[] = "Notas del usuario: {$plant['notes']}";
    }
    if ($symptoms) $ctx[] = "Lo que cuenta el usuario: $symptoms";
    if ($previous) {
        $p = $previous['result'];
        $names = implode(', ', array_column($p['problemas'], 'nombre')) ?: 'ninguno';
        $ctx[] = sprintf('Diagnóstico anterior (%s): estado "%s", salud %d/100. Resumen: %s Problemas: %s.',
            substr($previous['date'], 0, 10), $p['estado_general'], $p['puntuacion_salud'], $p['resumen'], $names);
    }
    $ctx[] = 'Fecha de hoy: ' . today();

    @set_time_limit(300);
    $userText = "Analiza esta planta y dame el diagnóstico.\n\n" . implode("\n", $ctx);
    if (ai_provider() === 'gemini') {
        return analyze_with_gemini($base64, $mediaType, $userText);
    }

    $client = new Anthropic\Client(apiKey: api_key());
    $model = current_model();

    $message = $client->beta->messages->create(
        model: $model,
        maxTokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM_PROMPT,
        outputConfig: [
            'effort' => 'medium',
            'format' => ['type' => 'json_schema', 'schema' => diagnosis_schema()],
        ],
        messages: [[
            'role' => 'user',
            'content' => [
                ['type' => 'image', 'source' => ['type' => 'base64', 'mediaType' => $mediaType, 'data' => $base64]],
                ['type' => 'text', 'text' => $userText],
            ],
        ]],
    );

    if ($message->stopReason === 'refusal') {
        throw new HttpError(422, 'La IA no pudo analizar esta imagen. Prueba con otra foto.');
    }
    $text = null;
    foreach ($message->content as $block) {
        if ($block->type === 'text') {
            $text = $block->text;
            break;
        }
    }
    $data = $text !== null ? json_decode($text, true) : null;
    if ($message->stopReason === 'max_tokens' || !is_array($data)) {
        throw new HttpError(502, 'La respuesta de la IA llegó incompleta. Inténtalo de nuevo.');
    }

    return [
        'result' => normalize_result($data),
        'model' => (string) $message->model,
        'demo' => false,
        'input_tokens' => (int) ($message->usage->inputTokens ?? 0),
        'output_tokens' => (int) ($message->usage->outputTokens ?? 0),
    ];
}

function pick_enum(string $name, mixed $value, string $fallback): string
{
    $strip = fn (string $s) => strtr(mb_strtolower($s), ['á' => 'a', 'é' => 'e', 'í' => 'i', 'ó' => 'o', 'ú' => 'u', 'ñ' => 'n', ' ' => '_']);
    $clean = $strip(trim((string) $value));
    foreach (ENUMS[$name] as $v) {
        if ($strip($v) === $clean) {
            return $v;
        }
    }
    return $fallback;
}

// Asegura que el resultado tenga la forma y los valores esperados.
function normalize_result(array $r): array
{
    $s = fn ($v) => is_string($v) ? $v : '';
    $ns = fn ($v) => is_string($v) && trim($v) !== '' ? $v : null;
    $list = fn ($v) => is_array($v) ? array_values($v) : [];

    $pi = is_array($r['planta_identificada'] ?? null) ? $r['planta_identificada'] : [];
    $out = [
        'es_planta' => (bool) ($r['es_planta'] ?? true),
        'planta_identificada' => [
            'nombre_comun' => $s($pi['nombre_comun'] ?? '') ?: 'Planta',
            'nombre_cientifico' => $ns($pi['nombre_cientifico'] ?? null),
            'familia' => $ns($pi['familia'] ?? null),
            'otros_nombres' => array_slice(array_values(array_filter(array_map($s, $list($pi['otros_nombres'] ?? null)))), 0, 4),
            'confianza' => pick_enum('confianza', $pi['confianza'] ?? '', 'media'),
        ],
        'estado_general' => pick_enum('estado_general', $r['estado_general'] ?? '', 'moderado'),
        'puntuacion_salud' => max(0, min(100, (int) round((float) ($r['puntuacion_salud'] ?? 50)))),
        'resumen' => $s($r['resumen'] ?? ''),
        'problemas' => [],
        'tratamiento' => [],
        'prevencion' => array_values(array_filter(array_map($s, $list($r['prevencion'] ?? null)))),
        'cuidados' => [],
        'riego_cada_dias' => null,
        'recordatorios_sugeridos' => [],
        'comparacion_anterior' => $ns($r['comparacion_anterior'] ?? null),
        'calidad_foto' => [
            'adecuada' => (bool) ($r['calidad_foto']['adecuada'] ?? true),
            'sugerencia' => $ns($r['calidad_foto']['sugerencia'] ?? null),
        ],
        'aviso' => $ns($r['aviso'] ?? null),
    ];
    foreach ($list($r['problemas'] ?? null) as $p) {
        if (!is_array($p)) continue;
        $out['problemas'][] = [
            'nombre' => $s($p['nombre'] ?? '') ?: 'Problema',
            'tipo' => pick_enum('tipo_problema', $p['tipo'] ?? '', 'otro'),
            'probabilidad' => pick_enum('confianza', $p['probabilidad'] ?? '', 'media'),
            'sintomas_observados' => array_values(array_filter(array_map($s, $list($p['sintomas_observados'] ?? null)))),
            'explicacion' => $s($p['explicacion'] ?? ''),
        ];
    }
    foreach ($list($r['tratamiento'] ?? null) as $t) {
        if (!is_array($t)) continue;
        $out['tratamiento'][] = [
            'paso' => $s($t['paso'] ?? ''),
            'detalle' => $s($t['detalle'] ?? ''),
            'cuando' => pick_enum('cuando', $t['cuando'] ?? '', 'esta_semana'),
        ];
    }
    foreach (['riego', 'luz', 'humedad', 'abono'] as $k) {
        $out['cuidados'][$k] = $s($r['cuidados'][$k] ?? '') ?: '—';
    }
    $riego = $r['riego_cada_dias'] ?? null;
    $out['riego_cada_dias'] = is_numeric($riego) && $riego > 0 ? min(60, (int) round((float) $riego)) : null;
    foreach (array_slice($list($r['recordatorios_sugeridos'] ?? null), 0, 6) as $x) {
        if (!is_array($x) || !$s($x['titulo'] ?? '')) continue;
        $rep = $x['repetir_cada_dias'] ?? null;
        $out['recordatorios_sugeridos'][] = [
            'tipo' => pick_enum('tipo_recordatorio', $x['tipo'] ?? '', 'otro'),
            'titulo' => mb_substr($x['titulo'], 0, 200),
            'en_dias' => max(0, min(365, (int) round((float) ($x['en_dias'] ?? 0)))),
            'repetir_cada_dias' => is_numeric($rep) && $rep > 0 ? min(365, (int) round((float) $rep)) : null,
        ];
    }
    return $out;
}

// Comprueba que la clave funciona (no consume saldo).
function test_api_key(string $key): void
{
    $client = new Anthropic\Client(apiKey: $key);
    $client->models->retrieve(current_model());
}

function demo_diagnosis(?array $plant, ?array $previous): array
{
    $score = $previous ? min(95, $previous['result']['puntuacion_salud'] + 12) : 62;
    return [
        'es_planta' => true,
        'planta_identificada' => [
            'nombre_comun' => $plant['species'] ?? $plant['name'] ?? 'Potus (ejemplo)',
            'nombre_cientifico' => 'Epipremnum aureum',
            'familia' => 'Araceae',
            'otros_nombres' => ['Pothos', 'Teléfono', 'Hiedra del diablo'],
            'confianza' => 'media',
        ],
        'estado_general' => $score >= 80 ? 'leve' : 'moderado',
        'puntuacion_salud' => $score,
        'resumen' => 'MODO DEMOSTRACIÓN: este es un diagnóstico de ejemplo, no un análisis real de tu foto. '
            . 'Añade una clave de IA (Gemini es gratis) en el panel de administración para obtener diagnósticos reales. En el ejemplo, la planta muestra hojas amarillas por exceso de riego.',
        'problemas' => [
            [
                'nombre' => 'Exceso de riego', 'tipo' => 'riego', 'probabilidad' => 'alta',
                'sintomas_observados' => ['Hojas inferiores amarillas', 'Sustrato con aspecto muy húmedo'],
                'explicacion' => 'Cuando las raíces están siempre mojadas no reciben oxígeno y la planta amarillea sus hojas más viejas.',
            ],
            [
                'nombre' => 'Posible falta de luz', 'tipo' => 'luz', 'probabilidad' => 'baja',
                'sintomas_observados' => ['Tallos algo alargados'],
                'explicacion' => 'Con poca luz la planta se estira buscando claridad y crece más débil.',
            ],
        ],
        'tratamiento' => [
            ['paso' => 'Deja de regar', 'detalle' => 'No riegues hasta que los primeros 3 cm de tierra estén secos.', 'cuando' => 'hoy'],
            ['paso' => 'Retira hojas dañadas', 'detalle' => 'Corta las hojas totalmente amarillas con tijeras limpias.', 'cuando' => 'hoy'],
            ['paso' => 'Revisa el drenaje', 'detalle' => 'Asegúrate de que la maceta tiene agujeros y vacía el plato.', 'cuando' => 'esta_semana'],
        ],
        'prevencion' => [
            'Riega solo cuando la tierra esté seca al tacto.',
            'Usa macetas con agujeros de drenaje.',
            'Colócala cerca de una ventana con luz indirecta.',
        ],
        'cuidados' => [
            'riego' => 'Cada 7-10 días, cuando el sustrato esté seco en superficie.',
            'luz' => 'Luz indirecta brillante; evita el sol directo de mediodía.',
            'humedad' => 'Media; agradece pulverizaciones en ambientes secos.',
            'abono' => 'Abono líquido para plantas verdes cada 15 días en primavera y verano.',
        ],
        'riego_cada_dias' => 8,
        'recordatorios_sugeridos' => [
            ['tipo' => 'revision', 'titulo' => 'Revisar si las hojas nuevas salen verdes', 'en_dias' => 7, 'repetir_cada_dias' => null],
            ['tipo' => 'riego', 'titulo' => 'Comprobar humedad y regar si está seca', 'en_dias' => 8, 'repetir_cada_dias' => 8],
            ['tipo' => 'abono', 'titulo' => 'Abonar', 'en_dias' => 15, 'repetir_cada_dias' => 15],
        ],
        'comparacion_anterior' => $previous ? 'MODO DEMOSTRACIÓN: en el ejemplo la planta ha mejorado respecto a la última revisión.' : null,
        'calidad_foto' => ['adecuada' => true, 'sugerencia' => null],
        'aviso' => 'El potus es tóxico si lo ingieren perros, gatos o niños pequeños.',
    ];
}
