// Fioremi Inspector: interfaz de una sola página sin dependencias.

// ---------- Utilidades ----------

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
const raw = (s) => new Raw(s);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Plantilla HTML que escapa todo salvo lo marcado con raw() o arrays de raw.
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('');
    else if (v instanceof Raw) out += v.s;
    else if (v === false || v === null || v === undefined) out += '';
    else out += esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* sin cuerpo */
  }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    state.user = null;
    location.hash = '#/login';
  }
  if (!res.ok) throw new Error(data?.error || 'Algo salió mal. Inténtalo de nuevo.');
  return data;
}

let toastTimer;
function toast(message, type = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

const photoUrl = (name) => (name ? `api/photos/${encodeURIComponent(name)}` : null);

function parseDate(s) {
  if (!s) return null;
  // Fechas de SQLite ("YYYY-MM-DD HH:MM:SS") están en UTC.
  return new Date(s.length === 10 ? `${s}T12:00:00` : `${s.replace(' ', 'T')}Z`);
}
const fmtDate = (s, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  s ? parseDate(s).toLocaleDateString('es', opts) : '';
const fmtDateTime = (s) =>
  s ? parseDate(s).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysUntil(dateStr) {
  const a = new Date(`${localToday()}T12:00:00`);
  const b = new Date(`${dateStr}T12:00:00`);
  return Math.round((b - a) / 86400000);
}
function dueLabel(dateStr) {
  const d = daysUntil(dateStr);
  if (d < -1) return raw(`<span class="overdue">Hace ${-d} días</span>`);
  if (d === -1) return raw('<span class="overdue">Ayer</span>');
  if (d === 0) return raw('<span class="due-today">Hoy</span>');
  if (d === 1) return 'Mañana';
  if (d < 7) return `En ${d} días`;
  return fmtDate(dateStr, { day: 'numeric', month: 'short' });
}

const STATUS_LABEL = { saludable: 'Saludable', leve: 'Problema leve', moderado: 'Problema moderado', grave: 'Problema grave' };
const STATUS_ICON = { saludable: '💚', leve: '🟡', moderado: '🟠', grave: '🔴' };
const REMINDER_ICON = {
  riego: '💧',
  abono: '🌱',
  tratamiento: '🧴',
  revision: '🔍',
  poda: '✂️',
  trasplante: '🪴',
  otro: '📌',
  nota: '📝',
};
const REMINDER_LABEL = {
  riego: 'Riego',
  abono: 'Abono',
  tratamiento: 'Tratamiento',
  revision: 'Revisión',
  poda: 'Poda',
  trasplante: 'Trasplante',
  otro: 'Otro',
  nota: 'Nota',
};
const PROBLEM_ICON = {
  plaga: '🐛',
  hongo: '🍄',
  bacteria: '🦠',
  virus: '🧬',
  riego: '💧',
  luz: '☀️',
  nutrientes: '🧪',
  temperatura: '🌡️',
  daño_fisico: '🩹',
  otro: '❓',
};
const WHEN_LABEL = { hoy: 'Hoy', esta_semana: 'Esta semana', continuo: 'De forma continua' };

function keyForm(which, masked, hint, placeholder) {
  return html`<form data-key-form="${which}">
    ${masked ? html`<p class="small" style="margin:0 0 6px">Guardada: <code>${masked}</code> ✅</p>` : ''}
    <div class="row"><input name="key" type="password" autocomplete="off" class="grow" style="width:auto" aria-label="Clave de ${which === 'gemini' ? 'Gemini' : 'Claude'}"
      placeholder="${masked ? 'Pega una clave nueva para cambiarla' : placeholder}" />
      <button class="btn primary" type="submit">Guardar</button></div>
    <p class="hint">${hint}</p>
    <p class="error-msg"></p>
    ${masked ? html`<button class="btn small danger" type="button" data-remove-key>Quitar clave</button>` : ''}
  </form>`;
}

const money = (n) => `$${Number(n || 0).toFixed(Number(n || 0) < 1 ? 3 : 2)}`;

const statusPill = (status) =>
  status ? html`<span class="pill ${status}">${STATUS_ICON[status]} ${STATUS_LABEL[status]}</span>` : '';

function thumb(photo, fallback = '🪴') {
  return photo ? html`<img src="${photoUrl(photo)}" alt="" loading="lazy" />` : fallback;
}

function healthColor(score) {
  if (score >= 80) return 'var(--ok)';
  if (score >= 55) return 'var(--warn)';
  return 'var(--bad)';
}

function gauge(score) {
  const r = 48;
  const c = 2 * Math.PI * r;
  const off = c * (1 - score / 100);
  return html`<div class="gauge" role="img" aria-label="Salud ${score} de 100">
    <svg viewBox="0 0 112 112" width="112" height="112">
      <circle cx="56" cy="56" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="12" />
      <circle cx="56" cy="56" r="${r}" fill="none" stroke="${healthColor(score)}" stroke-width="12"
        stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" />
    </svg>
    <div class="val"><div><b>${score}</b><span>de 100</span></div></div>
  </div>`;
}

// Reduce la foto en el navegador antes de enviarla (más rápido y barato).
async function resizeImage(file, maxSide = 1568) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('No se pudo leer la imagen. Prueba con una foto JPG o PNG.'));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function render(content) {
  app.innerHTML = String(content);
  window.scrollTo(0, 0);
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function showModal(content, onMount) {
  const dlg = $('#modal');
  dlg.innerHTML = `<div class="modal-body">${content}</div>`;
  dlg.showModal();
  dlg.onclick = (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
  };
  onMount?.(dlg);
  return dlg;
}

async function confirmDialog(message, okLabel = 'Sí, continuar') {
  return new Promise((resolve) => {
    const dlg = showModal(
      html`<p>${message}</p>
        <div class="btn-row" style="justify-content:flex-end">
          <button class="btn" data-close>Cancelar</button>
          <button class="btn primary" id="confirm-ok">${okLabel}</button>
        </div>`
    );
    $('#confirm-ok', dlg).onclick = () => {
      dlg.close();
      resolve(true);
    };
    dlg.addEventListener('close', () => resolve(false), { once: true });
  });
}

// Envía un formulario mostrando errores y desactivando el botón.
function handleForm(form, fn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    const errEl = form.querySelector('.error-msg');
    if (errEl) errEl.textContent = '';
    if (btn) btn.disabled = true;
    try {
      await fn(formData(form), form);
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
      else toast(err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

// ---------- Estado y enrutado ----------

const state = { user: null, status: null };

const routes = [
  [/^\/setup$/, viewSetup, { public: true }],
  [/^\/login$/, viewLogin, { public: true }],
  [/^\/registro$/, viewRegister, { public: true }],
  [/^\/$/, viewHome],
  [/^\/analizar$/, viewAnalyze],
  [/^\/diagnostico\/(\d+)$/, viewDiagnosis],
  [/^\/plantas$/, viewPlants],
  [/^\/planta\/(\d+)$/, viewPlant],
  [/^\/recordatorios$/, viewReminders],
  [/^\/historial$/, viewHistory],
  [/^\/cuenta$/, viewAccount],
  [/^\/admin$/, viewAdmin, { admin: true }],
];

async function loadStatus() {
  state.status = await api('/auth/status');
  state.user = state.status.user;
  $('#demo-banner').hidden = !state.status.demoMode || !state.user;
}

async function router() {
  const [path, query = ''] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(query);
  const match = routes.find(([re]) => re.test(path));
  if (!match) {
    location.hash = '#/';
    return;
  }
  const [re, view, opts = {}] = match;

  if (state.status?.needsSetup && path !== '/setup') return (location.hash = '#/setup');
  if (!opts.public && !state.user) return (location.hash = '#/login');
  if (opts.public && state.user) return (location.hash = '#/');
  if (opts.admin && state.user?.role !== 'admin') return (location.hash = '#/');

  const loggedIn = Boolean(state.user);
  $('#nav').hidden = !loggedIn;
  $('#topbar').hidden = !loggedIn;
  $('#demo-banner').hidden = !state.status?.demoMode || !loggedIn;
  if (loggedIn) {
    $('#topbar-user').textContent = state.user.name.trim().charAt(0).toUpperCase();
    const section = path.split('/')[1] || 'inicio';
    const navMap = { planta: 'plantas', diagnostico: 'historial', cuenta: '', admin: '' };
    const active = navMap[section] ?? section;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === active));
  }

  try {
    await view(...path.match(re).slice(1), params);
  } catch (err) {
    render(html`<div class="empty"><div class="big">🥀</div><p>${err.message}</p>
      <a class="btn" href="#/">Volver al inicio</a></div>`);
  }
  if (loggedIn) refreshBadge();
}

async function refreshBadge() {
  try {
    const { reminders } = await api('/reminders');
    const due = reminders.filter((r) => daysUntil(r.due_date) <= 0);
    const badge = $('#nav-badge');
    badge.hidden = due.length === 0;
    badge.textContent = due.length;
    maybeNotify(due);
  } catch {
    /* ignorar */
  }
}

// Notificación del navegador una vez al día si hay tareas pendientes.
async function maybeNotify(due) {
  if (!due.length || !('Notification' in window) || Notification.permission !== 'granted') return;
  const key = 'ip-notified';
  let last = null;
  try {
    last = localStorage.getItem(key);
  } catch {
    /* almacenamiento no disponible */
  }
  if (last === localToday()) return;
  try {
    localStorage.setItem(key, localToday());
  } catch {
    /* ignorar */
  }
  const body =
    due.length === 1 ? due[0].title : `${due.length} cuidados pendientes: ${due.slice(0, 3).map((r) => r.title).join(', ')}…`;
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) reg.showNotification('Tus plantas te necesitan 🌿', { body, icon: 'icons/icon-192.png', tag: 'ip-due' });
  else new Notification('Tus plantas te necesitan 🌿', { body });
}

// ---------- Vistas: acceso ----------

function authShell(title, subtitle, form, footer = '') {
  render(html`<div class="auth-wrap">
    <img class="auth-logo logo-img" src="icons/logo.png" alt="Logo de Fioremi" />
    <h1 class="center">${title}</h1>
    <p class="center muted">${subtitle}</p>
    <div class="card">${form}</div>
    ${footer}
  </div>`);
}

const passwordField = (name = 'password', label = 'Contraseña', autocomplete = 'new-password') =>
  html`<div class="field"><label for="${name}">${label} <span class="hint">(mínimo 8 caracteres)</span></label>
    <input id="${name}" name="${name}" type="password" minlength="8" required autocomplete="${autocomplete}" /></div>`;

function viewSetup() {
  if (!state.status.needsSetup) return (location.hash = '#/login');
  authShell(
    '¡Te damos la bienvenida!',
    'Crea la cuenta de administración. Con ella podrás usar la app y, más adelante, dar acceso a tus clientes.',
    html`<form id="f">
      <div class="field"><label for="name">Tu nombre</label><input id="name" name="name" type="text" required autocomplete="name" /></div>
      <div class="field"><label for="email">Correo electrónico</label><input id="email" name="email" type="email" required autocomplete="email" /></div>
      ${passwordField()}
      <p class="error-msg"></p>
      <button class="btn primary block" type="submit">Crear cuenta y empezar</button>
    </form>`
  );
  handleForm($('#f'), async (data) => {
    await api('/auth/setup', { method: 'POST', body: data });
    await loadStatus();
    location.hash = '#/';
  });
}

function viewLogin() {
  const reg = state.status.allowRegistration;
  authShell(
    'Fioremi Inspector',
    'Analiza tus plantas con inteligencia artificial.',
    html`<form id="f">
      <div class="field"><label for="email">Correo electrónico</label><input id="email" name="email" type="email" required autocomplete="email" /></div>
      <div class="field"><label for="password">Contraseña</label><input id="password" name="password" type="password" required autocomplete="current-password" /></div>
      <p class="error-msg"></p>
      <button class="btn primary block" type="submit">Entrar</button>
    </form>`,
    reg
      ? html`<p class="center">¿No tienes cuenta? <a href="#/registro">Regístrate</a></p>`
      : html`<p class="center muted small">¿No tienes cuenta? Pídesela al administrador.</p>`
  );
  handleForm($('#f'), async (data) => {
    await api('/auth/login', { method: 'POST', body: data });
    await loadStatus();
    location.hash = '#/';
  });
}

function viewRegister() {
  if (!state.status.allowRegistration) return (location.hash = '#/login');
  authShell(
    'Crear cuenta',
    'Regístrate para analizar y cuidar tus plantas.',
    html`<form id="f">
      <div class="field"><label for="name">Tu nombre</label><input id="name" name="name" type="text" required autocomplete="name" /></div>
      <div class="field"><label for="email">Correo electrónico</label><input id="email" name="email" type="email" required autocomplete="email" /></div>
      ${passwordField()}
      <p class="error-msg"></p>
      <button class="btn primary block" type="submit">Crear cuenta</button>
    </form>`,
    html`<p class="center">¿Ya tienes cuenta? <a href="#/login">Entra</a></p>`
  );
  handleForm($('#f'), async (data) => {
    await api('/auth/register', { method: 'POST', body: data });
    await loadStatus();
    location.hash = '#/';
  });
}

// ---------- Vista: inicio ----------

function reminderItem(r, { showPlant = true } = {}) {
  return html`<li data-reminder="${r.id}">
    <div class="avatar">${r.plant_photo && showPlant ? thumb(r.plant_photo) : REMINDER_ICON[r.type] || '📌'}</div>
    <div class="grow">
      <div class="wrap-text"><b>${REMINDER_ICON[r.type] || ''} ${r.title}</b></div>
      <div class="small muted">${dueLabel(r.due_date)}${r.repeat_days ? ` · cada ${r.repeat_days} días` : ''}${
        showPlant && r.plant_name ? ` · ${r.plant_name}` : ''
      }</div>
    </div>
    <button class="btn small primary" data-action="done" aria-label="Marcar como hecho">✓<span class="hide-xs"> Hecho</span></button>
    <button class="btn small ghost" data-action="more" aria-label="Más opciones">⋯</button>
  </li>`;
}

// Acciones de recordatorios en cualquier lista.
function bindReminderActions(root, onChange) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    const li = e.target.closest('[data-reminder]');
    if (!btn || !li) return;
    const id = li.dataset.reminder;
    try {
      if (btn.dataset.action === 'done') {
        btn.disabled = true;
        await api(`/reminders/${id}/done`, { method: 'POST' });
        toast('¡Hecho! 🌿');
        onChange();
      } else if (btn.dataset.action === 'more') {
        const dlg = showModal(html`<h3>Opciones</h3>
          <div class="stack">
            <button class="btn block" data-snooze="1">Posponer 1 día</button>
            <button class="btn block" data-snooze="3">Posponer 3 días</button>
            <button class="btn block" data-snooze="7">Posponer 1 semana</button>
            <button class="btn block danger" data-delete>Eliminar recordatorio</button>
            <button class="btn block ghost" data-close>Cancelar</button>
          </div>`);
        dlg.querySelectorAll('[data-snooze]').forEach((b) =>
          b.addEventListener('click', async () => {
            await api(`/reminders/${id}/snooze`, { method: 'POST', body: { days: Number(b.dataset.snooze) } });
            dlg.close();
            toast('Recordatorio pospuesto');
            onChange();
          })
        );
        $('[data-delete]', dlg).addEventListener('click', async () => {
          await api(`/reminders/${id}`, { method: 'DELETE' });
          dlg.close();
          toast('Recordatorio eliminado');
          onChange();
        });
      }
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

async function viewHome() {
  const [plants, { reminders }, diagnoses] = await Promise.all([
    api('/plants'),
    api('/reminders'),
    api('/diagnoses'),
  ]);
  const due = reminders.filter((r) => daysUntil(r.due_date) <= 0);
  const needAttention = plants
    .filter((p) => p.last_status && p.last_status !== 'saludable')
    .sort((a, b) => (a.last_health ?? 100) - (b.last_health ?? 100))
    .slice(0, 4);
  const hour = new Date().getHours();
  const greet = hour < 13 ? 'Buenos días' : hour < 20 ? 'Buenas tardes' : 'Buenas noches';

  render(html`
    <h1>${greet}, ${state.user.name.split(' ')[0]} 🌿</h1>
    <p class="muted">${
      plants.length
        ? `Tienes ${plants.length} ${plants.length === 1 ? 'planta' : 'plantas'} y ${due.length} ${due.length === 1 ? 'cuidado pendiente' : 'cuidados pendientes'} hoy.`
        : 'Empieza analizando tu primera planta.'
    }</p>

    <a href="#/analizar" class="card row" style="text-decoration:none;color:inherit;background:var(--primary-soft);border-color:transparent">
      <div style="font-size:2.4rem">📷</div>
      <div class="grow"><b>Analizar una planta</b><div class="small muted">Haz una foto y descubre qué le pasa y cómo cuidarla.</div></div>
      <div style="font-size:1.4rem">›</div>
    </a>

    ${
      due.length
        ? html`<div class="section-title"><h2>Para hoy</h2><a href="#/recordatorios" class="small">Ver todo</a></div>
          <div class="card"><ul class="list" id="due-list">${due.slice(0, 6).map((r) => reminderItem(r))}</ul></div>`
        : plants.length
          ? html`<div class="card row"><div style="font-size:1.8rem">✅</div><div class="grow">Todo al día. No hay cuidados pendientes hoy.</div></div>`
          : ''
    }

    ${
      needAttention.length
        ? html`<div class="section-title"><h2>Necesitan atención</h2></div>
          <div class="plant-grid">${needAttention.map(plantCard)}</div>`
        : ''
    }

    ${
      diagnoses.length
        ? html`<div class="section-title"><h2>Últimos análisis</h2><a href="#/historial" class="small">Ver historial</a></div>
          <div class="card"><ul class="list">${diagnoses.slice(0, 4).map(diagnosisItem)}</ul></div>`
        : ''
    }

    ${
      !plants.length && !diagnoses.length
        ? html`<div class="card">
          <h2>¿Cómo funciona?</h2>
          <ol class="steps">
            <li><b>Haz una foto</b> de la planta, mejor con luz natural y mostrando las hojas afectadas.</li>
            <li><b>La IA la analiza</b>: identifica la planta, detecta plagas, hongos o problemas de riego y luz.</li>
            <li><b>Recibe consejos</b> claros y paso a paso para tratarla y prevenir que vuelva a pasar.</li>
            <li><b>Guárdala en tus plantas</b> para tener su historial, recordatorios de riego y ver su evolución.</li>
          </ol>
        </div>`
        : ''
    }
  `);
  const dueList = $('#due-list');
  if (dueList) bindReminderActions(dueList, () => router());
}

function plantCard(p) {
  return html`<a class="plant-card" href="#/planta/${p.id}">
    <div class="thumb">${thumb(p.photo)}</div>
    <div class="body">
      <div class="name ellipsis">${p.name}</div>
      <div class="small muted ellipsis">${p.species || 'Sin especie'}</div>
      <div style="margin-top:6px">${p.last_status ? statusPill(p.last_status) : html`<span class="pill">Sin analizar</span>`}</div>
    </div>
  </a>`;
}

function diagnosisItem(d) {
  return html`<li><a class="item-link" href="#/diagnostico/${d.id}">
    <div class="avatar">${thumb(d.photo)}</div>
    <div class="grow">
      <div class="ellipsis"><b>${d.plant_name || d.species || 'Planta'}</b></div>
      <div class="small muted">${fmtDateTime(d.created_at)}${d.demo ? ' · demo' : ''}</div>
    </div>
    ${d.status ? statusPill(d.status) : html`<span class="pill">No es una planta</span>`}
  </a></li>`;
}

// ---------- Vista: analizar ----------

async function viewAnalyze(params) {
  const plants = await api('/plants');
  const preselect = params.get('planta') || '';
  let photoData = null;

  render(html`
    <h1>Analizar una planta</h1>
    <p class="muted">Haz una foto o elige una de tu galería. La inteligencia artificial te dirá qué le pasa y cómo ayudarla.</p>

    <form id="f">
      <div class="field">
        <div id="photo-zone" class="photo-drop">
          <div class="big">📷</div>
          <p><b>Añade una foto de la planta</b></p>
          <div class="btn-row" style="justify-content:center">
            <label class="btn primary" style="margin:0">Hacer foto
              <input type="file" accept="image/*" capture="environment" id="cam" hidden /></label>
            <label class="btn" style="margin:0">Elegir de la galería
              <input type="file" accept="image/*" id="gal" hidden /></label>
          </div>
          <ul class="tips" style="text-align:left">
            <li>Usa luz natural, sin flash.</li>
            <li>Enfoca bien las hojas o la zona dañada.</li>
            <li>Si puedes, muestra también la planta entera y la tierra.</li>
          </ul>
        </div>
        <div id="preview" class="photo-preview" hidden>
          <img id="preview-img" alt="Foto seleccionada" />
          <button type="button" class="btn small" id="change-photo">Cambiar foto</button>
        </div>
      </div>

      <div class="field">
        <label for="plant_id">¿De qué planta se trata?</label>
        <select id="plant_id" name="plant_id">
          <option value="">Solo analizar (sin guardar en una planta)</option>
          <option value="new">➕ Es una planta nueva: guardarla</option>
          ${plants.map((p) => html`<option value="${p.id}" ${String(p.id) === preselect ? raw('selected') : ''}>${p.name}${p.species ? ` (${p.species})` : ''}</option>`)}
        </select>
        <p class="hint">Si la guardas, tendrás su historial, recordatorios y podrás ver cómo evoluciona.</p>
      </div>
      <div class="field" id="new-name-field" hidden>
        <label for="new_plant_name">Nombre para tu planta</label>
        <input type="text" id="new_plant_name" name="new_plant_name" maxlength="80" placeholder="Ej.: Potus del salón" />
      </div>
      <div class="field">
        <label for="symptoms">¿Qué le notas? <span class="hint">(opcional, ayuda a acertar)</span></label>
        <textarea id="symptoms" name="symptoms" maxlength="2000" placeholder="Ej.: Hace una semana empezaron a salir manchas marrones. La riego cada 3 días y está junto a una ventana."></textarea>
      </div>
      <p class="error-msg"></p>
      <button class="btn primary block" type="submit" id="submit" disabled>🔍 Analizar planta</button>
    </form>
  `);

  const sel = $('#plant_id');
  const syncNew = () => {
    $('#new-name-field').hidden = sel.value !== 'new';
    $('#new_plant_name').required = sel.value === 'new';
  };
  sel.addEventListener('change', syncNew);

  const onFile = async (input) => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      photoData = await resizeImage(file);
      $('#preview-img').src = photoData;
      $('#photo-zone').hidden = true;
      $('#preview').hidden = false;
      $('#submit').disabled = false;
    } catch (err) {
      toast(err.message, 'error');
    }
    input.value = '';
  };
  $('#cam').addEventListener('change', (e) => onFile(e.target));
  $('#gal').addEventListener('change', (e) => onFile(e.target));
  $('#change-photo').addEventListener('click', () => {
    photoData = null;
    $('#photo-zone').hidden = false;
    $('#preview').hidden = true;
    $('#submit').disabled = true;
  });

  handleForm($('#f'), async (data, form) => {
    if (!photoData) throw new Error('Primero añade una foto.');
    const body = { photo: photoData, symptoms: data.symptoms };
    if (data.plant_id === 'new') body.new_plant_name = data.new_plant_name;
    else if (data.plant_id) body.plant_id = Number(data.plant_id);

    form.hidden = true;
    const loading = document.createElement('div');
    loading.className = 'analyzing';
    loading.innerHTML = String(html`<div class="leaf">🌿</div><h2>Analizando tu planta…</h2>
      <p class="muted" id="loading-msg">Observando hojas, tallos y tierra.</p><div class="spinner"></div>`);
    app.appendChild(loading);
    const msgs = [
      'Identificando la especie…',
      'Buscando plagas y hongos…',
      'Revisando señales de riego y luz…',
      'Preparando consejos para ti…',
    ];
    let i = 0;
    const timer = setInterval(() => {
      const el = $('#loading-msg');
      if (el) el.textContent = msgs[i++ % msgs.length];
    }, 3500);
    try {
      const d = await api('/diagnoses', { method: 'POST', body });
      location.hash = `#/diagnostico/${d.id}`;
    } catch (err) {
      loading.remove();
      form.hidden = false;
      throw err;
    } finally {
      clearInterval(timer);
    }
  });
  syncNew();
}

// ---------- Vista: diagnóstico ----------

async function viewDiagnosis(id) {
  const d = await api(`/diagnoses/${id}`);
  const r = d.result;
  const plants = d.plant_id ? [] : await api('/plants');

  if (!r.es_planta) {
    render(html`
      <div class="diag-photo"><img src="${photoUrl(d.photo)}" alt="Foto analizada" /></div>
      <div class="card"><h2>🤔 No parece una planta</h2><p>${r.resumen}</p>
        ${r.calidad_foto.sugerencia ? html`<p class="muted">${r.calidad_foto.sugerencia}</p>` : ''}
        <a class="btn primary" href="#/analizar">Probar con otra foto</a></div>`);
    return;
  }

  const byWhen = ['hoy', 'esta_semana', 'continuo']
    .map((w) => [w, r.tratamiento.filter((t) => t.cuando === w)])
    .filter(([, items]) => items.length);

  render(html`
    ${d.demo ? html`<div class="notice">🧪 <b>Diagnóstico de ejemplo.</b> La app está en modo demostración y no ha analizado tu foto de verdad.</div>` : ''}
    <div class="diag-photo"><img src="${photoUrl(d.photo)}" alt="Foto analizada" /></div>

    <div class="card">
      <div class="diag-head">
        ${gauge(r.puntuacion_salud)}
        <div>
          <h1 style="margin-bottom:4px">${r.planta_identificada.nombre_comun}</h1>
          ${r.planta_identificada.nombre_cientifico ? html`<div class="muted small"><i>${r.planta_identificada.nombre_cientifico}</i> · confianza ${r.planta_identificada.confianza}</div>` : ''}
          <div style="margin-top:8px">${statusPill(r.estado_general)}</div>
          ${d.plant_name ? html`<div class="small" style="margin-top:6px">🪴 <a href="#/planta/${d.plant_id}">${d.plant_name}</a></div>` : ''}
          <div class="small muted">${fmtDateTime(d.created_at)}</div>
        </div>
      </div>
      <p style="margin-top:14px">${r.resumen}</p>
      ${r.comparacion_anterior ? html`<div class="notice info">📈 <b>Evolución:</b> ${r.comparacion_anterior}</div>` : ''}
    </div>

    ${r.aviso ? html`<div class="notice bad">⚠️ ${r.aviso}</div>` : ''}
    ${!r.calidad_foto.adecuada && r.calidad_foto.sugerencia ? html`<div class="notice">📸 <b>Consejo para la foto:</b> ${r.calidad_foto.sugerencia}</div>` : ''}

    ${
      !d.plant_id
        ? html`<div class="card"><h3>Guardar en una planta</h3>
          <p class="small muted">Así tendrás su historial, recordatorios y su evolución.</p>
          <form id="link-form" class="row">
            <select name="plant_id" class="grow" style="width:auto">
              <option value="new">➕ Crear planta nueva</option>
              ${plants.map((p) => html`<option value="${p.id}">${p.name}</option>`)}
            </select>
            <button class="btn primary" type="submit">Guardar</button>
          </form></div>`
        : ''
    }

    ${
      r.problemas.length
        ? html`<div class="card"><h2>¿Qué le pasa?</h2>
          ${r.problemas.map(
            (p) => html`<div class="problem ${p.probabilidad}">
              <div class="row between"><h3 style="margin:0">${PROBLEM_ICON[p.tipo] || '❓'} ${p.nombre}</h3>
                <span class="pill ${p.probabilidad}">Probabilidad ${p.probabilidad}</span></div>
              <p style="margin:6px 0">${p.explicacion}</p>
              ${p.sintomas_observados.length ? html`<div class="small muted">Se observa: ${p.sintomas_observados.join(' · ')}</div>` : ''}
            </div>`
          )}
        </div>`
        : html`<div class="card"><h2>💚 ¡Está sana!</h2><p>No se ven problemas. Sigue con estos cuidados.</p></div>`
    }

    ${
      byWhen.length
        ? html`<div class="card"><h2>Qué hacer</h2>
          ${byWhen.map(
            ([w, items]) => html`<h3 class="muted" style="font-size:0.9rem;margin-top:12px">${WHEN_LABEL[w]}</h3>
              <ol class="steps">${items.map((t) => html`<li><b>${t.paso}</b><div>${t.detalle}</div></li>`)}</ol>`
          )}
        </div>`
        : ''
    }

    <div class="card"><h2>Cuidados recomendados</h2>
      <div class="care-grid">
        <div><b>💧 Riego</b>${r.cuidados.riego}</div>
        <div><b>☀️ Luz</b>${r.cuidados.luz}</div>
        <div><b>💨 Humedad</b>${r.cuidados.humedad}</div>
        <div><b>🌱 Abono</b>${r.cuidados.abono}</div>
      </div>
    </div>

    ${r.prevencion.length ? html`<div class="card"><h2>Para que no vuelva a pasar</h2><ul>${r.prevencion.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}

    ${
      d.plant_id && (r.recordatorios_sugeridos.length || r.riego_cada_dias)
        ? html`<div class="card"><h2>⏰ Recordatorios sugeridos</h2>
          <p class="small muted">Elige los que quieres activar.</p>
          <form id="apply-form">
            ${r.recordatorios_sugeridos.map(
              (s, i) => html`<label class="checkbox"><input type="checkbox" name="r${i}" value="${i}" checked />
                <span>${REMINDER_ICON[s.tipo] || '📌'} <b>${s.titulo}</b><br /><span class="small muted">${
                  s.en_dias === 0 ? 'Hoy' : `Dentro de ${s.en_dias} días`
                }${s.repetir_cada_dias ? `, y luego cada ${s.repetir_cada_dias} días` : ''}</span></span></label>`
            )}
            ${
              r.riego_cada_dias && !r.recordatorios_sugeridos.some((s) => s.tipo === 'riego')
                ? html`<label class="checkbox"><input type="checkbox" name="apply_watering" checked />
                  <span>💧 <b>Recordarme regar cada ${r.riego_cada_dias} días</b></span></label>`
                : ''
            }
            <button class="btn primary" type="submit">Activar recordatorios</button>
          </form></div>`
        : ''
    }

    <div class="btn-row" style="margin:18px 0">
      ${d.plant_id ? html`<a class="btn" href="#/planta/${d.plant_id}">Ver la planta</a>` : ''}
      <a class="btn" href="#/analizar${d.plant_id ? `?planta=${d.plant_id}` : ''}">Analizar otra foto</a>
      <button class="btn danger" id="del">Eliminar análisis</button>
    </div>
    <p class="small muted">Este diagnóstico es orientativo y lo genera una inteligencia artificial a partir de la foto. Ante dudas importantes, consulta con un vivero o especialista.</p>
  `);

  const link = $('#link-form');
  if (link) {
    handleForm(link, async (data) => {
      const body = data.plant_id === 'new' ? { new_plant: true } : { plant_id: Number(data.plant_id) };
      await api(`/diagnoses/${d.id}`, { method: 'PATCH', body });
      toast('Guardado en tu planta');
      router();
    });
  }
  const apply = $('#apply-form');
  if (apply) {
    handleForm(apply, async (_data, form) => {
      const reminders = [...form.querySelectorAll('input[name^=r]:checked')].map((x) => Number(x.value));
      const applyWatering = Boolean(form.querySelector('[name=apply_watering]:checked'));
      const res = await api(`/diagnoses/${d.id}/apply`, {
        method: 'POST',
        body: { reminders, apply_watering: applyWatering },
      });
      toast(res.created || applyWatering ? 'Recordatorios activados ⏰' : 'No elegiste ninguno');
      form.querySelector('[type=submit]').textContent = '✓ Activados';
      setTimeout(() => form.querySelectorAll('input,button').forEach((x) => (x.disabled = true)), 0);
    });
  }
  $('#del').addEventListener('click', async () => {
    if (!(await confirmDialog('¿Eliminar este análisis? No se puede deshacer.', 'Eliminar'))) return;
    await api(`/diagnoses/${d.id}`, { method: 'DELETE' });
    toast('Análisis eliminado');
    location.hash = d.plant_id ? `#/planta/${d.plant_id}` : '#/historial';
  });
}

