# 🌿 Fioremi Inspector

Aplicación web (instalable en el celular) que analiza fotos de plantas con inteligencia artificial y te dice qué les pasa y cómo cuidarlas.

Funciona en cualquier **hosting compartido con PHP**, como Hostinger, sin servidores especiales ni bases de datos que configurar.

## Qué hace

- **📷 Diagnóstico con IA**: haz una foto y obtén:
  - la especie de la planta,
  - una puntuación de salud del 0 al 100,
  - los problemas detectados (plagas, hongos, riego, luz, nutrientes…) y lo probable que es cada uno,
  - un tratamiento paso a paso,
  - cuidados recomendados, consejos de prevención y avisos (por ejemplo, si es tóxica para mascotas).
- **🪴 Mis plantas**: guarda cada planta con su foto, especie, ubicación y notas.
- **📈 Evolución**: cada nuevo análisis se compara con el anterior. Verás un gráfico de salud y la foto de "antes y ahora".
- **📋 Historial** de todos los análisis.
- **⏰ Recordatorios** de riego automáticos, más los que sugiere la IA. Se pueden repetir, posponer o marcar como hechos, y el navegador puede avisarte.
- **📝 Diario de cuidados**: apunta cuándo regaste, abonaste, podaste o aplicaste un tratamiento.
- **👑 Panel de administración**:
  - **clave de Anthropic y modelo de IA** (se configuran desde aquí, sin tocar archivos),
  - **gasto aproximado** del mes, en total y por cliente,
  - creación de cuentas para clientes, activación o desactivación y cambio de contraseñas,
  - límite diario de análisis por cliente,
  - registro público abierto o cerrado.
- **🔒 Privacidad**: cada usuario solo ve sus propias plantas y fotos.

Solo **analizar una foto** usa la IA y tiene costo, que es de unos centavos de dólar. El historial, los recordatorios y todo lo demás no cuestan nada.

## Instalar en Hostinger (paso a paso)

### Requisitos

- Cualquier plan de Hostinger con PHP 8.1 o superior, incluidos Single, Premium y Business.
- El archivo **`inspector-plantas.zip`**. Para generarlo, ver "Generar el zip" más abajo.

### 1. Crear el subdominio

1. En **hPanel**, entra en tu sitio web y luego en **Dominios → Subdominios**.
2. Escribe el nombre, por ejemplo `plantas`, y pulsa **Crear**.
3. Hostinger crea una carpeta para el subdominio, normalmente `public_html/plantas`.

### 2. Elegir la versión de PHP

1. Ve a **Avanzado → Configuración de PHP**.
2. Elige **PHP 8.2 o superior** y guarda.
3. En la pestaña **Extensiones de PHP**, comprueba que estén marcadas **pdo_sqlite**, **curl** y **mbstring**. Normalmente ya lo están.

### 3. Subir la app (con el instalador)

1. Abre **Archivos → Administrador de archivos** y entra en la carpeta del subdominio.
2. Sube **dos archivos, sin descomprimir nada**:
   - `inspector-plantas.zip`
   - `instalar.php` (está en `scripts/instalar.php`)
3. En el navegador, abre `https://tu-subdominio/instalar.php`.
4. El instalador comprueba PHP, descomprime la app, borra el .zip y la página de muestra de Hostinger, y después se borra a sí mismo.

**No descomprimas el .zip en tu computador.** La Mac oculta el archivo `.htaccess`, y al arrastrar los archivos sueltos no se suben las carpetas.

### 4. Activar HTTPS

En **Seguridad → SSL**, comprueba que el subdominio tiene certificado. Si no lo tiene, instálalo: es gratis. Sin HTTPS, la cámara del celular no funciona.

### 5. Primer uso

1. Abre `https://plantas.tudominio.com`.
2. Crea la **cuenta de administración**.
3. Ve a **Mi cuenta → Panel de administración → Inteligencia artificial**, pega tu clave de Anthropic y pulsa **Guardar clave**. La app comprueba que funciona antes de guardarla.

¡Listo! Ya puedes analizar plantas.

## La clave de Anthropic

La IA que analiza las fotos es Claude, de Anthropic. Para usarla necesitas una **clave de API**: una contraseña que identifica tu cuenta para que Anthropic sepa a quién cobrar.

1. Crea una cuenta en <https://console.anthropic.com>. Es distinta de la de claude.ai.
2. En **Billing**, añade una tarjeta y algo de saldo. Con 5 USD tienes para muchas pruebas.
3. En **API Keys**, pulsa **Create Key** y copia la clave, que empieza por `sk-ant-…`.
4. Pégala en el panel de administración de la app.

En la consola de Anthropic puedes poner un **límite de gasto mensual**. Sin clave, la app funciona en **modo demostración**, con diagnósticos de ejemplo.

### Costo aproximado por análisis

| Modelo (se elige en el panel) | Costo aproximado |
|---|---|
| Claude Opus 5.5 (máxima precisión) | 6 a 10 centavos de dólar |
| Claude Sonnet 5.5 (más económico) | 3 a 5 centavos de dólar |

## Copias de seguridad

Todos los datos están en la carpeta **`data/`** de la app:

- `inspector.db` es la base de datos,
- `uploads/` contiene las fotos.

Para hacer una copia, descarga esa carpeta desde el Administrador de archivos. Desde la web está bloqueada, así que nadie puede verla.

**Para actualizar la app a una versión nueva**, sube y extrae el zip nuevo encima del anterior. La carpeta `data/` no viene en el zip, así que tus datos se mantienen.

**Opcional, más seguro:** puedes guardar los datos fuera de `public_html`.

1. Copia `api/config.example.php` como `api/config.php`.
2. Indica la carpeta en `data_dir`, por ejemplo `/home/u123456789/inspector-datos`.

## Problemas frecuentes

| Problema | Solución |
|---|---|
| "Falta la extensión PHP…" | Actívala en hPanel → Avanzado → Configuración de PHP → Extensiones |
| "Esta app necesita PHP 8.1…" | Sube la versión de PHP en hPanel |
| La cámara no se abre | Comprueba que entras con `https://` |
| El análisis falla por tiempo | Inténtalo de nuevo o cambia a Sonnet 5.5 en el panel, que es más rápido |
| "Tu cuenta de Anthropic no tiene saldo" | Añade crédito en console.anthropic.com → Billing |

## Para desarrolladores

```
app/                 todo lo que se sube al hosting
  index.html, app.js, styles.css, sw.js   interfaz (JavaScript sin compilación)
  .htaccess          rutas y protección de carpetas
  api/index.php      punto de entrada de la API
  api/lib/           core (BD SQLite), auth, ai (Claude), reminders, routes
  composer.json      dependencias PHP (SDK oficial de Anthropic + Guzzle)
scripts/build.sh     genera dist/inspector-plantas.zip
test/                pruebas automáticas
```

Requisitos para desarrollar: PHP 8.1 o superior, Composer, Node.js 20 o superior (solo para las pruebas) y `zip`.

```bash
composer install             # instalar dependencias PHP
npm run dev                  # servidor local en http://localhost:8080
npm test                     # pruebas (usan modo demostración y un Anthropic simulado)
npm run build                # genera dist/inspector-plantas.zip
```

---

El diagnóstico es orientativo: lo genera una inteligencia artificial a partir de la foto. Ante problemas graves, conviene consultar con un vivero o especialista.
