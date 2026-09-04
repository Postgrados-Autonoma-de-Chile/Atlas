# Alineación con el plan curricular oficial

Trazabilidad entre el material curricular del **Nivel Inicial: Alfabetización ciudadana en
Inteligencia Artificial** y la implementación del bot.

**Fuente de verdad:** `Material Curricular_ PLAN _Alfabetización Ciudadana en Inteligencia
Artificial_` — Nivel 1 IA Plan Nacional (Ajustado), Microcápsulas 01 a 08, Cuestionario de
Caracterización (Ajustado).

El currículo **no vive en el código**: vive en [`curriculo/nivel1.json`](../curriculo/nivel1.json),
versionado, y lo carga [`scripts/cargar-curriculo.mjs`](../scripts/cargar-curriculo.mjs). Ajustar el
material no exige tocar la lógica del bot ni escribir una migración.

---

## 1. Diagnóstico: qué hacía el bot antes

Dictaba **otro curso**. No le faltaban piezas: los contenidos no coincidían.

| | Plan oficial | Implementación anterior |
|---|---|---|
| Microcápsulas | **8**, sobre resolver problemas cotidianos | **9**, sobre qué es la IA |
| Eje del nivel | Ruta **DEFINO → PREGUNTO → ORGANIZO → VERIFICO → DECIDO** | No existía |
| Interacción por cápsula | "Lo intento": elegir, clasificar, comparar, aplicar una pauta | Quiz de recordar contenido |
| Producto de cierre | Ficha de resolución de problema, 5 campos | No existía |
| Caracterización | 11 preguntas, primer paso obligatorio | No existía |
| Certificación | Por finalización, **sin evaluación formal** | Por finalización ✓ |
| Rol del tutor | Anfitrión que acompaña | Profesor que explica |

---

## 2. Matriz de trazabilidad

| Requisito curricular | Documento fuente | Cambio realizado | Archivo |
|---|---|---|---|
| 8 microcápsulas con su ficha de diseño | Plan Nacional §Diseño curricular · Microcápsulas 01-08 | Currículo como dato versionado + columnas `paso_ruta`, `proposito`, `pregunta_movilizadora`, `producto_evidencia`, `resultados_observables`, `guion_apertura`, `guion_cierre` | `curriculo/nivel1.json`, `migrations/0012`, `src/store/cursos.ts` |
| Ruta de 5 pasos visible en todo el recorrido | Plan Nacional §Ruta metodológica | `paso_ruta` por cápsula; el prompt obliga a mencionarlo; la ficha de cierre recorre los 5 | `migrations/0012`, `src/core/channel.ts`, `src/flows/fichaCierre.ts` |
| Guion del Anfitrión de apertura y cierre | Microcápsulas 01-08 §5 | Se carga textual y se expone al tutor como contenido curricular | `curriculo/nivel1.json`, `src/store/cursos.ts` |
| Al menos una acción del participante por cápsula | Plan Nacional §Criterios de implementación | Momento "Lo intento" con 4 tipos de interacción | `src/flows/evaluacion.ts`, `src/store/evaluaciones.ts` |
| Retroalimentar el **criterio**, no "correcto/incorrecto" | Microcápsula 02 §9 | Acuse breve por ítem; criterio del documento completo, una sola vez, al cerrar | `src/flows/evaluacion.ts` |
| Refuerzo no punitivo: revisar de nuevo sin penalización | Microcápsulas 01 §7 · 02 §7 · 04 §7 · checklist «retroalimentación útil y no punitiva» | Ante el primer error el ítem vuelve una vez, sin revelar la respuesta; la alternativa correcta se muestra recién después | `src/flows/evaluacion.ts` |
| Certificación por finalización, sin evaluación formal | Plan Nacional §Cierre | Se eliminó el puntaje del cierre; el prompt prohíbe hablar de notas | `src/flows/evaluacion.ts`, `src/core/channel.ts` |
| Cuestionario de caracterización primero | Cuestionario (Ajustado) | Flujo determinista de 11 preguntas; ruta bloqueada hasta completarlo | `src/flows/caracterizacion.ts`, `src/store/caracterizacion.ts`, `src/ai/toolRunner.ts` |
| Producto de cierre: ficha de 5 campos | Plan Nacional §Producto de cierre · Microcápsula 08 | Flujo de 5 campos = 5 pasos; su completitud completa la cápsula 8 | `src/flows/fichaCierre.ts`, `src/store/fichaCierre.ts` |
| Frase personal de la cápsula 2 recuperable en la 8 | Microcápsula 02 §13 | Tabla `nota_estudiante`; la ficha la ofrece como punto de partida | `migrations/0012`, `src/store/fichaCierre.ts` |
| Ejemplos de empleo, formación, hogar, trámites | Microcápsula 02 §9 | Instrucción en el prompt | `src/core/channel.ts` |
| No pedir RUT ni datos sensibles en ejemplos | Microcápsula 02 §13 | Prohibición explícita en el prompt | `src/core/channel.ts` |
| "Prompt" solo tras la expresión cotidiana | Microcápsula 02 §10 | Instrucción en el prompt | `src/core/channel.ts` |
| Prioridad material oficial > modelo | Encargo §16 · Plan Nacional | Orden de prioridad explícito; prohibición de inventar cápsulas u objetivos | `src/core/channel.ts` |

