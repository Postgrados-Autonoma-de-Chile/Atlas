#!/usr/bin/env node
/**
 * Lote único: excluye de ATLAS a las personas que aparecen en Bitrix24, por decisión de dirección
 * del 24-09-2026. Excluir NO es borrar: la persona conserva registro, consentimiento, avance y
 * certificados, y ATLAS deja de escribirle y de responderle. Se revierte poniendo excluido_at=NULL.
 *
 * La lista sale del cruce de los 78 registrantes contra Bitrix24 (24-09-2026): 77 aparecen allá
 * —1 como lead comercial activo con hilo de WhatsApp vivo, 64 marcados y refutados al verificar, 12
 * como coincidencia sin WhatsApp— y 1 no aparece (Mauricio Vial, +56992179265), que queda fuera del
 * lote. Los números van escritos uno por uno a propósito: este script no vuelve a consultar
 * Bitrix24 ni deduce a quién tocar, así que lo que hace es auditable leyéndolo.
 *
 *   node scripts/excluir-bitrix24-2026-09-24.mjs            → simulación (no escribe)
 *   node scripts/excluir-bitrix24-2026-09-24.mjs --aplicar  → aplica
 */
import pg from 'pg';

if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL.'); process.exit(1); }
const APLICAR = process.argv.includes('--aplicar');
const MOTIVO = 'Aparece en Bitrix24 (cruce 2026-09-24, decisión de dirección)';

