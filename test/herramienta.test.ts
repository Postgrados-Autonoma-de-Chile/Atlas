import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// "Me llevo una herramienta" (revisión F15): momento 5 de la arquitectura didáctica del Plan
// Nacional — "Recurso visual: entregar una regla, pauta o esquema reutilizable que sintetice el
// aprendizaje de la microcápsula". Hasta esta revisión no se cargaba como dato en absoluto;
// docs/CURRICULO.md lo dejaba anotado como pendiente ("hoy vive dentro del guion de cierre").
//
// FUENTE: la fila "Herramienta" (o su nombre local: Herramientas/Fórmula/Semáforo) de la
// "4. Secuencia instruccional detallada" de cada documento de producción — NO la fila "Ruta", que
// es el componente DEFINO✓/PREGUNTO✓ reutilizado en las 8 cápsulas y no es contenido propio de
// ninguna. Ver el comentario HERRAMIENTA en scripts/construir-curriculo.py para el detalle capsula
// por capsula.

const CURRICULO = JSON.parse(readFileSync(new URL('../curriculo/nivel1.json', import.meta.url), 'utf-8'));

const porOrden = (o: number) => CURRICULO.microcapsulas.find((m: any) => m.orden === o);

test('las cápsulas 1 a 5 y la 7 traen su herramienta, no vacía y sin repetir el guion de cierre', () => {
  for (const o of [1, 2, 3, 4, 5, 7]) {
    const cap = porOrden(o);
    assert.ok(cap.herramienta, `cápsula ${o} debería traer herramienta`);
    assert.ok(cap.herramienta.trim().length > 0);
    assert.notEqual(
      cap.herramienta, cap.guion_cierre,
      `cápsula ${o}: la herramienta tiene que ser una pieza propia, no una copia del cierre`,
    );
  }
});

test('las cápsulas 6 y 8 no traen herramienta inventada — ninguna introduce una regla nueva en la fuente', () => {
  // La 6 transfiere lo ya aprendido a casos distintos; la 8 entrega su propio producto (la ficha
  // de cierre, ya implementada en fichaCierre.ts). Que sea NULL es fiel a la fuente, no un hueco.
  assert.equal(porOrden(6).herramienta, null);
  assert.equal(porOrden(8).herramienta, null);
});

test('el contenido de cada herramienta es exactamente el de la fila de la fuente, palabra por palabra', () => {
  // Estos son los literales transcritos de "4. Secuencia instruccional detallada" de cada
  // documento de producción — fijarlos acá protege contra un cambio accidental en una edición
  // futura del JSON. Si el material cambia de verdad, este test se actualiza junto con la fuente.
  assert.equal(porOrden(1).herramienta, '1. DEFINO: ¿qué necesito resolver?');
  assert.equal(
    porOrden(2).herramienta,
    '4 preguntas para definir un problema:\n¿Qué ocurre? ¿Qué necesito? ¿Qué información tengo? ¿Qué condiciones debo considerar?',
  );
  assert.equal(
    porOrden(3).herramienta,
    '4 elementos para pedir una ayuda útil:\nNECESITO + CONTEXTO + CONDICIONES + RESULTADO.',
  );
  assert.equal(
    porOrden(4).herramienta,
    'Cinco formatos útiles:\nLista, tabla, pasos, ventajas/desventajas, criterios.',
  );
  assert.equal(
    porOrden(5).herramienta,
    '4 preguntas antes de usar información importante:\nFUENTE, FECHA, COINCIDENCIA, CONSECUENCIA.',
  );
  assert.equal(
    porOrden(7).herramienta,
    'Tres niveles para decidir cómo usar la IA:\nIA puede ayudar / IA + verificación / necesito fuente o persona competente.',
  );
});

test('el prompt del tutor instruye entregar la herramienta textual, en bloque propio, sin parafraseo', async () => {
  const { readFileSync: rfs } = await import('node:fs');
  const channel = rfs(new URL('../src/core/channel.ts', import.meta.url), 'utf-8');
  assert.match(channel, /herramienta/);
  assert.match(channel, /textual|palabra por palabra/i);
});