---

## 3. Los siete casos del encargo

| Caso | Qué debe pasar | Dónde se prueba |
|---|---|---|
| 1 · usuario nuevo | Comienza con caracterización | [`caracterizacion.test.ts`](../test/caracterizacion.test.ts) |
| 2 · completa la caracterización | Inicia la ruta correcta | [`caracterizacion.test.ts`](../test/caracterizacion.test.ts) |
| 3 · abandona | Continúa desde su último estado | [`caracterizacion.test.ts`](../test/caracterizacion.test.ts), [`fichaCierre.test.ts`](../test/fichaCierre.test.ts) |
| 4 · responde incorrectamente | Se ejecuta el refuerzo definido | [`interacciones.test.ts`](../test/interacciones.test.ts) |
| 5 · demuestra dominio | Avanza según las reglas | [`fichaCierre.test.ts`](../test/fichaCierre.test.ts), [`interacciones.test.ts`](../test/interacciones.test.ts) |
| 6 · intenta saltarse contenidos | Se respeta la lógica curricular | [`gateCaracterizacion.test.ts`](../test/gateCaracterizacion.test.ts), [`fichaCierre.test.ts`](../test/fichaCierre.test.ts) |
| 7 · termina una microcápsula | Pasa correctamente a la siguiente | [`avanceMicrocapsula.test.ts`](../test/avanceMicrocapsula.test.ts) |

---

## 4. Decisiones que conviene auditar

**Los cursos anteriores se archivan, no se borran.** Había 4 personas inscritas y un certificado
emitido. `cursoActivo()` pasa a devolver el currículo oficial y nadie pierde su historial.

**El plan no subdivide el nivel en módulos.** Son 8 microcápsulas bajo un único bloque. El esquema
exige un módulo, así que se crea uno solo: inventar una modularización sería inventar currículo.

**El cuestionario no ramifica la ruta.** El plan lo define como caracterización para orientar la
oferta formativa y **no** establece que las respuestas modifiquen el recorrido. No se implementa
ninguna personalización de ruta; las respuestas quedan estructuradas para el reporte y como contexto
de trato.

**Hay interacciones sin respuesta correcta por diseño.** La cápsula 6 pide elegir al menos dos casos
de interés y la 8 elegir entre un problema propio o uno preparado — su documento dice que ambas son
válidas. Se marcan con `question.sin_respuesta_correcta`: llamarlas "correctas" falsearía la
retroalimentación.

**El refuerzo no revela la respuesta en el primer intento.** El material pide permitir corregir
—«Permitir "Revisar de nuevo" sin penalización» (cápsula 1), «Permitir corregir hasta completar»
(2), «Debe permitir corrección inmediata» (4)— y decir de inmediato cuál correspondía clausura esa
corrección: no queda nada que revisar. Así que el ítem vuelve una vez, sin la respuesta. Una sola
revisión: dos serían adivinar por descarte con tres categorías. El registro en base de datos
conserva la **primera** respuesta, no la corregida; es un log de la interacción, no una nota, y
nada en la certificación lo usa.