// ---------- Vista: plantas ----------

function plantForm(p = {}) {
  return html`<form id="plant-form">
    <div class="field"><label for="pf-name">Nombre</label>
      <input id="pf-name" name="name" type="text" required maxlength="80" value="${p.name || ''}" placeholder="Ej.: Monstera del salón" /></div>
    <div class="field"><label for="pf-species">Especie <span class="hint">(opcional)</span></label>
      <input id="pf-species" name="species" type="text" maxlength="120" value="${p.species || ''}" placeholder="Ej.: Monstera deliciosa" /></div>
    <div class="field"><label for="pf-location">Ubicación <span class="hint">(opcional)</span></label>
      <input id="pf-location" name="location" type="text" maxlength="120" value="${p.location || ''}" placeholder="Ej.: Salón, junto a la ventana" /></div>
    <div class="field"><label for="pf-water">Regar cada… días <span class="hint">(vacío = sin recordatorio)</span></label>
      <input id="pf-water" name="water_every_days" type="number" min="1" max="90" value="${p.water_every_days || ''}" /></div>
    <div class="field"><label for="pf-notes">Notas <span class="hint">(opcional)</span></label>
      <textarea id="pf-notes" name="notes" maxlength="2000">${p.notes || ''}</textarea></div>
    <div class="field"><label>Foto <span class="hint">(opcional)</span></label>
      <input type="file" accept="image/*" id="pf-photo" /></div>
    <p class="error-msg"></p>
    <div class="btn-row" style="justify-content:flex-end">
      <button type="button" class="btn" data-close>Cancelar</button>
      <button class="btn primary" type="submit">Guardar</button>
    </div>
  </form>`;
}

