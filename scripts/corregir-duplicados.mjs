#!/usr/bin/env node
/**
 * Corrige el apellido duplicado en registros YA EXISTENTES: aplica la misma limpieza mecánica
 * que hoy corre en el flujo en vivo (quitarRepetidoDeNombre, src/core/identidad.ts) a lo que ya
 * quedó guardado, y actualiza SOLO cuando el resultado es una operación segura.
 *
 * Por defecto es un ENSAYO — no escribe nada.
 *
 *   node scripts/corregir-duplicados.mjs            # muestra qué haría, no toca la base
 *   node scripts/corregir-duplicados.mjs --aplicar  # corrige de verdad
 *
 * QUÉ CORRIGE, y por qué es seguro: el caso "Gabriela Silva" (nombre) + "Silva Arancibia"
 * (apellido), mostrado como "Gabriela Silva Silva Arancibia". Ninguno de los dos campos está mal
 * escrito — están duplicados entre sí. Quitar la repetición nunca inventa texto nuevo, solo
 * elimina lo que ya apareció antes en el MISMO registro. Solo toca casos donde nombre Y apellido,
 * cada uno por separado, ya pasan validarNombre() — es decir, ninguno de los dos es basura.
 *
 * QUÉ NO CORRIGE, a propósito: cualquier registro donde nombre o apellido NO pasan validarNombre()
 * por sí solos — una pregunta, un correo, una frase larga (revisión F14). Ahí no existe ninguna
 * transformación mecánica que recupere el nombre real: haría falta ADIVINAR qué parte del texto
 * es el nombre de verdad, y esa es una decisión humana sobre el nombre legal de una persona que
 * puede terminar impreso en un certificado — no algo que este script decida solo. Esos quedan
 * listados para revisión manual, exactamente como scripts/revisar-nombres.mjs ya los señala.
 *
 * Tampoco escribe cuando quitar la repetición dejaría el apellido VACÍO (la persona repitió todo
 * el nombre al responder "apellido"): guardar "" sería peor que no tocar nada.
 */
import pg from 'pg';

const aplicar = process.argv.includes('--aplicar');

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL (Cloud SQL Auth Proxy o conexión directa).');
  process.exit(1);
}

// ── Copia exacta de src/core/identidad.ts. Si esa cambia, actualizar acá también. ──
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
const { rows } = await pool.query(`SELECT id, nombre, apellido FROM person`);

let corregidos = 0;
let pendientesManual = 0;
let sinCambios = 0;

for (const r of rows) {
  const nombre = r.nombre ?? '';
  const apellido = r.apellido ?? '';

  if (!validarNombre(nombre) || !validarNombre(apellido)) {
    // Nombre o apellido son basura por sí solos: no es un caso de duplicación pura. Ya está en
    // el reporte de scripts/revisar-nombres.mjs; acá no se toca.
    pendientesManual++;
    continue;
  }

  const limpio = quitarRepetidoDeNombre(nombre, apellido);
  if (limpio === apellido.trim()) {
    sinCambios++;
    continue;
  }
  if (!limpio) {
    console.log(`[MANUAL] ${r.id}: el apellido "${apellido}" es enteramente una repetición del nombre "${nombre}" — no hay nada seguro que escribir, queda para revisión`);
    pendientesManual++;
    continue;
  }

  console.log(`${aplicar ? '[CORREGIDO]' : '[SE CORREGIRÍA]'} ${r.id}: apellido "${apellido}" → "${limpio}" (nombre "${nombre}" sin cambios)`);
  corregidos++;
  if (aplicar) {
    await pool.query('UPDATE person SET apellido = $1 WHERE id = $2', [limpio, r.id]);
  }
}

await pool.end();

console.log(
  `\n${corregidos} ${aplicar ? 'corregidos' : 'se corregirían con --aplicar'}, ` +
  `${pendientesManual} necesitan revisión manual (sin tocar), ` +
  `${sinCambios} ya estaban bien.`,
);
