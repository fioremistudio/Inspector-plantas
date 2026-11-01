# 🌿 Inspector de Plantas

Aplicación web (instalable en el celular) que analiza fotos de plantas con inteligencia artificial y te dice qué les pasa y cómo cuidarlas.

## Qué hace

- **📷 Diagnóstico con IA**: haz una foto y obtén:
  - la especie de la planta,
  - una puntuación de salud del 0 al 100,
  - los problemas detectados (plagas, hongos, riego, luz, nutrientes…) y lo probable que es cada uno,
  - un tratamiento paso a paso (qué hacer hoy, esta semana y de forma continua),
  - cuidados recomendados, consejos de prevención y avisos (por ejemplo, si es tóxica para mascotas).
- **🪴 Mis plantas**: guarda cada planta con su foto, especie, ubicación y notas.
- **📈 Evolución**: cada nuevo análisis se compara con el anterior. Verás un gráfico de salud, la foto de "antes y ahora" y todas las fotos en orden.
- **📋 Historial**: todos los análisis guardados.
- **⏰ Recordatorios**: de riego automáticos según la frecuencia de cada planta, más los que sugiere la IA (revisar el tratamiento, abonar…). Se pueden repetir, posponer o marcar como hechos, y el navegador puede avisarte.
- **📝 Diario de cuidados**: apunta cuándo regaste, abonaste, podaste o aplicaste un tratamiento.
- **👑 Administración**: la primera cuenta que se crea es la de administración. Desde el panel puedes:
  - crear cuentas para tus clientes, activarlas o desactivarlas y cambiar contraseñas,
  - abrir o cerrar el registro público,
  - ver estadísticas de uso.
- **🔒 Privacidad**: cada usuario solo ve sus propias plantas y fotos.
- **📱 Instalable** en Android e iPhone como si fuera una app, con modo oscuro automático.

## La clave de Anthropic, explicada

Para que la IA "vea" la foto, la app envía la imagen a Claude, el modelo de inteligencia artificial de Anthropic. Anthropic cobra un poco por cada análisis, y para saber a quién cobrar usa una **clave de API**: una contraseña larga y secreta que identifica tu cuenta.

**Cómo conseguirla:**

1. Entra en <https://console.anthropic.com> y crea una cuenta. Es distinta de tu cuenta de claude.ai.
2. En **Billing**, añade una tarjeta y algo de saldo. Con 5 USD alcanza para hacer muchas pruebas.
3. En **API Keys**, pulsa **Create Key**, ponle un nombre (por ejemplo, "Inspector de plantas") y copia la clave. Empieza por `sk-ant-…`.
4. Pégala en el archivo `.env` de la app (ver abajo).

**Importante:**

- La clave es como una contraseña: **no la compartas ni la subas a GitHub**. El archivo `.env` ya está excluido para que no se suba por error.
- Cada análisis cuesta solo unos centavos de dólar. En la consola de Anthropic puedes ver el gasto y poner un límite mensual.
- La app también limita los análisis diarios de cada cliente (`DAILY_DIAGNOSIS_LIMIT`). Las cuentas de administración no tienen ese límite.

**Sin clave**, la app funciona en **modo demostración**: puedes probar todo, pero los diagnósticos son de ejemplo y no analizan tu foto de verdad.

## Cómo ponerla en marcha

Necesitas [Node.js](https://nodejs.org) versión 22.13 o superior.

```bash
npm install
cp .env.example .env      # y escribe tu clave en ANTHROPIC_API_KEY
npm start
```

Abre <http://localhost:3000>. La primera vez te pedirá crear la cuenta de administración.

### Configuración (`.env`)

| Variable | Para qué sirve | Valor por defecto |
|---|---|---|
| `ANTHROPIC_API_KEY` | Clave de Anthropic. Si está vacía, se usa el modo demostración | (vacía) |
| `ANTHROPIC_MODEL` | Modelo de IA | `claude-opus-5-5` |
| `PORT` | Puerto del servidor | `3000` |
| `DATA_DIR` | Carpeta de la base de datos y las fotos | `./data` |
| `DAILY_DIAGNOSIS_LIMIT` | Análisis por cliente y día (`0` = sin límite) | `20` |
| `COOKIE_SECURE` | Pon `true` si la app se sirve con HTTPS | `false` |

## Publicarla en internet

Para usarla desde el celular fuera de casa, o para dar acceso a clientes, hay que publicarla en un servidor. Encajan bien servicios como Railway, Render o Fly.io, o cualquier servidor con Node.js:

1. Conecta este repositorio al servicio.
2. Comando de inicio: `npm start`.
3. Añade las variables `ANTHROPIC_API_KEY` y `COOKIE_SECURE=true` en su panel.
4. **Muy importante:** configura un **disco persistente** y apunta `DATA_DIR` a él. Si no, se perderán la base de datos y las fotos cada vez que el servicio se reinicie.

La cámara del celular y la instalación como app solo funcionan con HTTPS, y estos servicios ya lo incluyen.

### Instalar en el celular

- **Android (Chrome)**: menú ⋮ → «Instalar aplicación».
- **iPhone (Safari)**: botón Compartir → «Añadir a pantalla de inicio».

## Copias de seguridad

Todos los datos están en la carpeta `DATA_DIR`:

- `inspector.db` es la base de datos,
- `uploads/` contiene las fotos.

Para hacer una copia de seguridad, copia esa carpeta.

## Estructura del código

```
server/
  index.js          servidor web (Express) y rutas
  ai.js             análisis con Claude: instrucciones, formato de respuesta y modo demostración
  auth.js           cuentas, contraseñas cifradas y sesiones
  db.js             base de datos SQLite (incluida en Node.js)
  reminders.js      lógica de recordatorios y del diario de cuidados
  routes/           API: auth, plants, diagnoses, reminders, admin
public/             la app que ve el usuario (HTML, CSS y JavaScript, sin compilación)
test/               pruebas automáticas (npm test)
```

## Pruebas

```bash
npm test
```

Las pruebas usan el modo demostración, así que no gastan saldo de Anthropic.

## Próximos pasos posibles

- Notificaciones push reales, que lleguen aunque la app esté cerrada (Web Push).
- Recuperar la contraseña por correo electrónico.
- Planes de pago o límites distintos para cada cliente.
- Exportar el historial de una planta en PDF.

---

El diagnóstico es orientativo: lo genera una inteligencia artificial a partir de la foto. Ante problemas graves, conviene consultar con un vivero o especialista.