function openPlantForm(plant, onSaved) {
  const dlg = showModal(html`<h2>${plant ? 'Editar planta' : 'Nueva planta'}</h2>${plantForm(plant || {})}`);
  handleForm($('#plant-form', dlg), async (data) => {
    const file = $('#pf-photo', dlg).files?.[0];
    if (file) data.photo = await resizeImage(file, 1200);
    const saved = plant
      ? await api(`/plants/${plant.id}`, { method: 'PATCH', body: data })
      : await api('/plants', { method: 'POST', body: data });
    dlg.close();
    toast('Planta guardada');
    onSaved(saved);
  });
}

async function viewPlants(params) {
  const archived = params.get('archivadas') === '1';
  const plants = await api(`/plants${archived ? '?archived=1' : ''}`);
  render(html`
    <div class="row between"><h1 style="margin:0">${archived ? 'Plantas archivadas' : 'Mis plantas'}</h1>
      <button class="btn primary small" id="add">➕ Añadir</button></div>
    <p class="muted small">${archived ? html`<a href="#/plantas">← Volver a mis plantas</a>` : html`<a href="#/plantas?archivadas=1">Ver archivadas</a>`}</p>
    ${
      plants.length
        ? html`<div class="plant-grid">${plants.map(plantCard)}</div>`
        : html`<div class="empty"><div class="big">🪴</div>
          <p>${archived ? 'No tienes plantas archivadas.' : 'Aún no tienes plantas guardadas.'}</p>
          ${archived ? '' : html`<a class="btn primary" href="#/analizar">Analizar mi primera planta</a>`}</div>`
    }
  `);
  $('#add').addEventListener('click', () => openPlantForm(null, (p) => (location.hash = `#/planta/${p.id}`)));
}

