# -*- coding: utf-8 -*-
"""Arma el corpus de contenido del Nivel Inicial para el RAG, desde los documentos oficiales.

    python scripts/construir-contenido.py

Escribe curriculo/contenido-nivel1.json: un texto de estudio por microcápsula, que
scripts/ingerir-contenido.ts indexa con embeddings.

QUÉ SE INCLUYE Y POR QUÉ
Los documentos mezclan material para el estudiante con especificaciones de producción. Al RAG solo
va lo primero:

  §3 Resultados observables al finalizar   → qué se espera saber hacer
  §5 Guion del Anfitrión                   → la prosa de apertura y cierre
  §6 Desarrollo pantalla a pantalla        → el contenido visible de cada pantalla
  §7 Interacciones y retroalimentación     → la consigna, los ítems y el criterio

Se deja fuera §4 (la tabla de secuencia instruccional) porque al extraerse de un .docx las columnas
quedan como líneas sueltas y no se puede reconstruir qué celda va con cuál: indexarlo así le daría
al tutor frases partidas. Su contenido está de todos modos en §5 y §6. Y se deja fuera §8 a §14,
que son inventario de piezas, especificaciones técnicas y notas para el equipo de diseño.

Dentro de las secciones que sí entran se filtran las líneas de producción —"Indicaciones de
diseño:", "Dirección:", "Comportamiento de la interfaz:"— que le hablan a quien construye la
plataforma, no a quien estudia.

NO SE INVENTA NADA: cada línea del corpus está textual en los documentos.
"""
import io, json, os, re, zipfile, glob

D = r"C:\Users\Msi chile\Downloads\Material  Curricular_ PLAN  _Alfabetización Ciudadana en Inteligencia Artificial_"
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(RAIZ, 'curriculo', 'contenido-nivel1.json')

# Secciones que van al corpus, con el nombre que llevarán en el texto.
SECCIONES = {
    3: 'Al terminar esta microcápsula',
    5: 'Lo que dice el Anfitrión',
    6: 'Contenido, pantalla por pantalla',
    7: 'La práctica y su criterio',
}

# Líneas dirigidas a quien produce la plataforma, no a quien estudia.
PRODUCCION = re.compile(
    r'^(Indicaciones de dise|Direcci\u00f3n:|Comportamiento de la interfaz:|Comportamiento / interacci|'
    r'Especificaci\u00f3n|Objetivo de la pantalla:)',
)
# Prefijos que estorban al leer el texto seguido.
LIMPIAR = [
    ('Contenido visible: ', ''),
    ('Consigna al participante: ', 'Consigna: '),
    # Por WhatsApp no hay video: la etiqueta del formato original confundiría a quien lea el chunk.
    ('VIDEO DE APERTURA', 'Al abrir la microcápsula:'),
    ('VIDEO DE CIERRE', 'Al cerrar la microcápsula:'),
]


def texto_de_docx(ruta):
    with zipfile.ZipFile(ruta) as z:
        xml = z.read('word/document.xml').decode('utf-8', 'replace')
    for a, b in [('</w:p>', '\n'), ('<w:br/>', '\n'), ('<w:tab/>', '\t'), ('</w:tr>', '\n'), ('</w:tc>', ' | ')]:
        xml = xml.replace(a, b)
    t = re.sub(r'<[^>]+>', '', xml)
    for a, b in [('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'), ('&apos;', "'")]:
        t = t.replace(a, b)
    lineas = [re.sub(r'[ \t]+', ' ', l).strip(' |').strip() for l in t.split('\n')]
    return [l for l in lineas if l]


def secciones_de(lineas):
    """Parte el documento por sus encabezados numerados: {numero: [lineas]}."""
    fuera = {}
    actual = None
    for l in lineas:
        m = re.match(r'^(\d{1,2})\.\s+(.+)$', l)
        if m and int(m.group(1)) <= 14 and len(m.group(2)) < 60:
            actual = int(m.group(1))
            fuera[actual] = []
            continue
        if actual is not None:
            fuera[actual].append(l)
    return fuera


def material_de(lineas, titulo):
    sec = secciones_de(lineas)
    partes = []
    for num in sorted(SECCIONES):
        cuerpo = [l for l in sec.get(num, []) if not PRODUCCION.match(l)]
        if not cuerpo:
            continue
        for a, b in LIMPIAR:
            cuerpo = [l.replace(a, b) for l in cuerpo]
        partes.append(SECCIONES[num] + '\n' + '\n'.join(cuerpo))
    return (titulo + '\n\n' + '\n\n'.join(partes)).strip()


# El orden es el del plan, no el alfabético del sistema de archivos: la 6 se llama distinto.
ORDEN = [
    (1, 'Microcapsula 01'), (2, 'Microcapsula 02'), (3, 'Microcapsula 03'), (4, 'Microcapsula 04'),
    (5, 'Microcapsula 05'), (6, 'Microcapsula_06'), (7, 'Microcapsula 07'), (8, 'Microcapsula 08'),
]

curriculo = json.load(io.open(os.path.join(RAIZ, 'curriculo', 'nivel1.json'), encoding='utf-8'))
titulos = {m['orden']: m['titulo'] for m in curriculo['microcapsulas']}

salida = []
for orden, prefijo in ORDEN:
    encontrados = glob.glob(os.path.join(D, prefijo + '*.docx'))
    if len(encontrados) != 1:
        raise SystemExit('esperaba 1 documento para %s, hay %d' % (prefijo, len(encontrados)))
    titulo = titulos[orden]
    texto = material_de(texto_de_docx(encontrados[0]), titulo)
    if len(texto) < 500:
        raise SystemExit('la microcápsula %d quedó en %d caracteres: revisa el parseo' % (orden, len(texto)))
    salida.append({'orden': orden, 'titulo': titulo, 'texto': texto})
    print('%d. %-58s %5d chars' % (orden, titulo[:58], len(texto)))

doc = {
    'version': curriculo['version'],
    'fuente': curriculo['fuente'],
    'curso': curriculo['curso']['codigo'],
    'nota': 'Material de estudio por microcápsula: secciones 3, 5, 6 y 7 de cada documento oficial, '
            'sin las líneas de producción. Ver scripts/construir-contenido.py.',
    'microcapsulas': salida,
}
io.open(SALIDA, 'w', encoding='utf-8').write(json.dumps(doc, ensure_ascii=False, indent=2) + '\n')
print('\ntotal %d caracteres en %s' % (sum(len(m['texto']) for m in salida), os.path.relpath(SALIDA, RAIZ)))
