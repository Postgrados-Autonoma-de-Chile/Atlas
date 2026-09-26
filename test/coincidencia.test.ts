import { test } from 'node:test';
import assert from 'node:assert/strict';

// Coincidencia tolerante de los flujos deterministas.
//
// La línea que estas pruebas cuidan: perdonar un dedazo, sí; adivinar, no. En un instrumento de
// caracterización, guardar la alternativa equivocada es peor que volver a preguntar.

const { plano, distancia, tolerancia, mencionaAlguna, elegirPorTexto } =
  await import('../src/core/coincidencia');

test('plano: minúsculas y sin tildes', () => {
  assert.equal(plano('  Caracterización  '), 'caracterizacion');
  // La ñ se descompone y pierde la virgulilla: deseado, así "ensenanza" calza con "enseñanza".
  assert.equal(plano('ÑOÑO'), 'nono');
});

test('distancia: cuenta ediciones y corta temprano cuando ya no vale la pena', () => {
  assert.equal(distancia('curso', 'curso'), 0);
  assert.equal(distancia('cuestionario', 'cuestionaro'), 1);
  assert.equal(distancia('encuesta', 'encusta'), 1);
  // Con max=2, todo lo que esté más lejos devuelve 3 sin terminar de calcular.
  assert.equal(distancia('hola', 'buenas tardes', 2), 3);
});

test('tolerancia: las palabras cortas no perdonan nada', () => {
  // Con 1 error, "no" se confundiría con "yo" y "si" con "mi": en una encuesta eso invierte
  // la respuesta de la persona.
  assert.equal(tolerancia('no'), 0);
  assert.equal(tolerancia('si'), 0);
  assert.equal(tolerancia('curso'), 1);
  assert.equal(tolerancia('cuestionario'), 2);
});

test('mencionaAlguna: acepta el dedazo que antes dejaba a la persona atascada', () => {
  const claves = ['cuestionario', 'encuesta', 'empezar'];
  for (const t of ['quiero el cuestionario', 'CUESTIONARIO', 'cuestionarío',
                   'cuestionaro', 'custionario', 'dale con la encusta', 'quiero enpezar']) {
    assert.equal(mencionaAlguna(t, claves), true, `deberia reconocer: ${t}`);
  }
});

test('mencionaAlguna: no dispara con lo que no se le parece', () => {
  const claves = ['cuestionario', 'encuesta', 'empezar'];
  for (const t of ['hola, como estas', 'cuanto dura el programa', 'gracias']) {
    assert.equal(mencionaAlguna(t, claves), false, `no deberia reconocer: ${t}`);
  }
});

test('elegirPorTexto: perdona el dedazo cuando hay una ganadora clara', () => {
  const ops = [{ id: 'a', texto: 'Profesional' }, { id: 'b', texto: 'Enseñanza media' }];
  assert.equal(elegirPorTexto('profesionl', ops), 'a');
  assert.equal(elegirPorTexto('enseñanza medía', ops), 'b');
});

test('elegirPorTexto: ante un empate prefiere no entender', () => {
  // Dos alternativas igual de cerca: responder cualquiera sería inventar el dato.
  const ops = [{ id: 'a', texto: 'Sí, mucho' }, { id: 'b', texto: 'Sí, poco' }];
  assert.equal(elegirPorTexto('si, moco', ops), null);
});

test('elegirPorTexto: lo que no se parece a nada devuelve null', () => {
  const ops = [{ id: 'a', texto: 'Profesional' }, { id: 'b', texto: 'Técnico' }];
  assert.equal(elegirPorTexto('no se', ops), null);
  assert.equal(elegirPorTexto('', ops), null);
});

test('elegirPorTexto: en alternativas cortas exige literalidad', () => {
  const ops = [{ id: 'a', texto: 'Sí' }, { id: 'b', texto: 'No' }];
  assert.equal(elegirPorTexto('si', ops), 'a');
  assert.equal(elegirPorTexto('no', ops), 'b');
  assert.equal(elegirPorTexto('yo', ops), null, '"yo" NO puede volverse "no"');
});
