import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { log } from '../log';
import { safeEqual } from '../util/crypto';
import { once } from '../store/kv';
import { audit } from '../obs/audit';

/**
 * Fábrica de middleware que exige un token en un HEADER, comparado en tiempo constante.
 * Cambio de Fase 1 (hallazgo de seguridad MEDIA de la auditoría): ya NO se aceptan tokens por
 * query string — quedaban expuestos en logs de proxies, historial y Referer.
 * Fail-closed en producción: si el token no está configurado, rechaza con 503 en vez de dejar pasar.
 * En desarrollo (NODE_ENV != 'production') deja pasar con aviso para no bloquear el trabajo local.
 */
function tokenGuard(getExpected: () => string, headerName: string, label: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = getExpected();
    if (!expected) {
      // F12: FAIL-CLOSED por defecto en TODOS los entornos; solo DEV_FAIL_OPEN=true (prohibido
      // en producción por config.ts) permite operar sin el secreto en local.
      if (!config.devFailOpen) {
        return res.status(503).json({ ok: false, error: `${label} no configurado` });
      }
      log.warn(`${label}: sin token configurado (DEV_FAIL_OPEN activo — solo desarrollo)`);
      return next();
    }
    const given = req.header(headerName) ?? '';
    if (!safeEqual(given, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  };
}

/** Protege /metrics (y los futuros paneles de tutoría). Header `x-dashboard-token`. */
export const requireDashboardToken = tokenGuard(() => config.dashboardToken, 'x-dashboard-token', 'DASHBOARD_TOKEN');

/**
 * Quién entró al panel de dirección.
 *
 * Se anota UNA VEZ POR HORA por persona, no en cada petición: el panel se refresca solo cada 60
 * segundos, así que registrar cada visita metería ~1.400 filas diarias por director y enterraría
 * la auditoría del programa bajo el ruido de tener el panel abierto en una pestaña.
 *
 * En el detalle va el nombre, nunca el token. Un secreto que llega a un log deja de ser un secreto,
 * y esta tabla se lee desde el propio panel.
 */
async function anotarAcceso(quien: string): Promise<void> {
  try {
    const hora = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    if (!(await once(`panel:acceso:${hora}:${quien}`, 3700))) return;
    await audit({ type: 'panel_acceso', detail: { quien } });
  } catch (e) {
    // Que falle el registro no puede dejar a nadie fuera del panel: se avisa y se sigue.
    log.warn('panel: no se pudo anotar el acceso', { err: String(e) });
  }
}

/**
 * Guard de la vista de dirección: acepta el token completo, los tokens CON NOMBRE, o el token de
 * dirección compartido.
 *
 * El orden importa para lo que queda registrado. Los nombrados se prueban primero porque son los
 * únicos que dicen quién entró; el compartido se anota como «compartido (sin identificar)», que es
 * información real —alguien entró con la llave que no distingue a nadie— y hace visible cuánto
 * queda por migrar. El token completo es el del operador y se anota como tal.
 *
 * Todas las comparaciones son en tiempo constante y NO se corta al primer acierto: con seis
 * tokens da igual en la práctica, pero salir antes convierte la posición en la lista en una
 * diferencia medible, y no hay ninguna razón para introducirla.
 */
export const requireDireccionToken = (req: Request, res: Response, next: NextFunction) => {
  const given = req.header('x-dashboard-token') ?? '';
  if (given) {
    let quien: string | null = null;
    for (const t of config.dashboardTokensDireccion ?? []) {
      if (safeEqual(given, t.token)) quien = t.nombre;
    }
    if (!quien && config.dashboardTokenDireccion && safeEqual(given, config.dashboardTokenDireccion)) {
      quien = 'compartido (sin identificar)';
    }
    if (!quien && config.dashboardToken && safeEqual(given, config.dashboardToken)) {
      quien = 'token de operación';
    }
    if (quien) {
      void anotarAcceso(quien);
      return next();
    }
  }
  // Sin coincidencia: cae al guard de siempre, que resuelve el 401 y el fail-closed sin token
  // configurado. No se duplica esa lógica acá.
  return requireDashboardToken(req, res, next);
};
