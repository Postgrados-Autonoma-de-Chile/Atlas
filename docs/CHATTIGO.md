# BSP Chattigo

Adaptador alternativo a WhatsApp Cloud API directo. Implementa la misma interfaz `MessagingProvider`,
así que el motor, el tutor y los flujos deterministas no saben cuál está activo.

Referencia: https://development.chattigo.com/docs/api-bot/

Se activa con `WA_PROVIDER=chattigo`. Archivos: [`src/messaging/chattigo.ts`](../src/messaging/chattigo.ts)
y [`src/routes/chattigo.ts`](../src/routes/chattigo.ts).

---

## Lo que hay que pedirle a Chattigo antes de conectar

La documentación pública no cubre estos puntos. **Sin los dos primeros no se puede operar.**

1. **URLs base de los ambientes** (desarrollo y producción). La documentación solo nombra rutas
   (`/login`, `/outbound`), nunca el host.
2. **Cómo autenticar el webhook entrante.** Ver la sección de seguridad más abajo: es lo más
   importante de esta integración.
3. **El `namespace` de plantillas** del Business Manager (`CHATTIGO_NAMESPACE`), y confirmación de
   que el host de HSM es `https://login.chattigo.com/message`.
4. **Si el `/login` del servicio de HSM es el mismo** que el de la API del bot, o usa otro host o
   credenciales. Compartimos el JWT asumiendo que sí.
5. **Si existe un tipo interactivo de respuesta rápida** además de `cta_url` y `list`.

---

## Seguridad: el webhook no viene firmado

Meta manda `X-Hub-Signature-256` con un HMAC-SHA256 del cuerpo, y lo verificamos antes de procesar
nada. **Chattigo no firma**: su documentación solo describe un POST a la URL del cliente que debe
responder 200. No hay firma, ni token, ni lista de IPs.

Sin una barrera propia, cualquiera que descubra la URL puede inyectar mensajes en nombre de un
estudiante: alterar su progreso, o **disparar la emisión de un certificado a su nombre** y hacerlo
llegar a su correo.

La barrera es `CHATTIGO_WEBHOOK_TOKEN`, un secreto compartido que se acepta de dos formas:

| Forma | Ruta | Cuándo usarla |
|---|---|---|
| Header `x-atlas-token` | `POST /webhooks/chattigo` | **Preferida** |
| Segmento de ruta | `POST /webhooks/chattigo/<token>` | Solo si Chattigo no permite headers personalizados |

La ruta es la peor de las dos: el token queda escrito en los registros de cualquier proxy
intermedio. Úsala solo como salida.

La comparación es de tiempo constante y **fail-closed**: sin `CHATTIGO_WEBHOOK_TOKEN` configurado se
rechaza todo. Un webhook abierto que escribe en el expediente académico de una persona es peor que
uno caído.

---

## Qué se pierde respecto a Cloud API directo

| Capacidad | Cloud API | Chattigo | Consecuencia |
|---|---|---|---|
| Firma del webhook | HMAC-SHA256 | **No existe** | Barrera propia con secreto compartido |
| Plantillas HSM | Graph API | Otro servicio y otro host (`api-message-massive`) | Equivalente; hasta 1000 destinatarios por llamada |
| Estados de entrega | sent/delivered/read/failed | SENT/DELIVERY/READ/INVALID, al mismo webhook | Equivalente |
| Acuse de lectura | Sí | **No** | Sin doble check azul |
| Botones de respuesta | Hasta 3, bajo el mensaje | Solo lista | Un toque más para responder un verdadero/falso |
| Adjuntos entrantes | Id de media | URL descargable | Equivalente |

### Plantillas: otro servicio, otro host

Las plantillas NO van por la API del bot sino por
[api-message-massive](https://development.chattigo.com/docs/api-message-massive/):
`POST {CHATTIGO_HSM_BASE_URL}/inbound` con `type: "HSM"`. Comparte el JWT.

Dos particularidades:

- **La respuesta no trae id de mensaje**, solo `{success: true}`. El id llega después en el callback
  de estado, correlacionado con el `id` que mandamos nosotros — por eso lo generamos al enviar y lo
  devolvemos como `messageId`. Es la clave con la que el motor de recordatorios sabe después si el
  envío falló.
- **`botAttention: true` es obligatorio para ATLAS.** Nosotros abrimos la conversación; sin esa
  bandera la respuesta del estudiante caería en una cola de agentes humanos, que en ATLAS no existe.

Acepta hasta **1000 destinatarios por llamada**. Hoy enviamos de a uno, igual que con Cloud API; si
la convocatoria a 10.000 estudiantes lo pide, agrupar es un cambio acotado en
[`src/convocatoria/motor.ts`](../src/convocatoria/motor.ts).

### Estados de entrega

Llegan como callback al **mismo webhook** que los mensajes, distinguidos por `type` en mayúsculas:

| Chattigo | ATLAS |
|---|---|
| `SENT` | `sent` |
| `DELIVERY` | `delivered` |
| `READ` | `read` |
| `INVALID` | `failed` (con `errors[0].code`) |
| `SESSION` | ignorado — solo avisa que se abrió la ventana de 24 h, no es una entrega |

---

## Configuración

```bash
WA_PROVIDER=chattigo
CHATTIGO_BASE_URL=https://...        # pedírsela a Chattigo, sin barra final
CHATTIGO_USER=...
CHATTIGO_PASS=...
CHATTIGO_DID=56445550000             # el número de la cuenta, SIN '+'
CHATTIGO_ID_CAMPAIGN=353
CHATTIGO_BOT_NAME=ATLAS
CHATTIGO_WEBHOOK_TOKEN=...           # secreto largo y aleatorio; sin él no entra nada
CHATTIGO_HSM_BASE_URL=https://login.chattigo.com/message   # plantillas: OTRO host
CHATTIGO_NAMESPACE=...               # namespace del Business Manager; sin él no salen plantillas
```

Volver a Cloud API directo es `WA_PROVIDER=meta` y un redespliegue.

---

## Detalles de implementación

**El JWT dura 8 horas y se cachea en Redis**, no en memoria del proceso. Con varias instancias, cada
una pidiendo el suyo, se multiplican los logins — y como el token es por usuario, un login nuevo
puede invalidar el anterior y dejar a las otras instancias fuera.

**Un 401 al enviar renueva el token y reintenta una sola vez.** Más reintentos enmascararían un
problema de credenciales detrás de una tormenta de logins.

**Los ids entrantes se prefijan con `chattigo:`.** El id de Chattigo es un entero, y durante una
migración de número pueden convivir los dos proveedores: sin el prefijo podría colisionar con la
clave de idempotencia de otro mensaje.

**Los eventos `transfer`, `group`, `close` y `timeout` se descartan.** Son señales de la plataforma,
no turnos del estudiante; si llegaran al motor, el tutor respondería a algo que la persona nunca
escribió.

**El campo `did` cumple el rol de `phone_number_id`**: identifica a qué número llegó el mensaje, y la
guarda de número propio lo compara igual que en Cloud API.

---

## Estado

Implementado y cubierto por 25 pruebas ([`test/chattigo.test.ts`](../test/chattigo.test.ts)), pero
**nunca ejercitado contra la API real** — faltan las URLs base y las credenciales. Los formatos salen
de la documentación, no de tráfico observado.
