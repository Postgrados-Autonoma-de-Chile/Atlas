#!/usr/bin/env node
/**
 * Lote de corrección de los 14 registros de F14 con propuesta revisada y aprobada por el usuario
 * (22/23-sep-2026). NO es una herramienta reutilizable — es una lista fija, específica de este
 * incidente. Para casos nuevos, usar scripts/corregir-persona.mjs uno a la vez.
 *
 * Cada corrección es una LECTURA humana propuesta y confirmada, no una heurística automática:
 * 10 son "el apellido repite completo el nombre" (nombre ya tenía nombre+apellidos juntos, se
 * separa con la convención chilena — últimas dos palabras = apellido paterno+materno); 4 son
 * lectura del texto libre donde SÍ había un nombre reconocible en medio del ruido.
 *
 *   node scripts/lote-2026-09-23-nombres.mjs            # ensayo
 *   node scripts/lote-2026-09-23-nombres.mjs --aplicar  # escribe
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

const CORRECCIONES = [
  { id: 'e7c79376-d8c3-4906-a360-8893e149e926', nombre: 'Jonathan', apellido: 'Martinez Meza' },
  { id: 'ac502b6e-c823-4baa-83fe-a80c4cfd72c9', nombre: 'Gabriel', apellido: 'Álvarez Troncozo' },
  { id: 'fdd960db-d5be-4e77-809c-07e937d1d2f1', nombre: 'Solange', apellido: 'López Valdivia' },
  { id: '6e2ec463-7292-4073-8bc2-e19d26e4c9ff', nombre: 'Alexis', apellido: 'Roca' },
  { id: 'ddb4c14e-bcbf-4104-a1d2-6461a4e0e21a', nombre: 'Bessy', apellido: 'Gallardo Prado' },
  { id: '4c6fce11-7e12-4d0f-897f-2b9f4b430d1b', nombre: 'Valeria', apellido: 'Lufi' },
  { id: '3acf15a9-4226-4227-9bc6-30ea7c2a418f', nombre: 'Samuel', apellido: 'Trangulado' },
  { id: 'fc0ef6e3-f5ea-41a5-81c8-4ec8311875a8', nombre: 'Jonathan David', apellido: 'Contreras Trujillo' },
  { id: '17180971-f014-4649-87fe-8d4265d507ef', nombre: 'Bryan Alexis', apellido: 'Cortez Suazo' },
  { id: '05f7a24d-18fb-477a-9846-ce7a73320bec', nombre: 'John Anderson', apellido: 'Riascos Murillo' },
  { id: '57a786d1-8bd5-41cc-950d-4650fd7fd26b', nombre: 'Oscar Andres', apellido: 'González Castro' },
  { id: 'c99ea089-300f-482e-873a-e2bbba850d6e', nombre: 'Martha Cecilia', apellido: 'Turiso Acosta' },
  { id: '9a1e2d6d-29dc-4032-bf02-029031975904', nombre: 'John', apellido: 'Fuenzalida Rivera' },
  { id: '035faed7-9251-44aa-8b0d-d707edb2c046', nombre: 'Daniel Eduardo Abraham', apellido: 'Fernandez Oyarce' },
];

const aplicar = process.argv.includes('--aplicar');

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let ok = 0, error = 0;

for (const c of CORRECCIONES) {
  if (!validarNombre(c.nombre) || !validarNombre(c.apellido)) {
    console.log(`[RECHAZADO] ${c.id}: "${c.nombre}" / "${c.apellido}" no pasa validarNombre() -- revisar el lote`);
    error++;
    continue;
  }
  const { rows } = await pool.query('SELECT nombre, apellido FROM person WHERE id = $1', [c.id]);
  if (!rows[0]) {
    console.log(`[NO EXISTE] ${c.id}`);
    error++;
    continue;
  }
  console.log(`${aplicar ? '[CORREGIDO]' : '[SE CORREGIRÍA]'} ${c.id}: "${rows[0].nombre}" / "${rows[0].apellido}" → "${c.nombre}" / "${c.apellido}"`);
  ok++;
  if (aplicar) {
    await pool.query('UPDATE person SET nombre = $1, apellido = $2 WHERE id = $3', [c.nombre, c.apellido, c.id]);
  }
}

await pool.end();
console.log(`\n${ok} ${aplicar ? 'corregidos' : 'se corregirían con --aplicar'}, ${error} con error.`);
