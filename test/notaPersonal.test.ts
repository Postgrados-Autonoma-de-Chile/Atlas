import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// "Mi necesidad": el campo personal de la microcápsula 2 (paso DEFINO).
//
// FUENTE: "Microcapsula 02 Cómo describir un problema de manera clara.docx" — Pantalla 5 «Escribe
// una frase breve sobre una situación que quieras resolver», campo de texto OPCIONAL, «no exigir
// envío», «no solicitar datos sensibles»; y §13: «Si la plataforma permite persistencia, la frase
// personal puede recuperarse en la cápsula 8».
//
// Ese último punto es la razón de que exista: la ficha de cierre ya la leía y siempre la encontraba
// vacía, porque nada la escribía.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let guardadas: { personId: string; leccionId: string; texto: string }[] = [];
let guardarOk = true;

mock.module('../src/store/db.ts', {
  namedExports: { dbEnabled: () => true, dbInsertAudit: async () => {}, getPool: () => null },
});
mock.module('../src/store/fichaCierre.ts', {
  namedExports: {
    guardarNota: async (personId: string, leccionId: string, texto: string) => {
      if (!guardarOk) return false;
      guardadas.push({ personId, leccionId, texto });
      return true;
    },
  },
});

const { ofrecerNotaPersonal, manejarNotaPersonal } = await import('../src/flows/notaPersonal');
import type { InboundMessage, MessagingProvider, SendResult } from '../src/messaging/types';

const OK: SendResult = { ok: true };
function fakeProvider() {
  const textos: string[] = [];
  const p: MessagingProvider = {
    nombre: 'fake', configurado: () => true,
    enviarTexto: async (_t, texto) => (textos.push(texto), OK),
    enviarPlantilla: async () => OK, enviarBotones: async () => OK, enviarLista: async () => OK,
    enviarDocumento: async () => OK, marcarLeido: async () => OK, descargarMedia: async () => null,
  };
  return { p, textos };
}

let n = 0, nWa = 0;
let DE = '+56900140001';
const nuevo = () => (DE = `+5690014${String(++nWa).padStart(4, '0')}`);
const texto = (t: string): InboundMessage =>
  ({ waMessageId: 'w' + ++n, from: DE, timestamp: new Date(), type: 'text', text: t });
const PERSONA = { id: 'p1', nombre: 'Rodrigo' } as any;
const reset = () => { guardadas = []; guardarOk = true; nuevo(); };

const FRASE = 'Necesito encontrar un curso de computación cerca de mi casa que sea de tarde';

test('la oferta usa la consigna del documento y deja claro que es opcional', async () => {
  reset();
  const { p, textos } = fakeProvider();
  await ofrecerNotaPersonal(DE, p, 'l2');
  assert.match(textos[0], /Mi necesidad/);
  assert.match(textos[0], /opcional/i);
  assert.match(textos[0], /qué ocurre, qué necesitas y qué condiciones/i, 'la pauta del paso DEFINO');
  assert.match(textos[0], /\*continuar\*/, 'y cómo saltarla');
});

test('la frase se guarda tal cual, atada a la microcápsula', async () => {
  reset();
  const { p, textos } = fakeProvider();
  await ofrecerNotaPersonal(DE, p, 'l2');
  const r = await manejarNotaPersonal(texto(FRASE), PERSONA, p);
  assert.equal(r.handled, true);
  assert.deepEqual(guardadas, [{ personId: 'p1', leccionId: 'l2', texto: FRASE }]);
  assert.match(textos.at(-1)!, /actividad de cierre/, 'se le dice para qué sirve');
  assert.match(textos.at(-1)!, /\*continuar\*/);
});

test('saltarla es un camino de primera clase: el documento prohíbe exigir el envío', async () => {
  for (const salto of ['continuar', 'no', 'paso', 'después', 'ninguna']) {
    reset();
    const { p, textos } = fakeProvider();
    await ofrecerNotaPersonal(DE, p, 'l2');
    await manejarNotaPersonal(texto(salto), PERSONA, p);
    assert.equal(guardadas.length, 0, `"${salto}" no debe guardar nada`);
    assert.match(textos.at(-1)!, /Sin problema/, `"${salto}" debe seguir al curso`);
  }
});

test('un RUT, un teléfono o un correo NO se guardan', async () => {
  // El documento es explícito: «no solicitar datos sensibles», y esta frase se persiste y se vuelve
  // a mostrar en la cápsula 8.
  for (const sensible of [
    'Necesito ayuda con mi trámite, mi rut es 12.345.678-5 por si sirve',
    'Necesito que me llamen al +56 9 8765 4321 para coordinar el curso',
    'Mi correo es rodrigo.palma@uautonoma.cl y necesito información del curso',
  ]) {
    reset();
    const { p, textos } = fakeProvider();
    await ofrecerNotaPersonal(DE, p, 'l2');
    await manejarNotaPersonal(texto(sensible), PERSONA, p);
    assert.equal(guardadas.length, 0, sensible);
    assert.match(textos.at(-1)!, /sin datos personales/i);
  }
});

test('no insiste: tras una frase corta cierra el campo y sigue', async () => {
  // Insistir con un campo que el documento declara opcional lo convertiría en un requisito que el
  // plan no establece.
  reset();
  const { p, textos } = fakeProvider();
  await ofrecerNotaPersonal(DE, p, 'l2');
  await manejarNotaPersonal(texto('nada'), PERSONA, p);
  const r = await manejarNotaPersonal(texto('hola de nuevo'), PERSONA, p);
  assert.equal(r.handled, false, 'el campo ya se cerró: el turno le pertenece al tutor');
  void textos;
});

test('fuera de la ventana no intercepta nada', async () => {
  reset();
  const { p } = fakeProvider();
  const r = await manejarNotaPersonal(texto('quiero seguir el curso'), PERSONA, p);
  assert.equal(r.handled, false);
});

test('si la base falla, no se le promete que quedó guardada', async () => {
  reset();
  guardarOk = false;
  const { p, textos } = fakeProvider();
  await ofrecerNotaPersonal(DE, p, 'l2');
  await manejarNotaPersonal(texto(FRASE), PERSONA, p);
  assert.match(textos.at(-1)!, /No pude guardarla/);
  assert.doesNotMatch(textos.at(-1)!, /Anotada/);
});

test('sin persona no intercepta', async () => {
  reset();
  const { p } = fakeProvider();
  await ofrecerNotaPersonal(DE, p, 'l2');
  const r = await manejarNotaPersonal(texto(FRASE), null, p);
  assert.equal(r.handled, false);
});
