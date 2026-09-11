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
      .preguntas{display:grid;gap:1.1rem;margin:1rem 0 0}
      @media(min-width:60rem){.preguntas{grid-template-columns:1fr 1fr}}
      .preg{border:1px solid #ececf0;border-radius:6px;padding:.85rem 1rem}
      .preg h3{margin:0 0 .6rem;font-size:.85rem;font-weight:600;line-height:1.35;display:flex;gap:.5rem;align-items:baseline}
      .preg-n{display:inline-flex;align-items:center;justify-content:center;min-width:1.25rem;height:1.25rem;border-radius:3px;background:#eceef5;color:#273473;font-size:.68rem;font-weight:700;flex:none}
      .ops{display:grid;gap:.28rem}
      .op{display:grid;grid-template-columns:minmax(6rem,1fr) 5rem 3rem 2.4rem;gap:.5rem;align-items:center;font-size:.78rem}
      .op-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .op-barra{background:#eceef5;border-radius:2px;height:.5rem;overflow:hidden}
      .op-barra i{display:block;height:100%;background:#273473;border-radius:2px}
      .op-n,.op-pct{text-align:right;font-family:ui-monospace,monospace;font-size:.72rem;font-variant-numeric:tabular-nums}
      .op-pct{color:#667}
      .detalle-tit{margin:2rem 0 .6rem;font-size:1.05rem;font-weight:600}
      table.detalle th{font-size:.62rem}
      table.detalle td{font-size:.8rem}
      .mas-wrap{margin:.9rem 0 0}
      .mas{padding:.5rem 1rem;border:1px solid #273473;border-radius:6px;background:transparent;color:#273473;font-size:.85rem;font-weight:600;cursor:pointer;font-family:inherit}
      .mas:hover{background:#eceef5}
      .mas[disabled]{opacity:.5;cursor:default}
      .fin{margin:.9rem 0 0;font-size:.78rem;color:#8a8a8a}
      .alerta{display:inline-block;margin-left:.35rem;padding:.05rem .35rem;border-radius:4px;background:#fdecea;color:#b3261e;font-size:.7rem;font-weight:600;vertical-align:middle}

      /* Vista de dirección. Otra lectura: no "a quién le escribo" sino "el programa funciona".
         Las cifras van en serif del sistema —no hay recursos remotos, este archivo abre sin red—
         para que la escala se lea antes que el texto que la rodea. */
      .dir{--serif:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif}
      .dir h1{font-size:1.55rem;letter-spacing:-.015em;font-weight:600}
      .dir h2{margin:0 0 .7rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:#667;font-weight:700}
      .nota-dir{margin:-.35rem 0 .8rem;font-size:.75rem;color:#8a8a8a;line-height:1.4}
      .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:.6rem;margin:0 0 1rem}
      .kpi{padding:.85rem .95rem .8rem;background:#f6f7f9;border-radius:10px;border-top:3px solid #273473}
      .kpi.kpi-ok{border-top-color:#1d7a5f}
      .kpi b{display:block;font-family:var(--serif);font-size:2.1rem;line-height:1;color:#273473;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
      .kpi.kpi-ok b{color:#1d7a5f}
      .kpi span{display:block;margin-top:.3rem;font-size:.74rem;color:#667;line-height:1.3}
      .alertas{display:grid;gap:.45rem;margin:0 0 1.1rem}
      .al{display:flex;align-items:baseline;gap:.6rem;padding:.55rem .8rem;border-radius:8px;font-size:.8rem;line-height:1.35}
      .al b{font-family:var(--serif);font-size:1.15rem;font-variant-numeric:tabular-nums;flex:none}
      .al-roja{background:#fdecea;color:#8c1d18;border-left:3px solid #b3261e}
      .al-ambar{background:#fff8e6;color:#5a4a00;border-left:3px solid #d4a017}
      .dos{display:grid;gap:.9rem;margin:0 0 .9rem}
      @media(min-width:62rem){.dos{grid-template-columns:1fr 1fr;align-items:start}}
      .caja-dir{border:1px solid #e7e9ef;border-radius:10px;padding:1rem 1.1rem}
      .caja-dir svg{width:100%;height:auto;display:block}
      .g-val{font-size:8px;fill:#667;font-variant-numeric:tabular-nums}
      .g-eje{font-size:7.5px;fill:#9a9aa5;font-variant-numeric:tabular-nums}
      .pel{margin:0 0 .7rem}
      .pel:last-child{margin-bottom:0}
      .pel-cab{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem;font-size:.82rem}
      .pel-cab b{font-family:var(--serif);font-size:1.05rem;font-variant-numeric:tabular-nums}
      .pel-barra{height:.55rem;background:#eceef5;border-radius:3px;overflow:hidden;margin:.2rem 0 .15rem}
      .pel-barra i{display:block;height:100%;border-radius:3px}
      .pel-pct{font-size:.7rem;color:#9a9aa5;font-variant-numeric:tabular-nums}
      .costos{display:flex;gap:1.6rem;flex-wrap:wrap;margin:0 0 .7rem}
      .costos b{display:block;font-family:var(--serif);font-size:1.6rem;line-height:1.1;color:#273473;font-variant-numeric:tabular-nums}
      .costos span{font-size:.74rem;color:#667}
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
    `<title>Panel ATLAS</title>` +
    `<style>${PANEL_CSS}
      .acceso{max-width:24rem;margin:4rem auto;background:#fff;border-radius:12px;padding:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.12)}
      .acceso input{width:100%;box-sizing:border-box;padding:.6rem;font-family:ui-monospace,monospace;font-size:.9rem;border:1px solid #ccd;border-radius:6px;margin:.6rem 0}
      .acceso button,.barra button{padding:.5rem .9rem;border:0;border-radius:6px;background:#273473;color:#fff;font-size:.85rem;cursor:pointer}
      .barra{max-width:78rem;margin:0 auto .8rem;display:flex;align-items:center;gap:.75rem;font-size:.8rem;color:#667}
      .barra button{background:#eceef5;color:#273473}
      .err{color:#b3261e;font-size:.85rem;margin:.4rem 0 0}
      .barra .tab{background:transparent;color:#667;border:1px solid transparent;font-weight:600}
      .barra .tab.activa{background:#273473;color:#fff}
      #estado{margin-left:auto}
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
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}"></rect>` +
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
    peldano('Se registraron', r.registradas, r.registradas, 'var(--p-navy)') +
    peldano('Completaron el cuestionario', r.conCuestionario, r.registradas, 'var(--p-navy)') +
    peldano('Se inscribieron al curso', r.inscritas, r.registradas, 'var(--p-navy)') +
    peldano('Terminaron el curso', r.completaron, r.registradas, 'var(--p-verde)') +
    peldano('Recibieron certificado', r.certificadas, r.registradas, 'var(--p-verde)') +
    (r.certificadasPrevias > 0
      ? `<p class="nota-dir" style="margin:.7rem 0 0">Hay además ${r.certificadasPrevias} certificado${r.certificadasPrevias === 1 ? '' : 's'} de versiones anteriores del curso, fuera de este embudo.</p>`
      : '') +
    `</section>` +

    `<section class="caja-dir">` +
    `<h2>Dónde está cada estudiante</h2>` +
    `<p class="nota-dir">Personas por microcápsulas completadas, de 0 a ${r.totalMicrocapsulas}.</p>` +
    `<svg viewBox="0 0 340 150" role="img" aria-label="Distribución de estudiantes por microcápsulas completadas">` +
    `<g transform="translate(4,8)">${barras(avance, 332, 142, 'var(--p-navy)')}</g></svg>` +
    `</section>` +
    `</div>` +

    `<div class="dos">` +
    `<section class="caja-dir">` +
    `<h2>Altas por día</h2>` +
    `<p class="nota-dir">Últimos 14 días.</p>` +
    `<svg viewBox="0 0 340 150" role="img" aria-label="Personas registradas por día en los últimos 14 días">` +
    `<g transform="translate(4,8)">${barras(dias, 332, 142, 'var(--p-verde)')}</g></svg>` +
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
