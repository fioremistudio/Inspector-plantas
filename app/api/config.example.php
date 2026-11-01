<?php
// Configuración opcional. Lo normal es configurar todo desde el panel de administración
// de la app. Si prefieres fijar algo aquí, copia este archivo como "config.php".
// Lo que pongas aquí tiene prioridad sobre el panel.

return [
    // IA a usar: 'gemini' (gratis, con límites) o 'anthropic' (Claude, de pago). Vacío = la del panel.
    'provider' => '',

    // Clave de Google Gemini (Google AI Studio). Déjala vacía para usar la del panel.
    'gemini_api_key' => '',

    // Clave de Anthropic (empieza por "sk-ant-"). Déjala vacía para usar la del panel.
    'anthropic_api_key' => '',

    // Modelo: 'claude-opus-5-5' (máxima precisión) o 'claude-sonnet-5-5' (más económico).
    'model' => '',

    // Carpeta donde se guardan la base de datos y las fotos.
    // Recomendado: una carpeta FUERA de public_html, por ejemplo:
    // 'data_dir' => '/home/u123456789/inspector-datos',
    'data_dir' => '',
];
