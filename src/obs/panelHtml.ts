import type { ResumenPanel, FilaPanel, PreguntaAgregada, PaginaCaracterizacion, ResumenDireccion } from '../store/panel';

// Render del panel de cohorte. HTML autocontenido, sin dependencias externas: se abre desde un
// archivo guardado en el disco de quien lo pidió y funciona sin red.
//
// Lleva nombre y teléfono de personas reales, así que la página se marca noindex y dice en pantalla
// lo que contiene. No hay enlaces salientes ni recursos remotos: nada de esto viaja a un tercero.

const escapar = (t: unknown) =>
  String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const FECHA: Intl.DateTimeFormatOptions = {
  day: '2-digit', month: '2-digit', year: '2-digit',
  hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago', hour12: false,
};

const fecha = (d: Date | null) => (d ? new Date(d).toLocaleString('es-CL', FECHA) : '—');

/** Días desde la última actividad, para poder ver de un vistazo quién sigue activo. */
function hace(d: Date | null): { texto: string; dias: number | null } {
  if (!d) return { texto: 'sin actividad', dias: null };
  const dias = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
  if (dias <= 0) return { texto: 'hoy', dias: 0 };
  if (dias === 1) return { texto: 'ayer', dias: 1 };
  return { texto: `hace ${dias} días`, dias };
}

function estadoDe(f: FilaPanel): { texto: string; clase: string } {
  if (f.folio) return { texto: `certificada · ${f.folio}`, clase: 'e-bien' };
  if (!f.curso) return { texto: 'registrada, sin inscripción', clase: 'e-espera' };
  if (f.cursoArchivado) return { texto: `versión anterior · ${f.completadas}/${f.totalLecciones}`, clase: 'e-espera' };
  if (!f.caracterizacionCompleta) return { texto: 'cuestionario pendiente', clase: 'e-espera' };
  if (f.inscripcion === 'completada') return { texto: 'curso completo', clase: 'e-bien' };
  return { texto: `${f.completadas}/${f.totalLecciones} microcápsulas`, clase: 'e-curso' };
}

/**
 * Estilos del panel: el sistema de diseño **Nocturne** del proyecto, aplicado a una interfaz.
 *
 * Los tokens están COPIADOS acá, no enlazados, y eso es deliberado: este archivo se sirve desde
 * Cloud Run y también se guarda en disco con `curl -o`, así que no puede depender de una hoja de
 * estilos que vive en otra parte. La contrapartida es que si Nocturne se retoca, esta copia hay
 * que actualizarla a mano — de ahí el identificador del sistema en la línea de abajo.
 *
 * Origen: _ds/nocturne-1eeab971-ec09-49be-a83b-729311bac525 (styles.css + readme.md).
 * Lo que el sistema pide y acá se respeta: fondo oscuro de croma baja, Inter en peso 500 —la
 * jerarquía es tamaño y espacio, nunca más negrita—, el acento como línea o borde y jamás como
 * relleno de un área grande, botones con contorno, reglas que se desvanecen en los extremos,
 * radios de 8px, la escala densa de 0.7× y foco de teclado con anillo de acento.
 *
 * Nocturne es un sistema oscuro por decisión, así que el panel no sigue el tema del sistema
 * operativo: pinta su propio fondo siempre.
 *
 * DONDE EL SISTEMA SE DOBLA: Nocturne carga Inter desde Google Fonts. Acá no. Esta página lleva
 * nombres y teléfonos de personas reales, y pedir un archivo a un tercero le avisaría a ese
 * tercero que alguien la está mirando —con su IP y el Referer— justo en la página que el proyecto
 * decidió que no tuviera un solo recurso remoto. Así que el token declara Inter con system-ui
 * detrás y la identidad la cargan el color, la densidad, los radios y las reglas que se
 * desvanecen, que es donde vive de todos modos. Hay una prueba que lo sostiene.
 */