function healthChart(diagnoses) {
  const points = diagnoses
    .filter((d) => d.health_score !== null)
    .slice()
    .reverse();
  if (points.length < 2) return '';
  const W = 600;
  const H = 180;
  const pad = { l: 30, r: 12, t: 12, b: 26 };
  const t0 = parseDate(points[0].created_at).getTime();
  const t1 = parseDate(points[points.length - 1].created_at).getTime();
  const span = Math.max(1, t1 - t0);
  const x = (d) => pad.l + ((parseDate(d.created_at).getTime() - t0) / span) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);
  const line = points.map((d, i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)},${y(d.health_score).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points[points.length - 1]).toFixed(1)},${y(0)} L${x(points[0]).toFixed(1)},${y(0)} Z`;
  return html`<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución de la salud">
    ${[0, 50, 100].map((v) => html`<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" /><text x="0" y="${y(v) + 4}">${v}</text>`)}
    <path class="area" d="${area}" />
    <path class="line" d="${line}" />
    ${points.map((d) => html`<circle class="dot" cx="${x(d).toFixed(1)}" cy="${y(d.health_score).toFixed(1)}" r="5"><title>${fmtDate(d.created_at)}: ${d.health_score}/100</title></circle>`)}
    <text x="${pad.l}" y="${H - 6}">${fmtDate(points[0].created_at, { day: 'numeric', month: 'short' })}</text>
    <text x="${W - pad.r}" y="${H - 6}" text-anchor="end">${fmtDate(points[points.length - 1].created_at, { day: 'numeric', month: 'short' })}</text>
  </svg></div>`;
}

async function viewPlant(id, params) {
  const { plant: p, diagnoses, care, reminders } = await api(`/plants/${id}`);
  const tab = params.get('tab') || 'evolucion';
  const first = diagnoses[diagnoses.length - 1];
  const last = diagnoses[0];
  const trend =
    first && last && first !== last && first.health_score !== null && last.health_score !== null
      ? last.health_score - first.health_score
      : null;

  const tabs = [
    ['evolucion', 'Evolución'],
    ['analisis', `Análisis (${diagnoses.length})`],
    ['cuidados', 'Diario'],
    ['avisos', `Avisos (${reminders.length})`],
  ];

  let body = '';
  if (tab === 'evolucion') {
    body = diagnoses.length
      ? html`
        ${
          trend !== null
            ? html`<div class="notice ${trend >= 0 ? 'info' : 'bad'}">${trend > 0 ? '📈' : trend < 0 ? '📉' : '➡️'}
              Desde el primer análisis (${fmtDate(first.created_at)}), su salud ha ${
                trend > 0 ? `mejorado ${trend} puntos` : trend < 0 ? `empeorado ${-trend} puntos` : 'seguido igual'
              }: de ${first.health_score} a ${last.health_score}.</div>`
            : ''
        }
        ${healthChart(diagnoses) ? html`<div class="card"><h3>Salud a lo largo del tiempo</h3>${healthChart(diagnoses)}</div>` : ''}
        ${
          first !== last
            ? html`<div class="card"><h3>Antes y ahora</h3><div class="compare">
              <figure><img src="${photoUrl(first.photo)}" alt="Primera foto" /><figcaption>${fmtDate(first.created_at)} · ${first.health_score ?? '–'}/100</figcaption></figure>
              <figure><img src="${photoUrl(last.photo)}" alt="Última foto" /><figcaption>${fmtDate(last.created_at)} · ${last.health_score ?? '–'}/100</figcaption></figure>
            </div></div>`
            : html`<div class="notice info">📸 Vuelve a analizarla dentro de unos días para ver cómo evoluciona.</div>`
        }
        <div class="card"><h3>Todas las fotos</h3><div class="photo-strip">
          ${diagnoses.slice().reverse().map((d) => html`<a href="#/diagnostico/${d.id}"><img src="${photoUrl(d.photo)}" alt="" loading="lazy" />${fmtDate(d.created_at, { day: 'numeric', month: 'short' })}</a>`)}
        </div></div>`
      : html`<div class="empty"><div class="big">📷</div><p>Analiza esta planta para empezar a seguir su evolución.</p>
        <a class="btn primary" href="#/analizar?planta=${p.id}">Analizar ahora</a></div>`;
  } else if (tab === 'analisis') {
    body = diagnoses.length
      ? html`<div class="card"><ul class="list">${diagnoses.map(
          (d) => html`<li><a class="item-link" href="#/diagnostico/${d.id}">
            <div class="avatar">${thumb(d.photo)}</div>
            <div class="grow"><div><b>${fmtDate(d.created_at)}</b> · ${d.health_score ?? '–'}/100</div>
              <div class="small muted ellipsis">${d.problemas.length ? d.problemas.join(', ') : 'Sin problemas'}</div></div>
            ${statusPill(d.status)}</a></li>`
        )}</ul></div>`
      : html`<div class="empty"><p>Aún no hay análisis.</p></div>`;
  } else if (tab === 'cuidados') {
    body = html`<div class="card"><h3>Apuntar un cuidado</h3>
        <form id="care-form">
          <div class="row">
            <select name="type" style="width:auto">
              ${['riego', 'abono', 'tratamiento', 'poda', 'trasplante', 'nota'].map((t) => html`<option value="${t}">${REMINDER_ICON[t]} ${REMINDER_LABEL[t]}</option>`)}
            </select>
            <input type="text" name="note" class="grow" style="width:auto" maxlength="1000" placeholder="Detalle (opcional)" />
            <button class="btn primary" type="submit">Apuntar</button>
          </div>
        </form></div>
      ${
        care.length
          ? html`<div class="card"><ul class="timeline">${care.map(
              (c) => html`<li data-care="${c.id}"><div class="row between"><b>${REMINDER_ICON[c.type] || '📝'} ${REMINDER_LABEL[c.type] || c.type}</b>
                <button class="btn small ghost" data-del-care aria-label="Borrar">🗑</button></div>
                ${c.note ? html`<div>${c.note}</div>` : ''}<div class="small muted">${fmtDateTime(c.created_at)}</div></li>`
            )}</ul></div>`
          : html`<p class="muted center">Aquí verás cuándo la regaste, abonaste o trataste.</p>`
      }`;
  } else if (tab === 'avisos') {
    body = html`<div class="btn-row" style="margin-bottom:12px"><button class="btn primary small" id="new-reminder">➕ Nuevo recordatorio</button></div>
      ${
        reminders.length
          ? html`<div class="card"><ul class="list" id="plant-reminders">${reminders.map((r) => reminderItem(r, { showPlant: false }))}</ul></div>`
          : html`<p class="muted center">No hay recordatorios para esta planta.</p>`
      }`;
  }

  render(html`
    <p class="small"><a href="#/plantas">← Mis plantas</a></p>
    <div class="plant-hero">${thumb(p.photo)}</div>
    <div class="row between">
      <div class="grow"><h1 style="margin-bottom:2px">${p.name}</h1>
        <div class="muted">${p.species || 'Especie sin indicar'}${p.location ? ` · ${p.location}` : ''}</div></div>
      ${p.last_health !== null ? html`<div class="center"><b style="font-size:1.6rem;color:${healthColor(p.last_health)}">${p.last_health}</b><div class="small muted">salud</div></div>` : ''}
    </div>
    <div class="row small muted" style="margin:8px 0 14px">
      ${p.last_status ? statusPill(p.last_status) : ''}
      ${p.water_every_days ? html`<span>💧 Cada ${p.water_every_days} días</span>` : ''}
      ${p.last_watered_at ? html`<span>Último riego: ${fmtDate(p.last_watered_at, { day: 'numeric', month: 'short' })}</span>` : ''}
    </div>
    ${p.notes ? html`<p class="small">${p.notes}</p>` : ''}
    <div class="btn-row">
      <a class="btn primary" href="#/analizar?planta=${p.id}">📷 Nuevo análisis</a>
      <button class="btn" id="watered">💧 La regué hoy</button>
      <button class="btn" id="edit">✏️ Editar</button>
      <button class="btn ghost" id="more">⋯</button>
    </div>
    <div class="tabs" role="tablist">${tabs.map(([k, label]) => html`<button role="tab" class="${k === tab ? 'active' : ''}" data-tab="${k}">${label}</button>`)}</div>
    ${body}
  `);

  const reload = (t = tab) => {
    const target = `#/planta/${p.id}?tab=${t}`;
    if (location.hash === target) router();
    else location.hash = target;
  };
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => reload(b.dataset.tab)));
  $('#watered').addEventListener('click', async () => {
    await api(`/plants/${p.id}/care`, { method: 'POST', body: { type: 'riego' } });
    toast('Riego apuntado 💧');
    reload();
  });
  $('#edit').addEventListener('click', () => openPlantForm(p, () => reload()));
  $('#more').addEventListener('click', () => {
    const dlg = showModal(html`<h3>${p.name}</h3><div class="stack">
      <button class="btn block" id="archive">${p.archived ? 'Recuperar de archivadas' : '📦 Archivar (ya no la tengo)'}</button>
      <button class="btn block danger" id="delete">🗑 Eliminar planta y su historial</button>
      <button class="btn block ghost" data-close>Cancelar</button></div>`);
    $('#archive', dlg).addEventListener('click', async () => {
      await api(`/plants/${p.id}`, { method: 'PATCH', body: { archived: !p.archived } });
      dlg.close();
      toast(p.archived ? 'Planta recuperada' : 'Planta archivada');
      location.hash = '#/plantas';
    });
    $('#delete', dlg).addEventListener('click', async () => {
      dlg.close();
      if (!(await confirmDialog(`¿Eliminar "${p.name}" con todos sus análisis, fotos y recordatorios? No se puede deshacer.`, 'Eliminar'))) return;
      await api(`/plants/${p.id}`, { method: 'DELETE' });
      toast('Planta eliminada');
      location.hash = '#/plantas';
    });
  });

  const careForm = $('#care-form');
  if (careForm) {
    handleForm(careForm, async (data) => {
      await api(`/plants/${p.id}/care`, { method: 'POST', body: data });
      toast('Apuntado');
      reload();
    });
    $('.timeline')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-del-care]');
      if (!btn) return;
      const careId = btn.closest('[data-care]').dataset.care;
      await api(`/plants/${p.id}/care/${careId}`, { method: 'DELETE' });
      reload();
    });
  }
  const list = $('#plant-reminders');
  if (list) bindReminderActions(list, () => reload());
  $('#new-reminder')?.addEventListener('click', () => openReminderForm([p], p.id, () => reload()));
}

