import { test } from 'node:test';
import assert from 'node:assert/strict';

// GUARDA DE NÚMERO PROPIO.
//
// El webhook de Meta se configura por APP, no por número: una app suscrita a varias cuentas de
// WhatsApp Business recibe el tráfico de TODAS. Este test existe por un incidente real durante el
// despliegue del piloto: la app quedó suscrita a una cuenta que contenía un número PRODUCTIVO de la
// Universidad (+56 44 890 5256, con nombre verificado y calidad GREEN), y el servicio de demo
// alcanzó a recibir su webhook. No hubo daño —nadie escribió en esa ventana— pero de haber ocurrido,
// una persona que escribía al número institucional habría recibido a un tutor pidiéndole su nombre
// para inscribirla a un curso, y se le habría creado una ficha de estudiante.
//
// Señal para reconocer un número de prueba de Meta: está en el rango +1 555, su verified_name es el
// de la app y su quality_rating es UNKNOWN (nunca envió mensajes reales). Cualquier otro es productivo.

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.WA_CLOUD_PHONE_NUMBER_ID = '1134474803093373'; // el de prueba del piloto

const { normalizarEntrante } = await import('../src/messaging/metaCloud');

const sobre = (phoneNumberId: string, texto = 'hola') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '133096946544939',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '+1 555 453 0328', phone_number_id: phoneNumberId },
            contacts: [{ wa_id: '56911112222', profile: { name: 'Prueba' } }],
            messages: [{ from: '56911112222', id: 'wamid.X', timestamp: '1', type: 'text', text: { body: texto } }],
          },
        },
      ],
    },
  ],
});

test('normalizarEntrante: captura a QUÉ número llegó el mensaje', () => {
  const [m] = normalizarEntrante(sobre('1134474803093373')).messages;
  assert.equal(m.aPhoneNumberId, '1134474803093373');
});

test('normalizarEntrante: sin metadata deja el campo undefined, no una cadena vacía', () => {
  // Un undefined hace que la guarda no bloquee (no puede afirmar que sea ajeno); una cadena vacía
  // sí compararía distinto y descartaría mensajes legítimos de proveedores que no manden metadata.
  const cuerpo: any = sobre('x');
  delete cuerpo.entry[0].changes[0].value.metadata;
  const [m] = normalizarEntrante(cuerpo).messages;
  assert.equal(m.aPhoneNumberId, undefined);
});

test('el número propio y uno ajeno se distinguen', () => {
  const propio = normalizarEntrante(sobre('1134474803093373')).messages[0];
  const ajeno = normalizarEntrante(sobre('110930822111072')).messages[0]; // el productivo del incidente
  assert.equal(propio.aPhoneNumberId, process.env.WA_CLOUD_PHONE_NUMBER_ID);
  assert.notEqual(ajeno.aPhoneNumberId, process.env.WA_CLOUD_PHONE_NUMBER_ID);
});

test('la guarda vive en el pipeline y compara contra el número configurado', async () => {
  // Verificación estructural: que el código de procesarMensajeEntrante contenga la comparación.
  // Es frágil como test, pero barato, y protege una defensa que un refactor podría borrar sin
  // que ningún otro test se entere — el costo de perderla es atender a un número ajeno.
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../src/routes/whatsapp.ts', import.meta.url), 'utf8');
  assert.match(src, /aPhoneNumberId !== config\.waCloudPhoneNumberId/);
  assert.match(src, /inbound:numero_ajeno/);
});
