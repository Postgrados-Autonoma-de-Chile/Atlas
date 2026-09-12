# El panel de seguimiento

Tres vistas para tres lectores distintos, detrás de dos niveles de acceso. Existe porque las
preguntas "¿a quién le escribo?" y "¿esto funciona?" no se responden con la misma pantalla, y
porque la segunda tiene que poder mostrarse en una reunión sin exponer a nadie.

Entrada: **`/panel`** en el servicio desplegado.

## Las tres vistas

| Vista | Ruta | Para quién | Qué lleva |
|---|---|---|---|
| **Programa** | `/panel/direccion` | quien dirige el programa | puros agregados — **ni un dato personal** |
| **Cohorte** | `/panel/cohorte` | quien opera el día a día | nombres, teléfonos, estado, avance |
| **Caracterización** | `/panel/caracterizacion` | quien analiza | agregado del cuestionario + detalle paginado |

**Programa** es la primera pestaña porque es la primera pregunta, y es la única proyectable: el
embudo del registro al certificado, dónde está cada estudiante, el ciclo de hoy etapa por etapa,
las interacciones por hora, la actividad del agente, las altas por día, el costo del modelo y el
catálogo de cursos con su avance por módulo.

**Cohorte** es la que lleva PII y la que se puede guardar en disco con `curl -o` para trabajar sin
conexión. El correo y el RUT **no aparecen**: van cifrados y el panel no los consulta.

## Cómo se entra

El token viaja en el header `x-dashboard-token`, **nunca por query string** — ahí quedaría en los
logs de los proxies, en el historial del navegador y en el `Referer` de cualquier enlace saliente.
Como un navegador no puede mandar headers escribiendo una URL, `/panel` es una página pública que
no consulta la base: solo el formulario. El token se guarda en `sessionStorage`, así que muere al
cerrar la pestaña y hay que volver a pegarlo en cada sesión nueva. Es deliberado.

### Matriz de acceso

| | `/panel/direccion` | `/panel/cohorte` | `/panel/caracterizacion` | `/metrics`, `/jobs/*` |
|---|---|---|---|---|
| Token con nombre (director) | ✅ | ❌ 401 | ❌ 401 | ❌ 401 |
| Token de dirección compartido | ✅ | ❌ 401 | ❌ 401 | ❌ 401 |
| Token de operación | ✅ | ✅ | ✅ | ✅ |

La inclusión va en un solo sentido y hay una prueba por cada dirección
([`test/tokenDireccion.test.ts`](../test/tokenDireccion.test.ts)): equivocarse hacia un lado rompe
el panel, hacia el otro filtra justo lo que esto existe para no filtrar.

**Regla:** sesión con nombre para personas, token para máquinas. Cloud Scheduler golpea
`/jobs/recordatorios` cada 15 minutos con el token de operación y una máquina no puede iniciar
sesión, así que ese token no desaparece.

### Los secretos

| Secreto | Variable | Para qué |
|---|---|---|
| `atlas-dashboard-token` | `DASHBOARD_TOKEN` | operación: las tres vistas, `/metrics` y los jobs |
| `atlas-tokens-direccion` | `DASHBOARD_TOKENS_DIRECCION` | lista `Nombre\|token`, una por línea |
| `atlas-dashboard-token-direccion` | `DASHBOARD_TOKEN_DIRECCION` | token de dirección compartido (en retirada) |

Los dos últimos son **opcionales**: sin ellos el guard se comporta como antes y no abre ninguna
puerta nueva. No están en la lista de variables obligatorias en producción a propósito — ponerlos
ahí dejaría el servicio sin arrancar hasta crear el secreto.

## Runbook: dar y quitar acceso a un director

No se edita el secreto a mano. Es justo el tipo de tarea donde se cuela un token cortado o un
nombre repetido, y el script valida las dos cosas.

```bash
node scripts/token-director.mjs listar                    # quién tiene acceso (sin imprimir tokens)
node scripts/token-director.mjs agregar "Ana Directora"   # imprime su token UNA vez
node scripts/token-director.mjs quitar  "Ana Directora"   # borra su línea
```