// ---------- Vista: recordatorios ----------

function openReminderForm(plants, plantId, onSaved) {
  const dlg = showModal(html`<h2>Nuevo recordatorio</h2>
    <form id="rf">
      <div class="field"><label for="rf-title">¿Qué hay que hacer?</label>
        <input id="rf-title" name="title" type="text" required maxlength="200" placeholder="Ej.: Aplicar jabón potásico" /></div>
      <div class="field"><label for="rf-type">Tipo</label>
        <select id="rf-type" name="type">${['riego', 'abono', 'tratamiento', 'revision', 'poda', 'trasplante', 'otro'].map((t) => html`<option value="${t}">${REMINDER_ICON[t]} ${REMINDER_LABEL[t]}</option>`)}</select></div>
      <div class="field"><label for="rf-plant">Planta</label>
        <select id="rf-plant" name="plant_id"><option value="">Ninguna en concreto</option>
          ${plants.map((p) => html`<option value="${p.id}" ${p.id === plantId ? raw('selected') : ''}>${p.name}</option>`)}</select></div>
      <div class="row">
        <div class="field grow"><label for="rf-date">Fecha</label><input id="rf-date" name="due_date" type="date" value="${localToday()}" required /></div>
        <div class="field grow"><label for="rf-rep">Repetir cada (días)</label><input id="rf-rep" name="repeat_days" type="number" min="1" max="365" placeholder="No repetir" /></div>
      </div>
      <p class="error-msg"></p>
      <div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancelar</button>
        <button class="btn primary" type="submit">Guardar</button></div>
    </form>`);
  handleForm($('#rf', dlg), async (data) => {
    await api('/reminders', { method: 'POST', body: data });
    dlg.close();
    toast('Recordatorio creado ⏰');
    onSaved();
  });
}

