import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Token de solo-dirección: repartir el panel sin repartir a las personas.
//
// POR QUÉ EXISTE: el panel tenía un token y abría las tres vistas. Dárselo a un director para que
// viera si el programa funciona significaba entregarle también la lista con nombres y teléfonos.
// Ahora hay un segundo secreto que abre ÚNICAMENTE /panel/direccion, que es la vista de puros
// agregados.
//
// Lo que estas pruebas cuidan es la dirección de la inclusión. El token completo tiene que seguir
// abriendo todo —quien opera no debería necesitar dos credenciales para dos pestañas— y el de
// dirección NO tiene que abrir nada más. Un error en cualquiera de los dos sentidos es grave: uno
// rompe el panel, el otro filtra los datos que este trabajo existe para no filtrar.

process.env.NODE_ENV = 'test';

// `config` es un singleton congelado al importar: poner process.env acá no haría nada. Hay que
// reemplazar el módulo. (Este proyecto ya se comió dos pruebas en falso verde por olvidarlo.)
mock.module('../src/config.ts', {
  namedExports: {
    config: {
      dashboardToken: 'TOKEN-COMPLETO-0000',
      dashboardTokenDireccion: 'TOKEN-DIRECCION-1111',
      devFailOpen: false,
    },
  },
});

const { requireDashboardToken, requireDireccionToken } = await import('../src/routes/guard');

function correr(guard: any, token: string | null) {
  const req = { header: (h: string) => (h === 'x-dashboard-token' && token ? token : undefined) };
  let estado = 0, siguio = false;
  const res = { status: (c: number) => { estado = c; return res; }, json: () => res };
  guard(req, res, () => { siguio = true; });
  return { estado, siguio };
}

test('el token de dirección abre la vista de dirección', () => {
  assert.equal(correr(requireDireccionToken, 'TOKEN-DIRECCION-1111').siguio, true);
});

test('el token de dirección NO abre la cohorte ni la caracterización', () => {
  // Esta es la prueba que justifica todo el cambio: si pasa, el secreto no sirve de nada.
  const r = correr(requireDashboardToken, 'TOKEN-DIRECCION-1111');
  assert.equal(r.siguio, false);
  assert.equal(r.estado, 401);
});

test('el token completo sigue abriendo las tres vistas', () => {
  assert.equal(correr(requireDireccionToken, 'TOKEN-COMPLETO-0000').siguio, true);
  assert.equal(correr(requireDashboardToken, 'TOKEN-COMPLETO-0000').siguio, true);
});

test('un token inventado no abre nada', () => {
  for (const g of [requireDireccionToken, requireDashboardToken]) {
    const r = correr(g, 'TOKEN-DIRECCION-111');  // un carácter menos
    assert.equal(r.siguio, false);
    assert.equal(r.estado, 401);
  }
});

test('sin token tampoco', () => {
  assert.equal(correr(requireDireccionToken, null).estado, 401);
});

test('sin el secreto configurado no se abre ninguna puerta nueva', async () => {
  // El token de dirección es OPCIONAL. Si no está, el guard tiene que comportarse EXACTAMENTE
  // como el de siempre — y en particular no dejar pasar a quien no trae nada, que sería convertir
  // una variable vacía en acceso público.
  mock.restoreAll();
  const t = await import('node:test');
  t.mock.module('../src/config.ts', {
    namedExports: { config: { dashboardToken: 'SOLO-ESTE', dashboardTokenDireccion: '', devFailOpen: false } },
  });
  const g = await import('../src/routes/guard.ts?vacio');
  assert.equal(correr(g.requireDireccionToken, 'SOLO-ESTE').siguio, true);
  assert.equal(correr(g.requireDireccionToken, '').estado, 401);
  assert.equal(correr(g.requireDireccionToken, 'lo-que-sea').estado, 401);
});
