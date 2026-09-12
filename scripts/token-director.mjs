#!/usr/bin/env node
/**
 * Alta y baja de tokens del panel de dirección.
 *
 * El panel se reparte con un token por persona para poder saber quién entró y para poder
 * revocárselo a una sola sin rotarle el secreto a todas. Editar esa lista a mano en la consola de
 * Secret Manager es exactamente el tipo de tarea donde se cuela un token cortado o un nombre
 * repetido, así que se hace desde acá.
 *
 *   node scripts/token-director.mjs listar
 *   node scripts/token-director.mjs agregar "Ana Directora"
 *   node scripts/token-director.mjs quitar  "Ana Directora"
 *
 * `agregar` imprime el token UNA VEZ. No queda guardado en ninguna otra parte legible: el secreto
 * es la única copia, y está para que el servicio lo compare, no para volver a leerlo. Si se pierde,
 * se quita a esa persona y se le agrega de nuevo.
 *
 * Después de agregar o quitar hay que redesplegar para que el servicio tome la versión nueva:
 *   gcloud run services update atlas-demo --region us-east1 \
 *     --update-secrets=DASHBOARD_TOKENS_DIRECCION=atlas-tokens-direccion:latest
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const PROYECTO = process.env.ATLAS_PROYECTO ?? 'postgrados-ua';
const SECRETO = process.env.ATLAS_SECRETO_DIRECCION ?? 'atlas-tokens-direccion';

// En Windows `gcloud` es un .cmd, y Node ≥18 se niega a ejecutar un .cmd sin `shell: true` (la
// mitigación de BatBadBut). Con shell los argumentos se concatenan sin escapar, así que lo único
// que va en la línea de comandos son estos dos valores y se validan antes: el nombre de la persona
// NUNCA pasa por ahí — entra por stdin, con --data-file=-.
const SEGURO = /^[A-Za-z0-9_-]+$/;
for (const [k, v] of [['ATLAS_PROYECTO', PROYECTO], ['ATLAS_SECRETO_DIRECCION', SECRETO]]) {
  if (!SEGURO.test(v)) {
    console.error(`${k} tiene caracteres que no corresponden a un identificador de GCP: ${v}`);
    process.exit(1);
  }
}
const ENenWIN = process.platform === 'win32';
const gcloud = (args, entrada) =>
  execFileSync(ENenWIN ? 'gcloud.cmd' : 'gcloud', args, {
    input: entrada, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], shell: ENenWIN,
  });

/**
 * Lee la lista. Si falla, ABORTA: no devuelve vacío.
 *
 * La primera versión de esto atrapaba el error y seguía con una lista vacía, y por un rato
 * `listar` respondió "sin tokens" cuando lo que pasaba era que no encontraba gcloud. Con esa
 * lógica, un `quitar` habría escrito una versión nueva sin NINGÚN token y revocado a todos de una
 * vez. Un fallo de lectura no puede parecerse a una lista vacía cuando lo siguiente es reescribirla.
 */
function leer() {
  try {
    return gcloud(['secrets', 'versions', 'access', 'latest', `--secret=${SECRETO}`, `--project=${PROYECTO}`]);
  } catch (e) {
    console.error(
      [
        '',
        `No se pudo leer el secreto ${SECRETO} en ${PROYECTO}.`,
        'Si el secreto todavía no existe, créalo primero:',
        `  gcloud secrets create ${SECRETO} --project=${PROYECTO} --replication-policy=automatic --data-file=-`,
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

/** Mismo formato que lee config.ts: `Nombre|token`, una por línea, `#` para comentarios. */
function parsear(crudo) {
  return crudo
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('|');
      return i < 1 ? null : { nombre: l.slice(0, i).trim(), token: l.slice(i + 1).trim() };
    })
    .filter(Boolean);
}

const CABECERA = [
  '# Tokens del panel de dirección: Nombre|token, uno por línea.',
  '# Se edita con scripts/token-director.mjs, no a mano.',
  '# Quitar una línea revoca a esa persona sin afectar a las demás (hay que redesplegar).',
].join('\n');

function guardar(lista) {
  const cuerpo = [CABECERA, ...lista.map((x) => `${x.nombre}|${x.token}`), ''].join('\n');
  gcloud(['secrets', 'versions', 'add', SECRETO, `--project=${PROYECTO}`, '--data-file=-'], cuerpo);
}

const [accion, nombre] = process.argv.slice(2);
const lista = parsear(leer());

if (accion === 'listar') {
  if (!lista.length) {
    console.log('Sin tokens de dirección. Agrega uno con:  node scripts/token-director.mjs agregar "Nombre"');
  } else {
    console.log(`${lista.length} con acceso a /panel/direccion:`);
    // El token NO se imprime: esto es para saber quién tiene acceso, no para recuperar secretos.
    for (const x of lista) console.log(`  · ${x.nombre}`);
  }
} else if (accion === 'agregar') {
  if (!nombre) throw new Error('Falta el nombre: agregar "Ana Directora"');
  if (nombre.includes('|')) throw new Error('El nombre no puede llevar "|": es el separador del formato');
  if (lista.some((x) => x.nombre.toLowerCase() === nombre.toLowerCase())) {
    throw new Error(`"${nombre}" ya tiene token. Quítalo primero si quieres uno nuevo.`);
  }
  const token = randomBytes(24).toString('base64url');
  guardar([...lista, { nombre, token }]);
  console.log(`\nToken de ${nombre} — cópialo ahora, no se vuelve a mostrar:\n\n  ${token}\n`);
  console.log('Falta redesplegar para que el servicio lo acepte:');
  console.log('  gcloud run services update atlas-demo --region us-east1 \\');
  console.log(`    --update-secrets=DASHBOARD_TOKENS_DIRECCION=${SECRETO}:latest`);
} else if (accion === 'quitar') {
  if (!nombre) throw new Error('Falta el nombre: quitar "Ana Directora"');
  const quedan = lista.filter((x) => x.nombre.toLowerCase() !== nombre.toLowerCase());
  if (quedan.length === lista.length) throw new Error(`"${nombre}" no está en la lista.`);
  guardar(quedan);
  console.log(`${nombre} fuera. Su token deja de servir en cuanto redespliegues:`);
  console.log('  gcloud run services update atlas-demo --region us-east1 \\');
  console.log(`    --update-secrets=DASHBOARD_TOKENS_DIRECCION=${SECRETO}:latest`);
} else {
  console.log('Uso: node scripts/token-director.mjs listar | agregar "Nombre" | quitar "Nombre"');
  process.exitCode = 1;
}