export const PANEL_CSS = `
      :root{
        /* — Nocturne: roles y rampas tonales (generadas en OKLCH sobre una misma escala de
           luminosidad, así que el mismo paso de cualquier rampa pesa lo mismo) — */
        --color-bg:#161826;
        --color-surface:#232532;
        --color-text:#e9e9ed;
        --color-accent:#9184d9;
        --color-divider:color-mix(in srgb,#e9e9ed 16%,transparent);
        --color-neutral-100:#f3f5fe; --color-neutral-200:#e4e7f5; --color-neutral-300:#cfd3e5;
        --color-neutral-400:#b2b6ca; --color-neutral-500:#9397ab; --color-neutral-600:#75798c;
        --color-neutral-700:#595d6c; --color-neutral-800:#3f424d; --color-neutral-900:#292b31;
        --color-accent-100:#f5f4ff; --color-accent-200:#e7e5fe; --color-accent-300:#d2cefd;
        --color-accent-400:#b5abfc; --color-accent-500:#968ae0; --color-accent-600:#796cbf;
        --color-accent-700:#5d5294; --color-accent-800:#423a6a; --color-accent-900:#2b2741;
        --font-heading:"Inter",system-ui,-apple-system,sans-serif;
        --font-body:"Inter",system-ui,-apple-system,sans-serif;
        --font-heading-weight:500;
        --space-1:2.8px; --space-2:5.6px; --space-3:8.4px; --space-4:11.2px;
        --space-6:16.8px; --space-8:22.4px;
        --radius-sm:4px; --radius-md:8px; --radius-lg:14px;
        --shadow-sm:0 0 0 1px #3f424d;
        --shadow-md:0 0 0 1px #595d6c,0 6px 18px rgba(0,0,0,.55);
        /* Color semántico. Nocturne es monocromo —un solo acento— y no define estos roles; un
           panel sí los necesita, porque "hay que atender esto" no puede leerse igual que el
           resto. Siguen su método: relleno del paso oscuro, texto del paso claro, croma baja. */
        --p-critico:#c4566e; --p-critico-fill:#3a2430; --p-critico-texto:#f2ccd5;
        --p-aviso:#bf9a52; --p-aviso-fill:#332c20; --p-aviso-texto:#f0e2c6;
        --p-bien:#5fa98d; --p-bien-fill:#1e3430; --p-bien-texto:#c9e8dc;
        /* La regla que se desvanece en los extremos: firma del sistema, 48px por lado. */
        --p-regla:linear-gradient(to right,transparent,var(--color-divider) 48px,
                  var(--color-divider) calc(100% - 48px),transparent);
      }
      *,*::before,*::after{box-sizing:border-box}
      body{font-family:var(--font-body);margin:0;padding:var(--space-8) var(--space-6);
        background:var(--color-bg);color:var(--color-text);font-size:15px;line-height:1.55}
      .caja{max-width:78rem;margin:0 auto;background:var(--color-surface);
        border-radius:var(--radius-lg);padding:var(--space-8);box-shadow:var(--shadow-sm)}
      h1,h2,h3{font-family:var(--font-heading);font-weight:var(--font-heading-weight);
        line-height:1.12;letter-spacing:-.015em}
      h1{margin:0 0 var(--space-1);font-size:25px}
      .sub{margin:0 0 var(--space-8);font-size:12px;letter-spacing:.02em;
        color:var(--color-neutral-500)}
      :focus{outline:none}
      :focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}
      ::selection{background:color-mix(in srgb,var(--color-accent) 30%,transparent)}

      /* Tarjetas de cifras. El acento entra como línea o borde, nunca como relleno. */
      .tarjetas{display:flex;gap:var(--space-3);flex-wrap:wrap;margin:0 0 var(--space-8)}
      .t{background:var(--color-bg);border-radius:var(--radius-md);
        padding:var(--space-4) var(--space-6);min-width:7rem;box-shadow:var(--shadow-sm)}
      .t b{display:block;font-family:var(--font-heading);font-weight:var(--font-heading-weight);
        font-size:26px;line-height:1.1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
      .t span{display:block;margin-top:var(--space-1);font-size:10.5px;letter-spacing:.08em;
        text-transform:uppercase;color:var(--color-neutral-500)}
      .t-alerta{box-shadow:inset 0 0 0 1px var(--p-critico)}
      .t-alerta b{color:var(--p-critico-texto)}

      /* Tablas: la regla la pinta la FILA, no la celda, para que el desvanecido cruce la fila
         completa en vez de cortarse en cada columna. */
      .scroll{overflow-x:auto}
      table{border-collapse:collapse;width:100%;font-size:14px}
      th,td{text-align:left;padding:var(--space-2) var(--space-3);white-space:nowrap;
        border-bottom:1px solid transparent}
      th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;
        color:color-mix(in srgb,var(--color-text) 60%,transparent)}
      thead tr{background:var(--p-regla) no-repeat bottom/100% 1px}
      tbody tr{background:linear-gradient(to right,transparent,
        color-mix(in srgb,var(--color-text) 8%,transparent) 48px,
        color-mix(in srgb,var(--color-text) 8%,transparent) calc(100% - 48px),transparent)
        no-repeat bottom/100% 1px}
      tbody tr:hover{background:
        linear-gradient(color-mix(in srgb,var(--color-text) 4%,transparent),
                        color-mix(in srgb,var(--color-text) 4%,transparent))
          no-repeat 0 0/100% 100%,
        linear-gradient(to right,transparent,
          color-mix(in srgb,var(--color-text) 8%,transparent) 48px,
          color-mix(in srgb,var(--color-text) 8%,transparent) calc(100% - 48px),transparent)
          no-repeat bottom/100% 1px}
      .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
      .num{text-align:right;font-variant-numeric:tabular-nums}
      /* Estados de la cohorte como roles, no como hexadecimales sueltos en el render. */
      .e-bien{color:var(--p-bien)}
      .e-espera{color:var(--p-aviso)}
      .e-curso{color:var(--color-accent-300)}
      .tenue{color:var(--color-neutral-600)}

      .aviso{margin:var(--space-8) 0 0;padding:var(--space-4) var(--space-6);
        background:var(--color-bg);border-left:2px solid var(--color-accent);
        border-radius:var(--radius-sm);font-size:13px;color:var(--color-neutral-300)}
      .aviso strong{color:var(--color-text);font-weight:500}
      .aviso-roja{border-left-color:var(--p-critico);background:var(--p-critico-fill);
        color:var(--p-critico-texto)}
      .aviso-roja strong{color:var(--color-neutral-100)}
      .pie{margin:var(--space-6) 0 0;font-size:11.5px;color:var(--color-neutral-600)}

      /* Caracterización: la barra de cada opción es una línea de acento, no un bloque. */
      .preguntas{display:grid;gap:var(--space-8);margin:var(--space-6) 0 0}
      @media(min-width:60rem){.preguntas{grid-template-columns:1fr 1fr}}
      .preg{border-radius:var(--radius-md);padding:var(--space-6);background:var(--color-bg);
        box-shadow:var(--shadow-sm)}
      .preg h3{margin:0 0 var(--space-4);font-size:13.5px;line-height:1.35;display:flex;
        gap:var(--space-3);align-items:baseline}
      .preg-n{display:inline-flex;align-items:center;justify-content:center;min-width:18px;
        height:18px;border-radius:var(--radius-sm);background:var(--color-accent-900);
        color:var(--color-accent-300);font-size:10px;font-family:var(--font-heading);flex:none}
      .ops{display:grid;gap:var(--space-1)}
      .op{display:grid;grid-template-columns:minmax(6rem,1fr) 5rem 3rem 2.4rem;gap:var(--space-3);
        align-items:center;font-size:12.5px}
      .op-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        color:var(--color-neutral-300)}
      .op-barra{background:var(--color-neutral-900);border-radius:2px;height:6px;overflow:hidden}
      .op-barra i{display:block;height:100%;background:var(--color-accent-500);border-radius:2px}
      .op-n,.op-pct{text-align:right;font-family:ui-monospace,monospace;font-size:11px;
        font-variant-numeric:tabular-nums}
      .op-pct{color:var(--color-neutral-500)}
      .detalle-tit{margin:var(--space-8) 0 var(--space-4);font-family:var(--font-heading);
        font-weight:var(--font-heading-weight);font-size:20px;letter-spacing:-.015em}
      table.detalle th{font-size:10px}
      table.detalle td{font-size:12.5px}

      /* Botón: contorno de acento. El sistema no rellena acciones. */
      .mas-wrap{margin:var(--space-6) 0 0}
      .mas{display:inline-flex;align-items:center;gap:6px;cursor:pointer;
        font-family:var(--font-heading);font-weight:var(--font-heading-weight);font-size:14px;
        line-height:1.2;color:var(--color-accent);background:transparent;
        border:1px solid var(--color-accent);padding:var(--space-2) calc(var(--space-3)*1.2);
        border-radius:var(--radius-md)}
      .mas:hover{background:color-mix(in srgb,var(--color-accent) 12%,transparent)}
      .mas:active{background:color-mix(in srgb,var(--color-accent) 22%,transparent)}
      .mas[disabled]{opacity:.45;cursor:not-allowed}
      .fin{margin:var(--space-6) 0 0;font-size:12px;color:var(--color-neutral-600)}
      .alerta{display:inline-flex;align-items:center;margin-left:var(--space-2);padding:3px 10px;
        border-radius:calc(var(--radius-md)*.75);background:var(--p-critico-fill);
        color:var(--p-critico-texto);font-size:11px;letter-spacing:.02em;vertical-align:middle}

      /* ── Vista de dirección ──
         Otra lectura: no "a quién le escribo" sino "el programa funciona". Las cifras crecen por
         tamaño y espacio, que es como Nocturne construye jerarquía: nunca por más negrita. */
      .dir h1{font-size:32px;margin:0 0 var(--space-2)}
      .dir h2{margin:0 0 var(--space-4);font-size:11px;text-transform:uppercase;
        letter-spacing:.1em;color:var(--color-accent);font-weight:var(--font-heading-weight)}
      .nota-dir{margin:calc(var(--space-3)*-1) 0 var(--space-6);font-size:12px;
        color:var(--color-neutral-500);line-height:1.5}
      .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));
        gap:var(--space-3);margin:0 0 var(--space-8)}
      .kpi{padding:var(--space-6);border-radius:var(--radius-md);background:var(--color-bg);
        display:flex;flex-direction:column;gap:var(--space-1);
        box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--color-accent) 45%,transparent)}
      .kpi-ok{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--p-bien) 45%,transparent)}
      .kpi b{font-family:var(--font-heading);font-weight:var(--font-heading-weight);font-size:34px;
        line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
      .kpi-ok b{color:var(--p-bien-texto)}
      .kpi span{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;
        color:var(--color-neutral-500);line-height:1.4}
      .alertas{display:grid;gap:var(--space-2);margin:0 0 var(--space-8)}
      .al{display:flex;align-items:baseline;gap:var(--space-4);
        padding:var(--space-4) var(--space-6);border-radius:var(--radius-md);font-size:13px;
        line-height:1.5}
      .al b{font-family:var(--font-heading);font-weight:var(--font-heading-weight);font-size:20px;
        font-variant-numeric:tabular-nums;flex:none;line-height:1.2}
      .al-roja{background:var(--p-critico-fill);color:var(--p-critico-texto);
        box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--p-critico) 55%,transparent)}
      .al-ambar{background:var(--p-aviso-fill);color:var(--p-aviso-texto);
        box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--p-aviso) 55%,transparent)}
      .dos{display:grid;gap:var(--space-3);margin:0 0 var(--space-3)}
      @media(min-width:62rem){.dos{grid-template-columns:1fr 1fr;align-items:start}}
      .caja-dir{border-radius:var(--radius-md);padding:var(--space-6);background:var(--color-bg);
        box-shadow:var(--shadow-sm)}
      .caja-dir svg{width:100%;height:auto;display:block}
      .g-val{font-size:8px;fill:var(--color-neutral-400);font-variant-numeric:tabular-nums}
      .g-eje{font-size:7.5px;fill:var(--color-neutral-600);font-variant-numeric:tabular-nums}
      .pel{margin:0 0 var(--space-4)}
      .pel:last-child{margin-bottom:0}
      .pel-cab{display:flex;justify-content:space-between;align-items:baseline;
        gap:var(--space-3);font-size:13px;color:var(--color-neutral-300)}
      .pel-cab b{font-family:var(--font-heading);font-weight:var(--font-heading-weight);
        font-size:17px;color:var(--color-text);font-variant-numeric:tabular-nums}
      .pel-barra{height:6px;background:var(--color-neutral-900);border-radius:2px;
        overflow:hidden;margin:var(--space-1) 0}
      .pel-barra i{display:block;height:100%;border-radius:2px}
      .pel-pct{font-size:11px;color:var(--color-neutral-600);font-variant-numeric:tabular-nums}
      .costos{display:flex;gap:var(--space-8);flex-wrap:wrap;margin:0 0 var(--space-4)}
      .costos b{display:block;font-family:var(--font-heading);
        font-weight:var(--font-heading-weight);font-size:26px;line-height:1.1;
        letter-spacing:-.02em;font-variant-numeric:tabular-nums}
      .costos span{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;
        color:var(--color-neutral-500)}
    `;

