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

/** Estilos del panel. Compartidos con la página de acceso, para no mantenerlos dos veces. */
export const PANEL_CSS = `
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
      .alerta{display:inline-block;margin-left:.35rem;padding:.05rem .35rem;border-radius:4px;background:#fdecea;color:#b3261e;font-size:.7rem;font-weight:600;vertical-align:middle}
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
      const gris = (h.dias ?? 999) > 14 ? 'color:#8a8a8a' : '';
      return (
        `<tr style="${gris}">` +
        `<td><strong>${escapar(f.nombre)}</strong>` +
        (f.alertasBienestar > 0
          ? ` <span class="alerta" title="Se activó la contención por señal de riesgo vital ${f.alertasBienestar} ${f.alertasBienestar === 1 ? 'vez' : 'veces'}">contención ×${f.alertasBienestar}</span>`
          : '') + `</td>` +
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

  const contenido =
    `<h1>Cohorte ATLAS</h1>` +
    `<p class="sub">Generado el ${escapar(fecha(r.generadoEn))} (hora de Chile)</p>` +
    `<div class="tarjetas">` +
    `<div class="t"><b>${r.filas.length}</b><span>registradas</span></div>` +
    `<div class="t"><b>${activas7}</b><span>activas (7 días)</span></div>` +
    `<div class="t"><b>${conAvance}</b><span>con avance</span></div>` +
    `<div class="t"><b>${r.filas.filter((f) => f.folio).length}</b><span>certificadas</span></div>` +
    (alertadas
      ? `<div class="t" style="background:#fdecea"><b style="color:#b3261e">${alertadas}</b><span>con contención</span></div>`
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
      ? `<p class="aviso" style="background:#fdecea;border-left-color:#b3261e;color:#7a1a12">` +
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
    `<title>Cohorte ATLAS</title>` +
    `<style>${PANEL_CSS}
      .acceso{max-width:24rem;margin:4rem auto;background:#fff;border-radius:12px;padding:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.12)}
      .acceso input{width:100%;box-sizing:border-box;padding:.6rem;font-family:ui-monospace,monospace;font-size:.9rem;border:1px solid #ccd;border-radius:6px;margin:.6rem 0}
      .acceso button,.barra button{padding:.5rem .9rem;border:0;border-radius:6px;background:#273473;color:#fff;font-size:.85rem;cursor:pointer}
      .barra{max-width:78rem;margin:0 auto .8rem;display:flex;align-items:center;gap:.75rem;font-size:.8rem;color:#667}
      .barra button{background:#eceef5;color:#273473}
      .err{color:#b3261e;font-size:.85rem;margin:.4rem 0 0}
    </style>` +
    `<body>` +
    `<div id="acceso" class="acceso" hidden>` +
    `<h1>Cohorte ATLAS</h1>` +
    `<p class="sub">Panel de seguimiento. Requiere el token del panel.</p>` +
    `<form id="f"><input id="tk" type="password" autocomplete="off" placeholder="x-dashboard-token" autofocus>` +
    `<button type="submit">Entrar</button></form>` +
    `<p id="err" class="err" hidden></p>` +
    `<p class="pie">El token se guarda solo en esta pestaña y se borra al cerrarla.</p>` +
    `</div>` +
    `<div id="vista" hidden>` +
    `<div class="barra"><span id="estado">cargando…</span>` +
    `<button id="recargar" type="button">Actualizar</button>` +
    `<button id="salir" type="button">Salir</button></div>` +
    `<div class="caja" id="contenido"></div>` +
    `</div>` +
    `<script>
(function(){
  var CLAVE='atlas.panel.token', REFRESCO=${refrescoSeg}*1000;
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
    fetch('/panel/cohorte?vista=fragmento',{headers:{'x-dashboard-token':tk},cache:'no-store'})
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
  document.getElementById('recargar').addEventListener('click',cargar);
  document.getElementById('salir').addEventListener('click',function(){ pedirToken(); });
  cargar();
})();
    </script></body>`
  );
}
