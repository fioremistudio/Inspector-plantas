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
    if ($status === 429 || $reason === 'RESOURCE_EXHAUSTED') {
        throw new HttpError(503, 'Se alcanzó el límite gratuito de Gemini. Espera un minuto (o hasta mañana si es el límite diario), o cambia a Claude en el panel de administración.');
    }
    $message = (string) ($body['error']['message'] ?? '');
    if ($status === 403 || str_contains($detail, 'API_KEY_INVALID') || str_contains($detail, 'ACCESS_TOKEN_TYPE_UNSUPPORTED')
        || stripos($message, 'API key not valid') !== false || $reason === 'PERMISSION_DENIED' || $reason === 'UNAUTHENTICATED') {
        throw new HttpError(502, 'La clave de Gemini no es válida o no tiene permisos. Revísala en el panel de administración.');
    }
    error_log('[inspector] Gemini ' . $status . ': ' . substr(json_encode($body), 0, 500));
    throw new HttpError(502, 'El servicio de IA de Google devolvió un error. Inténtalo de nuevo.');
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
    return (string) array_key_first($candidates);
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

function analyze_with_gemini(string $base64, string $mediaType, string $userText): array
{
    $model = gemini_model();
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
            'generationConfig' => [
                'responseMimeType' => 'application/json',
                'responseSchema' => gemini_schema(diagnosis_schema()),
                'maxOutputTokens' => 16000,
            ],
        ],
    ]);
    $body = json_decode((string) $res->getBody(), true) ?: [];
    if ($res->getStatusCode() !== 200) {
        gemini_fail($res->getStatusCode(), $body);
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
    $data = json_decode($text, true);
    if ($finish === 'MAX_TOKENS' || !is_array($data)) {
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