async function viewReminders() {
  const [{ reminders }, plants] = await Promise.all([api('/reminders'), api('/plants')]);
  const groups = [
    ['Atrasados', reminders.filter((r) => daysUntil(r.due_date) < 0)],
    ['Hoy', reminders.filter((r) => daysUntil(r.due_date) === 0)],
    ['Próximos 7 días', reminders.filter((r) => daysUntil(r.due_date) > 0 && daysUntil(r.due_date) <= 7)],
    ['Más adelante', reminders.filter((r) => daysUntil(r.due_date) > 7)],
  ].filter(([, items]) => items.length);

  const canNotify = 'Notification' in window && Notification.permission === 'default';

  render(html`
    <div class="row between"><h1 style="margin:0">Recordatorios</h1>
      <button class="btn primary small" id="new">➕ Nuevo</button></div>
    ${
      canNotify
        ? html`<div class="notice info row" style="margin-top:14px"><div class="grow">🔔 Activa los avisos para que la app te recuerde los cuidados al abrirla.</div>
          <button class="btn small primary" id="notify">Activar</button></div>`
        : ''
    }
    <div id="groups">
    ${
      groups.length
        ? groups.map(
            ([title, items]) => html`<div class="section-title"><h2>${title}</h2></div>
            <div class="card"><ul class="list">${items.map((r) => reminderItem(r))}</ul></div>`
          )
        : html`<div class="empty"><div class="big">⏰</div><p>No tienes recordatorios.</p>
          <p class="small">Se crean al guardar plantas con frecuencia de riego, o desde las sugerencias de cada análisis.</p></div>`
    }
    </div>
  `);
  bindReminderActions($('#groups'), () => router());
  $('#new').addEventListener('click', () => openReminderForm(plants, null, () => router()));
  $('#notify')?.addEventListener('click', async () => {
    const perm = await Notification.requestPermission();
    toast(perm === 'granted' ? 'Avisos activados 🔔' : 'No se activaron los avisos');
    router();
  });
}