/**
 * @param fragmento true = solo el contenido, sin <!doctype> ni <style>. Lo usa la página de acceso,
 *   que ya trae los estilos y reemplaza su contenido en cada refresco. El render es UNO: mantener
 *   dos versiones de esta tabla garantizaría que se separen.
 */
export function panelCohorteHtml(r: ResumenPanel, fragmento = false): string {
  const activas7 = r.filas.filter((f) => (hace(f.ultimoEn).dias ?? 999) <= 7).length;
  const conAvance = r.filas.filter((f) => f.completadas > 0).length;

  const alertadas = r.filas.filter((f) => f.alertasBienestar > 0).length;

  const filas = r.filas
    .map((f) => {
      const e = estadoDe(f);
      const h = hace(f.ultimoEn);
      const apagada = (h.dias ?? 999) > 14 ? ' class="tenue"' : '';
      return (
        `<tr${apagada}>` +
        `<td><strong>${escapar(f.nombre)}</strong>` +
        (f.alertasBienestar > 0
          ? ` <span class="alerta" title="Se activó la contención por señal de riesgo vital ${f.alertasBienestar} ${f.alertasBienestar === 1 ? 'vez' : 'veces'}">contención ×${f.alertasBienestar}</span>`
          : '') + `</td>` +
        `<td class="mono">${escapar(f.waId)}</td>` +
        `<td class="${e.clase}">${escapar(e.texto)}</td>` +
        `<td class="num">${f.turnos}</td>` +
        `<td class="num">${f.eventos}</td>` +
        `<td class="mono">${escapar(fecha(f.registradoEn))}</td>` +
        `<td class="mono">${escapar(fecha(f.ultimoEn))}</td>` +
        `<td>${escapar(h.texto)}</td>` +
        `</tr>`
      );
    })
    .join('');

  const contenido =
    `<h1>Cohorte ATLAS</h1>` +
    `<p class="sub">Generado el ${escapar(fecha(r.generadoEn))} (hora de Chile)</p>` +
    `<div class="tarjetas">` +
    `<div class="t"><b>${r.filas.length}</b><span>registradas</span></div>` +
    `<div class="t"><b>${activas7}</b><span>activas (7 días)</span></div>` +
    `<div class="t"><b>${conAvance}</b><span>con avance</span></div>` +
    `<div class="t"><b>${r.filas.filter((f) => f.folio).length}</b><span>certificadas</span></div>` +
    (alertadas
      ? `<div class="t t-alerta"><b>${alertadas}</b><span>con contención</span></div>`
      : '') +
    `</div>` +
    `<div class="scroll"><table>` +
    `<thead><tr><th>Persona</th><th>Teléfono</th><th>Estado</th><th class="num">Turnos</th>` +
    `<th class="num">Eventos</th><th>Registro</th><th>Último mensaje</th><th></th></tr></thead>` +
    `<tbody>${filas || '<tr><td colspan="8">Sin personas registradas.</td></tr>'}</tbody>` +
    `</table></div>` +
    `<p class="aviso"><strong>Turnos</strong> son los intercambios con el tutor. <strong>Eventos</strong> ` +
    `incluye además el registro, el cuestionario, la práctica y la certificación — un mensaje puede ` +
    `generar varios. Ambos se cuentan sobre la auditoría, que conserva ${r.retencionDias} días: un ` +
    `número bajo en alguien antiguo puede ser historial ya purgado, no inactividad.</p>` +
    (alertadas
      ? `<p class="aviso aviso-roja">` +
        `<strong>${alertadas} ${alertadas === 1 ? 'persona' : 'personas'}</strong> escribió algo que activó la ` +
        `contención por señal de riesgo vital. ATLAS detuvo el curso y entregó las líneas de ayuda ` +
        `(*4141*, 600 360 7777, 131); lo que escribió NO se guarda en ninguna parte, solo el hecho.` +
        `<br><strong>El programa no tiene seguimiento humano para estos casos</strong> (ver ` +
        `docs/BIENESTAR.md): la respuesta automática fue la intervención completa. Esta marca es ` +
        `informativa y nadie es notificado.</p>`
      : '') +
    `<p class="pie">Contiene nombres y teléfonos de personas reales. No compartir por canales abiertos ` +
    `ni subir a servicios de terceros. El correo y el RUT no aparecen acá: van cifrados y este panel ` +
    `no los consulta.</p>`;

  if (fragmento) return contenido;
  return (
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>Cohorte ATLAS — ${r.filas.length} personas</title>` +
    `<style>${PANEL_CSS}</style>` +
    `<body><div class="caja">${contenido}</div></body>`
  );
}

/**
 * Página de acceso al panel: pública, pero SIN un solo dato de nadie.
 *
 * El endpoint de datos exige el token en un HEADER, y un navegador no puede enviar headers
 * escribiendo una URL. La salida obvia —aceptar el token por query string— es justo lo que este
 * proyecto ya descartó: queda en los logs de los proxies, en el historial del navegador y en el
 * Referer de cualquier enlace saliente.
 *
 * Así que el token se escribe acá, se guarda en sessionStorage —muere al cerrar la pestaña— y viaja
 * por `fetch` en el header. Esta página no consulta la base: si alguien la abre sin el token, no ve
 * nada más que el formulario.
 */
export function panelAccesoHtml(refrescoSeg = 60): string {
  return (
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>Panel ATLAS</title>` +
    `<style>${PANEL_CSS}
      .acceso{max-width:24rem;margin:4rem auto;background:var(--color-surface);
        border-radius:var(--radius-lg);padding:var(--space-8);box-shadow:var(--shadow-md)}
      .acceso input{width:100%;min-height:36px;padding:6px 10px;font-family:ui-monospace,monospace;
        font-size:14px;margin:var(--space-4) 0;color:var(--color-text);
        caret-color:var(--color-accent);background:var(--color-bg);
        border:1px solid var(--color-divider);border-radius:var(--radius-md)}
      .acceso input:hover{border-color:color-mix(in srgb,var(--color-text) 45%,transparent)}
      .acceso input:focus-visible{border-color:var(--color-accent);outline-offset:0}
      .acceso button,.barra button{cursor:pointer;font-family:var(--font-heading);
        font-weight:var(--font-heading-weight);font-size:14px;line-height:1.2;
        padding:var(--space-2) calc(var(--space-3)*1.2);border-radius:var(--radius-md);
        background:transparent;color:var(--color-accent);border:1px solid var(--color-accent)}
      .acceso button:hover,.barra button:hover{
        background:color-mix(in srgb,var(--color-accent) 12%,transparent)}
      .barra{max-width:78rem;margin:0 auto var(--space-4);display:flex;align-items:center;
        gap:var(--space-3);flex-wrap:wrap;font-size:12px;color:var(--color-neutral-500)}
      .barra button{color:var(--color-neutral-300);border-color:var(--color-divider)}
      .barra button:hover{background:color-mix(in srgb,var(--color-text) 7%,transparent)}
      .err{color:var(--p-critico);font-size:13px;margin:var(--space-2) 0 0}
      /* La pestaña activa se marca con el acento en el texto y una línea bajo el rótulo. Un
         relleno de acento sería justo lo que el sistema no hace. */
      .barra .tab{border-color:transparent;color:var(--color-neutral-500)}
      .barra .tab.activa{color:var(--color-accent);
        box-shadow:inset 0 -2px 0 0 var(--color-accent);border-radius:var(--radius-sm)}
      #estado{margin-left:auto;font-variant-numeric:tabular-nums}
    </style>` +
    `<body>` +
    `<div id="acceso" class="acceso" hidden>` +
    `<h1>Panel ATLAS</h1>` +
    `<p class="sub">Seguimiento del programa. Requiere el token del panel.</p>` +
    `<form id="f"><input id="tk" type="password" autocomplete="off" placeholder="x-dashboard-token" autofocus>` +
    `<button type="submit">Entrar</button></form>` +
    `<p id="err" class="err" hidden></p>` +
    `<p class="pie">El token se guarda solo en esta pestaña y se borra al cerrarla.</p>` +
    `</div>` +
    `<div id="vista" hidden>` +
    `<div class="barra">` +
    `<button class="tab activa" type="button" data-ruta="/panel/direccion">Programa</button>` +
    `<button class="tab" type="button" data-ruta="/panel/cohorte">Cohorte</button>` +
    `<button class="tab" type="button" data-ruta="/panel/caracterizacion">Caracterización</button>` +
    `<span id="estado">cargando…</span>` +
    `<button id="recargar" type="button">Actualizar</button>` +
    `<button id="salir" type="button">Salir</button></div>` +
    `<div class="caja" id="contenido"></div>` +
    `</div>` +
    `<script>
(function(){
  var CLAVE='atlas.panel.token', REFRESCO=${refrescoSeg}*1000, RUTA='/panel/direccion';
  var acceso=document.getElementById('acceso'), vista=document.getElementById('vista');
  var err=document.getElementById('err'), estado=document.getElementById('estado');
  var timer=null;
  function pedirToken(mensaje){
    if(timer){clearInterval(timer);timer=null;}
    try{sessionStorage.removeItem(CLAVE);}catch(e){}
    vista.hidden=true; acceso.hidden=false;
    if(mensaje){err.textContent=mensaje; err.hidden=false;} else {err.hidden=true;}
    var i=document.getElementById('tk'); i.value=''; i.focus();
  }
  function guardado(){ try{return sessionStorage.getItem(CLAVE);}catch(e){return null;} }
  function cargar(){
    var tk=guardado();
    if(!tk){ pedirToken(); return; }
    estado.textContent='actualizando…';
    fetch(RUTA+'?vista=fragmento',{headers:{'x-dashboard-token':tk},cache:'no-store'})
      .then(function(r){
        if(r.status===401) throw new Error('token');
        if(!r.ok) throw new Error('http '+r.status);
        return r.text();
      })
      .then(function(html){
        document.getElementById('contenido').innerHTML=html;
        acceso.hidden=true; vista.hidden=false;
        var h=new Date();
        estado.textContent='actualizado '+String(h.getHours()).padStart(2,'0')+':'+String(h.getMinutes()).padStart(2,'0')+':'+String(h.getSeconds()).padStart(2,'0');
        if(!timer) timer=setInterval(cargar,REFRESCO);
      })
      .catch(function(e){
        if(e.message==='token'){ pedirToken('Ese token no es válido.'); return; }
        estado.textContent='sin conexión ('+e.message+') — reintentando';
      });
  }
  document.getElementById('f').addEventListener('submit',function(ev){
    ev.preventDefault();
    var v=document.getElementById('tk').value.trim();
    if(!v) return;
    try{sessionStorage.setItem(CLAVE,v);}catch(e){ pedirToken('Este navegador no permite guardar el token.'); return; }
    cargar();
  });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){
    b.addEventListener('click',function(){
      Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(x){x.classList.remove('activa');});
      b.classList.add('activa');
      RUTA=b.getAttribute('data-ruta');
      if(timer){clearInterval(timer);timer=null;}
      cargar();
    });
  });
  // "Cargar más": pide SOLO las filas siguientes con el cursor y las agrega al final. No se
  // recalcula el agregado, que es la consulta cara.
  document.getElementById('contenido').addEventListener('click',function(ev){
    var b=ev.target.closest ? ev.target.closest('.mas') : null;
    if(!b) return;
    var tk=guardado(); if(!tk) return pedirToken();
    b.disabled=true; b.textContent='Cargando…';
    fetch('/panel/caracterizacion?cursor='+encodeURIComponent(b.getAttribute('data-cursor')),
          {headers:{'x-dashboard-token':tk},cache:'no-store'})
      .then(function(r){ if(r.status===401) throw new Error('token'); return r.text(); })
      .then(function(html){
        var m=html.match(/<!--CURSOR:([^>]*)-->/);
        var cursor=m?m[1]:'';
        var tbody=document.querySelector('table.detalle tbody');
        if(tbody) tbody.insertAdjacentHTML('beforeend', html.replace(/<!--CURSOR:[^>]*-->/,''));
        if(cursor){ b.setAttribute('data-cursor',cursor); b.disabled=false; b.textContent='Cargar 50 más'; }
        else { b.parentNode.innerHTML='<p class="fin">No hay más registros.</p>'; }
      })
      .catch(function(e){
        if(e.message==='token') return pedirToken('Ese token no es válido.');
        b.disabled=false; b.textContent='Reintentar';
      });
  });
  document.getElementById('recargar').addEventListener('click',cargar);
  document.getElementById('salir').addEventListener('click',function(){ pedirToken(); });
  cargar();
})();
    </script></body>`
  );
}

