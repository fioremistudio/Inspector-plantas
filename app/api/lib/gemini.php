<?php
// Análisis con Google Gemini (nivel gratuito disponible).

declare(strict_types=1);

function gemini_base_url(): string
{
    return rtrim(getenv('GEMINI_BASE_URL') ?: 'https://generativelanguage.googleapis.com', '/');
}

function gemini_http(): GuzzleHttp\Client
{
    return new GuzzleHttp\Client([
        'base_uri' => gemini_base_url(),
        'timeout' => 180,
        'connect_timeout' => 15,
        'http_errors' => false,
    ]);
}

/** Lanza HttpError con un mensaje claro según la respuesta de error de Gemini. */
function gemini_fail(int $status, array $body): never
{
    $reason = $body['error']['status'] ?? '';
    $detail = json_encode($body['error']['details'] ?? []);
    if ($status === 503 || $reason === 'UNAVAILABLE') {
        throw new HttpError(503, 'Los servidores gratuitos de Google están saturados en este momento. Espera unos minutos y vuelve a intentarlo, o cambia a Claude en el panel de administración.');
    }
    if ($status === 429 || $reason === 'RESOURCE_EXHAUSTED') {
        throw new HttpError(503, 'Se alcanzó el límite gratuito de Gemini. Espera un minuto (o hasta mañana si es el límite diario), o cambia a Claude en el panel de administración.');
    }
    $message = (string) ($body['error']['message'] ?? '');
    if ($status === 403 || str_contains($detail, 'API_KEY_INVALID') || str_contains($detail, 'ACCESS_TOKEN_TYPE_UNSUPPORTED')
        || stripos($message, 'API key not valid') !== false || $reason === 'PERMISSION_DENIED' || $reason === 'UNAUTHENTICATED') {
        throw new HttpError(502, 'La clave de Gemini no es válida o no tiene permisos. Revísala en el panel de administración.');
    }
    log_error('Gemini ' . $status . ' (' . gemini_model() . '): ' . substr(json_encode($body, JSON_UNESCAPED_UNICODE), 0, 2000));
    $hint = $message !== '' ? ' Detalle: ' . mb_substr($message, 0, 180) : '';
    throw new HttpError(502, 'El servicio de IA de Google devolvió un error. Inténtalo de nuevo.' . $hint);
}

/**
 * Comprueba la clave y elige el mejor modelo "Flash" disponible.
 * Prefiere la versión estable más alta de "gemini-X-flash"; si no hay, "flash-lite"; si no, cualquier modelo que analice imágenes.
 */
function gemini_pick_model(string $key): string
{
    $res = gemini_http()->get('/v1beta/models', [
        'headers' => ['x-goog-api-key' => $key],
        'query' => ['pageSize' => 1000],
    ]);
    $body = json_decode((string) $res->getBody(), true) ?: [];
    if ($res->getStatusCode() !== 200) {
        gemini_fail($res->getStatusCode(), $body);
    }
    $candidates = [];
    foreach ($body['models'] ?? [] as $m) {
        $name = preg_replace('#^models/#', '', (string) ($m['name'] ?? ''));
        if (!in_array('generateContent', $m['supportedGenerationMethods'] ?? [], true)) continue;
        if (!preg_match('/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/', $name, $mm)) continue;
        // Primero los "flash" normales (más precisos), luego los "lite"; dentro, la versión más alta.
        $candidates[$name] = ($mm[2] ?? '') === '' ? 1000 + (float) $mm[1] : (float) $mm[1];
    }
    if (!$candidates) {
        foreach ($body['models'] ?? [] as $m) {
            $name = preg_replace('#^models/#', '', (string) ($m['name'] ?? ''));
            if (str_contains($name, 'flash') && in_array('generateContent', $m['supportedGenerationMethods'] ?? [], true)
                && !preg_match('/image|tts|audio|live|embedding/', $name)) {
                $candidates[$name] = 0;
            }
        }
    }
    if (!$candidates) {
        throw new HttpError(502, 'Tu cuenta de Google no tiene disponible ningún modelo Gemini Flash para analizar fotos.');
    }
    arsort($candidates);
    $ranked = array_map('strval', array_keys($candidates));
    set_setting('gemini_models', json_encode(array_slice($ranked, 0, 6)));
    return $ranked[0];
}

/** Modelos a probar en orden: el elegido y, de respaldo, los siguientes mejores de la cuenta. */
function gemini_model_chain(): array
{
    $list = json_decode((string) get_setting('gemini_models', ''), true);
    if (!is_array($list) || !$list) {
        try {
            gemini_pick_model(gemini_api_key());
            $list = json_decode((string) get_setting('gemini_models', '[]'), true) ?: [];
        } catch (Throwable $e) {
            $list = [];
        }
    }
    return array_slice(array_values(array_unique([gemini_model(), ...$list])), 0, 4);
}