// ---------- Vista: historial ----------

async function viewHistory() {
  const diagnoses = await api('/diagnoses');
  render(html`<h1>Historial de análisis</h1>
    ${
      diagnoses.length
        ? html`<div class="card"><ul class="list">${diagnoses.map(diagnosisItem)}</ul></div>`
        : html`<div class="empty"><div class="big">📋</div><p>Todavía no has analizado ninguna planta.</p>
          <a class="btn primary" href="#/analizar">Analizar una planta</a></div>`
    }`);
}

// ---------- Vista: cuenta ----------

function viewAccount() {
  const u = state.user;
  render(html`
    <h1>Mi cuenta</h1>
    <div class="card"><div class="row"><div class="topbar-user" style="width:52px;height:52px;font-size:1.4rem">${u.name.charAt(0).toUpperCase()}</div>
      <div class="grow"><b>${u.name}</b><div class="small muted">${u.email}</div>
        <div class="small">${u.role === 'admin' ? '👑 Administrador' : 'Usuario'}</div></div></div></div>
    ${u.role === 'admin' ? html`<a class="card row" href="#/admin" style="text-decoration:none;color:inherit"><div style="font-size:1.6rem">⚙️</div>
      <div class="grow"><b>Panel de administración</b><div class="small muted">Usuarios, clientes y configuración</div></div><div>›</div></a>` : ''}
    <div class="card"><h2>Cambiar contraseña</h2>
      <form id="pw">
        <div class="field"><label for="current">Contraseña actual</label><input id="current" name="current" type="password" required autocomplete="current-password" /></div>
        ${passwordField('next', 'Nueva contraseña')}
        <p class="error-msg"></p>
        <button class="btn primary" type="submit">Cambiar contraseña</button>
      </form></div>
    <div class="card"><h2>Instalar en el móvil</h2>
      <p class="small">En <b>Android (Chrome)</b>: menú ⋮ → «Instalar aplicación» o «Añadir a pantalla de inicio».<br />
      En <b>iPhone (Safari)</b>: botón Compartir → «Añadir a pantalla de inicio».</p></div>
    <button class="btn danger block" id="logout">Cerrar sesión</button>
  `);
  handleForm($('#pw'), async (data, form) => {
    await api('/auth/password', { method: 'POST', body: data });
    form.reset();
    toast('Contraseña cambiada');
  });
  $('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    state.user = null;
    location.hash = '#/login';
  });
}

// ---------- Vista: administración ----------