/** Barra de proporción para una alternativa del cuestionario. */
function barraOpcion(o: { texto: string; n: number; pct: number }): string {
  const ancho = Math.max(o.pct, o.n > 0 ? 1.5 : 0);
  return (
    `<div class="op">` +
    `<span class="op-txt">${escapar(o.texto)}</span>` +
    `<span class="op-barra"><i style="width:${ancho.toFixed(1)}%"></i></span>` +
    `<span class="op-n">${o.n.toLocaleString('es-CL')}</span>` +
    `<span class="op-pct">${o.pct.toFixed(0)} %</span>` +
    `</div>`
  );
}

/**
 * Vista de caracterización: primero el agregado —que es para lo que existe el cuestionario— y
 * debajo el detalle por persona, paginado.
 */
export function caracterizacionHtml(
  agregado: PreguntaAgregada[], pagina: PaginaCaracterizacion, cacheado: boolean,
): string {
  const respondieron = agregado[0]?.respondieron ?? 0;

  const preguntas = agregado
    .map((p) =>
      `<section class="preg">` +
      `<h3><span class="preg-n">${p.orden}</span>${escapar(p.enunciado)}</h3>` +
      `<div class="ops">${p.opciones.map(barraOpcion).join('')}</div>` +
      `</section>`,
    )
    .join('');

  return (
    `<h1>Caracterización</h1>` +
    `<p class="sub">${respondieron.toLocaleString('es-CL')} personas completaron las ` +
    `${agregado.length} preguntas${cacheado ? ' · agregado desde caché, se recalcula cada 5 min' : ''}</p>` +
    `<div class="preguntas">${preguntas || '<p>Sin respuestas todavía.</p>'}</div>` +
    `<h2 class="detalle-tit">Respuesta por persona</h2>` +
    `<div id="tabla-detalle">${filasDetalleHtml(pagina, true)}</div>`
  );
}

