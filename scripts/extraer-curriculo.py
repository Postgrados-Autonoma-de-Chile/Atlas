import io, os, re, zipfile, glob, sys

D = r"C:\Users\Msi chile\Downloads\Material  Curricular_ PLAN  _Alfabetización Ciudadana en Inteligencia Artificial_"
SALIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'curriculo')
os.makedirs(SALIDA, exist_ok=True)


def texto_de_docx(ruta: str) -> str:
    """Extrae el texto de un .docx conservando párrafos, saltos y tablas."""
    with zipfile.ZipFile(ruta) as z:
        xml = z.read('word/document.xml').decode('utf-8', 'replace')

    # Marca los límites que importan ANTES de borrar etiquetas, o todo queda pegado.
    xml = xml.replace('</w:p>', '\n')            # fin de párrafo
    xml = xml.replace('<w:br/>', '\n')           # salto manual
    xml = xml.replace('<w:tab/>', '\t')
    xml = xml.replace('</w:tr>', '\n')           # fila de tabla
    xml = xml.replace('</w:tc>', ' | ')          # celda de tabla
    txt = re.sub(r'<[^>]+>', '', xml)

    # Entidades XML
    for a, b in [('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'), ('&apos;', "'")]:
        txt = txt.replace(a, b)

    lineas = [re.sub(r'[ \t]+', ' ', l).strip(' |').strip() for l in txt.split('\n')]
    lineas = [l for l in lineas if l]
    return '\n'.join(lineas)


archivos = sorted(glob.glob(os.path.join(D, '*.docx')))
print(f"{len(archivos)} documentos\n")
for a in archivos:
    nombre = os.path.basename(a)
    try:
        t = texto_de_docx(a)
    except Exception as e:
        print(f"  FALLO {nombre}: {e}")
        continue
    destino = os.path.join(SALIDA, re.sub(r'[^\w\d.-]+', '_', nombre).replace('.docx', '.txt'))
    io.open(destino, 'w', encoding='utf-8').write(t)
    print(f"  {nombre[:62]:<64} {len(t):>6,} chars  {t.count(chr(10))+1:>4} líneas")
print(f"\nescritos en: {SALIDA}")