**El bloqueo de la ruta vive en el estado, no en el prompt.** `inscribirme_al_curso` y
`continuar_curso` verifican la caracterización. Ponerlo solo en el prompt permitiría que el modelo
se lo salte por complacer a quien insiste.

---

## 5. Inconsistencia del material, normalizada

La **microcápsula 7** escribe la misma categoría de dos maneras:

```
"Confirmar la fecha oficial de una postulación  → IA + verificación"
"Conocer el texto vigente de una norma          → IA + verificación / fuente oficial"
```

Conceptualmente es una sola: el sufijo aclara dónde verificar, no define otra categoría. Sin
unificarla se le ofrecerían al estudiante dos alternativas casi idénticas y la clasificación
quedaría sin respuesta defendible. Se unifica por el prefijo; el criterio está en
[`scripts/construir-curriculo.py`](../scripts/construir-curriculo.py).

**La microcápsula 2** es una clasificación cuyas categorías viven en la consigna, no pegadas a los
ítems. El documento lista los fragmentos en el mismo orden que las cuatro preguntas —y su Pantalla 2
los etiqueta como situación, necesidad e información—, así que el mapeo posicional está fundado en
la fuente. Sin eso la cápsula habría quedado como selección única y habría perdido su propósito:
practicar la pauta del paso DEFINO.

---

## 6. Adaptaciones al canal

El plan está escrito para una plataforma web con video, arrastrar y soltar, e infografías
interactivas. WhatsApp no tiene nada de eso. Lo que se conserva es la **función didáctica**:

| Momento del plan | En WhatsApp |
|---|---|
| Video de apertura del Anfitrión | El texto del guion de apertura |
| "Comprendo" — pantallas gráficas | Mensaje con la idea central |
| "Veo cómo funciona" — demostración | Ejemplo en el mensaje de la cápsula |
| "Lo intento" — arrastrar y clasificar | Un ítem por mensaje, con botones o lista |
| "Me llevo una herramienta" | La pauta en el cierre |
| Video de cierre | El texto del guion de cierre |

**Botones y listas.** Los títulos de botón de WhatsApp admiten 20 caracteres y las listas 10 filas.
Se usan botones solo si todas las opciones caben enteras; si no, lista. La pregunta de región del
cuestionario tiene 16 opciones, así que cae a una lista numerada por texto: sin ese camino la
pregunta simplemente no se podría hacer.

---

## 7. Cómo cargar o actualizar el currículo

```bash
# 1. Extraer el texto de los .docx (requiere Python)
python scripts/extraer-curriculo.py

# 2. Construir curriculo/nivel1.json
python scripts/construir-curriculo.py

# 3. Cargar a la base (idempotente; --dry-run para simular)
DATABASE_URL=... node scripts/cargar-curriculo.mjs --archivar-otros
```

El cargador reconcilia por códigos y órdenes estables: recargar tras un cambio del material no
duplica ni pierde avance, porque `lesson_progress` apunta a `lesson.id`, que se conserva.

---

## 8. Pendiente

**Las transcripciones de las microcápsulas no están cargadas como contenido RAG.** El plan describe
las pantallas y las demostraciones, pero el texto que el estudiante leería en cada una está en los
documentos de producción y no se ha ingerido en `content_item`. Sin eso, `buscar_contenido_curso`
responde con las descripciones y no con el material completo.

**El momento "Me llevo una herramienta"** (la pauta reutilizable de cada cápsula) no se entrega como
pieza aparte: hoy vive dentro del guion de cierre. El plan lo define como recurso propio, exportable.

**La retroalimentación por ítem no existe en la fuente.** Las cápsulas 5 y 7 piden en su diseño web
«explicación breve por tarjeta» y «retroalimentación matizada» para los casos frontera, pero el
documento entrega un solo párrafo de «Retroalimentación prevista» por actividad. Redactar uno por
ítem sería escribir currículo, así que el criterio se entrega completo al cerrar.

**El campo personal opcional de la cápsula 2** tiene tabla y lector, pero el flujo que lo ofrece
durante esa cápsula no está implementado — hoy solo se recupera si existe.
