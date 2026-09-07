import type { ResumenPanel, FilaPanel } from '../store/panel';

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

function estadoDe(f: FilaPanel): { texto: string; color: string } {
  if (f.folio) return { texto: `certificada · ${f.folio}`, color: '#0f7b3f' };
  if (!f.curso) return { texto: 'registrada, sin inscripción', color: '#8a6d00' };
  if (f.cursoArchivado) return { texto: `versión anterior · ${f.completadas}/${f.totalLecciones}`, color: '#8a6d00' };
  if (!f.caracterizacionCompleta) return { texto: 'cuestionario pendiente', color: '#8a6d00' };
  if (f.inscripcion === 'completada') return { texto: 'curso completo', color: '#0f7b3f' };
  return { texto: `${f.completadas}/${f.totalLecciones} microcápsulas`, color: '#273473' };
}

export function panelCohorteHtml(r: ResumenPanel): string {
  const activas7 = r.filas.filter((f) => (hace(f.ultimoEn).dias ?? 999) <= 7).length;
  const conAvance = r.filas.filter((f) => f.completadas > 0).length;

  const filas = r.filas
    .map((f) => {
      const e = estadoDe(f);
      const h = hace(f.ultimoEn);
      const gris = (h.dias ?? 999) > 14 ? 'color:#8a8a8a' : '';
      return (
        `<tr style="${gris}">` +
        `<td><strong>${escapar(f.nombre)}</strong></td>` +
        `<td class="mono">${escapar(f.waId)}</td>` +
        `<td style="color:${e.color}">${escapar(e.texto)}</td>` +
        `<td class="num">${f.turnos}</td>` +
        `<td class="num">${f.eventos}</td>` +
        `<td class="mono">${escapar(fecha(f.registradoEn))}</td>` +
        `<td class="mono">${escapar(fecha(f.ultimoEn))}</td>` +
        `<td>${escapar(h.texto)}</td>` +
        `</tr>`
      );
    })
    .join('');

  return (
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>Cohorte ATLAS — ${r.filas.length} personas</title>` +
    `<style>
      body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:1.5rem;background:#f6f7f9;color:#1a1a1a}
      .caja{max-width:78rem;margin:0 auto;background:#fff;border-radius:12px;padding:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.12)}
      h1{margin:0 0 .2rem;font-size:1.3rem}
      .sub{margin:0 0 1.2rem;color:#667;font-size:.85rem}
      .tarjetas{display:flex;gap:.75rem;flex-wrap:wrap;margin:0 0 1.2rem}
      .t{background:#f6f7f9;border-radius:8px;padding:.6rem .9rem;min-width:7rem}
      .t b{display:block;font-size:1.5rem;line-height:1.1;color:#273473}
      .t span{font-size:.75rem;color:#667}
      .scroll{overflow-x:auto}
      table{border-collapse:collapse;width:100%;font-size:.86rem}
      th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #ececf0;white-space:nowrap}
      th{font-size:.72rem;text-transform:uppercase;letter-spacing:.03em;color:#667;border-bottom:2px solid #ddd}
      tr:hover td{background:#fafbfc}
      .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem}
      .num{text-align:right;font-variant-numeric:tabular-nums}
      .aviso{margin:1.2rem 0 0;padding:.7rem .9rem;background:#fff8e6;border-left:3px solid #d4a017;border-radius:4px;font-size:.8rem;color:#5a4a00}
      .pie{margin:1rem 0 0;font-size:.75rem;color:#8a8a8a}
    </style>` +
    `<body><div class="caja">` +
    `<h1>Cohorte ATLAS</h1>` +
    `<p class="sub">Generado el ${escapar(fecha(r.generadoEn))} (hora de Chile)</p>` +
    `<div class="tarjetas">` +
    `<div class="t"><b>${r.filas.length}</b><span>registradas</span></div>` +
    `<div class="t"><b>${activas7}</b><span>activas (7 días)</span></div>` +
    `<div class="t"><b>${conAvance}</b><span>con avance</span></div>` +
    `<div class="t"><b>${r.filas.filter((f) => f.folio).length}</b><span>certificadas</span></div>` +
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
    `<p class="pie">Contiene nombres y teléfonos de personas reales. No compartir por canales abiertos ` +
    `ni subir a servicios de terceros. El correo y el RUT no aparecen acá: van cifrados y este panel ` +
    `no los consulta.</p>` +
    `</div></body>`
  );
}
