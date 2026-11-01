import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Base de datos temporal y modo demostración (sin llamadas reales a la IA).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-test-'));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';
process.env.DAILY_DIAGNOSIS_LIMIT = '3';

const { createApp } = await import('../server/index.js');
const { normalizeResult } = await import('../server/ai.js');

let server;
let base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Cliente HTTP mínimo que guarda la cookie de sesión.
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, data };
  };
}

// PNG de 1x1 píxel.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const admin = client();
const customer = client();
const stranger = client();

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

  r = await customer('GET', '/api/admin/users');
  assert.equal(r.status, 403, 'un cliente no entra al panel de administración');

  r = await admin('PATCH', '/api/admin/settings', { allowRegistration: true });
  r = await stranger('POST', '/api/auth/register', { name: 'Nuevo', email: 'nuevo@example.com', password: 'secreto123' });
  assert.equal(r.status, 201);
});

test('flujo completo: analizar, guardar planta, recordatorios y evolución', async () => {
  // Análisis creando una planta nueva.
  let r = await customer('POST', '/api/diagnoses', { photo: PNG, new_plant_name: 'Potus del salón', symptoms: 'Hojas amarillas' });
  assert.equal(r.status, 201);
  assert.equal(r.data.demo, 1);
  assert.ok(r.data.plant_id);
  const plantId = r.data.plant_id;
  const first = r.data;

  // La planta tiene recordatorio de riego automático.
  r = await customer('GET', `/api/plants/${plantId}`);
  assert.equal(r.data.plant.name, 'Potus del salón');
  assert.equal(r.data.plant.water_every_days, 8);
  assert.equal(r.data.reminders.filter((x) => x.type === 'riego').length, 1);

  // Activar recordatorios sugeridos (revisión y abono).
  r = await customer('POST', `/api/diagnoses/${first.id}/apply`, { reminders: [0, 2] });
  assert.equal(r.data.created, 2);
  r = await customer('GET', '/api/reminders');
  assert.equal(r.data.reminders.length, 3);

  // Completar un recordatorio repetitivo crea el siguiente y lo apunta en el diario.
  const abono = r.data.reminders.find((x) => x.type === 'abono');
  r = await customer('POST', `/api/reminders/${abono.id}/done`);
  assert.equal(r.status, 200);
  r = await customer('GET', `/api/plants/${plantId}`);
  assert.ok(r.data.care.some((c) => c.type === 'abono'));
  assert.equal(r.data.reminders.filter((x) => x.type === 'abono').length, 1);

  // Regar reprograma el riego.
  r = await customer('POST', `/api/plants/${plantId}/care`, { type: 'riego' });
  assert.equal(r.status, 201);
  r = await customer('GET', `/api/plants/${plantId}`);
  const riego = r.data.reminders.find((x) => x.type === 'riego');
  assert.ok(riego.due_date > new Date().toISOString().slice(0, 10));
  assert.ok(r.data.plant.last_watered_at);

  // Segundo análisis de la misma planta: compara con el anterior.
  r = await customer('POST', '/api/diagnoses', { photo: PNG, plant_id: plantId });
  assert.equal(r.status, 201);
  assert.ok(r.data.result.comparacion_anterior);
  assert.ok(r.data.health_score > first.health_score);

  r = await customer('GET', `/api/plants/${plantId}`);
  assert.equal(r.data.diagnoses.length, 2);

  // Las fotos solo las ve su dueño.
  const photo = r.data.plant.photo;
  r = await customer('GET', `/api/photos/${photo}`);
  assert.equal(r.status, 200);
  r = await stranger('GET', `/api/photos/${photo}`);
  assert.equal(r.status, 404);
  r = await stranger('GET', `/api/plants/${plantId}`);
  assert.equal(r.status, 404, 'otro usuario no ve la planta');
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
  // El cliente ya hizo 2; el límite de prueba es 3.
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

test('normalizeResult corrige valores fuera de lo esperado', () => {
  const r = normalizeResult({
    planta_identificada: { nombre_comun: 'x', nombre_cientifico: null, confianza: 'Alta' },
    estado_general: 'MODERADO',
    puntuacion_salud: 140,
    problemas: [{ tipo: 'Daño físico', probabilidad: 'rarísima' }],
    tratamiento: [{ cuando: 'esta semana' }],
    recordatorios_sugeridos: [{ tipo: 'Revisión', titulo: 't', en_dias: -3, repetir_cada_dias: 0 }],
    riego_cada_dias: 0,
  });
  assert.equal(r.planta_identificada.confianza, 'alta');
  assert.equal(r.estado_general, 'moderado');
  assert.equal(r.puntuacion_salud, 100);
  assert.equal(r.problemas[0].tipo, 'daño_fisico');
  assert.equal(r.problemas[0].probabilidad, 'media');
  assert.equal(r.tratamiento[0].cuando, 'esta_semana');
  assert.equal(r.recordatorios_sugeridos[0].tipo, 'revision');
  assert.equal(r.recordatorios_sugeridos[0].en_dias, 0);
  assert.equal(r.recordatorios_sugeridos[0].repetir_cada_dias, null);
  assert.equal(r.riego_cada_dias, null);
});
