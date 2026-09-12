# ATLAS — Tutor educativo de IA por WhatsApp

Proyecto de la **Universidad Autónoma de Chile**. Un tutor conversacional que acompaña por WhatsApp a quienes cursan el **Nivel Inicial: Alfabetización ciudadana en Inteligencia Artificial**: entrega el cuestionario de caracterización, conduce las 8 microcápsulas y su práctica, resuelve dudas con RAG sobre el material oficial, recuerda el progreso, retoma a quien abandona y gestiona la certificación.

El currículo es **dato, no código**: vive en [`curriculo/nivel1.json`](curriculo/nivel1.json) y se carga a la base con un script idempotente. La trazabilidad requisito → fuente → cambio → archivo está en [`docs/CURRICULO.md`](docs/CURRICULO.md).

**Estado: Fases 1 a 14 implementadas**, más la convocatoria de cohortes y la alineación curricular. 234 tests en verde, typecheck limpio. El código está listo; lo que falta para el piloto es operacional (número de WhatsApp real, contrato del BSP, despliegue) y está detallado en [§14](#14-lo-que-falta-para-el-piloto).

> Este repositorio nació como un chatbot comercial omnicanal sobre Bitrix24. En la Fase 1 se eliminó toda la lógica de ventas y se conservó el núcleo conversacional, que estaba probado en producción. La baja operacional del sistema anterior es un proceso aparte: [`docs/DECOMISO-VENTAS.md`](docs/DECOMISO-VENTAS.md).

---

## 1. Principio de diseño

**Lo que puede ser determinista no se delega al modelo.**

Tres flujos interceptan el mensaje **antes** de que llegue al LLM: registro de identidad, respuestas de evaluación y certificación. Validar un RUT, corregir un quiz o decidir si alguien cumple los requisitos para certificar son operaciones con una respuesta correcta única — un modelo de lenguaje solo agrega variabilidad y riesgo.

El LLM se ocupa de lo que sí es su trabajo: explicar, responder dudas sobre el material y conversar. Y para eso los datos académicos **siempre** vienen de Postgres vía herramientas, nunca de la memoria del modelo.

```mermaid
flowchart TD
    A[Webhook Meta] --> B{Firma HMAC}
    B -->|inválida| Z[401]
    B -->|válida| C[ACK 200 inmediato]
    C --> D{Dedupe por wamid<br/>TTL 8 días}
    D -->|repetido| Z2[descartar]
    D -->|nuevo| E[Registrar ventana 24h<br/>+ marcar leído]
    E --> F{¿Tiene Persona?}
    F -->|no| G[Flujo REGISTRO<br/>determinista]
    F -->|sí| H{¿Opt-out/in<br/>recordatorios?}
    H -->|sí| I[Persistir y confirmar]
    H -->|no| J{¿Respuesta<br/>de quiz?}
    J -->|sí| K[Flujo EVALUACIÓN<br/>determinista]
    J -->|no| L{¿En certificación?}
    L -->|sí| M[Flujo CERTIFICACIÓN<br/>determinista]
    L -->|no| N[Rehidratación académica<br/>desde Postgres]
    N --> O[Motor LLM<br/>agentLoop + tools]
    O --> P[Respuesta por<br/>MessagingProvider]
```

Cada flujo determinista que consume el mensaje corta el pipeline: el motor no corre.

---

## 2. Stack

| Capa | Tecnología |
|---|---|
| Runtime | Node.js ≥22, TypeScript vía `tsx` (dev) / `esbuild` bundle CJS (prod) |
| HTTP | Express 4 |
| LLM | Anthropic Claude — `claude-sonnet-5` (tutor), `claude-haiku-4-5` (clasificador) |
| Embeddings | Google `gemini-embedding-001`, 768 dims (Matryoshka) |
| Estado efímero | Redis — memoria conversacional, locks distribuidos, idempotencia, rate limit, métricas |
| Fuente de verdad | PostgreSQL + **pgvector** — identidad, progreso, evaluaciones, certificados |
| Mensajería | WhatsApp Cloud API (Meta), detrás de una abstracción de proveedor |
| Correo | SMTP genérico (nodemailer) |
| Cola | Pub/Sub con ordering por estudiante |
| Config | zod, validada al arrancar |
| Destino | GCP: Cloud Run (webhook + worker), Cloud SQL, Redis (Memorystore o VM `e2-micro`), Pub/Sub, Cloud Scheduler, Secret Manager |

**Dos proveedores de IA.** Anthropic para el razonamiento, Google para los embeddings del RAG. Son dos cuentas, dos facturas y dos puntos de falla; la decisión está registrada en la migración `0005`: pgvector en Cloud SQL en vez de Vertex Vector Search, que cuesta ~US$55/mes fijos.

---

## 3. Estructura del repositorio

```
src/
├── index.ts                  # bootstrap Express: 10 endpoints, arranque de BD y barridos
├── config.ts                 # configuración central validada con zod (fail-fast)
├── log.ts                    # logger JSON estructurado
├── ai/
│   ├── agentLoop.ts          # MOTOR: bucle de tool-calling, cache_control, saneado del historial
│   ├── client.ts             # único punto de instanciación del SDK de Anthropic
│   ├── memory.ts             # historial por conversación en Redis (TTL, recorte)
│   ├── tools.ts              # registro de las 6 herramientas del tutor
│   ├── toolRunner.ts         # ejecutor: valida antes de todo efecto, nunca lanza al motor
│   ├── embeddings.ts         # cliente de embeddings Gemini
│   └── transcribe.ts         # STT de notas de voz (Deepgram)
├── core/
│   ├── channel.ts            # ChannelProfile: prompt + modelo + tools + thinking por canal
│   └── identidad.ts          # validación de nombre, email y RUT (módulo 11)
├── messaging/
│   ├── types.ts              # interfaz MessagingProvider + tipos normalizados
│   ├── metaCloud.ts          # implementación Cloud API
│   ├── chattigo.ts           # implementación BSP Chattigo (JWT, HSM, estados)
│   ├── colaTurnos.ts         # publish/decode Pub/Sub con orderingKey por estudiante
│   └── index.ts              # factory del proveedor
├── flows/
│   ├── bienestar.ts          # contención ante señal de riesgo vital (corre ANTES de todo)
│   ├── registro.ts           # captura de identidad conversacional (determinista)
│   ├── caracterizacion.ts    # cuestionario oficial de 11 preguntas (primer paso, obligatorio)
│   ├── evaluacion.ts         # momento "Lo intento" de cada microcápsula (determinista)
│   ├── fichaCierre.ts        # producto de cierre: los 5 pasos de la ruta sobre un caso real
│   └── certificacion.ts      # RUT, código por correo y emisión (determinista)
├── rag/
│   ├── chunker.ts            # troceado del material del curso
│   └── retrieval.ts          # búsqueda vectorial con umbral + fallback léxico
├── reminders/motor.ts        # planificar + despachar, con dedupe fail-closed
├── convocatoria/
│   ├── motor.ts              # oleadas de invitación con cupo y reclamo atómico
│   └── qr.ts                 # enlace wa.me con texto precargado (la vía gratuita)
├── cert/
│   ├── pdf.ts                # generación del certificado con pdf-lib
│   └── mailer.ts             # envío SMTP
├── store/
│   ├── db.ts                 # pool de Postgres, retención de auditoría
│   ├── kv.ts                 # Redis con degradación a memoria en dev
│   ├── personas.ts           # identidad y consentimiento
│   ├── cursos.ts             # cursos, inscripción, progreso, campos curriculares
│   ├── caracterizacion.ts    # preguntas, opciones y respuestas del cuestionario
│   ├── evaluaciones.ts       # interacciones, intentos, respuestas
│   ├── fichaCierre.ts        # ficha de resolución de problema y notas del estudiante
│   ├── recordatorios.ts      # cola de recordatorios con estados
│   ├── certificados.ts       # emisión y folios
│   ├── invitaciones.ts       # cola de convocatoria
│   ├── metricasNegocio.ts    # agregaciones §20 para /metrics
│   └── tokenCrypto.ts        # AES-256-GCM para PII en reposo
├── routes/
│   ├── whatsapp.ts           # webhook: verificación, firma, pipeline completo
│   ├── pubsub.ts             # worker: verificación OIDC del push
│   ├── guard.ts              # tokens por header, fail-closed
│   └── rateLimit.ts          # límite por IP distribuido
├── obs/                      # métricas, auditoría, redacción de PII, correlación de requests
├── util/                     # semáforo, locks in-process y distribuido, comparación timing-safe
└── eval/juez.ts              # juez LLM del harness pedagógico

curriculo/nivel1.json         # el plan curricular oficial como dato versionado
scripts/cargar-curriculo.mjs  # carga idempotente del currículo a la base
migrations/                   # 16 migraciones node-pg-migrate (.cjs)
infra/                        # Terraform del piloto GCP
perf/                         # carga con k6 (firma HMAC real) + verificador de invariantes
eval/golden-set.json          # casos de referencia del harness pedagógico
contenido/                    # material del curso del piloto
docs/                         # CURRICULO · BIENESTAR · PANEL · DEPLOY · SEGURIDAD · OBSERVABILIDAD · CHATTIGO
test/                         # 46 archivos, 374 tests
```

---

## 4. Modelo de datos

19 tablas en 10 migraciones. El avance académico vive en Postgres y **no** en Redis: quien vuelve tres semanas después retoma exactamente donde quedó.

| Migración | Tablas | Para qué |
|---|---|---|
| `0001` | `audit_log` | Auditoría con retención configurable |
| `0002` | `person`, `person_identity`, `consent` | Identidad del estudiante y consentimiento versionado |
| `0003` | `course`, `module`, `lesson`, `content_item`, `enrollment`, `lesson_progress` | Estructura del curso y progreso |
| `0004` | — | Semilla del curso del piloto |
| `0005` | `content_chunk` | Chunks vectorizados (`CREATE EXTENSION vector`) |
| `0006` | `quiz`, `question`, `question_option`, `quiz_attempt`, `attempt_answer` | Evaluaciones formativas |
| `0007` | — | Semilla del quiz de la propuesta 1 |
| `0008` | `reminder` | Cola de recordatorios con `clave_dedupe UNIQUE` |
| `0009` | `certificate` | Certificados con folio |
| `0010` | `invitation` | Convocatoria de cohortes (sin FK a `person`: invita a quien aún no existe) |

**El contenido del piloto** es *Nivel Inicial — Alfabetización ciudadana en IA*, sembrado como **tres propuestas** de curso, cada una con **9 lecciones** (8 microcápsulas más el producto de cierre) — 27 en total:

| Código | Nombre |
|---|---|
| `NIVEL-INICIAL-P1` | IA en la vida cotidiana |
| `NIVEL-INICIAL-P2` | IA para resolver problemas diarios |
| `NIVEL-INICIAL-P3` | IA, ciudadanía digital y uso responsable |

Los cursos nacen en estado `inactivo`: hay que activarlos explícitamente. El material vive en [`contenido/`](contenido/); las transcripciones se cargan como `content_item` y de ahí las trocea el RAG.

---

## 5. Endpoints

| Método | Ruta | Protección | Para qué |
|---|---|---|---|
| `GET` | `/` | — | Página estática de cortesía |
| `GET` | `/health` | — | Healthcheck: estado de Redis y Postgres |
| `GET` | `/metrics` | `x-dashboard-token` | Métricas técnicas, de negocio y costo LLM estimado |
| `GET` | `/webhooks/whatsapp` | `hub.verify_token` | Handshake de suscripción de Meta |
| `POST` | `/webhooks/whatsapp` | HMAC `X-Hub-Signature-256` + rate limit estricto | Recepción de mensajes |
| `POST` | `/pubsub/turnos` | OIDC del push (fail-closed) | Worker: consume turnos de la cola |
| `POST` | `/jobs/recordatorios` | `x-dashboard-token` | Job de recordatorios (Cloud Scheduler) |
| `POST` | `/jobs/convocatoria/cargar` | `x-dashboard-token` | Carga el listado a invitar (idempotente) |
| `POST` | `/jobs/convocatoria` | `x-dashboard-token` | Oleada de invitaciones (Cloud Scheduler) |
| `GET` | `/jobs/convocatoria` | `x-dashboard-token` | Estado de la cola y enlace de entrada para el QR |

---

## 6. Herramientas del tutor

Seis, en [`src/ai/tools.ts`](src/ai/tools.ts). El motor filtra por `profile.toolNames`, así que cada canal habilita su subconjunto.

| Herramienta | Qué hace |
|---|---|
| `consultar_mis_datos` | Datos de registro, con el correo enmascarado |
| `inscribirme_al_curso` | Inscribe y devuelve la primera microcápsula |
| `consultar_progreso` | Avance real desde Postgres — nunca de memoria |
| `continuar_curso` | Entrega la microcápsula actual y la marca como entregada |
| `completar_leccion` | Cierra la microcápsula y acumula minutos |
| `buscar_contenido_curso` | RAG sobre el material oficial, con la fuente para citar |

La regla dura del RAG: si nada supera `RAG_MIN_SCORE`, devuelve `encontrado:false` y el tutor **dice que el material no lo cubre**. No inventa.

---

## 7. Los seis flujos deterministas

### Registro ([`flows/registro.ts`](src/flows/registro.ts))

Según [`docs/specs/captura-identidad-estudiante.md`](docs/specs/). Consentimiento primero por botones, un dato por mensaje, confirmación del correo, máximo 2 reintentos por campo — al tercero se pausa y el mensaje pasa al tutor. La persona se crea recién con la captura mínima completa, de forma atómica. **El RUT no se pide acá**, solo al certificar.

### Contención ante riesgo vital ([`flows/bienestar.ts`](src/flows/bienestar.ts))

Corre **antes que todos los demás**, incluido el registro. El prompt del tutor ya tenía el protocolo, pero solo alcanza a los mensajes que llegan al modelo: en el piloto alguien escribió "tengo pensamientos suicidas" en el campo del nombre y el registro lo guardó como nombre. Detecta expresiones inequívocas de ideación suicida o autolesión, consume el turno, entrega las líneas de ayuda de Chile y registra que ocurrió sin guardar el texto. **El programa no tiene seguimiento humano para estos casos**, así que la respuesta automática es la intervención completa — alcance, límites y lo que haría falta para cambiarlo en [`docs/BIENESTAR.md`](docs/BIENESTAR.md).

### Caracterización ([`flows/caracterizacion.ts`](src/flows/caracterizacion.ts))

El cuestionario oficial de 11 preguntas, que el plan define como el paso inicial. Se conduce solo, con botones cuando caben, lista cuando son hasta 10 y texto numerado cuando son más (la pregunta de región tiene 16 opciones). El requisito se hace cumplir en las **herramientas**, no en el prompt: `inscribirme_al_curso` y `continuar_curso` devuelven `caracterizacion_pendiente` hasta que esté completo, así que insistir no sirve.

### "Lo intento" ([`flows/evaluacion.ts`](src/flows/evaluacion.ts))

La práctica que el plan exige en cada microcápsula, en las cuatro formas que los documentos definen: selección única, clasificación, selección múltiple con mínimo y elección entre opciones ambas válidas. Ante un error el ítem vuelve **una vez** para revisarlo, sin penalización y sin revelar la respuesta — el material pide «Permitir "Revisar de nuevo" sin penalización». El criterio del documento se entrega completo al cerrar, una sola vez. **No hay nota**: la certificación es por finalización.

### Ficha de cierre ([`flows/fichaCierre.ts`](src/flows/fichaCierre.ts))

El producto de cierre del nivel. Sus cinco campos son los cinco pasos de la ruta, así que llenarla es recorrer DEFINO → PREGUNTO → ORGANIZO → VERIFICO → DECIDO sobre un caso real. Completarla completa la microcápsula 8: el plan pide evidencia de aplicación, no que el contenido se haya enviado.

### Certificación ([`flows/certificacion.ts`](src/flows/certificacion.ts))

La elegibilidad nace en la misma transacción que completa el curso. Después: RUT validado por módulo 11 con confirmación → código de verificación al correo → emisión con folio → PDF por correo → confirmación por WhatsApp. Ni el RUT ni la emisión pasan por el LLM.

---

## 8. Recordatorios

Dos etapas idempotentes que dispara Cloud Scheduler vía `POST /jobs/recordatorios` — sin `setInterval` en proceso, que fue un hallazgo de la auditoría.

1. **Planificar**: decide a quién corresponde (inactividad, opt-in vigente, tope de insistencia) y lo programa con `clave_dedupe` única por ventana temporal. El dedupe es **fail-closed en Postgres**, no en Redis.
2. **Despachar**: envía los vencidos respetando la ventana hábil de Chile — **lunes a sábado, 10:00 a 20:00**, con feriados. Usa texto libre si la ventana de servicio de 24 h está abierta (**gratis**) y plantilla utility solo si está cerrada (**se paga**).

El opt-out es inmediato y se evalúa **antes** del opt-in, porque "no quiero recordatorios" contiene "quiero recordatorios". Solo se confirma al estudiante lo que efectivamente se persistió. Es obligación de Meta y de la Ley 21.719.

---

## 8b. Convocatoria de cohortes

Llevar gente **hacia** el tutor. Dos vías, con costos muy distintos:

**El QR / enlace `wa.me` — gratis.** `GET /jobs/convocatoria` devuelve el enlace armado desde `WA_ME_NUMERO` y `WA_ME_TEXTO`, con el texto **precargado**: la persona escanea, WhatsApp se abre con el mensaje escrito y solo aprieta enviar. Ese primer mensaje lo inicia el estudiante, así que no se cobra y no consume el tramo de mensajería de Meta. Es la palanca más rentable de todo el sistema y su código son 20 líneas.

**Las plantillas de invitación — se pagan.** Categoría marketing, entre USD 0,025 y 0,137 por mensaje según país, y sujetas al tramo de Meta (2.000 contactos por 24 h para un negocio verificado, escalando a 10.000 y 100.000 con uso y calidad). Por eso el job viene **apagado** y con cupo por corrida y por día.

La estrategia que sale mejor en costo, plazo y riesgo de calidad es **dejar correr el QR primero** y mandar plantillas solo al remanente. Eso lo materializa `descartarYaRegistradas`, que corre **antes** de gastar: quien ya tiene Persona sale de la cola marcado `descartada`, sin enviarle nada.

FSM de `invitation`: `pendiente → enviada → respondio | fallida | descartada`.

- `telefono UNIQUE` da idempotencia de carga: recargar el mismo listado no duplica ni reenvía. Los números se normalizan a E.164 al cargar, así que un mismo teléfono escrito de tres formas colapsa en una invitación.
- El reclamo es **atómico en Postgres** antes de enviar: dos réplicas del job no pagan dos veces la misma plantilla.
- Las **fallidas se reintentan** hasta `CONVOCATORIA_MAX_INTENTOS`, porque un `ok:false` del proveedor es él diciendo que no envió — reintentar no arriesga pagar doble.
- El webhook marca `respondio` en el **primer mensaje** de cualquier número de la cola, venga del QR o de la plantilla. Deja de estar en la cola aunque todavía no complete el registro.

## 9. Configuración

54 variables en [`.env.example`](.env.example), validadas con zod al arrancar. Dos niveles de rigor:

- **Un valor malformado detiene el proceso en cualquier entorno.** Se abandonó el patrón heredado de tragar el error y caer a un default silencioso.
- **En producción, además, es fail-fast por ausencia.** Sin `ANTHROPIC_API_KEY`, `REDIS_URL`, `DATABASE_URL`, `META_VERIFY_TOKEN`, `META_APP_SECRET`, `DASHBOARD_TOKEN`, `TOKEN_ENC_KEY`, `WA_CLOUD_PHONE_NUMBER_ID` o `WA_CLOUD_TOKEN`, el servicio no arranca. Y `DEV_FAIL_OPEN=true` está **prohibido** en producción.

Grupos: LLM · STT · persistencia · webhook Meta · envío WhatsApp · seguridad · límites · memoria conversacional · correo SMTP · recordatorios · RAG · Pub/Sub · observabilidad.

Valores por defecto que conviene conocer:

| Variable | Default | Nota |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | |
| `ANTHROPIC_EFFORT` | `low` | Punto de partida para chat; se re-evalúa con el harness |
| `EMBEDDING_DIM` | `768` | Debe calzar con el `vector(N)` de la migración `0005` |
| `RAG_MIN_SCORE` | `0.55` | Bajo esto: "no está en el material" |
| `RAG_TOP_K` | `6` | |
| `MEMORY_TTL_HOURS` | `48` | |
| `REMINDER_DIAS_INACTIVIDAD` | `3` | |
| `REMINDER_MAX_SIN_ACTIVIDAD` | `3` | Tope de insistencia |
| `PUBSUB_TOPIC` | *(vacío)* | Vacío = despacho in-process (dev o piloto de un servicio) |

En el perfil de WhatsApp, `thinking` va **`disabled`** a propósito: en Sonnet 5 el thinking adaptativo viene activado y consume `max_tokens`, lo que truncaría respuestas cortas. Con thinking apagado el modelo es menos propenso a usar herramientas, así que el prompt empuja el tool-first de forma explícita.

---

## 10. Desarrollo local

```bash
npm install
cp .env.example .env      # completa al menos ANTHROPIC_API_KEY
npm run typecheck
npm test                  # suite hermética: sin Redis ni Postgres reales
npm run dev
```

La suite corre sin servicios externos. Para ejercitar el sistema completo hacen falta Redis y **un Postgres con pgvector** — la imagen `postgres:16-alpine` **no** lo trae:

```bash
docker run -d --name atlas-pg -p 5433:5432 --restart unless-stopped \
  -e POSTGRES_USER=atlas -e POSTGRES_PASSWORD=atlaslocal -e POSTGRES_DB=atlas \
  pgvector/pgvector:pg16

docker run -d --name atlas-redis -p 6380:6379 --restart unless-stopped redis:7-alpine
```

```env
DATABASE_URL=postgresql://atlas:atlaslocal@localhost:5433/atlas
REDIS_URL=redis://localhost:6380
```

Y después las migraciones:

```bash
npm run migrate          # up
npm run migrate:down     # revertir la última
```

Sin `REDIS_URL` el KV degrada a memoria del proceso: sirve para desarrollo, pero **no ejercita** la idempotencia ni los locks distribuidos, así que las pruebas de esos caminos serían optimistas.

Otros scripts:

| Comando | Para qué |
|---|---|
| `npm run smoke:anthropic` | Verifica la API de Anthropic sin tocar WhatsApp |
| `npm run eval:tutor` | Harness pedagógico contra `eval/golden-set.json`, con juez LLM |
| `npm run build` | Bundle CJS con esbuild para Cloud Run |
| `npm run start:prod` | Corre el bundle |

---

## 11. Tests

**234 tests en 36 archivos**, todos en verde. Cubren, entre otros: el bucle del agente con el cliente mockeado, el pipeline de WhatsApp, la verificación de firma, el push de Pub/Sub, los seis flujos deterministas, los siete casos curriculares del encargo, la validación de identidad, el troceado del RAG, el juez del harness, los recordatorios, la convocatoria, el adaptador Chattigo, el PDF del certificado, y dos suites dedicadas a que los guards y las verificaciones sean **fail-closed** (`failclosed.test.ts`, `seguridad.test.ts`).

### Recorrer el curso a mano, sin WhatsApp

`npm run sim` levanta el **mismo pipeline del webhook** con un proveedor de mensajería de consola: imprime lo que el bot enviaría y los botones se eligen escribiendo su número. Sirve para caminar el flujo completo —caracterización, las 8 microcápsulas con su "Lo intento", la ficha de cierre, la certificación— sin número real y sin costo por mensaje.

```bash
DATABASE_URL=postgres://atlas:atlaslocal@localhost:5433/atlas npm run sim
# comandos dentro del simulador: /estado  /nuevo  /reset  /salir
```

Con la entrada por tubería o archivo (`npm run sim < guion.txt`) el recorrido se vuelve repetible; las líneas que empiezan con `#` son comentarios. Dos guardas: el proveedor de consola se **inyecta**, así que el script no puede enviar un WhatsApp real, y se niega a correr contra una base que no sea local salvo `--acepto-base-remota` — en Cloud SQL hay estudiantes de verdad. Los turnos del tutor sí llaman a la API de Anthropic, así que necesitan `ANTHROPIC_API_KEY` válida; los flujos deterministas corren sin ella.

---

## 12. Despliegue

IaC del piloto en [`infra/`](infra/) (Terraform) y runbook en [`docs/DEPLOY.md`](docs/DEPLOY.md). Región recomendada `us-east1`; `southamerica-west1` solo si la Universidad exige residencia de datos, con un 20-40 % más de costo.

Terraform provisiona: Artifact Registry, Cloud SQL con su base y usuario, Memorystore Redis, tres cuentas de servicio (runtime, push, scheduler) con IAM acotado, Secret Manager con la `DATABASE_URL` generada, y el topic de Pub/Sub **con ordering habilitado** más su DLQ y la push subscription.

El split de Fase 11 son dos servicios Cloud Run sobre el mismo bundle: el **webhook** publica cada mensaje normalizado a Pub/Sub con `orderingKey = teléfono del estudiante`, y el **worker** lo consume por push. Semántica at-least-once domesticada aguas abajo con dedupe por `wamid` más los UNIQUE académicos; el orden por estudiante lo dan el ordering key y el lock por conversación.

---

## 13. Observabilidad, costo y seguridad

`GET /metrics` devuelve contadores técnicos, latencia del LLM, **métricas de negocio** desde las tablas reales y el **costo estimado del LLM** según los precios configurables `LLM_USD_*`. Catálogo de alertas y formato de logs en [`docs/OBSERVABILIDAD.md`](docs/OBSERVABILIDAD.md).

Sobre el costo de WhatsApp, el dato que gobierna el diseño: **las conversaciones iniciadas por el estudiante son gratis** y las plantillas utility dentro de la ventana de 24 h también. Solo se paga la plantilla enviada fuera de esa ventana — por eso el motor de recordatorios elige texto libre cuando puede.

**El panel de seguimiento** vive en `/panel` y son tres vistas para tres lectores: *Programa* —puros agregados, sin un dato personal, la única que se puede proyectar en una reunión—, *Cohorte* —nombres, teléfonos y avance, para quien opera— y *Caracterización*. El acceso tiene dos niveles: un token de operación que abre todo, y **un token por director** que abre solo la vista de Programa y deja registrado quién entró, para poder revocárselo a una persona sin rotárselo a todas. Alta y baja con [`scripts/token-director.mjs`](scripts/token-director.mjs); el detalle, lo que el panel deliberadamente no muestra y las alternativas descartadas, en [`docs/PANEL.md`](docs/PANEL.md).

Seguridad: PII cifrada en reposo con AES-256-GCM, redacción de PII en logs y auditoría, auditoría minimizada (metadatos del turno, nunca el texto completo), tokens solo por header —nunca por query string, que quedaba expuesto en logs de proxies y en el Referer—, y comparación timing-safe. Estado del gate en [`docs/SEGURIDAD.md`](docs/SEGURIDAD.md).

---

## 14. Lo que falta para el piloto

**Bloqueantes operacionales**

1. **Número de WhatsApp dedicado.** Lo que hay conectado es un **número de prueba de Meta** (`+1 555…`), que solo puede escribirle a un puñado de destinatarios preinscritos: sirve para desarrollar, no para una cohorte. El definitivo debe ser uno que nunca haya estado registrado en WhatsApp —al conectarlo queda consumido—, recibir un SMS o llamada una vez, y tener el nombre visible aprobado por Meta.
2. **Escalón de mensajería de Meta.** Un número nuevo parte en 250 destinatarios por 24 h y sube a 1.000, 10.000 y 100.000 según uso y calidad. No se puede pedir: se construye a lo largo de semanas, así que la primera oleada tiene que planificarse contra ese techo.
3. **Credenciales**: `WA_CLOUD_TOKEN` (token de usuario del sistema, permanente), `WA_CLOUD_PHONE_NUMBER_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `GEMINI_API_KEY`, SMTP.
4. **Plantilla utility de recordatorio aprobada** por Meta (`WA_TEMPLATE_RECORDATORIO`).
5. **Transcripciones de las microcápsulas** cargadas como `content_item`: hoy el RAG tiene 1.410 caracteres —descripciones, no el material— así que `buscar_contenido_curso` responde con menos de lo que el curso enseña.

**Pendientes de código**


| Pendiente | Detalle |
|---|---|
| **Adaptador BSP** | Chattigo está implementado ([`messaging/chattigo.ts`](src/messaging/chattigo.ts), 25 tests, [`docs/CHATTIGO.md`](docs/CHATTIGO.md)) pero **nunca corrió contra la API real**: sin contrato firmado no hay credenciales con las que probarlo |
| **Currículo en producción** | La migración 0012 y `scripts/cargar-curriculo.mjs` solo se han corrido contra la base local. En Cloud SQL viven 4 estudiantes y un certificado emitido: la carga archiva los cursos anteriores (no los borra) y hay que ejecutarla a mano |
| **`maxScale = 1`** | Cloud Run está fijado en una instancia: unos 80 turnos concurrentes. Subirlo a 10 es un parámetro, pero conviene hacerlo con el número real ya conectado |
| **QR imprimible** | El enlace `wa.me` ya se genera (`GET /jobs/convocatoria`); falta convertirlo en un PNG/SVG para afiches. Cualquier generador sirve mientras tanto |
| **Fase 15** | Escalabilidad — plan en la auditoría §13 |
| **Feriados** | Lista fija de cuatro fechas en `reminders/motor.ts`; conviene externalizarla |

**Límite conocido de Fase 10a**: en modo in-process el turno se procesa después del ACK, así que si la instancia muere el turno se pierde. El split de Pub/Sub (Fase 11) lo resuelve y ya está implementado — hay que habilitarlo con `PUBSUB_TOPIC`.

---

## 15. Fases

0 Auditoría ✔ · 1 Limpieza ✔ · 2 Arquitectura ✔ · 3 Identidad ✔ · 4 Cursos y progreso ✔ · 5 RAG ✔ · 6 Tutor pedagógico ✔ · 7 Evaluaciones ✔ · 8 Certificación ✔ · 9 Recordatorios ✔ (9.1 endurecimiento ✔) · 10 WhatsApp Cloud API (10a ✔) · 11 GCP ✔ · 12 Seguridad ✔ · 13 Observabilidad ✔ · 14 Performance ✔ *(escrito; falta ejecutarlo contra staging)* · 15 Escalabilidad ⬜
