# ATLAS — Tutor educativo de IA por WhatsApp

Proyecto de la **Universidad Autónoma de Chile**. Un tutor conversacional que acompaña a estudiantes de cursos de formación por WhatsApp: entrega las clases en microcápsulas, resuelve dudas con RAG sobre el material oficial del curso, evalúa para enseñar, recuerda el progreso, retoma a quien abandona y gestiona la certificación.

**Estado: Fases 1 a 14 implementadas.** 118 tests en verde, typecheck limpio. El código está listo; lo que falta para el piloto es operacional (número de WhatsApp, credenciales, despliegue) y está detallado en [§14](#14-lo-que-falta-para-el-piloto).

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
| Destino | GCP: Cloud Run (webhook + worker), Cloud SQL, Memorystore, Pub/Sub, Cloud Scheduler, Secret Manager |

**Dos proveedores de IA.** Anthropic para el razonamiento, Google para los embeddings del RAG. Son dos cuentas, dos facturas y dos puntos de falla; la decisión está registrada en la migración `0005`: pgvector en Cloud SQL en vez de Vertex Vector Search, que cuesta ~US$55/mes fijos.

---

## 3. Estructura del repositorio

```
src/
├── index.ts                  # bootstrap Express: 7 endpoints, arranque de BD y barridos
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
│   ├── colaTurnos.ts         # publish/decode Pub/Sub con orderingKey por estudiante
│   └── index.ts              # factory del proveedor
├── flows/
│   ├── registro.ts           # captura de identidad conversacional (determinista)
│   ├── evaluacion.ts         # interceptor de respuestas de quiz (determinista)
│   └── certificacion.ts      # RUT, código por correo y emisión (determinista)
├── rag/
│   ├── chunker.ts            # troceado del material del curso
│   └── retrieval.ts          # búsqueda vectorial con umbral + fallback léxico
├── reminders/motor.ts        # planificar + despachar, con dedupe fail-closed
├── cert/
│   ├── pdf.ts                # generación del certificado con pdf-lib
│   └── mailer.ts             # envío SMTP
├── store/
│   ├── db.ts                 # pool de Postgres, retención de auditoría
│   ├── kv.ts                 # Redis con degradación a memoria en dev
│   ├── personas.ts           # identidad y consentimiento
│   ├── cursos.ts             # cursos, inscripción, progreso
│   ├── evaluaciones.ts       # quizzes, intentos, respuestas
│   ├── recordatorios.ts      # cola de recordatorios con estados
│   ├── certificados.ts       # emisión y folios
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

migrations/                   # 9 migraciones node-pg-migrate (.cjs)
infra/                        # Terraform del piloto GCP
perf/                         # carga con k6 (firma HMAC real) + verificador de invariantes
eval/golden-set.json          # casos de referencia del harness pedagógico
contenido/                    # material del curso del piloto
docs/                         # DEPLOY · SEGURIDAD · OBSERVABILIDAD · DECOMISO-VENTAS · specs/
test/                         # 24 archivos, 118 tests
```

---

## 4. Modelo de datos

18 tablas en 9 migraciones. El avance académico vive en Postgres y **no** en Redis: quien vuelve tres semanas después retoma exactamente donde quedó.

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

**El contenido del piloto** es *Nivel Inicial — Alfabetización ciudadana en IA*, sembrado como **tres propuestas** de curso (`NIVEL-INICIAL-P1`, `P2`, `P3`) de **8 microcápsulas cada una** más un producto de cierre — 24 lecciones en total. La P1, "IA en la vida cotidiana", va desde "¿Qué es la inteligencia artificial?" hasta un checklist de uso responsable. El material vive en [`contenido/`](contenido/); las transcripciones se cargan como `content_item` y de ahí las trocea el RAG.

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

## 7. Los tres flujos deterministas

### Registro ([`flows/registro.ts`](src/flows/registro.ts))

Según [`docs/specs/captura-identidad-estudiante.md`](docs/specs/). Consentimiento primero por botones, un dato por mensaje, confirmación del correo, máximo 2 reintentos por campo — al tercero se pausa y el mensaje pasa al tutor. La persona se crea recién con la captura mínima completa, de forma atómica. **El RUT no se pide acá**, solo al certificar.

### Evaluación ([`flows/evaluacion.ts`](src/flows/evaluacion.ts))

Intercepta las respuestas de quiz antes del motor. El parsing de la alternativa es exacto (id de botón o texto A-D / V-F) y el registro es transaccional. La retroalimentación nace de la explicación docente guardada en la pregunta: **corregir → decir la correcta → explicar el porqué → invitar a seguir**. Es evaluación formativa: enseña, no filtra.

### Certificación ([`flows/certificacion.ts`](src/flows/certificacion.ts))

La elegibilidad nace en la misma transacción que completa el curso. Después: RUT validado por módulo 11 con confirmación → código de verificación al correo → emisión con folio → PDF por correo → confirmación por WhatsApp. Ni el RUT ni la emisión pasan por el LLM.

---

## 8. Recordatorios

Dos etapas idempotentes que dispara Cloud Scheduler vía `POST /jobs/recordatorios` — sin `setInterval` en proceso, que fue un hallazgo de la auditoría.

1. **Planificar**: decide a quién corresponde (inactividad, opt-in vigente, tope de insistencia) y lo programa con `clave_dedupe` única por ventana temporal. El dedupe es **fail-closed en Postgres**, no en Redis.
2. **Despachar**: envía los vencidos respetando la ventana hábil de Chile — **lunes a sábado, 10:00 a 20:00**, con feriados. Usa texto libre si la ventana de servicio de 24 h está abierta (**gratis**) y plantilla utility solo si está cerrada (**se paga**).

El opt-out es inmediato y se evalúa **antes** del opt-in, porque "no quiero recordatorios" contiene "quiero recordatorios". Solo se confirma al estudiante lo que efectivamente se persistió. Es obligación de Meta y de la Ley 21.719.

---

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

**118 tests en 24 archivos**, todos en verde. Cubren, entre otros: el bucle del agente con el cliente mockeado, el pipeline de WhatsApp, la verificación de firma, el push de Pub/Sub, los tres flujos deterministas, la validación de identidad, el troceado del RAG, el juez del harness, los recordatorios, el PDF del certificado, y dos suites dedicadas a que los guards y las verificaciones sean **fail-closed** (`failclosed.test.ts`, `seguridad.test.ts`).

---

## 12. Despliegue

IaC del piloto en [`infra/`](infra/) (Terraform) y runbook en [`docs/DEPLOY.md`](docs/DEPLOY.md). Región recomendada `us-east1`; `southamerica-west1` solo si la Universidad exige residencia de datos, con un 20-40 % más de costo.

Terraform provisiona: Artifact Registry, Cloud SQL con su base y usuario, Memorystore Redis, tres cuentas de servicio (runtime, push, scheduler) con IAM acotado, Secret Manager con la `DATABASE_URL` generada, y el topic de Pub/Sub **con ordering habilitado** más su DLQ y la push subscription.

El split de Fase 11 son dos servicios Cloud Run sobre el mismo bundle: el **webhook** publica cada mensaje normalizado a Pub/Sub con `orderingKey = teléfono del estudiante`, y el **worker** lo consume por push. Semántica at-least-once domesticada aguas abajo con dedupe por `wamid` más los UNIQUE académicos; el orden por estudiante lo dan el ordering key y el lock por conversación.

---

## 13. Observabilidad, costo y seguridad

`GET /metrics` devuelve contadores técnicos, latencia del LLM, **métricas de negocio** desde las tablas reales y el **costo estimado del LLM** según los precios configurables `LLM_USD_*`. Catálogo de alertas y formato de logs en [`docs/OBSERVABILIDAD.md`](docs/OBSERVABILIDAD.md).

Sobre el costo de WhatsApp, el dato que gobierna el diseño: **las conversaciones iniciadas por el estudiante son gratis** y las plantillas utility dentro de la ventana de 24 h también. Solo se paga la plantilla enviada fuera de esa ventana — por eso el motor de recordatorios elige texto libre cuando puede.

Seguridad: PII cifrada en reposo con AES-256-GCM, redacción de PII en logs y auditoría, auditoría minimizada (metadatos del turno, nunca el texto completo), tokens solo por header —nunca por query string, que quedaba expuesto en logs de proxies y en el Referer—, y comparación timing-safe. Estado del gate en [`docs/SEGURIDAD.md`](docs/SEGURIDAD.md).

---

## 14. Lo que falta para el piloto

**Bloqueantes operacionales**

1. **Número de WhatsApp dedicado.** Debe ser uno que nunca haya estado registrado en WhatsApp: al conectarlo a la plataforma queda consumido y no puede volver a usarse en la app. Requiere recibir un SMS o llamada una vez, y aprobación del nombre visible por Meta.
2. **Credenciales**: `WA_CLOUD_TOKEN` (token de usuario del sistema, permanente), `WA_CLOUD_PHONE_NUMBER_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `GEMINI_API_KEY`, SMTP.
3. **Plantilla utility de recordatorio aprobada** por Meta (`WA_TEMPLATE_RECORDATORIO`).
4. **Transcripciones de las microcápsulas** cargadas como `content_item`: sin ellas el RAG no tiene material que buscar.

**Pendientes de código**

| Pendiente | Detalle |
|---|---|
| **Adaptador BSP** | La costura está lista y la regla arquitectónica es explícita: nada fuera de `src/messaging/` importa Meta/Graph. Pero `WA_PROVIDER` solo acepta `meta` o vacío; agregar Chattigo o Atom es escribir otra implementación de `MessagingProvider` y extender ese enum |
| **Convocatoria** | No existe forma de invitar a una cohorte. Los recordatorios apuntan a estudiantes ya registrados; una invitación va a quien todavía no existe en la base. Faltan la carga del listado, las oleadas con cupo diario, y el link `wa.me` con QR y texto precargado (que es lo que convierte la conversación en gratuita) |
| **Fase 15** | Escalabilidad — plan en la auditoría §13 |
| **Feriados** | Lista fija de cuatro fechas en `reminders/motor.ts`; conviene externalizarla |

**Límite conocido de Fase 10a**: en modo in-process el turno se procesa después del ACK, así que si la instancia muere el turno se pierde. El split de Pub/Sub (Fase 11) lo resuelve y ya está implementado — hay que habilitarlo con `PUBSUB_TOPIC`.

---

## 15. Fases

0 Auditoría ✔ · 1 Limpieza ✔ · 2 Arquitectura ✔ · 3 Identidad ✔ · 4 Cursos y progreso ✔ · 5 RAG ✔ · 6 Tutor pedagógico ✔ · 7 Evaluaciones ✔ · 8 Certificación ✔ · 9 Recordatorios ✔ (9.1 endurecimiento ✔) · 10 WhatsApp Cloud API (10a ✔) · 11 GCP ✔ · 12 Seguridad ✔ · 13 Observabilidad ✔ · 14 Performance ✔ *(escrito; falta ejecutarlo contra staging)* · 15 Escalabilidad ⬜
