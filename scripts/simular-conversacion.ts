// Simulador de conversación: recorre el curso completo por consola, sin WhatsApp.
//
// Llama al MISMO pipeline que el webhook (procesarMensajeEntrante) con un proveedor de mensajería
// que imprime en pantalla en vez de llamar a Meta. Así se puede caminar el flujo nuevo entero
// —caracterización → 8 microcápsulas con su "Lo intento" → ficha de cierre → certificado— contra
// la base local, sin número real, sin costo por mensaje y sin tocar producción.
//
// Uso:
//   DATABASE_URL=postgres://atlas:atlaslocal@localhost:5432/atlas npx tsx scripts/simular-conversacion.ts
//   ... y luego se escribe como estudiante. Los botones y listas se eligen por número.
//
// Comandos: /salir · /estado · /nuevo · /reset
//
// GUARDAS
//   · El proveedor es de consola y se inyecta: este script no puede enviar un WhatsApp real.
//   · Se niega a correr contra una base que no sea local, salvo --acepto-base-remota. En Cloud SQL
//     viven estudiantes de verdad y un certificado emitido; una prueba no se hace ahí.
//   · Si hay SMTP configurado, la certificación SÍ manda un correo real (es su flujo). Se avisa.

import { createInterface } from 'node:readline/promises';
import { initDb, dbEnabled } from '../src/store/db';
import { procesarMensajeEntrante } from '../src/routes/whatsapp';
import { estadoAcademico } from '../src/store/cursos';
import { buscarPersonaPorWaId } from '../src/store/personas';
import { estaCompleta, respondidas, totalPreguntas } from '../src/store/caracterizacion';
import { kvDel } from '../src/store/kv';
import { config } from '../src/config';
import type {
  BotonOpcion, ListaOpcion, InboundMessage, MessagingProvider, SendResult,
} from '../src/messaging/types';

const OK: SendResult = { ok: true, messageId: 'sim' };
const C = {
  bot: '\x1b[36m', yo: '\x1b[32m', op: '\x1b[33m', gris: '\x1b[90m', off: '\x1b[0m',
};

/** Opciones del último mensaje interactivo: permiten "tocar el botón" escribiendo su número. */
let ultimasOpciones: { id: string; titulo: string }[] = [];

const proveedorConsola: MessagingProvider = {
  nombre: 'consola',
  configurado: () => true,

  async enviarTexto(_to, texto) {
    ultimasOpciones = [];
    console.log(`\n${C.bot}ATLAS${C.off}  ${texto.replace(/\n/g, '\n       ')}`);
    return OK;
  },

  async enviarBotones(_to, cuerpo, botones: BotonOpcion[]) {
    ultimasOpciones = botones.map((b) => ({ id: b.id, titulo: b.titulo }));
    console.log(`\n${C.bot}ATLAS${C.off}  ${cuerpo.replace(/\n/g, '\n       ')}`);
    botones.forEach((b, i) => console.log(`       ${C.op}[${i + 1}]${C.off} ${b.titulo}`));
    return OK;
  },

  async enviarLista(_to, cuerpo, textoBoton, opciones: ListaOpcion[]) {
    ultimasOpciones = opciones.map((o) => ({ id: o.id, titulo: o.titulo }));
    console.log(`\n${C.bot}ATLAS${C.off}  ${cuerpo.replace(/\n/g, '\n       ')}`);
    console.log(`       ${C.gris}(${textoBoton})${C.off}`);
    opciones.forEach((o, i) =>
      console.log(`       ${C.op}[${i + 1}]${C.off} ${o.titulo}${o.descripcion ? ` — ${o.descripcion}` : ''}`),
    );
    return OK;
  },

  async enviarPlantilla(_to, plantilla, lang, params) {
    console.log(`\n${C.gris}[plantilla ${plantilla} (${lang}) params=${JSON.stringify(params)}]${C.off}`);
    return OK;
  },

  // Hoy nada llama a enviarDocumento —el certificado va por correo— pero la interfaz lo exige.
  async enviarDocumento(_to, urlOMediaId, filename, caption) {
    console.log(`\n${C.bot}ATLAS${C.off}  ${C.op}📄 ${filename}${C.off} ${C.gris}${urlOMediaId.slice(0, 100)}${C.off}`);
    if (caption) console.log(`       ${caption.replace(/\n/g, '\n       ')}`);
    return OK;
  },

  async descargarMedia() { return null; },
  async marcarLeido() { return OK; },
};

/** Solo bases locales: una prueba no se corre contra los estudiantes de verdad. */
function baseEsLocal(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === 'host.docker.internal';
  } catch {
    return false;
  }
}

let n = 0;
const nuevoId = () => `sim.${Date.now()}.${++n}`;

