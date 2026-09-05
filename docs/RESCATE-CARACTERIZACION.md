# Rescate del trabajo de `demo12` (caracterización y ficha de cierre)

**Esta rama NO se puede mergear tal como está.** Ver "Lo que falta".

## Qué pasó

La imagen `atlas:demo12`, desplegada a mano el 2026-09-04 22:08 UTC (revisión
`atlas-demo-00019-zcq`), contenía código que no estaba en ninguna rama de GitHub. El
2026-09-05 rompió el inicio de curso en producción: consultaba columnas y tablas que
nunca se crearon. Los 43 errores de esquema estaban todos en esa revisión; la anterior
había servido 70 turnos sin uno solo. Se mitigó devolviendo el tráfico a `demo11`.

El código fuente solo existía en la máquina de quien construyó la imagen.

## Cómo se recuperó

El `Dockerfile` compila con `esbuild --sourcemap`, y esbuild **incrusta el código fuente
original** dentro del `.map` (`sourcesContent`). Bajando la capa de la imagen desde
Artifact Registry y leyendo `dist/index.cjs.map` se recuperaron los 54 archivos propios
del proyecto, con su contenido original en TypeScript.

El delta se calculó contra `1fc0a15` — el estado de `main` en el momento en que se
construyó `demo12`, no contra `main` actual, que ya incluye optimizaciones posteriores.

## Qué se recuperó

**Archivos nuevos (759 líneas):**

- `src/flows/caracterizacion.ts`
- `src/flows/fichaCierre.ts`
- `src/store/caracterizacion.ts`
- `src/store/fichaCierre.ts`

**Archivos modificados:**

- `src/ai/toolRunner.ts`
- `src/core/channel.ts`
- `src/flows/evaluacion.ts`
- `src/routes/whatsapp.ts`
- `src/store/cursos.ts`
- `src/store/evaluaciones.ts`

Compila (`npm run typecheck` exit 0) y construye (`npm run build` OK).

## Lo que falta

**1. Las migraciones — no son recuperables.** esbuild no las empaqueta: `node-pg-migrate`
las carga en runtime desde `migrations/`, así que nunca entraron a la imagen. Hay que
reescribirlas, o pedírselas al autor. El esquema que el código exige, extraído de las
consultas:

| Objeto | Tipo |
|---|---|
| `survey_question` | tabla |
| `survey_option` | tabla |
| `survey_answer` (+ constraint `survey_answer_unico`) | tabla |
| `person.caracterizacion_completada_en` | columna |
| `leccion.paso_ruta` | columna |
| `tipo_interaccion` | columna |
| `ficha_cierre*` | tabla/columnas |

**2. Tres tests fallan**, todos en evaluación/quiz:

- `ciclo completo: comando quiz → SM por lista → correcta → V/F por botones → incorrecta → resumen`
- `el quiz se envía solo al completar la microcápsula, sin preguntar nada`
- `"quiz" sigue sirviendo para repetir uno por voluntad propia`

Es coherente con que el autor cambió `evaluacion.ts` y `evaluaciones.ts` sin actualizar
los tests. Hay que decidir si el comportamiento nuevo es el correcto (y actualizar los
tests) o si es una regresión.

**3. Falta rebasar sobre `main`.** Esta rama parte de `1fc0a15`. `main` ya tiene después
el indicador de escritura y el caché del historial. Al integrar hay que **mergear**, no
sobrescribir: `whatsapp.ts` lo tocan ambos lados.

## La lección

Desplegar una imagen construida desde código sin commitear dejó el trabajo sin respaldo y
la producción sin forma de diagnosticarse. El gate de CI en `.github/workflows/deploy.yml`
existe exactamente para impedirlo, y está inerte solo porque faltan cuatro Variables del
repositorio: `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`.

Además conviene etiquetar las imágenes con el SHA del commit en vez de `demoN`: `demo12`
no le decía a nadie qué contenía, y eso fue justamente lo que hizo caro el diagnóstico.
