import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config, demoMode } from './config.js';
import { HttpError } from './util.js';

// Campo de texto con un conjunto de valores válidos. Se valida y normaliza después
// (ver normalizeResult) para tolerar pequeñas variaciones de mayúsculas o acentos.
const ENUMS = {
  confianza: ['alta', 'media', 'baja'],
  estado_general: ['saludable', 'leve', 'moderado', 'grave'],
  tipo_problema: ['plaga', 'hongo', 'bacteria', 'virus', 'riego', 'luz', 'nutrientes', 'temperatura', 'daño_fisico', 'otro'],
  cuando: ['hoy', 'esta_semana', 'continuo'],
  tipo_recordatorio: ['riego', 'abono', 'tratamiento', 'revision', 'poda', 'trasplante', 'otro'],
};
const choice = (name) => z.string().describe(`Uno de: ${ENUMS[name].join(' | ')}`);

// Esquema de la respuesta que pedimos a la IA (salida estructurada en JSON).
export const DiagnosisSchema = z.object({
  es_planta: z.boolean().describe('false si la foto no muestra una planta'),
  planta_identificada: z.object({
    nombre_comun: z.string(),
    nombre_cientifico: z.string().nullable(),
    confianza: choice('confianza'),
  }),
  estado_general: choice('estado_general'),
  puntuacion_salud: z
    .number()
    .int()
    .describe('Salud de la planta de 0 (muerta) a 100 (perfecta)'),
  resumen: z.string().describe('Dos o tres frases claras para una persona sin conocimientos técnicos'),
  problemas: z.array(
    z.object({
      nombre: z.string(),
      tipo: choice('tipo_problema'),
      probabilidad: choice('confianza'),
      sintomas_observados: z.array(z.string()),
      explicacion: z.string(),
    })
  ),
  tratamiento: z.array(
    z.object({
      paso: z.string(),
      detalle: z.string(),
      cuando: choice('cuando'),
    })
  ),
  prevencion: z.array(z.string()),
  cuidados: z.object({
    riego: z.string(),
    luz: z.string(),
    humedad: z.string(),
    abono: z.string(),
  }),
  riego_cada_dias: z
    .number()
    .int()
    .nullable()
    .describe('Frecuencia de riego aproximada recomendada en días, o null si no se puede estimar'),
  recordatorios_sugeridos: z.array(
    z.object({
      tipo: choice('tipo_recordatorio'),
      titulo: z.string(),
      en_dias: z.number().int().describe('Dentro de cuántos días desde hoy'),
      repetir_cada_dias: z.number().int().nullable(),
    })
  ),
  comparacion_anterior: z
    .string()
    .nullable()
    .describe('Evolución respecto al diagnóstico anterior, si se proporcionó; si no, null'),
  calidad_foto: z.object({
    adecuada: z.boolean(),
    sugerencia: z.string().nullable(),
  }),
  aviso: z
    .string()
    .nullable()
    .describe('Advertencias importantes: toxicidad para mascotas o niños, riesgo de contagio a otras plantas, etc.'),
});

const SYSTEM_PROMPT = `Eres un fitopatólogo y jardinero experto que ayuda a personas sin conocimientos técnicos a cuidar sus plantas. Analizas una foto y das un diagnóstico claro y consejos prácticos en español.

Cómo trabajar:
- Observa con detalle hojas, tallos, sustrato, maceta y entorno visibles. Basa el diagnóstico en lo que realmente se ve; si algo es incierto, dilo y baja la probabilidad.
- Considera las causas más comunes antes que las raras (el exceso de riego es la causa más frecuente de problemas en plantas de interior).
- Los tratamientos deben ser concretos y realizables en casa. Prioriza soluciones suaves y caseras (jabón potásico, aceite de neem, ajustar riego o luz, aislar la planta, podar partes dañadas) antes que productos químicos. Si recomiendas un producto, di el tipo de producto, no una marca.
- Si la planta está sana, dilo con claridad y da consejos de mantenimiento; no inventes problemas.
- Si la foto no es de una planta, marca es_planta = false y explica qué foto se necesita.
- Si la foto es borrosa, oscura o no muestra la zona afectada, indícalo en calidad_foto y sugiere cómo tomar una mejor.
- Sugiere recordatorios útiles (riego, revisión del tratamiento, abono). Para un tratamiento, sugiere una revisión en 5-10 días para seguir la evolución.
- Si se te da el diagnóstico anterior de la misma planta, compara y explica si ha mejorado, empeorado o sigue igual en comparacion_anterior.
- Usa un tono cercano, tranquilizador y directo. Nada de jerga sin explicar.`;

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