/**
 * Filas del detalle. Se renderiza aparte porque el botón "cargar más" pide solo esto y lo agrega
 * al final: traer de nuevo el agregado en cada página sería pagar la consulta cara por nada.
 */
export function filasDetalleHtml(pagina: PaginaCaracterizacion, conCabecera: boolean): string {
  const filas = pagina.filas
    .map((f) =>
      `<tr><td><strong>${escapar(f.nombre)}</strong></td>` +
      `<td class="mono">${escapar(f.waId)}</td>` +
      `<td class="mono">${escapar(fecha(f.completadaEn))}</td>` +
      pagina.columnas.map((c) => `<td>${escapar(f.respuestas[c.codigo] ?? '—')}</td>`).join('') +
      `</tr>`,
    )
    .join('');

  const boton = pagina.siguiente
    ? `<div class="mas-wrap"><button class="mas" type="button" data-cursor="${escapar(pagina.siguiente)}">Cargar 50 más</button></div>`
    : `<p class="fin">No hay más registros.</p>`;

  if (!conCabecera) return filas + `<!--CURSOR:${pagina.siguiente ?? ''}-->`;

  return (
    `<div class="scroll"><table class="detalle"><thead><tr>` +
    `<th>Persona</th><th>Teléfono</th><th>Completó</th>` +
    pagina.columnas.map((c) => `<th title="${escapar(c.enunciado)}">${escapar(c.codigo)}</th>`).join('') +
    `</tr></thead><tbody>${filas || '<tr><td colspan="14">Nadie ha completado el cuestionario.</td></tr>'}</tbody>` +
    `</table></div>${boton}`
  );
}

