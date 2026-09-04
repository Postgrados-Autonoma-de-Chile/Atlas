"""Construye curriculo/nivel1.json del repositorio a partir de los .docx extraídos.

Regenerable: si el material curricular cambia, se vuelve a correr y el cargador
del repositorio aplica las diferencias. La fuente de verdad son los documentos.
"""
import io, os, re, json

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, 'curriculo')
REPO = r"c:\Users\Msi chile\Desktop\Proyectos Postgrados\Atlas"

caps = json.load(io.open(os.path.join(BASE, 'curriculo.json'), encoding='utf-8'))

# ── Paso de la ruta: el documento lo escribe en prosa; se normaliza al código ──
PASOS = {1: 'ENTRADA', 2: 'DEFINO', 3: 'PREGUNTO', 4: 'ORGANIZO',
         5: 'VERIFICO', 6: 'APLICO', 7: 'DECIDO', 8: 'INTEGRO'}

# ── Tipo de interacción, deducido de la consigna y los ítems ──────────────────
# Los documentos no lo declaran; se infiere de la forma de los ítems:
#   ítems con "→ categoría"  -> clasificación (el ítem trae su respuesta)
#   "Selecciona al menos"    -> selección múltiple sin respuesta correcta
#   "Elige cómo quieres"     -> elección de modalidad, ambas válidas
#   resto                    -> selección única con una mejor opción
def tipo_y_items(orden, consigna, items):
    if re.search(r'selecciona al menos', consigna, re.I):
        return 'seleccion_multiple', [dict(texto=i, categoria=None, correcta=None) for i in items], 2
    if re.search(r'elige c[oó]mo quieres', consigna, re.I):
        return 'eleccion', [dict(texto=i, categoria=None, correcta=None) for i in items], 1
    if all('→' in i for i in items):
        salida = []
        for i in items:
            izq, der = i.split('→', 1)
            salida.append(dict(texto=izq.strip(' .'), categoria=der.strip(' .'), correcta=None))
        # ── INCONSISTENCIA DEL MATERIAL, normalizada ───────────────────────
        # La cápsula 7 escribe la misma categoría de dos formas: "IA + verificación"
        # y "IA + verificación / fuente oficial". Conceptualmente es una sola: el
        # sufijo aclara dónde verificar, no define otra categoría. Sin normalizar,
        # al estudiante se le ofrecerían dos alternativas casi idénticas y la
        # clasificación dejaría de tener una respuesta defendible.
        # Se unifica por el prefijo antes de la barra cuando ambas variantes
        # coexisten en la misma interacción.
        cats = {x['categoria'] for x in salida}
        for x in salida:
            if '/' in x['categoria']:
                base = x['categoria'].split('/')[0].strip()
                if any(c.strip() == base for c in cats):
                    x['categoria'] = base
        return 'clasificacion', salida, len(items)
    # Selección única. La opción correcta se marca a mano abajo: los documentos no
    # la señalan, y deducirla por longitud sería adivinar.
    return 'seleccion_unica', [dict(texto=i, categoria=None, correcta=None) for i in items], 1


# ── Opción correcta de las selecciones únicas ────────────────────────────────
# Determinada leyendo la retroalimentación de cada documento, que explica el criterio.
#   Cápsula 1: "La IA puede ayudar a ordenar y comparar información" -> ítem 1.
#   Cápsula 2: clasificación (sin ítem único correcto).
#   Cápsula 3: "La solicitud más útil explicita la necesidad, el contexto, una
#              condición relevante y el tipo de resultado esperado" -> ítem 3.
CORRECTA = {1: 0, 3: 2}

# ── Cápsula 2: clasificación cuyas categorías viven en la CONSIGNA ───────────
# Sus ítems no traen "→" porque las cuatro categorías están enunciadas en la
# consigna ("¿qué ocurre?, ¿qué se necesita?, ¿qué información ya existe? o ¿qué
# condición debe considerarse?"). El documento lista los fragmentos en ese mismo
# orden —y su Pantalla 2 etiqueta la frase contextualizada como "situación,
# necesidad, información"—, así que el mapeo posicional está fundado en la fuente,
# no adivinado. Sin esto la cápsula quedaría como selección única y perdería su
# propósito: practicar la pauta de cuatro preguntas del paso DEFINO.
CATEGORIAS_C2 = ['Qué ocurre', 'Qué necesito', 'Qué información tengo', 'Qué condiciones debo considerar']

microcapsulas = []
for c in caps:
    o = c['orden']
    tipo, items, minimo = tipo_y_items(o, c['interaccion']['consigna'], c['interaccion']['items'])
    if o in CORRECTA:
        for k, it in enumerate(items):
            it['correcta'] = (k == CORRECTA[o])
    if o == 2:
        tipo, minimo = 'clasificacion', len(items)
        for k, it in enumerate(items):
            it['categoria'] = CATEGORIAS_C2[k] if k < len(CATEGORIAS_C2) else None
    dur = re.findall(r'\d+', c['duracion'])
    microcapsulas.append(dict(
        orden=o,
        titulo=re.sub(r'^Microc[aá]psula\s*\d+\.\s*', '', c['titulo']).strip(),
        paso_ruta=PASOS[o],
        duracion_min=int(dur[-1]) if dur else 6,
        proposito=c['proposito'],
        pregunta_movilizadora=c['pregunta_movilizadora'],
        producto_evidencia=c['producto'],
        resultados_observables=c['resultados'],
        guion_apertura=c['guion_apertura'],
        guion_cierre=c['guion_cierre'],
        tipo='actividad_cierre' if o == 8 else 'capsula',
        interaccion=dict(
            tipo=tipo,
            consigna=c['interaccion']['consigna'],
            retroalimentacion=c['interaccion']['retroalimentacion'],
            minimo_requerido=minimo,
            items=items,
        ),
        fuente=c['archivo'],
    ))

