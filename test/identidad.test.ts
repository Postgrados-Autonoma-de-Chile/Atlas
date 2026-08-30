import { test } from 'node:test';
import assert from 'node:assert/strict';

// Validadores puros de identidad (Fase 3): RUT módulo 11, email, nombre, normalización y hash.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { validarRut, normalizarRut, validarEmail, normalizarEmail, validarNombre, capitalizar, hashLookup } =
  await import('../src/core/identidad');

test('validarRut: dígitos verificadores correctos (módulo 11)', () => {
  assert.equal(validarRut('11111111-1'), true);
  assert.equal(validarRut('12345678-5'), true);
  assert.equal(validarRut('12.345.678-5'), true); // con puntos
  assert.equal(validarRut('12345670-K'), true); // dv K
  assert.equal(validarRut('12345670-k'), true); // k minúscula
});

test('validarRut: rechaza dv incorrecto y formatos inválidos', () => {
  assert.equal(validarRut('12345678-9'), false);
  assert.equal(validarRut('11111111-2'), false);
  assert.equal(validarRut('123-4'), false); // muy corto
  assert.equal(validarRut('no-es-rut'), false);
  assert.equal(validarRut(''), false);
});

test('normalizarRut: formato canónico NNNNNNNN-D', () => {
  assert.equal(normalizarRut('12.345.678-5'), '12345678-5');
  assert.equal(normalizarRut(' 12345670-k '), '12345670-K');
  // Sin guion: el último carácter es el dv (validarRut decide con el módulo 11).
  assert.equal(normalizarRut('123456785'), '12345678-5');
  assert.equal(validarRut('123456785'), true);
  assert.equal(normalizarRut('12345670K'), '12345670-K');
  assert.equal(normalizarRut('123456'), ''); // demasiado corto para ser RUT
});

test('validarEmail / normalizarEmail', () => {
  assert.equal(validarEmail('rodrigo.palma@uautonoma.cl'), true);
  assert.equal(validarEmail('a@b.cl'), true);
  assert.equal(validarEmail('sin-arroba.cl'), false);
  assert.equal(validarEmail('dos @espacios.cl'), false);
  assert.equal(validarEmail('user@dominio'), false); // sin tld
  assert.equal(normalizarEmail('  Rodrigo.Palma@UAUTONOMA.CL '), 'rodrigo.palma@uautonoma.cl');
});

test('validarNombre: mínimo 2 caracteres, sin dígitos', () => {
  assert.equal(validarNombre('Rodrigo'), true);
  assert.equal(validarNombre('Jo'), true);
  assert.equal(validarNombre('R2D2'), false);
  assert.equal(validarNombre('A'), false);
  assert.equal(validarNombre('  '), false);
});

test('capitalizar', () => {
  assert.equal(capitalizar('rodrigo palma'), 'Rodrigo Palma');
  assert.equal(capitalizar('MAGDALENA'), 'Magdalena');
});

test('hashLookup: determinista, 64 hex, sensible al valor normalizado', () => {
  const h1 = hashLookup('rodrigo@uautonoma.cl');
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(h1, hashLookup('rodrigo@uautonoma.cl'));
  assert.notEqual(h1, hashLookup('otro@uautonoma.cl'));
});