/** Barras de una serie, con la altura proporcional al máximo y el valor sobre cada una. */
function barras(datos: { etiqueta: string; n: number }[], ancho: number, alto: number, color: string): string {
  if (!datos.length) return '';
  const max = Math.max(...datos.map((d) => d.n), 1);
  const gap = 6;
  const w = Math.max(6, (ancho - gap * (datos.length - 1)) / datos.length);
  const base = alto - 22;
  return datos
    .map((d, i) => {
      const h = d.n === 0 ? 1.5 : Math.max(3, (d.n / max) * (base - 16));
      const x = i * (w + gap);
      const y = base - h;
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" style="fill:${color}"></rect>` +
        (d.n > 0 ? `<text class="g-val" x="${(x + w / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${d.n}</text>` : '') +
        `<text class="g-eje" x="${(x + w / 2).toFixed(1)}" y="${(base + 13).toFixed(1)}" text-anchor="middle">${escapar(d.etiqueta)}</text>`
      );
    })
    .join('');
}

/** Un peldaño del embudo, con su proporción respecto al primero. */
function peldano(etiqueta: string, n: number, tope: number, color: string): string {
  const pct = tope ? (n / tope) * 100 : 0;
  return (
    `<div class="pel">` +
    `<div class="pel-cab"><span>${escapar(etiqueta)}</span><b>${n.toLocaleString('es-CL')}</b></div>` +
    `<div class="pel-barra"><i style="width:${Math.max(pct, n > 0 ? 2 : 0).toFixed(1)}%;background:${color}"></i></div>` +
    `<div class="pel-pct">${pct.toFixed(0)} % de las registradas</div>` +
    `</div>`
  );
}