/** 77 personas. Formato E.164 con '+', igual que person_identity.valor_lookup. */
const NUMEROS = [
  // Confirmada como lead comercial activo con hilo de WhatsApp vivo.
  ['+56994386248', 'Guillermina Valencia'],
  // Marcadas por el primer pase y refutadas en la verificación (64).
  ['+56949851272', 'Francisco Rojas'],
  ['+56936464823', 'Catherine Campos Martinez'],
  ['+56976504510', 'Richard Muñoz'],
  ['+56998274155', 'Ximena Berna'],
  ['+56954450093', 'Emmanuel Zuñiga'],
  ['+56947968453', 'Bryan Alexis Cortez Suazo'],
  ['+56954214213', 'Samuel Trangulado'],
  ['+56995142600', 'Valeria Lufi'],
  ['+56933470165', 'Pablo Mosqueira'],
  ['+56935933428', 'Alén Maripán'],
  ['+56942560141', 'Magdalena Vera'],
  ['+56963937313', 'Melissa David'],
  ['+56998658697', 'Alue Navarro'],
  ['+56963710851', 'Bessy Gallardo Prado'],
  ['+56951987346', 'Maicol Levens'],
  ['+56992808805', 'Daniel Eduardo Abraham Fernandez Oyarce'],
  ['+56999159709', 'Soledad Urrutia'],
  ['+56971903813', 'Sebastián Fernández'],
  ['+56983567040', 'Francisca Godoy'],
  ['+56933164395', 'John Fuenzalida Rivera'],
  ['+56958856737', 'Martha Cecilia Turiso Acosta'],
  ['+56983961205', 'Oscar Andres González Castro'],
  ['+56981281438', 'Jonathan David Contreras Trujillo'],
  ['+56979841452', 'Matías Velasquez'],
  ['+56934260374', 'Alexis Roca'],
  ['+56974172182', 'Solange López Valdivia'],
  ['+56995275199', 'Gabriel Álvarez Troncozo'],
  ['+56938886274', 'Jonathan Martinez Meza'],
  ['+56981440237', 'Patricia Fuenzalida'],
  ['+56935966108', 'Barbara Hernández'],
  ['+56998210869', 'Elías Raipane'],
  ['+56995131813', 'Solange Acevedo'],
  ['+56976748463', 'Claudia Rojas'],
  ['+56936843469', 'Natacha Ivonne Pavez Pavez'],
  ['+56973082638', 'Gonzalo Alvarado'],
  ['+56999875868', 'Daniel Ponce'],
  ['+56985959731', 'Karin Rodriguez'],
  ['+56981339764', 'Marianela Elmes'],
  ['+56990032300', 'Bernardita Reyes'],
  ['+56996886476', 'Roberto Rodríguez'],
  ['+56992034744', 'Pascal Gawenson'],
  ['+56975685359', 'Ricardo Nuñez'],
  ['+56949211528', 'Thessy Sene'],
  ['+56923883848', 'Rodrigo Palma'],
  ['+56981600113', 'Luis Miranda'],
  ['+56997777521', 'Ivees González'],
  ['+56956368457', 'Sebastián Rosales'],
  ['+56954828230', 'Vaithiare Espinoza'],
  ['+56961900228', 'Felipe Moreno'],
  ['+56964013664', 'Claudio Quezada'],
  ['+56986964480', 'Aaron Arriagada'],
  ['+56950695559', 'Julio Alguerno'],
  ['+56942207289', 'Pedro Olivares'],
  ['+56951979867', 'Gustavo Niklander'],
  ['+56958402356', 'Franco Rojas'],
  ['+56974033836', 'Karina Astorga'],
  ['+56990839981', 'Katherine Pamela Altamirano Sarabia'],
  ['+56959587992', 'Giuliana Camblor'],
  ['+56973596510', 'Alejandra Muñoz Sepulveda'],
  ['+56972183716', 'Sara Fredes'],
  ['+56949614895', 'Hector Valenzueka'],
  ['+56998596352', 'Magister En Derecho Penal Y Procesal Penal Urbina Reyes'],
  ['+56962849194', 'Carlos Sepúlveda'],
  ['+56958596015', 'Matías Palma'],
  // En Bitrix24 pero sin ningún hilo de WhatsApp (12).
  ['+56956329915', 'Juan Weldt Paredes'],
  ['+56963902615', 'Leslie Contreras'],
  ['+56982903642', 'Vivi Blanco'],
  ['+56961289673', 'Danny Lopez'],
  ['+56933763202', 'John Anderson Riascos Murillo'],
  ['+56977837201', 'Sergio Ulloa'],
  ['+56944051923', 'Yuviksa Alvarez'],
  ['+56931465186', 'Los Horarios Carrasco'],
  ['+56995069291', 'Israel Carvajal'],
  ['+56966339507', 'Jairo Videla'],
  ['+56987073910', 'Pablo Saldívar'],
  ['+56954544936', 'María Paz Campos Zurita'],
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

console.log(`${APLICAR ? 'APLICANDO' : 'SIMULACIÓN (sin escribir)'} — ${NUMEROS.length} números\n`);

let yaExcluidos = 0, porExcluir = 0, noEncontrados = 0, recordatoriosCancelados = 0;

for (const [waId, nombre] of NUMEROS) {
  const { rows } = await pool.query(
    `SELECT p.id, p.nombre, p.apellido, p.excluido_at
       FROM person_identity i JOIN person p ON p.id = i.person_id
      WHERE i.tipo = 'wa_id' AND i.valor_lookup = $1`,
    [waId],
  );
  if (!rows[0]) { noEncontrados++; console.log(`  SIN REGISTRO  ${waId}  (${nombre})`); continue; }

  const p = rows[0];
  if (p.excluido_at) { yaExcluidos++; console.log(`  ya excluida   ${waId}  ${p.nombre ?? ''} ${p.apellido ?? ''}`.trimEnd()); continue; }

  porExcluir++;
  console.log(`  ${APLICAR ? 'excluida     ' : 'se excluiría '} ${waId}  ${p.nombre ?? ''} ${p.apellido ?? ''}`.trimEnd());

  if (APLICAR) {
    await pool.query(`UPDATE person SET excluido_at = now(), excluido_motivo = $2, updated_at = now() WHERE id = $1`, [p.id, MOTIVO]);
    // Los recordatorios ya encolados no se despacharían igual (la consulta de despacho filtra por
    // excluido_at), pero dejarlos en 'programado' para siempre ensucia la cola.
    const c = await pool.query(`UPDATE reminder SET estado = 'cancelado' WHERE person_id = $1 AND estado = 'programado'`, [p.id]);
    recordatoriosCancelados += c.rowCount ?? 0;
  }
}

console.log(`\n${APLICAR ? 'Aplicado' : 'Resumen de la simulación'}:`);
console.log(`  excluidas:            ${porExcluir}`);
console.log(`  ya estaban excluidas: ${yaExcluidos}`);
console.log(`  sin registro en BD:   ${noEncontrados}`);
if (APLICAR) console.log(`  recordatorios cancelados: ${recordatoriosCancelados}`);
if (!APLICAR) console.log('\nPara aplicar: agrega --aplicar');

await pool.end();
