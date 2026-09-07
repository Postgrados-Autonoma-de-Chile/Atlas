// Borra la MEMORIA conversacional y los flujos a medio camino de un número, sin tocar a la persona
// ni su avance académico.
//
//   REDIS_URL=... npx tsx scripts/olvidar-conversacion.ts <+56912345678>
//
// PARA QUÉ: el tutor recuerda las últimas 48 h de conversación, y a veces ese recuerdo es justo el
// problema. Pasó en el piloto: una persona recibió "ahí viene tu quiz" por un defecto ya corregido,
// y aun después de arreglarlo el tutor siguió preguntando por ese quiz durante media hora — porque
// su memoria decía que lo había prometido. Sin esta herramienta, la única salida era esperar el TTL.
//
// EXIGE REDIS. Si corre sin REDIS_URL, kv degrada a memoria y el borrado no toca nada: aparentaría
// haber funcionado. Eso ya ocurrió una vez con el script de supresión, así que acá se verifica.
import { kvKind, kvDel, kvVivo } from '../src/store/kv';

/** Todo lo efímero de una conversación. Debe seguir a los flujos: un prefijo que falte deja
 *  al estudiante atrapado en un estado que ya nadie puede ver. */
const PREFIJOS = [
  'mem:',              // historial que ve el tutor
  'registro:',         // captura de identidad a medio camino
  'caracterizacion:',  // cuestionario a medio responder
  'evaluacion:',       // práctica abierta
  'quiz:pendiente:',   // marcador de práctica por enviar
  'nota:',             // campo personal de la microcápsula 2
  'ficha:',            // ficha de cierre a medio llenar
  'cert:',             // certificación a medio camino
  'bienestar:',        // marca de contención ya entregada
];

async function main() {
  const waId = process.argv[2];
  if (!waId || !/^\+\d{8,15}$/.test(waId)) {
    throw new Error('Uso: <waId en E.164 con +>, por ejemplo +56912345678');
  }
  if (kvKind !== 'redis') {
    throw new Error(
      `kv está en modo "${kvKind}": sin REDIS_URL este borrado no tocaría nada y parecería haber ` +
      'funcionado. Ejecútalo con REDIS_URL y acceso a la red del servicio.',
    );
  }
  if (!(await kvVivo())) throw new Error('Redis no responde al PING: no se borró nada.');

  for (const p of PREFIJOS) await kvDel(`${p}${waId}`);
  console.log(`✔ Conversación olvidada para ${waId} (${PREFIJOS.length} claves).`);
  console.log('  La persona, su avance y sus respuestas NO se tocaron.');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
