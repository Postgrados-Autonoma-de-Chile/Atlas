import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { log } from '../log';
import { safeEqual } from '../util/crypto';

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
 * Guard de la vista de dirección: acepta el token completo O el token de solo-dirección.
 *
 * POR QUÉ EXISTE: el panel tenía un token y abría las tres vistas, incluida la de cohorte con
 * nombres y teléfonos. Compartirlo con quien solo necesita ver si el programa funciona significaba
 * entregarle también la lista de personas. Ahora hay un segundo secreto que abre ÚNICAMENTE
 * /panel/direccion, que es la vista sin un solo dato personal.
 *
 * El token completo sigue sirviendo acá: quien opera no debería necesitar dos credenciales para
 * ver dos pestañas. La relación es de inclusión, no de exclusión.
 *
 * Si DASHBOARD_TOKEN_DIRECCION no está configurado, esto se comporta igual que el guard normal:
 * no abre ninguna puerta nueva por omisión.
 */
export const requireDireccionToken = (req: Request, res: Response, next: NextFunction) => {
  const soloDireccion = config.dashboardTokenDireccion;
  if (soloDireccion) {
    const given = req.header('x-dashboard-token') ?? '';
    if (safeEqual(given, soloDireccion)) return next();
  }
  return requireDashboardToken(req, res, next);
};
