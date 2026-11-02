// Pruebas del servidor PHP. Ejecutar con: npm test
// Arrancan el servidor de desarrollo de PHP con una base de datos temporal.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.APP_DIR ? path.resolve(process.env.APP_DIR) : path.join(here, '..', 'app');

// PNG de 1x1 píxel.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function freePort() {
  const srv = http.createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function startPhp(env) {
  const port = await freePort();
  const proc = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', appDir, path.join(here, 'php-router.php')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  proc.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/auth/status`);
      return { proc, base, log: () => log };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`El servidor PHP no arrancó:\n${log}`);
}

// Cliente HTTP mínimo que guarda la cookie de sesión.
function client(getBase) {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(getBase() + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, data, headers: res.headers };
  };
}

describe('modo demostración', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-test-'));
  let srv;
  const getBase = () => srv.base;
  const admin = client(getBase);
  const customer = client(getBase);
  const stranger = client(getBase);

  before(async () => {
    srv = await startPhp({ DATA_DIR: tmp, ANTHROPIC_API_KEY: '', DAILY_DIAGNOSIS_LIMIT: '3', WIKIPEDIA_BASE_URL: 'http://127.0.0.1:9', GBIF_BASE_URL: 'http://127.0.0.1:9' });
  });
  after(() => {
    srv.proc.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('el primer usuario crea la cuenta de administración', async () => {
    let r = await admin('GET', '/api/auth/status');
    assert.equal(r.data.needsSetup, true);
    assert.equal(r.data.demoMode, true);

    r = await admin('POST', '/api/auth/setup', { name: 'Admin', email: 'admin@example.com', password: 'secreto123' });
    assert.equal(r.status, 201);

    r = await admin('GET', '/api/auth/status');
    assert.equal(r.data.user.role, 'admin');
    assert.equal(r.data.needsSetup, false);

    r = await stranger('POST', '/api/auth/setup', { name: 'X', email: 'x@example.com', password: 'secreto123' });
    assert.equal(r.status, 403, 'no se puede repetir la configuración inicial');
  });

  test('el registro está cerrado por defecto y el admin crea clientes', async () => {
    let r = await stranger('POST', '/api/auth/register', { name: 'X', email: 'x@example.com', password: 'secreto123' });
    assert.equal(r.status, 403);

    r = await customer('POST', '/api/admin/users', { name: 'C', email: 'c@example.com', password: 'secreto123' });
    assert.equal(r.status, 401, 'sin sesión no se accede al panel');

    r = await admin('POST', '/api/admin/users', { name: 'Clienta', email: 'cliente@example.com', password: 'secreto123' });
    assert.equal(r.status, 201);

    r = await customer('POST', '/api/auth/login', { email: 'cliente@example.com', password: 'mal' });
    assert.equal(r.status, 401);
    r = await customer('POST', '/api/auth/login', { email: 'CLIENTE@example.com', password: 'secreto123' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /HttpOnly/i);

    r = await customer('GET', '/api/admin/users');
    assert.equal(r.status, 403, 'un cliente no entra al panel de administración');

    await admin('PATCH', '/api/admin/settings', { allowRegistration: true });
    r = await stranger('POST', '/api/auth/register', { name: 'Nuevo', email: 'nuevo@example.com', password: 'secreto123' });
    assert.equal(r.status, 201);
  });

  test('flujo completo: analizar, guardar planta, recordatorios y evolución', async () => {
    let r = await customer('POST', '/api/diagnoses', { photo: PNG, new_plant_name: 'Potus del salón', symptoms: 'Hojas amarillas' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.demo, 1);
    assert.ok(r.data.plant_id);
    assert.equal(r.data.cost_usd, undefined, 'el coste no se muestra al cliente');
    const plantId = r.data.plant_id;
    const first = r.data;

    r = await customer('GET', `/api/plants/${plantId}`);
    assert.equal(r.data.plant.name, 'Potus del salón');
    assert.equal(r.data.plant.water_every_days, 8);
    assert.equal(r.data.reminders.filter((x) => x.type === 'riego').length, 1);

    r = await customer('POST', `/api/diagnoses/${first.id}/apply`, { reminders: [0, 2] });
    assert.equal(r.data.created, 2);
    r = await customer('GET', '/api/reminders');
    assert.equal(r.data.reminders.length, 3);

    const abono = r.data.reminders.find((x) => x.type === 'abono');
    r = await customer('POST', `/api/reminders/${abono.id}/done`);
    assert.equal(r.status, 200);
    r = await customer('GET', `/api/plants/${plantId}`);
    assert.ok(r.data.care.some((c) => c.type === 'abono'));
    assert.equal(r.data.reminders.filter((x) => x.type === 'abono').length, 1, 'se crea el siguiente abono');

    r = await customer('POST', `/api/plants/${plantId}/care`, { type: 'riego' });
    assert.equal(r.status, 201);
    r = await customer('GET', `/api/plants/${plantId}`);
    const riego = r.data.reminders.find((x) => x.type === 'riego');
    assert.ok(riego.due_date > new Date().toISOString().slice(0, 10), 'el riego se reprograma');
    assert.ok(r.data.plant.last_watered_at);

    r = await customer('POST', '/api/diagnoses', { photo: PNG, plant_id: plantId });
    assert.equal(r.status, 201);
    assert.ok(r.data.result.comparacion_anterior);
    assert.ok(r.data.health_score > first.health_score);

    r = await customer('GET', `/api/plants/${plantId}`);
    assert.equal(r.data.diagnoses.length, 2);

    const photo = r.data.plant.photo;
    r = await customer('GET', `/api/photos/${photo}`);
    assert.equal(r.status, 200);
    r = await stranger('GET', `/api/photos/${photo}`);
    assert.equal(r.status, 404, 'otro usuario no ve la foto');
    r = await stranger('GET', `/api/plants/${plantId}`);
    assert.equal(r.status, 404, 'otro usuario no ve la planta');
  });

  test('directorio: 50 fichas iniciales y enlace con el análisis', async () => {
    let r = await customer('GET', '/api/species');
    assert.equal(r.status, 200);
    assert.equal(r.data.length, 50);
    const potus = r.data.find((x) => x.nombre_cientifico === 'Epipremnum aureum');
    assert.ok(potus);

    // El análisis de demostración identifica un potus: se enlaza con su ficha.
    const plants = await customer('GET', '/api/plants');
    const plant = await customer('GET', `/api/plants/${plants.data[0].id}`);
    assert.equal(plant.data.species.id, potus.id);
    const d = await customer('GET', `/api/diagnoses/${plant.data.diagnoses[0].id}`);
    assert.equal(d.data.species.nombre_comun, 'Potus');
    assert.ok(d.data.species.riego);

    // Sin Wikipedia/GBIF disponibles, la ficha se abre igual.
    r = await customer('GET', `/api/species/${potus.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.enriquecida, 1);
    assert.equal(r.data.toxica_mascotas, true);
    assert.ok(r.data.veces_vista >= 1);
  });

  test('directorio: solo la administración edita fichas', async () => {
    const { data: list } = await admin('GET', '/api/species');
    const monstera = list.find((x) => x.nombre_cientifico === 'Monstera deliciosa');
    let r = await customer('PATCH', `/api/species/${monstera.id}`, { riego: 'Nada' });
    assert.equal(r.status, 403);
    r = await admin('PATCH', `/api/species/${monstera.id}`, { riego: 'Cada semana, sin encharcar.', otros_nombres: 'Costilla de Adán, Monstruo verde', verificada: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.riego, 'Cada semana, sin encharcar.');
    assert.deepEqual(r.data.otros_nombres, ['Costilla de Adán', 'Monstruo verde']);
    assert.equal(r.data.verificada, true);
    r = await admin('POST', '/api/species', { nombre_comun: 'Planta de prueba', nombre_cientifico: 'Testus plantus' });
    assert.equal(r.status, 201);
    r = await admin('DELETE', `/api/species/${r.data.id}`);
    assert.equal(r.status, 200);
    r = await admin('POST', '/api/species', { nombre_comun: '' });
    assert.equal(r.status, 400);
  });

  test('las carpetas privadas no son accesibles desde la web', async () => {
    for (const url of ['/data/inspector.db', '/vendor/autoload.php', '/api/lib/core.php', '/api/lib/species-seed.json', '/data/errors.log']) {
      const r = await fetch(srv.base + url);
      assert.notEqual(r.status, 200, url);
    }
  });

  test('análisis suelto que luego se guarda en una planta nueva', async () => {
    let r = await stranger('POST', '/api/diagnoses', { photo: PNG });
    assert.equal(r.data.plant_id, null);
    r = await stranger('PATCH', `/api/diagnoses/${r.data.id}`, { new_plant: true });
    assert.ok(r.data.plant_id);
    r = await stranger('GET', '/api/plants');
    assert.equal(r.data.length, 1);
    assert.ok(r.data[0].photo);
  });

  test('límite diario de análisis para clientes', async () => {
    let r = await customer('POST', '/api/diagnoses', { photo: PNG });
    assert.equal(r.status, 201);
    r = await customer('POST', '/api/diagnoses', { photo: PNG });
    assert.equal(r.status, 429);
  });

  test('validaciones de entrada', async () => {
    let r = await stranger('POST', '/api/diagnoses', { photo: 'data:text/plain;base64,aGk=' });
    assert.equal(r.status, 400);
    r = await customer('POST', '/api/plants', { name: '' });
    assert.equal(r.status, 400);
    r = await admin('POST', '/api/admin/users', { name: 'Y', email: 'malo', password: 'secreto123' });
    assert.equal(r.status, 400);
    r = await admin('POST', '/api/admin/users', { name: 'Y', email: 'y@example.com', password: 'corta' });
    assert.equal(r.status, 400);
    r = await admin('PATCH', '/api/admin/settings', { apiKey: 'no-es-una-clave' });
    assert.equal(r.status, 400);
    r = await admin('PATCH', '/api/admin/settings', { model: 'otro-modelo' });
    assert.equal(r.status, 400);
    const res = await fetch(`${srv.base}/api/plants`, { method: 'POST', body: 'name=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(res.status, 415, 'solo se aceptan peticiones JSON');
  });

  test('ajustes del panel de administración', async () => {
    let r = await admin('PATCH', '/api/admin/settings', { model: 'claude-sonnet-5-5', dailyLimit: 7 });
    assert.equal(r.status, 200);
    r = await admin('GET', '/api/admin/overview');
    assert.equal(r.data.settings.model, 'claude-sonnet-5-5');
    assert.equal(r.data.settings.apiKeyMasked, '');
    assert.equal(r.data.stats.costMonth, 0);
    // DAILY_DIAGNOSIS_LIMIT en el entorno tiene prioridad sobre el panel.
    assert.equal(r.data.settings.dailyLimit, 3);
  });

  test('debe quedar siempre un administrador activo', async () => {
    const { data: users } = await admin('GET', '/api/admin/users');
    const me = users.find((u) => u.role === 'admin');
    const r = await admin('PATCH', `/api/admin/users/${me.id}`, { role: 'user' });
    assert.equal(r.status, 400);
  });

  test('desactivar un usuario cierra su sesión', async () => {
    const { data: users } = await admin('GET', '/api/admin/users');
    const c = users.find((u) => u.email === 'cliente@example.com');
    await admin('PATCH', `/api/admin/users/${c.id}`, { active: false });
    const r = await customer('GET', '/api/plants');
    assert.equal(r.status, 401);
    const login = await customer('POST', '/api/auth/login', { email: 'cliente@example.com', password: 'secreto123' });
    assert.equal(login.status, 403);
  });
});

describe('análisis real contra un Anthropic simulado', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-test-'));
  let srv;
  let fake;
  const requests = [];
  const admin = client(() => srv.base);

  const answer = {
    es_planta: true,
    planta_identificada: { nombre_comun: 'Monstera', nombre_cientifico: 'Monstera deliciosa', confianza: 'Alta' },
    estado_general: 'leve',
    puntuacion_salud: 140,
    resumen: 'Tiene algunas manchas por exceso de sol.',
    problemas: [{ nombre: 'Quemadura solar', tipo: 'Luz', probabilidad: 'alta', sintomas_observados: ['Manchas'], explicacion: 'Sol directo.' }],
    tratamiento: [{ paso: 'Mover', detalle: 'Aléjala de la ventana.', cuando: 'hoy' }],
    prevencion: ['Luz indirecta'],
    cuidados: { riego: 'Semanal', luz: 'Indirecta', humedad: 'Media', abono: 'Mensual' },
    riego_cada_dias: 7,
    recordatorios_sugeridos: [{ tipo: 'revision', titulo: 'Revisar hojas', en_dias: 7, repetir_cada_dias: null }],
    comparacion_anterior: null,
    calidad_foto: { adecuada: true, sugerencia: null },
    aviso: null,
  };

  before(async () => {
    fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
        res.setHeader('Content-Type', 'application/json');
        if (req.url.startsWith('/api/rest_v1/page/summary/')) {
          return res.end(JSON.stringify({ type: 'standard', title: 'Monstera deliciosa', extract: 'Especie de planta trepadora de la familia Araceae.', thumbnail: { source: 'https://upload.wikimedia.org/monstera.jpg' }, content_urls: { desktop: { page: 'https://es.wikipedia.org/wiki/Monstera_deliciosa' } } }));
        }
        if (req.url.startsWith('/v1/species/match')) {
          return res.end(JSON.stringify({ matchType: 'EXACT', usageKey: 2868241, canonicalName: 'Rarus plantus', family: 'Rarusaceae' }));
        }
        if (req.url.startsWith('/v1/models/')) {
          return res.end(JSON.stringify({ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }));
        }
        res.end(
          JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: JSON.stringify(answer) }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 3000, output_tokens: 2000 },
          })
        );
      });
    }).listen(0);
    await new Promise((r) => fake.once('listening', r));
    const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
    srv = await startPhp({ DATA_DIR: tmp, ANTHROPIC_BASE_URL: fakeUrl, WIKIPEDIA_BASE_URL: fakeUrl, GBIF_BASE_URL: fakeUrl });
    await admin('POST', '/api/auth/setup', { name: 'Admin', email: 'admin@example.com', password: 'secreto123' });
  });
  after(() => {
    srv.proc.kill();
    fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('guardar la clave desde el panel la comprueba primero', async () => {
    const r = await admin('PATCH', '/api/admin/settings', { apiKey: 'sk-ant-api03-PRUEBA_prueba_prueba_12345' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const check = requests.at(-1);
    assert.match(check.url, /^\/v1\/models\//);
    const sentKey = check.headers['x-api-key'] ?? check.headers.authorization?.replace(/^Bearer /, '');
    assert.equal(sentKey, 'sk-ant-api03-PRUEBA_prueba_prueba_12345');
    const o = await admin('GET', '/api/admin/overview');
    assert.equal(o.data.settings.apiKeyMasked, 'sk-ant-…2345');
    assert.equal(o.data.system.demoMode, false);
  });

  test('envía la foto con el formato correcto y guarda el resultado', async () => {
    const r = await admin('POST', '/api/diagnoses', { photo: PNG, new_plant_name: 'Monstera', symptoms: 'Manchas' });
    assert.equal(r.status, 201, JSON.stringify(r.data) + srv.log());

    const sent = requests.at(-1);
    assert.equal(sent.url, '/v1/messages');
    assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    const b = sent.body;
    assert.equal(b.model, 'claude-opus-5-5');
    assert.equal(b.fallbacks, 'default');
    assert.equal(b.max_tokens, 16000);
    assert.equal(b.output_config.effort, 'medium');
    assert.equal(b.output_config.format.type, 'json_schema');
    const schema = b.output_config.format.schema;
    assert.equal(schema.additionalProperties, false, 'el esquema conserva additionalProperties');
    assert.ok(schema.required.includes('puntuacion_salud'));
    assert.deepEqual(schema.properties.estado_general.enum, ['saludable', 'leve', 'moderado', 'grave']);
    const [img, txt] = b.messages[0].content;
    assert.equal(img.type, 'image');
    assert.equal(img.source.media_type, 'image/png');
    assert.equal(img.source.data, PNG.split(',')[1]);
    assert.match(txt.text, /Manchas/);

    // El resultado se normaliza.
    assert.equal(r.data.demo, 0);
    assert.equal(r.data.result.puntuacion_salud, 100);
    assert.equal(r.data.result.planta_identificada.confianza, 'alta');
    assert.equal(r.data.result.problemas[0].tipo, 'luz');

    const o = await admin('GET', '/api/admin/overview');
    // 3000 * 4 / 1M + 2000 * 20 / 1M = 0.052
    assert.equal(o.data.stats.costMonth, 0.052);
    const users = await admin('GET', '/api/admin/users');
    assert.equal(users.data[0].cost_month, 0.052);
  });

  test('el segundo análisis envía el diagnóstico anterior para comparar', async () => {
    const plants = await admin('GET', '/api/plants');
    const r = await admin('POST', '/api/diagnoses', { photo: PNG, plant_id: plants.data[0].id });
    assert.equal(r.status, 201);
    assert.match(requests.at(-1).body.messages[0].content[1].text, /Diagnóstico anterior/);
  });

  test('enlaza la Monstera con su ficha y crea fichas nuevas para especies desconocidas', async () => {
    const list = await admin('GET', '/api/diagnoses');
    const first = await admin('GET', `/api/diagnoses/${list.data.at(-1).id}`);
    assert.equal(first.data.species.nombre_cientifico, 'Monstera deliciosa');

    const original = answer.planta_identificada;
    answer.planta_identificada = { nombre_comun: 'Planta rara', nombre_cientifico: 'Rarus plantus', familia: null, otros_nombres: ['Rareza'], confianza: 'alta' };
    const before = (await admin('GET', '/api/species')).data.length;
    let r = await admin('POST', '/api/diagnoses', { photo: PNG });
    answer.planta_identificada = original;
    assert.equal(r.status, 201);
    const sp = r.data.species;
    assert.equal(sp.nombre_cientifico, 'Rarus plantus');
    assert.equal(sp.verificada, false);
    assert.match(sp.fuente, /IA/);
    assert.equal((await admin('GET', '/api/species')).data.length, before + 1);

    // Al abrir la ficha se completa con Wikipedia y GBIF.
    r = await admin('GET', `/api/species/${sp.id}`);
    assert.equal(r.data.descripcion, 'Especie de planta trepadora de la familia Araceae.');
    assert.equal(r.data.imagen_url, 'https://upload.wikimedia.org/monstera.jpg');
    assert.equal(r.data.familia, 'Rarusaceae');
    assert.equal(r.data.gbif_key, 2868241);
    assert.ok(requests.some((x) => x.url.startsWith('/api/rest_v1/page/summary/') && x.headers['user-agent'].startsWith('FioremiInspector')));

    // La segunda vez se reutiliza la misma ficha.
    answer.planta_identificada = { nombre_comun: 'Rareza', nombre_cientifico: 'Rarus plantus var. minor', confianza: 'media' };
    r = await admin('POST', '/api/diagnoses', { photo: PNG });
    answer.planta_identificada = original;
    assert.equal(r.data.species.id, sp.id);
  });

  test('cambiar a Sonnet desde el panel cambia el modelo usado', async () => {
    await admin('PATCH', '/api/admin/settings', { model: 'claude-sonnet-5-5' });
    await admin('POST', '/api/diagnoses', { photo: PNG });
    assert.equal(requests.at(-1).body.model, 'claude-sonnet-5-5');
  });
});

test('los archivos PHP no tienen errores de sintaxis', () => {
  const files = [path.join(appDir, 'api', 'index.php'), ...fs.readdirSync(path.join(appDir, 'api', 'lib')).map((f) => path.join(appDir, 'api', 'lib', f))];
  for (const f of files) execFileSync('php', ['-l', f], { stdio: 'pipe' });
});

describe('Gemini (gratis) contra un servidor simulado', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-test-'));
  let srv;
  let fake;
  let mode = 'ok';
  const requests = [];
  const admin = client(() => srv.base);
  const answer = {
    es_planta: true,
    planta_identificada: { nombre_comun: 'Orquídea', nombre_cientifico: 'Phalaenopsis', confianza: 'media' },
    estado_general: 'saludable',
    puntuacion_salud: 88,
    resumen: 'Está sana.',
    problemas: [],
    tratamiento: [],
    prevencion: ['Riego moderado'],
    cuidados: { riego: 'Semanal', luz: 'Indirecta', humedad: 'Alta', abono: 'Mensual' },
    riego_cada_dias: 7,
    recordatorios_sugeridos: [],
    comparacion_anterior: null,
    calidad_foto: { adecuada: true, sugerencia: null },
    aviso: null,
  };

  before(async () => {
    fake = http
      .createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
          res.setHeader('Content-Type', 'application/json');
          if (req.headers['x-goog-api-key'] === 'MALA_clave_000000000000000000000000') {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }));
          }
          if (req.url.startsWith('/v1beta/models?') || req.url === '/v1beta/models') {
            const m = (name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] });
            return res.end(JSON.stringify({ models: [m('gemini-2.5-flash'), m('gemini-3.1-flash-lite'), m('gemini-3.0-flash'), m('gemini-3.0-pro'), { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }] }));
          }
          if (mode === 'busy' || (mode === 'busy-first' && req.url.includes('gemini-3.0-flash:'))) {
            res.statusCode = 503;
            return res.end(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } }));
          }
          if (mode === 'limit') {
            res.statusCode = 429;
            return res.end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }));
          }
          const parsed = body ? JSON.parse(body) : {};
          if (mode === 'schema400' && parsed.generationConfig?.responseSchema) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload received. Unknown name "propertyOrdering"' } }));
          }
          if (mode === 'schema400') {
            return res.end(JSON.stringify({
              candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(answer) + '\n```' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
            }));
          }
          res.end(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'pensando…', thought: true }, { text: JSON.stringify(answer) }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 600 },
              modelVersion: 'gemini-3.0-flash',
            })
          );
        });
      })
      .listen(0);
    await new Promise((r) => fake.once('listening', r));
    srv = await startPhp({ DATA_DIR: tmp, GEMINI_BASE_URL: `http://127.0.0.1:${fake.address().port}`, GEMINI_RETRY_PAUSE_MS: '10' });
    await admin('POST', '/api/auth/setup', { name: 'Admin', email: 'admin@example.com', password: 'secreto123' });
  });
  after(() => {
    srv.proc.kill();
    fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('una clave inválida se rechaza con un mensaje claro', async () => {
    const r = await admin('PATCH', '/api/admin/settings', { geminiKey: 'MALA_clave_000000000000000000000000' });
    assert.equal(r.status, 502);
    assert.match(r.data.error, /clave de Gemini no es válida/);
  });

  test('guardar la clave elige el mejor modelo Flash y activa Gemini', async () => {
    const r = await admin('PATCH', '/api/admin/settings', { geminiKey: 'AIzaPRUEBA_prueba_prueba_prueba_1234', provider: 'gemini' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const o = await admin('GET', '/api/admin/overview');
    assert.equal(o.data.settings.provider, 'gemini');
    assert.equal(o.data.settings.geminiModel, 'gemini-3.0-flash');
    assert.equal(o.data.system.demoMode, false);
  });

  test('acepta también el formato nuevo de clave de Google (AQ.…)', async () => {
    const r = await admin('PATCH', '/api/admin/settings', { geminiKey: 'AQ.Ab8RN6KrPrueba_prueba-prueba.1234567890' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(requests.at(-1).headers['x-goog-api-key'], 'AQ.Ab8RN6KrPrueba_prueba-prueba.1234567890');
    // Volver a la clave usada por las pruebas siguientes.
    await admin('PATCH', '/api/admin/settings', { geminiKey: 'AIzaPRUEBA_prueba_prueba_prueba_1234' });
  });

  test('analiza la foto con Gemini y no suma gasto', async () => {
    const r = await admin('POST', '/api/diagnoses', { photo: PNG, new_plant_name: 'Orquídea', symptoms: 'Hojas firmes' });
    assert.equal(r.status, 201, JSON.stringify(r.data) + srv.log());
    assert.equal(r.data.result.planta_identificada.nombre_comun, 'Orquídea');
    assert.equal(r.data.result.puntuacion_salud, 88);
    assert.deepEqual(r.data.result.planta_identificada.otros_nombres, []);
    assert.equal(r.data.result.planta_identificada.familia, null);
    assert.equal(r.data.demo, 0);

    const sent = requests.at(-1);
    assert.equal(sent.url, '/v1beta/models/gemini-3.0-flash:generateContent');
    assert.equal(sent.headers['x-goog-api-key'], 'AIzaPRUEBA_prueba_prueba_prueba_1234');
    const b = sent.body;
    assert.equal(b.contents[0].parts[0].inlineData.mimeType, 'image/png');
    assert.equal(b.contents[0].parts[0].inlineData.data, PNG.split(',')[1]);
    assert.match(b.contents[0].parts[1].text, /Hojas firmes/);
    assert.match(b.systemInstruction.parts[0].text, /fitopatólogo/);
    const schema = b.generationConfig.responseSchema;
    assert.equal(b.generationConfig.responseMimeType, 'application/json');
    assert.equal(schema.type, 'OBJECT');
    assert.equal(schema.additionalProperties, undefined, 'Gemini no admite additionalProperties');
    assert.deepEqual(schema.properties.estado_general.enum, ['saludable', 'leve', 'moderado', 'grave']);
    assert.deepEqual(schema.properties.aviso, { nullable: true, type: 'STRING' });
    assert.ok(schema.properties.planta_identificada.properties.otros_nombres);
    assert.equal(schema.properties.problemas.items.type, 'OBJECT');

    const o = await admin('GET', '/api/admin/overview');
    assert.equal(o.data.stats.costMonth, 0);
  });

  test('si Google rechaza el formato, reintenta sin esquema y funciona', async () => {
    mode = 'schema400';
    const before = requests.length;
    const r = await admin('POST', '/api/diagnoses', { photo: PNG, new_plant: true, new_plant_name: '' });
    mode = 'ok';
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const calls = requests.slice(before).filter((x) => x.url.includes(':generateContent'));
    assert.equal(calls.length, 2, 'primero con esquema, luego sin él');
    assert.ok(calls[0].body.generationConfig.responseSchema);
    assert.equal(calls[1].body.generationConfig.responseSchema, undefined);
    assert.match(calls[1].body.contents[0].parts[1].text, /Responde ÚNICAMENTE con un objeto JSON/);
    // Sin nombre: la planta se guarda con el nombre que detectó la IA.
    assert.equal(r.data.plant_name, 'Orquídea');
  });

  test('si el modelo está saturado, prueba con el siguiente modelo', async () => {
    mode = 'busy-first';
    const before = requests.length;
    const r = await admin('POST', '/api/diagnoses', { photo: PNG });
    mode = 'ok';
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const calls = requests.slice(before).filter((x) => x.url.includes(':generateContent'));
    assert.equal(calls[0].url, '/v1beta/models/gemini-3.0-flash:generateContent');
    assert.equal(calls[1].url, '/v1beta/models/gemini-2.5-flash:generateContent');
  });

  test('si todos los modelos están saturados, avisa en español', async () => {
    mode = 'busy';
    const r = await admin('POST', '/api/diagnoses', { photo: PNG });
    mode = 'ok';
    assert.equal(r.status, 503);
    assert.match(r.data.error, /saturados/);
  });

  test('si se acaba el límite gratuito avisa con un mensaje claro', async () => {
    mode = 'limit';
    const r = await admin('POST', '/api/diagnoses', { photo: PNG });
    mode = 'ok';
    assert.equal(r.status, 503);
    assert.match(r.data.error, /límite gratuito de Gemini/);
  });
});