async function viewAdmin() {
  const [overview, users] = await Promise.all([api('/admin/overview'), api('/admin/users')]);
  const s = overview.stats;
  const cfg = overview.settings;
  render(html`
    <p class="small"><a href="#/cuenta">← Mi cuenta</a></p>
    <h1>Administración</h1>
    ${
      overview.system.demoMode
        ? html`<div class="notice">🧪 <b>Modo demostración.</b> Añade una clave de IA aquí abajo para que los análisis sean reales. Gemini es gratis.</div>`
        : ''
    }
    <div class="stats">
      <div class="stat"><b>${s.users}</b><span>Usuarios</span></div>
      <div class="stat"><b>${s.plants}</b><span>Plantas</span></div>
      <div class="stat"><b>${s.diagnosesMonth}</b><span>Análisis este mes</span></div>
      <div class="stat"><b>${money(s.costMonth)}</b><span>Gasto IA este mes (aprox.)</span></div>
    </div>

    <div class="card" style="margin-top:14px"><h2>🤖 Inteligencia artificial</h2>
      <p class="small muted">Elige qué IA analiza las fotos. Puedes cambiar cuando quieras; los diagnósticos se ven igual.</p>
      <div class="provider-choice" role="radiogroup" aria-label="IA para analizar fotos">
        <label class="provider ${cfg.provider === 'gemini' ? 'on' : ''}"><input type="radio" name="provider" value="gemini" ${cfg.provider === 'gemini' ? raw('checked') : ''} />
          <span><b>Gemini (Google)</b><span class="pill saludable">Gratis</span><br /><span class="small muted">Con límite de análisis por minuto y por día.</span></span></label>
        <label class="provider ${cfg.provider === 'anthropic' ? 'on' : ''}"><input type="radio" name="provider" value="anthropic" ${cfg.provider === 'anthropic' ? raw('checked') : ''} />
          <span><b>Claude (Anthropic)</b><span class="pill">De pago</span><br /><span class="small muted">Máxima precisión, unos centavos por análisis.</span></span></label>
      </div>

      <h3 style="margin-top:18px">Clave de Gemini <span class="hint">(gratis)</span></h3>
      ${
        cfg.geminiKeyLocked
          ? html`<p class="small">Fijada en <code>config.php</code>: <code>${cfg.geminiKeyMasked}</code></p>`
          : keyForm('gemini', cfg.geminiKeyMasked, 'Consíguela gratis en aistudio.google.com → «Get API key» → «Create API key». Se comprueba antes de guardarla.', 'AIza… o AQ.…')
      }
      ${cfg.geminiModel ? html`<p class="small muted">Modelo detectado: <code>${cfg.geminiModel}</code></p>` : ''}

      <h3 style="margin-top:18px">Clave de Claude <span class="hint">(de pago)</span></h3>
      ${
        cfg.apiKeyLocked
          ? html`<p class="small">Fijada en <code>config.php</code>: <code>${cfg.apiKeyMasked}</code></p>`
          : keyForm('anthropic', cfg.apiKeyMasked, 'Consíguela en console.anthropic.com → API Keys. Se comprueba antes de guardarla.', 'sk-ant-…')
      }
      <div class="field" style="margin-top:12px"><label for="model">Modelo de Claude</label>
        <select id="model">${overview.models.map((m) => html`<option value="${m.id}" ${m.id === cfg.model ? raw('selected') : ''}>${m.label}</option>`)}</select>
        <p class="hint">Opus 5.5 ≈ 6–10 centavos por análisis · Sonnet 5.5 ≈ la mitad.</p></div>

      <div class="field" style="margin-top:18px"><label for="daily-limit">Límite de análisis por cliente y día <span class="hint">(0 = sin límite; no aplica a administradores)</span></label>
        <div class="row"><input id="daily-limit" type="number" min="0" max="1000" value="${cfg.dailyLimit}" style="width:120px" />
          <button class="btn small" id="save-limit">Guardar</button></div></div>
      <p class="small muted">Gasto acumulado total con Claude: ${money(s.costTotal)} (estimación). Los análisis con Gemini gratis no suman gasto.</p>
      <div class="btn-row"><button class="btn small" type="button" id="test-key">Probar la IA elegida</button></div>
    </div>

    <div class="card"><h2>Registro de clientes</h2>
      <label class="checkbox"><input type="checkbox" id="allow-reg" ${overview.settings.allowRegistration ? raw('checked') : ''} />
        <span><b>Permitir que cualquiera se registre</b><br /><span class="small muted">Si está desactivado, solo tú puedes crear cuentas desde aquí.</span></span></label>
    </div>

    <div class="section-title"><h2>Usuarios</h2><button class="btn primary small" id="new-user">➕ Crear usuario</button></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Nombre</th><th>Rol</th><th>Plantas</th><th>Análisis</th><th>Gasto mes</th><th>Último acceso</th><th></th></tr></thead>
      <tbody>${users.map(
        (u) => html`<tr>
          <td><b>${u.name}</b>${u.id === state.user.id ? ' (tú)' : ''}<div class="small muted">${u.email}</div>${!u.active ? html`<span class="pill grave">Desactivado</span>` : ''}</td>
          <td>${u.role === 'admin' ? '👑 Admin' : 'Cliente'}</td>
          <td>${u.plants}</td><td>${u.diagnoses}</td><td>${money(u.cost_month)}</td>
          <td class="small">${u.last_login_at ? fmtDateTime(u.last_login_at) : 'Nunca'}</td>
          <td><button class="btn small" data-edit-user="${u.id}">Editar</button></td>
        </tr>`
      )}</tbody></table></div>
  `);

  const saveSetting = async (body, message) => {
    await api('/admin/settings', { method: 'PATCH', body });
    toast(message);
  };
  document.querySelectorAll('[data-key-form]').forEach((form) => {
    const which = form.dataset.keyForm; // 'gemini' | 'anthropic'
    const field = which === 'gemini' ? 'geminiKey' : 'apiKey';
    handleForm(form, async (data) => {
      const key = (data.key || '').trim();
      if (!key) throw new Error('Pega la clave primero.');
      const body = { [field]: key };
      // Si aún no hay IA con clave, se activa la que se acaba de configurar.
      if (overview.system.demoMode) body.provider = which;
      await api('/admin/settings', { method: 'PATCH', body });
      toast('Clave guardada y comprobada ✅');
      await loadStatus();
      router();
    });
    form.querySelector('[data-remove-key]')?.addEventListener('click', async () => {
      if (!(await confirmDialog('¿Quitar esta clave?', 'Quitar'))) return;
      await saveSetting({ [field]: '' }, 'Clave eliminada');
      await loadStatus();
      router();
    });
  });
  document.querySelectorAll('input[name=provider]').forEach((r) =>
    r.addEventListener('change', async () => {
      await saveSetting({ provider: r.value }, r.value === 'gemini' ? 'Ahora se usa Gemini (gratis)' : 'Ahora se usa Claude');
      await loadStatus();
      router();
    })
  );
  $('#test-key').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/admin/test-key', { method: 'POST' });
      toast('La conexión con la IA funciona ✅');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      e.target.disabled = false;
    }
  });
  $('#model').addEventListener('change', (e) => saveSetting({ model: e.target.value }, 'Modelo actualizado'));
  $('#save-limit').addEventListener('click', () =>
    saveSetting({ dailyLimit: Number($('#daily-limit').value) || 0 }, 'Límite guardado')
  );

  $('#allow-reg').addEventListener('change', async (e) => {
    await api('/admin/settings', { method: 'PATCH', body: { allowRegistration: e.target.checked } });
    state.status.allowRegistration = e.target.checked;
    toast(e.target.checked ? 'Registro abierto' : 'Registro cerrado');
  });

  $('#new-user').addEventListener('click', () => {
    const dlg = showModal(html`<h2>Crear usuario</h2>
      <form id="uf">
        <div class="field"><label for="uf-name">Nombre</label><input id="uf-name" name="name" type="text" required /></div>
        <div class="field"><label for="uf-email">Correo electrónico</label><input id="uf-email" name="email" type="email" required /></div>
        <div class="field"><label for="uf-pw">Contraseña inicial <span class="hint">(mínimo 8; compártela con el cliente)</span></label>
          <input id="uf-pw" name="password" type="text" minlength="8" required value="${Math.random().toString(36).slice(2, 7)}-${Math.random().toString(36).slice(2, 7)}" /></div>
        <div class="field"><label for="uf-role">Rol</label><select id="uf-role" name="role"><option value="user">Cliente</option><option value="admin">Administrador</option></select></div>
        <p class="error-msg"></p>
        <div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancelar</button>
          <button class="btn primary" type="submit">Crear</button></div>
      </form>`);
    handleForm($('#uf', dlg), async (data) => {
      await api('/admin/users', { method: 'POST', body: data });
      dlg.close();
      toast('Usuario creado');
      router();
    });
  });

  app.querySelectorAll('[data-edit-user]').forEach((b) =>
    b.addEventListener('click', () => {
      const u = users.find((x) => String(x.id) === b.dataset.editUser);
      const dlg = showModal(html`<h2>${u.name}</h2><p class="small muted">${u.email}</p>
        <form id="ef">
          <div class="field"><label for="ef-name">Nombre</label><input id="ef-name" name="name" type="text" required value="${u.name}" /></div>
          <div class="field"><label for="ef-role">Rol</label><select id="ef-role" name="role">
            <option value="user" ${u.role === 'user' ? raw('selected') : ''}>Cliente</option>
            <option value="admin" ${u.role === 'admin' ? raw('selected') : ''}>Administrador</option></select></div>
          <label class="checkbox"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''} /><span>Cuenta activa</span></label>
          <div class="field"><label for="ef-pw">Nueva contraseña <span class="hint">(vacío = no cambiar)</span></label>
            <input id="ef-pw" name="password" type="text" minlength="8" /></div>
          <p class="error-msg"></p>
          <div class="btn-row" style="justify-content:space-between">
            ${u.id !== state.user.id ? html`<button type="button" class="btn danger" id="del-user">Eliminar</button>` : html`<span></span>`}
            <div class="btn-row"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Guardar</button></div>
          </div>
        </form>`);
      handleForm($('#ef', dlg), async (data) => {
        const body = { name: data.name, role: data.role, active: data.active === 'on' };
        if (data.password) body.password = data.password;
        await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
        dlg.close();
        toast('Usuario actualizado');
        if (u.id === state.user.id) await loadStatus();
        router();
      });
      $('#del-user', dlg)?.addEventListener('click', async () => {
        dlg.close();
        if (!(await confirmDialog(`¿Eliminar a ${u.name} y todas sus plantas y análisis? No se puede deshacer.`, 'Eliminar'))) return;
        try {
          await api(`/admin/users/${u.id}`, { method: 'DELETE' });
          toast('Usuario eliminado');
          router();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    })
  );
}

// ---------- Arranque ----------

window.addEventListener('hashchange', router);
window.addEventListener('unhandledrejection', (e) => toast(e.reason?.message || 'Error inesperado', 'error'));

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    await loadStatus();
  } catch {
    render(html`<div class="empty"><div class="big">🔌</div><p>No se pudo conectar con el servidor.</p></div>`);
    return;
  }
  router();
})();