async function estado(waId: string): Promise<void> {
  const persona = await buscarPersonaPorWaId(waId);
  if (!persona) return console.log(`${C.gris}sin persona registrada para ${waId}${C.off}`);
  const [ac, comp, hechas, total] = await Promise.all([
    estadoAcademico(persona.id), estaCompleta(persona.id),
    respondidas(persona.id), totalPreguntas(),
  ]);
  console.log(`${C.gris}persona        ${persona.id} · ${[persona.nombre, persona.apellido].filter(Boolean).join(' ')}`);
  console.log(`caracterización ${comp ? 'completa' : `${hechas}/${total}`}`);
  console.log(`curso           ${ac?.curso?.nombre ?? '—'}`);
  console.log(`avance          ${ac?.completadas ?? 0}/${ac?.totalLecciones ?? 0} · próxima: ${ac?.proxima ? `${ac.proxima.orden}. ${ac.proxima.titulo}` : '—'}${C.off}`);
}

/** Borra el estado efímero del número: memoria del tutor y flujos a medio camino. */
async function reset(waId: string): Promise<void> {
  for (const k of [`mem:${waId}`, `registro:${waId}`, `caracterizacion:${waId}`,
    `evaluacion:${waId}`, `ficha:${waId}`, `cert:${waId}`, `quiz:pendiente:${waId}`]) {
    await kvDel(k).catch(() => {});
  }
  ultimasOpciones = [];
  console.log(`${C.gris}estado efímero borrado (lo persistido en Postgres NO se toca)${C.off}`);
}

async function main() {
  const remotaOk = process.argv.includes('--acepto-base-remota');
  const url = process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('Define DATABASE_URL (la base local del contenedor).');
  if (!baseEsLocal(url) && !remotaOk) {
    throw new Error(
      `DATABASE_URL apunta a ${new URL(url).hostname}, que no es local.\n` +
      'En la base de producción hay estudiantes reales y un certificado emitido: no se prueba ahí.\n' +
      'Si de verdad lo quieres, repite con --acepto-base-remota.',
    );
  }

  await initDb();
  if (!dbEnabled()) throw new Error('Sin conexión a la base: el flujo curricular no puede correr.');

  let waId = process.env.SIM_WA_ID || `+5695${String(Date.now()).slice(-7)}`;

  console.log(`${C.gris}────────────────────────────────────────────────────────${C.off}`);
  console.log(`ATLAS · simulador de conversación   ${C.gris}proveedor: consola (no envía nada)${C.off}`);
  console.log(`${C.gris}base:     ${new URL(url).hostname}${new URL(url).pathname}`);
  console.log(`número:   ${waId}`);
  console.log(`correo:   ${config.smtpHost ? `SMTP configurado (${config.smtpHost}) — la certificación enviará un correo REAL` : 'sin SMTP: la certificación no podrá enviar el código'}`);
  console.log(`comandos: /salir  /estado  /nuevo  /reset${C.off}`);
  console.log(`${C.gris}────────────────────────────────────────────────────────${C.off}`);

  /** Procesa una línea del estudiante. Devuelve false si pidió salir. */
  async function turno(linea: string): Promise<boolean> {
    if (!linea) return true;
    if (linea === '/salir') return false;
    if (linea === '/estado') { await estado(waId); return true; }
    if (linea === '/reset') { await reset(waId); return true; }
    if (linea === '/nuevo') {
      waId = `+5695${String(Date.now()).slice(-7)}`;
      ultimasOpciones = [];
      console.log(`${C.gris}número nuevo: ${waId} (empieza de cero)${C.off}`);
      return true;
    }

    // Un número cuando hay botones/lista en pantalla = tocar esa opción.
    const idx = /^\d+$/.test(linea) ? Number(linea) - 1 : -1;
    const elegida = idx >= 0 ? ultimasOpciones[idx] : undefined;

    const msg: InboundMessage = elegida
      ? {
          waMessageId: nuevoId(), from: waId, timestamp: new Date(), type: 'interactive',
          interactiveReplyId: elegida.id, interactiveReplyTitle: elegida.titulo,
        }
      : { waMessageId: nuevoId(), from: waId, timestamp: new Date(), type: 'text', text: linea };

    if (elegida) console.log(`${C.gris}      (tocó «${elegida.titulo}»)${C.off}`);

    try {
      await procesarMensajeEntrante(msg, proveedorConsola);
    } catch (e) {
      console.error(`\n\x1b[31mfalló el turno:\x1b[0m ${String(e)}`);
    }
    return true;
  }

  // Guion por tubería o archivo (`< guion.txt`): el mismo recorrido, repetible. Útil para volver a
  // caminar el curso completo después de un cambio sin tipear 40 respuestas de nuevo.
  if (!process.stdin.isTTY) {
    const guion = await new Promise<string>((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (d) => (buf += d));
      process.stdin.on('end', () => resolve(buf));
    });
    for (const linea of guion.split(/\r?\n/)) {
      const l = linea.trim();
      if (!l || l.startsWith('#')) continue;
      console.log(`\n${C.yo}tú${C.off}  ▸ ${l}`);
      if (!(await turno(l))) break;
    }
    return salir();
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    let linea: string;
    try {
      linea = (await rl.question(`\n${C.yo}tú${C.off}  ▸ `)).trim();
    } catch {
      break; // entrada cerrada (Ctrl+D)
    }
    if (!(await turno(linea))) break;
  }
  rl.close();
  return salir();
}

/** Cierra la entrada antes de terminar: salir con stdin a medio cerrar aborta libuv en Windows. */
function salir(): never {
  process.stdin.removeAllListeners();
  process.stdin.pause();
  process.exit(0);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
