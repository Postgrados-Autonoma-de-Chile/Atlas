import { config } from '../config';
import { MetaCloudProvider } from './metaCloud';
import { chattigoProvider } from './chattigo';
import type { MessagingProvider } from './types';

export type { MessagingProvider, SendResult, InboundEvent, InboundMessage, InboundStatus } from './types';
export { normalizarEntrante, normalizarE164 } from './metaCloud';
export { normalizarEntranteChattigo, verificarTokenChattigo } from './chattigo';

// Factory del proveedor de mensajería, elegido por WA_PROVIDER:
//   'meta'     → Cloud API directo
//   'chattigo' → BSP Chattigo
//   ''         → Meta sin credenciales: todo envío se omite con {skipped:true}, que es el
//                comportamiento seguro para desarrollo y pruebas.
//
// Cambiar de proveedor es esta línea más las credenciales: el motor, el tutor y los flujos
// deterministas hablan con MessagingProvider y no saben cuál está detrás.
let instancia: MessagingProvider | null = null;

export function messagingProvider(): MessagingProvider {
  if (!instancia) {
    instancia = config.waProvider === 'chattigo' ? chattigoProvider : new MetaCloudProvider();
  }
  return instancia;
}