/** Errores pasajeros (saturación, límite de un modelo concreto, fallo del servidor). */
function gemini_is_transient(int $status, array $body): bool
{
    $reason = $body['error']['status'] ?? '';
    return in_array($status, [429, 500, 502, 503, 504], true)
        || in_array($reason, ['UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'DEADLINE_EXCEEDED'], true);
}

/** Convierte el esquema JSON de la app al formato de esquema que acepta Gemini. */
function gemini_schema(array $s): array
{
    $out = [];
    $type = $s['type'] ?? 'string';
    if (is_array($type)) {
        $out['nullable'] = in_array('null', $type, true);
        $type = array_values(array_diff($type, ['null']))[0] ?? 'string';
    }
    $out['type'] = strtoupper($type);
    if (isset($s['enum'])) $out['enum'] = $s['enum'];
    if (isset($s['description'])) $out['description'] = $s['description'];
    if (isset($s['properties'])) {
        $out['properties'] = array_map('gemini_schema', $s['properties']);
        $out['required'] = $s['required'] ?? array_keys($s['properties']);
        $out['propertyOrdering'] = array_keys($s['properties']);
    }
    if (isset($s['items'])) $out['items'] = gemini_schema($s['items']);
    return $out;
}

function gemini_generate(string $model, string $base64, string $mediaType, string $userText, bool $withSchema): array
{
    $config = ['responseMimeType' => 'application/json', 'maxOutputTokens' => 16000];
    if ($withSchema) {
        $config['responseSchema'] = gemini_schema(diagnosis_schema());
    } else {
        // Plan B: el formato se describe en el texto en lugar de imponerlo.
        $userText .= "\n\nResponde ÚNICAMENTE con un objeto JSON válido que siga exactamente este esquema JSON (mismos nombres de campos):\n"
            . json_encode(diagnosis_schema(), JSON_UNESCAPED_UNICODE);
    }
    $res = gemini_http()->post('/v1beta/models/' . rawurlencode($model) . ':generateContent', [
        'headers' => ['x-goog-api-key' => gemini_api_key()],
        'json' => [
            'systemInstruction' => ['parts' => [['text' => SYSTEM_PROMPT]]],
            'contents' => [[
                'role' => 'user',
                'parts' => [
                    ['inlineData' => ['mimeType' => $mediaType, 'data' => $base64]],
                    ['text' => $userText],
                ],
            ]],
            'generationConfig' => $config,
        ],
    ]);
    return [$res->getStatusCode(), json_decode((string) $res->getBody(), true) ?: []];
}

function analyze_with_gemini(string $base64, string $mediaType, string $userText): array
{
    $chain = gemini_model_chain();
    $model = $chain[0];
    foreach ($chain as $i => $model) {
        [$status, $body] = gemini_generate($model, $base64, $mediaType, $userText, true);
        if ($status === 400 && ($body['error']['status'] ?? '') === 'INVALID_ARGUMENT'
            && stripos((string) ($body['error']['message'] ?? ''), 'API key') === false) {
            // Google rechazó la petición (probablemente el esquema): se reintenta sin él.
            log_error("Gemini 400 con esquema ($model), reintentando sin esquema: " . substr(json_encode($body, JSON_UNESCAPED_UNICODE), 0, 1500));
            [$status, $body] = gemini_generate($model, $base64, $mediaType, $userText, false);
        }
        if ($status === 200 || !gemini_is_transient($status, $body) || $i === count($chain) - 1) {
            break;
        }
        // Modelo saturado o sin cupo: se prueba el siguiente de la lista.
        log_error("Gemini $status ($model), probando otro modelo: " . substr(json_encode($body, JSON_UNESCAPED_UNICODE), 0, 300));
        usleep((int) (getenv('GEMINI_RETRY_PAUSE_MS') ?: 1500) * 1000);
    }
    if ($status !== 200) {
        gemini_fail($status, $body);
    }
    if (!empty($body['promptFeedback']['blockReason'])) {
        throw new HttpError(422, 'La IA no pudo analizar esta imagen. Prueba con otra foto.');
    }
    $candidate = $body['candidates'][0] ?? [];
    $finish = $candidate['finishReason'] ?? 'STOP';
    if (in_array($finish, ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'], true)) {
        throw new HttpError(422, 'La IA no pudo analizar esta imagen. Prueba con otra foto.');
    }
    $text = '';
    foreach ($candidate['content']['parts'] ?? [] as $part) {
        if (empty($part['thought']) && isset($part['text'])) {
            $text .= $part['text'];
        }
    }
    $text = trim($text);
    if (preg_match('/^```(?:json)?\s*(.*?)\s*```$/s', $text, $m)) {
        $text = $m[1];
    }
    $data = json_decode($text, true);
    if ($finish === 'MAX_TOKENS' || !is_array($data)) {
        log_error('Gemini respuesta no válida (' . $finish . '): ' . mb_substr($text, 0, 1500));
        throw new HttpError(502, 'La respuesta de la IA llegó incompleta. Inténtalo de nuevo.');
    }
    $usage = $body['usageMetadata'] ?? [];
    return [
        'result' => normalize_result($data),
        'model' => (string) ($body['modelVersion'] ?? $model),
        'demo' => false,
        'input_tokens' => (int) ($usage['promptTokenCount'] ?? 0),
        'output_tokens' => (int) (($usage['candidatesTokenCount'] ?? 0) + ($usage['thoughtsTokenCount'] ?? 0)),
    ];
}
