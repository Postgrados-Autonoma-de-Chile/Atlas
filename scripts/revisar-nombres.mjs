#!/usr/bin/env node
/**
 * Personas cuyo nombre/apellido no pasaría la validación de hoy. Solo lectura.
 *
 *   node scripts/revisar-nombres.mjs
 *
 * POR QUÉ EXISTE: hasta la revisión F14, validarNombre() solo exigía "sin dígitos" — una pregunta
 * completa, un correo pegado en la respuesta, o el nombre repetido en el apellido pasaban sin
 * problema. Esto quedó guardado en `person` para quienes se registraron antes del arreglo, y
 * certificacion.ts imprime persona.nombre/apellido TAL CUAL en el PDF del certificado sin volver
 * a preguntar — así que un nombre mal capturado hoy es un certificado mal impreso el día que esa
 * persona termine el curso.
 *
 * Este script NO corrige nada. Adivinar el nombre real a partir de basura ("Sara Fredes
 * Hfredes@indap.cl Ahí Está El Apellido" → ¿es "Sara Fredes"? probablemente, pero es una persona
 * quien debe confirmarlo, no una heurística) es exactamente el tipo de decisión que este proyecto
 * no delega a código. Lo que hace es señalar A QUIÉN corregirle el registro a mano —o a quién
 * volver a preguntarle por WhatsApp— antes de que llegue a certificarse.
 *
 * Usa el MISMO criterio que src/core/identidad.ts (validarNombre + quitarRepetidoDeNombre),
 * copiado acá en JS plano para no depender del build de TypeScript en un script suelto.
 */
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL (Cloud SQL Auth Proxy o conexión directa).');
  process.exit(1);
}

// ── Copia exacta de la lógica de src/core/identidad.ts. Si esa cambia, actualizar acá también. ──
function validarNombre(raw) {
  const v = String(raw ?? '').trim();
  if (v.length < 2 || v.length > 80) return false;
  if (/\d/.test(v)) return false;
  if (/[?¿@:]/.test(v)) return false;
  if (v.split(/\s+/).length > 5) return false;
  return true;
}
const plano = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function quitarRepetidoDeNombre(nombreYaCapturado, apellidoCrudo) {
  const yaVisto = new Set(plano(nombreYaCapturado ?? '').split(/\s+/).filter(Boolean));
  return String(apellidoCrudo ?? '')
    .trim()
    .split(/\s+/)
    .filter((palabra) => palabra && !yaVisto.has(plano(palabra)))
    .join(' ');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const { rows } = await pool.query(`
  SELECT p.id, p.nombre, p.apellido, p.created_at,
         i.valor_lookup AS wa_id,
         EXISTS(SELECT 1 FROM certificate c WHERE c.person_id = p.id AND c.folio IS NOT NULL) AS certificada
    FROM person p
    LEFT JOIN person_identity i ON i.person_id = p.id AND i.tipo = 'wa_id'
   ORDER BY p.created_at DESC
`);
await pool.end();

const motivos = (nombre, apellido) => {
  const r = [];
  if (!validarNombre(nombre)) r.push('nombre no pasa la validación de hoy');
  if (!validarNombre(apellido)) r.push('apellido no pasa la validación de hoy');
  const sinRepetir = quitarRepetidoDeNombre(nombre, apellido);
  if (validarNombre(nombre) && validarNombre(apellido) && sinRepetir !== apellido.trim()) {
    r.push(sinRepetir ? `apellido repite parte del nombre (quedaría: "${sinRepetir}")` : 'apellido es enteramente una repetición del nombre');
  }
  return r;
};

const afectadas = rows
  .map((r) => ({ ...r, motivos: motivos(r.nombre ?? '', r.apellido ?? '') }))
  .filter((r) => r.motivos.length > 0);

if (!afectadas.length) {
  console.log('Ningún registro actual falla la validación de hoy.');
  process.exit(0);
}

console.log(`${afectadas.length} de ${rows.length} personas registradas necesitan revisión manual:\n`);
for (const r of afectadas) {
  const cert = r.certificada ? '  ⚠️  YA TIENE CERTIFICADO EMITIDO CON ESTE NOMBRE' : '';
  console.log(`· ${r.wa_id ?? '(sin whatsapp)'}  —  registrada ${new Date(r.created_at).toLocaleString('es-CL')}${cert}`);
  console.log(`  nombre:   "${r.nombre}"`);
  console.log(`  apellido: "${r.apellido}"`);
  for (const m of r.motivos) console.log(`  · ${m}`);
  console.log();
}

const certificadas = afectadas.filter((r) => r.certificada);
if (certificadas.length) {
  console.log(`⚠️  ${certificadas.length} de estas YA tienen un certificado emitido con el nombre mal capturado. Revisar primero.`);
}