/**
 * Analiza una foto de una planta.
 * @param {object} opts
 * @param {string} opts.imageBase64 imagen en base64 (sin el prefijo data:)
 * @param {string} opts.mediaType  image/jpeg | image/png | image/webp | image/gif
 * @param {object|null} opts.plant datos de la planta (si existe)
 * @param {string|null} opts.symptoms descripción del usuario
 * @param {object|null} opts.previous diagnóstico anterior { date, result }
 */
export async function analyzePlant({ imageBase64, mediaType, plant, symptoms, previous }) {
  if (demoMode()) return { result: demoDiagnosis(plant, previous), model: 'demo', demo: true };

  const context = [];
  if (plant) {
    context.push(`Planta registrada por el usuario: "${plant.name}"`);
    if (plant.species) context.push(`Especie indicada: ${plant.species}`);
    if (plant.location) context.push(`Ubicación: ${plant.location}`);
    if (plant.water_every_days) context.push(`Riego actual: cada ${plant.water_every_days} días`);
    if (plant.last_watered_at) context.push(`Último riego registrado: ${plant.last_watered_at.slice(0, 10)}`);
    if (plant.notes) context.push(`Notas del usuario: ${plant.notes}`);
  }
  if (symptoms) context.push(`Lo que cuenta el usuario: ${symptoms}`);
  if (previous) {
    const p = previous.result;
    context.push(
      `Diagnóstico anterior (${previous.date.slice(0, 10)}): estado "${p.estado_general}", salud ${p.puntuacion_salud}/100. ` +
        `Resumen: ${p.resumen} Problemas: ${p.problemas.map((x) => x.nombre).join(', ') || 'ninguno'}.`
    );
  }
  context.push(`Fecha de hoy: ${new Date().toISOString().slice(0, 10)}`);

  const response = await getClient().beta.messages.parse({
    model: config.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: zodOutputFormat(DiagnosisSchema) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          {
            type: 'text',
            text: `Analiza esta planta y dame el diagnóstico.\n\n${context.join('\n')}`,
          },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new HttpError(422, 'La IA no pudo analizar esta imagen. Prueba con otra foto.');
  }
  if (response.stop_reason === 'max_tokens' || !response.parsed_output) {
    throw new HttpError(502, 'La respuesta de la IA llegó incompleta. Inténtalo de nuevo.');
  }

  return { result: normalizeResult(response.parsed_output), model: response.model, demo: false };
}

function pick(name, value, fallback) {
  const clean = String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');
  const match = ENUMS[name].find(
    (v) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === clean
  );
  return match || fallback;
}

export function normalizeResult(r) {
  r.planta_identificada.confianza = pick('confianza', r.planta_identificada.confianza, 'media');
  r.estado_general = pick('estado_general', r.estado_general, 'moderado');
  r.puntuacion_salud = Math.max(0, Math.min(100, Math.round(r.puntuacion_salud)));
  for (const p of r.problemas) {
    p.tipo = pick('tipo_problema', p.tipo, 'otro');
    p.probabilidad = pick('confianza', p.probabilidad, 'media');
  }
  for (const t of r.tratamiento) t.cuando = pick('cuando', t.cuando, 'esta_semana');
  r.recordatorios_sugeridos = r.recordatorios_sugeridos
    .map((x) => ({
      ...x,
      tipo: pick('tipo_recordatorio', x.tipo, 'otro'),
      en_dias: Math.max(0, Math.min(365, Math.round(x.en_dias))),
      repetir_cada_dias:
        x.repetir_cada_dias && x.repetir_cada_dias > 0 ? Math.min(365, Math.round(x.repetir_cada_dias)) : null,
    }))
    .slice(0, 6);
  if (r.riego_cada_dias !== null) {
    r.riego_cada_dias = r.riego_cada_dias > 0 ? Math.min(60, Math.round(r.riego_cada_dias)) : null;
  }
  return r;
}

// Diagnóstico de ejemplo para probar la app sin clave de API.
function demoDiagnosis(plant, previous) {
  const score = previous ? Math.min(95, previous.result.puntuacion_salud + 12) : 62;
  return {
    es_planta: true,
    planta_identificada: {
      nombre_comun: plant?.species || plant?.name || 'Potus (ejemplo)',
      nombre_cientifico: 'Epipremnum aureum',
      confianza: 'media',
    },
    estado_general: score >= 80 ? 'leve' : 'moderado',
    puntuacion_salud: score,
    resumen:
      'MODO DEMOSTRACIÓN: este es un diagnóstico de ejemplo, no un análisis real de tu foto. ' +
      'Configura la clave de Anthropic para obtener diagnósticos reales. En el ejemplo, la planta muestra hojas amarillas por exceso de riego.',
    problemas: [
      {
        nombre: 'Exceso de riego',
        tipo: 'riego',
        probabilidad: 'alta',
        sintomas_observados: ['Hojas inferiores amarillas', 'Sustrato con aspecto muy húmedo'],
        explicacion:
          'Cuando las raíces están siempre mojadas no reciben oxígeno y la planta amarillea sus hojas más viejas.',
      },
      {
        nombre: 'Posible falta de luz',
        tipo: 'luz',
        probabilidad: 'baja',
        sintomas_observados: ['Tallos algo alargados'],
        explicacion: 'Con poca luz la planta se estira buscando claridad y crece más débil.',
      },
    ],
    tratamiento: [
      { paso: 'Deja de regar', detalle: 'No riegues hasta que los primeros 3 cm de tierra estén secos.', cuando: 'hoy' },
      { paso: 'Retira hojas dañadas', detalle: 'Corta las hojas totalmente amarillas con tijeras limpias.', cuando: 'hoy' },
      { paso: 'Revisa el drenaje', detalle: 'Asegúrate de que la maceta tiene agujeros y vacía el plato.', cuando: 'esta_semana' },
    ],
    prevencion: [
      'Riega solo cuando la tierra esté seca al tacto.',
      'Usa macetas con agujeros de drenaje.',
      'Colócala cerca de una ventana con luz indirecta.',
    ],
    cuidados: {
      riego: 'Cada 7-10 días, cuando el sustrato esté seco en superficie.',
      luz: 'Luz indirecta brillante; evita el sol directo de mediodía.',
      humedad: 'Media; agradece pulverizaciones en ambientes secos.',
      abono: 'Abono líquido para plantas verdes cada 15 días en primavera y verano.',
    },
    riego_cada_dias: 8,
    recordatorios_sugeridos: [
      { tipo: 'revision', titulo: 'Revisar si las hojas nuevas salen verdes', en_dias: 7, repetir_cada_dias: null },
      { tipo: 'riego', titulo: 'Comprobar humedad y regar si está seca', en_dias: 8, repetir_cada_dias: 8 },
      { tipo: 'abono', titulo: 'Abonar', en_dias: 15, repetir_cada_dias: 15 },
    ],
    comparacion_anterior: previous
      ? 'MODO DEMOSTRACIÓN: en el ejemplo la planta ha mejorado respecto a la última revisión.'
      : null,
    calidad_foto: { adecuada: true, sugerencia: null },
    aviso: 'El potus es tóxico si lo ingieren perros, gatos o niños pequeños.',
  };
}