# ── Cuestionario de caracterización ──────────────────────────────────────────
txt = io.open(os.path.join(SRC, 'Cuestionario_de_Caracterización_Ajustado_.txt'), encoding='utf-8').read()
L = [l.strip() for l in txt.split('\n') if l.strip()]
preguntas, seccion, actual = [], '', None
for l in L:
    ms = re.match(r'^([IVX]+)\.\s*(.+)$', l)
    if ms:
        seccion = ms.group(2).strip()
        continue
    mp = re.match(r'^(\d+)\.\s*(.+)$', l)
    if mp:
        if actual:
            preguntas.append(actual)
        actual = dict(numero=int(mp.group(1)), seccion=seccion, enunciado=mp.group(2).strip(), opciones=[])
        continue
    if l.startswith('☐') and actual:
        actual['opciones'].append(l.lstrip('☐').strip())
if actual:
    preguntas.append(actual)

# Códigos estables para no depender del número de orden.
CODIGOS = {1: 'edad', 2: 'genero', 3: 'region', 4: 'nivel_educativo', 5: 'area_formacion',
           6: 'situacion_laboral', 7: 'trabaja_en_su_area', 8: 'anios_experiencia',
           9: 'dificultad_empleabilidad', 10: 'busca_reconversion', 11: 'expectativa'}
for p in preguntas:
    p['codigo'] = CODIGOS.get(p['numero'], f"p{p['numero']}")

intro = next((l for l in L if l.startswith('El presente cuestionario')), '')

doc = dict(
    version='nivel1-2026-09',
    fuente='Material Curricular_ PLAN _Alfabetización Ciudadana en Inteligencia Artificial_',
    curso=dict(
        codigo='NIVEL-1-IA-PROBLEMAS',
        nombre='Nivel Inicial: Alfabetización ciudadana en Inteligencia Artificial',
        descripcion='IA para resolver problemas diarios. Microlearning de 40 a 60 minutos en 8 microcápsulas de 5 a 7 minutos.',
        proposito=('Promover una alfabetización básica en inteligencia artificial para la ciudadanía, mediante '
                   'microcápsulas breves que permitan utilizar herramientas de IA para buscar, organizar y analizar '
                   'información, comparar alternativas y apoyar la resolución de problemas cotidianos de manera responsable.'),
        competencia=('Comprende conceptos básicos de inteligencia artificial, reconoce sus usos cotidianos y laborales, '
                     'e identifica formas simples de utilizar información y herramientas de IA para resolver problemas '
                     'diarios de manera responsable.'),
        resultados_generales=[
            'Reconocer usos básicos de la IA como apoyo para comprender y abordar problemas cotidianos.',
            'Formular necesidades y solicitudes simples, y utilizar la IA para organizar y comparar información.',
            'Verificar información, reconocer límites de la IA y utilizar sus respuestas como apoyo para tomar decisiones.',
        ],
        certificacion='finalizacion',
        producto_cierre=('Ficha breve de resolución de problema con apoyo de IA: problema identificado, pregunta '
                         'formulada, respuesta obtenida, verificación básica y decisión o acción posible.'),
    ),
    ruta=[
        dict(codigo='DEFINO', descripcion='Comprendo qué necesito resolver, qué información tengo y qué condiciones debo considerar.'),
        dict(codigo='PREGUNTO', descripcion='Transformo la necesidad en una solicitud clara para la IA, entregando contexto, condiciones y el resultado esperado.'),
        dict(codigo='ORGANIZO', descripcion='Pido a la IA que presente la información de una forma útil: listas, tablas, pasos, ventajas y desventajas o criterios de comparación.'),
        dict(codigo='VERIFICO', descripcion='Reviso aquello que importa: fuente, fecha, coincidencia con información confiable y consecuencias de un posible error.'),
        dict(codigo='DECIDO', descripcion='Utilizo la respuesta como apoyo, reconozco sus límites y defino personalmente el próximo paso o la fuente competente que corresponde consultar.'),
    ],
    microcapsulas=microcapsulas,
    caracterizacion=dict(introduccion=intro, preguntas=preguntas),
)

destino = os.path.join(REPO, 'curriculo')
os.makedirs(destino, exist_ok=True)
ruta = os.path.join(destino, 'nivel1.json')
io.open(ruta, 'w', encoding='utf-8').write(json.dumps(doc, ensure_ascii=False, indent=2))

print(f"escrito: {ruta}  ({os.path.getsize(ruta):,} bytes)\n")
print("microcápsulas:")
for m in microcapsulas:
    i = m['interaccion']
    corr = sum(1 for x in i['items'] if x['correcta']) or '—'
    print(f"  {m['orden']}. [{m['paso_ruta']:<8}] {m['titulo'][:44]:<46} {i['tipo']:<20} "
          f"{len(i['items'])} ítems, min={i['minimo_requerido']}, correctas={corr}")
print(f"\ncaracterización: {len(preguntas)} preguntas")
for p in preguntas:
    print(f"  {p['numero']:>2}. {p['codigo']:<26} {len(p['opciones']):>2} opciones  {p['enunciado'][:52]}")
