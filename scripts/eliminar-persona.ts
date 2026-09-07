// Derecho de supresión (Ley 21.719 / F12): borra TODOS los datos de una persona.
// El esquema tiene ON DELETE CASCADE desde person → identidades, consentimientos, inscripciones,
// progreso, intentos de evaluación, respuestas, certificados y recordatorios. Además limpia el KV
// (memoria conversacional, flujos, ventana 24h) y la auditoría correlacionada al wa_id.
//
// Uso: DATABASE_URL=... npx tsx scripts/eliminar-persona.ts <+56912345678 | person-uuid> --confirmar
import { initDb, getPool } from '../src/store/db';
import { kvDel, kvKind } from '../src/store/kv';

async function main() {
  const [quien, flag] = process.argv.slice(2);
  if (!quien) throw new Error('Uso: <waId E.164 con + | person uuid> --confirmar');
  await initDb();
  const pool = getPool();
  if (!pool) throw new Error('Sin DATABASE_URL o esquema sin migrar.');

  const esUuid = /^[0-9a-f-]{36}$/i.test(quien);
  const r = esUuid
    ? await pool.query(
        `SELECT p.id, pi.valor_lookup AS wa_id FROM person p
         LEFT JOIN person_identity pi ON pi.person_id = p.id AND pi.tipo='wa_id' WHERE p.id=$1`, [quien])
    : await pool.query(
        `SELECT p.id, pi.valor_lookup AS wa_id FROM person_identity pi
         JOIN person p ON p.id = pi.person_id WHERE pi.tipo='wa_id' AND pi.valor_lookup=$1`, [quien]);
  const row = r.rows[0];
  if (!row) throw new Error('Persona no encontrada.');

  const resumen = await pool.query(
    `SELECT (SELECT count(*) FROM enrollment WHERE person_id=$1) AS inscripciones,
            (SELECT count(*) FROM certificate WHERE person_id=$1) AS certificados,
            (SELECT count(*) FROM reminder WHERE person_id=$1) AS recordatorios`,
    [row.id],
  );
  console.log(`Persona ${row.id} (wa_id ${row.wa_id ?? 'sin wa_id'})`);
  console.log(`  inscripciones: ${resumen.rows[0].inscripciones} · certificados: ${resumen.rows[0].certificados} · recordatorios: ${resumen.rows[0].recordatorios}`);

  if (flag !== '--confirmar') {
    console.log('\nDRY-RUN: nada borrado. Repite con --confirmar para eliminar DEFINITIVAMENTE.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (row.wa_id) await client.query(`DELETE FROM audit_log WHERE dialog_id=$1`, [row.wa_id]);
    await client.query(`DELETE FROM person WHERE id=$1`, [row.id]); // cascada al resto del esquema
    // Constancia de la supresión (sin PII: solo el uuid ya inexistente).
    await client.query(`INSERT INTO audit_log (type, detail) VALUES ('persona_suprimida', $1)`, [
      JSON.stringify({ personId: row.id }),
    ]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Sin REDIS_URL, kv degrada a memoria y esta limpieza no toca nada — aparentaría haber
  // funcionado. Pasó de verdad: dos supresiones dejaron la memoria conversacional intacta, y una
  // persona que volvió a registrarse en el mismo número heredó el hilo anterior. Se avisa fuerte en
  // vez de mentir en la última línea.
  if (row.wa_id && kvKind !== 'redis') {
    console.warn(`
⚠ kv en modo "${kvKind}": los datos de Postgres SÍ se borraron, pero el estado`);
    console.warn('  efímero (memoria del tutor, flujos a medio camino) NO. Vuelve a ejecutar con');
    console.warn(`  REDIS_URL, o corre: npx tsx scripts/olvidar-conversacion.ts ${row.wa_id}`);
  }
  if (row.wa_id) {
    // Un prefijo que falte deja residuo de una persona ya suprimida, así que esta lista tiene que
    // seguir a los flujos: 'caracterizacion:', 'ficha:' y 'quiz:pendiente:' nacieron con la
    // alineación curricular y no estaban acá. ('quiz:oferta:' desapareció al volverse obligatoria
    // la práctica; se conserva para limpiar instalaciones que aún lo tengan.)
    for (const prefijo of [
      'mem:', 'registro:', 'caracterizacion:', 'evaluacion:', 'quiz:pendiente:', 'quiz:oferta:',
      'ficha:', 'cert:', 'ult_in:',
    ]) {
      await kvDel(`${prefijo}${row.wa_id}`);
    }
    await kvDel(`certcode:${row.id}`);
  }
  console.log('✔ Persona eliminada (BD en cascada + KV + auditoría correlacionada). Queda la constancia "persona_suprimida".');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