/**
 * Vista de dirección: si el programa funciona, en una pantalla.
 *
 * Sin un solo dato personal — son todos agregados — así que es la única del panel que se puede
 * proyectar en una reunión sin exponer a nadie.
 */
export function direccionHtml(r: ResumenDireccion, clpPorTurno: number): string {
  // Sobre TODAS las inscripciones, no solo las vivas: dejar fuera a los cupos vencidos y
  // abandonados subiría la tasa justamente al empeorar el programa.
  const finalizacion = r.inscritas > 0 ? (r.completaron / r.inscritas) * 100 : 0;
  const costoModelo = r.turnos * clpPorTurno;
  const porCertificado = r.certificadas > 0 ? costoModelo / r.certificadas : 0;
  const clp = (x: number) => 'CLP ' + Math.round(x).toLocaleString('es-CL');

  const dias = r.registrosPorDia.map((d) => ({ etiqueta: d.dia.slice(8), n: d.n }));
  const avance = r.avance.map((a) => ({ etiqueta: String(a.completadas), n: a.personas }));

  const alertas = [
    r.alertasBienestar > 0
      ? `<div class="al al-roja"><b>${r.alertasBienestar}</b><span>contenciones por señal de riesgo vital — sin seguimiento humano definido</span></div>`
      : '',
    r.cuposPorVencer > 0
      ? `<div class="al al-ambar"><b>${r.cuposPorVencer}</b><span>cupos vencen en los próximos 7 días</span></div>`
      : '',
  ].filter(Boolean).join('');

  return (
    `<div class="dir">` +
    `<h1>Programa de Alfabetización en IA</h1>` +
    `<p class="sub">Actualizado ${escapar(fecha(r.generadoEn))} · hora de Chile</p>` +

    `<div class="kpis">` +
    `<div class="kpi"><b>${r.registradas.toLocaleString('es-CL')}</b><span>personas registradas</span></div>` +
    `<div class="kpi"><b>${r.cursando.toLocaleString('es-CL')}</b><span>cursando ahora</span></div>` +
    `<div class="kpi kpi-ok"><b>${r.certificadas.toLocaleString('es-CL')}</b><span>certificados emitidos</span></div>` +
    `<div class="kpi"><b>${finalizacion.toFixed(0)} %</b><span>finalización de quienes se inscriben</span></div>` +
    `</div>` +

    (alertas ? `<div class="alertas">${alertas}</div>` : '') +

    `<div class="dos">` +
    `<section class="caja-dir">` +
    `<h2>Del registro al certificado</h2>` +
    peldano('Se registraron', r.registradas, r.registradas, 'var(--color-accent-500)') +
    peldano('Completaron el cuestionario', r.conCuestionario, r.registradas, 'var(--color-accent-500)') +
    peldano('Se inscribieron al curso', r.inscritas, r.registradas, 'var(--color-accent-500)') +
    peldano('Terminaron el curso', r.completaron, r.registradas, 'var(--p-bien)') +
    peldano('Recibieron certificado', r.certificadas, r.registradas, 'var(--p-bien)') +
    (r.certificadasPrevias > 0
      ? `<p class="nota-dir" style="margin:.7rem 0 0">Hay además ${r.certificadasPrevias} certificado${r.certificadasPrevias === 1 ? '' : 's'} de versiones anteriores del curso, fuera de este embudo.</p>`
      : '') +
    `</section>` +

    `<section class="caja-dir">` +
    `<h2>Dónde está cada estudiante</h2>` +
    `<p class="nota-dir">Personas por microcápsulas completadas, de 0 a ${r.totalMicrocapsulas}.</p>` +
    `<svg viewBox="0 0 340 150" role="img" aria-label="Distribución de estudiantes por microcápsulas completadas">` +
    `<g transform="translate(4,8)">${barras(avance, 332, 142, 'var(--color-accent-500)')}</g></svg>` +
    `</section>` +
    `</div>` +

    `<div class="dos">` +
    `<section class="caja-dir">` +
    `<h2>Altas por día</h2>` +
    `<p class="nota-dir">Últimos 14 días.</p>` +
    `<svg viewBox="0 0 340 150" role="img" aria-label="Personas registradas por día en los últimos 14 días">` +
    `<g transform="translate(4,8)">${barras(dias, 332, 142, 'var(--p-bien)')}</g></svg>` +
    `</section>` +

    `<section class="caja-dir">` +
    `<h2>Costo del modelo a la fecha</h2>` +
    `<div class="costos">` +
    `<div><b>${clp(costoModelo)}</b><span>acumulado · ${r.turnos.toLocaleString('es-CL')} turnos</span></div>` +
    (r.certificadas > 0
      ? `<div><b>${clp(porCertificado)}</b><span>por certificado emitido</span></div>`
      : `<div><b>—</b><span>por certificado (aún sin emitir)</span></div>`) +
    `</div>` +
    `<p class="nota-dir">Solo el modelo de lenguaje, que es el costo variable por estudiante. Los mensajes de WhatsApp dentro de la conversación no tienen tarifa; la infraestructura corre del orden de CLP 8.000 al mes.</p>` +
    `</section>` +
    `</div>` +
    `</div>`
  );
}
