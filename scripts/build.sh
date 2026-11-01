#!/usr/bin/env bash
# Genera dist/inspector-plantas.zip listo para subir a Hostinger (o cualquier hosting con PHP 8.1+).
set -euo pipefail
cd "$(dirname "$0")/.."

STAGE="dist/inspector-plantas"
rm -rf dist && mkdir -p "$STAGE"

# Copia la app sin datos locales ni configuración privada.
tar -C app --exclude=./data --exclude=./vendor --exclude=./api/config.php -cf - . | tar -C "$STAGE" -xf -

# Librerías de PHP (solo las necesarias para producción).
cp composer.json composer.lock "$STAGE/"
COMPOSER_ALLOW_SUPERUSER=1 composer install -d "$STAGE" --prefer-dist --no-dev --optimize-autoloader --no-interaction --quiet
rm -f "$STAGE/composer.json" "$STAGE/composer.lock"

# Quita documentación y ejemplos de las librerías para aligerar el zip.
find "$STAGE/vendor" -type d \( -iname tests -o -iname test -o -iname docs -o -iname examples -o -iname fixtures -o -name .git -o -name .github \) -prune -exec rm -rf {} +
find "$STAGE/vendor" -type f \( -iname '*.md' -o -iname 'phpunit*' -o -iname '.gitattributes' \) -delete

(cd "$STAGE" && zip -qr -9 ../inspector-plantas.zip .)
echo "Listo: dist/inspector-plantas.zip ($(du -h dist/inspector-plantas.zip | cut -f1))"
