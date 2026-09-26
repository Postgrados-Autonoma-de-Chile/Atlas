#!/usr/bin/env node
/**
 * Revierte la exclusión de una o varias personas: pone excluido_at en NULL y ATLAS vuelve a
 * atenderlas, con su registro, consentimiento, avance y certificados intactos — es justo lo que la
 * migración 0018 dejó previsto al elegir una marca reversible en vez de un DELETE.
 *
 * NO resucita los recordatorios que la exclusión canceló. Volver a encolarlos es otra decisión
 * —implica escribirle a alguien que llevaba semanas sin recibir nada— y debe tomarse aparte.
 *
 *   node scripts/desbloquear-persona.mjs +56999159709             → simulación (no escribe)
 *   node scripts/desbloquear-persona.mjs +56999159709 --aplicar   → aplica
 *   node scripts/desbloquear-persona.mjs +569... +569... --aplicar → varias de una vez
 */
import pg from 'pg';

if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL.'); process.exit(1); }
const APLICAR = process.argv.includes('--aplicar');
const NUMEROS = process.argv.slice(2).filter((a) => a.startsWith('+'));
if (NUMEROS.length === 0) {
  console.error('Uso: node scripts/desbloquear-persona.mjs +56912345678 [+569...] [--aplicar]');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
console.log(`${APLICAR ? 'APLICANDO' : 'SIMULACIÓN (sin escribir)'} — ${NUMEROS.length} número(s)\n`);

let desbloqueadas = 0, noEstaban = 0, noEncontradas = 0;

for (const waId of NUMEROS) {
  const { rows } = await pool.query(
    `SELECT p.id, p.nombre, p.apellido, p.excluido_at, p.excluido_motivo
       FROM person_identity i JOIN person p ON p.id = i.person_id
      WHERE i.tipo = 'wa_id' AND i.valor_lookup = $1`,
    [waId],
  );
  if (!rows[0]) { noEncontradas++; console.log(`  SIN REGISTRO   ${waId}`); continue; }

  const p = rows[0];
  const quien = `${p.nombre ?? ''} ${p.apellido ?? ''}`.trim() || '(sin nombre)';
  if (!p.excluido_at) { noEstaban++; console.log(`  no estaba excluida  ${waId}  ${quien}`); continue; }

  desbloqueadas++;
  console.log(`  ${APLICAR ? 'desbloqueada  ' : 'se desbloquearía'} ${waId}  ${quien}`);
  console.log(`      excluida el ${new Date(p.excluido_at).toISOString().slice(0, 10)} — ${p.excluido_motivo ?? 'sin motivo registrado'}`);

  if (APLICAR) {
    await pool.query(
      `UPDATE person SET excluido_at = NULL, excluido_motivo = NULL, updated_at = now() WHERE id = $1`,
      [p.id],
    );
  }
}

console.log(`\n${APLICAR ? 'Aplicado' : 'Resumen de la simulación'}:`);
console.log(`  desbloqueadas:        ${desbloqueadas}`);
console.log(`  no estaban excluidas: ${noEstaban}`);
console.log(`  sin registro en BD:   ${noEncontradas}`);
if (!APLICAR) console.log('\nPara aplicar: agrega --aplicar');

await pool.end();