Cualquiera de los dos últimos **exige redesplegar** para que el servicio tome la versión nueva:

```bash
gcloud run services update atlas-demo --region us-east1 \
  --update-secrets=DASHBOARD_TOKENS_DIRECCION=atlas-tokens-direccion:latest
```

El token se muestra una sola vez: el secreto es la única copia y está para que el servicio lo
compare, no para volver a leerlo. Si alguien lo pierde, se le quita y se le agrega de nuevo.

Quitar a una persona **no afecta a las demás**, que es la razón de ser de la lista: con un token
compartido, revocárselo a uno obligaba a rotarlo para todos.

### Retirar el token compartido

Mientras `atlas-dashboard-token-direccion` tenga valor, alguien puede entrar sin identificarse. En
la tabla de accesos aparece como **«compartido (sin identificar)»**. Cuando esa línea deje de
aparecer, todos migraron y el secreto se puede vaciar.

## Quién entró

El guard escribe un evento `panel_acceso` con el **nombre** de la persona — nunca el token: un
secreto que llega a un log deja de ser un secreto, y esta tabla se lee desde el propio panel.

Se anota **una vez por hora y por persona**, no en cada petición. El panel se refresca solo cada 60
segundos; registrarlo todo metería ~1.400 filas diarias por director y enterraría la auditoría del
programa bajo el ruido de tener una pestaña abierta.

La tabla se ve en la vista de **Cohorte**, no en la de Programa: es información del equipo y no
tiene nada que hacer en la pantalla que se proyecta en una reunión.

## Lo que el panel NO muestra, a propósito

- **La vista de Programa no consulta `dialog_id`**, que es el teléfono. El feed dice qué pasó y
  cuándo, nunca a quién. Hay una prueba que lo sostiene.
- **No hay transcripción de conversaciones.** El texto no se guarda: `audit()` minimiza el `detail`
  en origen —eventos y metadatos, nunca el mensaje— y mostrarlo exigiría revertir esa decisión.
  No es una limitación técnica.
- **Ningún recurso remoto.** Ni tipografías, ni CDN. La página de cohorte lleva nombres y teléfonos,
  y pedir un archivo a un tercero le avisaría a ese tercero que alguien la está mirando, con su IP
  y el `Referer`. Hay una prueba por página.
- **El gráfico por hora no separa "mensajes de la persona" de "respuestas del agente".** Un turno
  es las dos cosas a la vez y el desglose no está registrado, así que el reparto sería inventado.
  Apila turnos dentro del total de eventos, que sí es exacto porque el total los incluye.
- **El feed deja fuera `turn`, `tool_call` y `tool_result`**: son de otra escala y llenarían las
  catorce filas antes de mostrar una microcápsula entregada. Siguen contando en el gráfico.

## De dónde sale cada número

Todo sale de las tablas reales; no hay una tabla de métricas que alguien tenga que mantener en
paralelo. Ver [`src/store/panel.ts`](../src/store/panel.ts).

| Bloque | Función | Caché |
|---|---|---|
| Embudo, avance, altas, alertas, cupos | `resumenDireccion()` | 120 s |
| Ciclo, interacciones/hora, latencia, feed | `pulsoAgente()` | 30 s |
| Cursos y avance por módulo | `catalogoPanel()` | 300 s |
| Accesos al panel | `accesosPanel()` | — |
| Cohorte | `panelCohorte()` | — |
| Caracterización (agregado / detalle) | `caracterizacionAgregada()` / `caracterizacionPagina()` | 300 s / — |

Ritmos distintos, cachés distintas: el embudo se mueve en semanas, el pulso en minutos y el
catálogo cuando se recarga el currículo. Si el pulso o el catálogo fallan, la vista dibuja el resto
en vez de caerse — media pantalla cierta antes que una entera con un bloque inventado.

**Criterios que los números respetan, y que es fácil romper sin darse cuenta:**

- La tasa de finalización va sobre **todas** las inscripciones, no solo las vivas. Con el
  denominador anterior subía al vencer cupos: el programa se veía mejor por perder gente.
