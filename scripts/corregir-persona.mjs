#!/usr/bin/env node
/**
 * Corrige el nombre/apellido de UNA persona, a mano, uno a la vez.
 *
 *   node scripts/corregir-persona.mjs <id>                              # muestra el estado actual
 *   node scripts/corregir-persona.mjs <id> --nombre "X" --apellido "Y"  # ensayo: qué escribiría
 *   node scripts/corregir-persona.mjs <id> --nombre "X" --apellido "Y" --aplicar   # escribe
 *
 * POR QUÉ EXISTE: complementa a corregir-duplicados.mjs, que solo toca los casos mecánicos (quitar
 * una repetición exacta). Para el resto —apellido que quedaría vacío tras limpiar, o basura real
 * en el campo— no hay ninguna transformación automática segura: alguien tiene que DECIDIR cuál es
 * el nombre real. Esta herramienta hace ese último paso explícito y auditable: una persona, un
 * valor propuesto, una confirmación, nunca un lote silencioso.
 *
 * Valida con la MISMA regla que el flujo en vivo (src/core/identidad.ts): si lo que se quiere
 * escribir no pasaría validarNombre() hoy, se niega — no tiene sentido "corregir" un dato para
 * dejarlo en el mismo estado que esto existe para arreglar.
 */
import pg from 'pg';

function validarNombre(raw) {
  const v = String(raw ?? '').trim();
  if (v.length < 2 || v.length > 80) return false;
  if (/\d/.test(v)) return false;
  if (/[?¿@:]/.test(v)) return false;
  if (v.split(/\s+/).length > 5) return false;
  return true;
}

const [id, ...resto] = process.argv.slice(2);
const aplicar = resto.includes('--aplicar');
const iNombre = resto.indexOf('--nombre');
const iApellido = resto.indexOf('--apellido');
const nombreNuevo = iNombre >= 0 ? resto[iNombre + 1] : null;
const apellidoNuevo = iApellido >= 0 ? resto[iApellido + 1] : null;

if (!id) {
  console.error('Uso: node scripts/corregir-persona.mjs <id> [--nombre "X" --apellido "Y"] [--aplicar]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const { rows } = await pool.query(
  `SELECT p.id, p.nombre, p.apellido, p.created_at, i.valor_lookup AS wa_id,
          EXISTS(SELECT 1 FROM certificate c WHERE c.person_id = p.id AND c.folio IS NOT NULL) AS certificada
     FROM person p LEFT JOIN person_identity i ON i.person_id = p.id AND i.tipo = 'wa_id'
    WHERE p.id = $1`,
  [id],
);
const persona = rows[0];
if (!persona) {
  console.error(`No existe ninguna persona con id ${id}.`);
  await pool.end();
  process.exit(1);
}

console.log(`Estado actual de ${persona.id} (${persona.wa_id ?? 'sin whatsapp'}, registrada ${new Date(persona.created_at).toLocaleString('es-CL')}):`);
console.log(`  nombre:   "${persona.nombre}"`);
console.log(`  apellido: "${persona.apellido}"`);
if (persona.certificada) console.log('  ⚠️  YA TIENE CERTIFICADO EMITIDO');

if (!nombreNuevo && !apellidoNuevo) {
  await pool.end();
  process.exit(0); // solo consulta: sin --nombre/--apellido no hay nada más que hacer
}

const nombreFinal = nombreNuevo ?? persona.nombre;
const apellidoFinal = apellidoNuevo ?? persona.apellido;

if (!validarNombre(nombreFinal) || !validarNombre(apellidoFinal)) {
  console.error(`\nEl valor propuesto no pasa validarNombre() — no se escribe: "${nombreFinal}" / "${apellidoFinal}"`);
  await pool.end();
  process.exit(1);
}

console.log(`\n${aplicar ? 'Escribiendo' : 'Se escribiría (ensayo, falta --aplicar)'}:`);
console.log(`  nombre:   "${persona.nombre}" → "${nombreFinal}"`);
console.log(`  apellido: "${persona.apellido}" → "${apellidoFinal}"`);

if (aplicar) {
  await pool.query('UPDATE person SET nombre = $1, apellido = $2 WHERE id = $3', [nombreFinal, apellidoFinal, id]);
  console.log('\nListo.');
}
await pool.end();