- Los certificados se acotan al **curso vigente**, como el resto del embudo. Sin eso, el último
  peldaño superaba al anterior con certificados de una versión archivada. Los previos se cuentan
  aparte y se nombran, para que nadie busque un certificado que sí existe.
- Los ejes de tiempo se rellenan con `generate_series` y se cortan **en hora de Chile**. Un día sin
  registros se leía como un día que no existió, y un alta de las 21:00 en Santiago caía al día
  siguiente al truncar en UTC.
- La latencia se informa como **mediana y p90**, no promedio: un turno de certificación de 70 s
  arrastra la media y deja de describir lo que le pasa a la mayoría.

## El aspecto

Sistema de diseño **Nocturne**, del proyecto de Claude Design que se usa para las presentaciones
al directorio. No vive en este repo: viene de la carpeta exportada, en
`_ds/nocturne-1eeab971-ec09-49be-a83b-729311bac525/` (`styles.css` + `readme.md`). Los tokens
están **copiados** en
[`src/obs/panelHtml.ts`](../src/obs/panelHtml.ts), no enlazados: el archivo se sirve desde Cloud Run
y también se guarda en disco, así que no puede depender de una hoja que vive en otra parte. Si
Nocturne se retoca, esta copia se actualiza a mano.

Donde el sistema se dobla: Nocturne carga Inter desde Google Fonts y acá no se puede, por la regla
de cero recursos remotos. El token declara Inter con `system-ui` detrás y la identidad la cargan el
color, la densidad, los radios y las reglas que se desvanecen en los extremos.

> Cuidado al dibujar en SVG: `fill="var(--x)"` **no** sustituye de forma confiable en un atributo de
> presentación y la barra se dibuja negra, sin ningún error. Va en `style`. Estuvo así en producción
> medio día.

## A escala

Con 200.000 personas el panel no puede volverse el peor enemigo de la base. Lo que lo sostiene:
paginación **keyset** en el detalle de caracterización (nunca `OFFSET`, cuyo costo crece con el
número de página), agregados cacheados, índices parciales, e índice en `person(created_at)` para
las altas.

## Decisiones descartadas

**Inicio de sesión institucional (SSO).** Resolvería lo que los tokens no: saber quién miró sin
repartir secretos, y revocar a una persona desde IAM. Las cuentas de la Universidad son Microsoft
(Entra ID) sobre el dominio `@uautonoma.cl`. Dos caminos: IAP con Identity Platform por debajo
—descartado, arrastra un balanceador HTTPS externo, dominio propio con certificado y un tenant de
GCIP—, u OIDC dentro de la propia app, que es contenido y no toca infraestructura. **Ninguno se
implementó: requiere que alguien con permisos de administrador en Entra registre la aplicación, y
esa vía quedó fuera de alcance.** Si se retoma, hace falta el id de aplicación, el id de directorio
y un secreto de cliente, con la URI de redirección apuntando a `/panel/callback`. Ojo: restringir
al inquilino **no** restringe a los directores — el dominio incluye a los estudiantes, así que haría
falta además una lista de correos autorizados.

**Abrir `/panel/direccion` sin token.** No hay datos personales ahí, pero sí cuánta gente entra,
cuánta abandona, cuánto cuesta el programa y cuántas contenciones por riesgo vital hubo. Con la URL
bastaría y terminaría indexado.

**El token en el enlace.** Es exactamente lo que el proyecto descartó al decidir que viajara por
header.

## Límites conocidos

- **Revocar exige redesplegar.** El secreto se lee al arrancar el contenedor, así que quitar una
  línea no tiene efecto hasta el siguiente despliegue.
- **Los tokens no expiran.** Sirven hasta que alguien los quite.
- **Mientras exista el token compartido**, no hay trazabilidad individual de quien lo use.
- El panel **destapó una inconsistencia del currículo** que no es suya: el curso vigente
  (`NIVEL-1-IA-PROBLEMAS`) lleva el nombre del curso completo pero contiene un solo módulo, y los
  tres archivados se llaman como los tres módulos. Registrado acá para que no se pierda; la decisión
  de qué debe contener el curso vigente es del programa.
