import { config } from '../config';
import { MetaCloudProvider } from './metaCloud';
import type { MessagingProvider } from './types';

export type { MessagingProvider, SendResult, InboundEvent, InboundMessage, InboundStatus } from './types';
export { normalizarEntrante, normalizarE164 } from './metaCloud';

// Factory del proveedor de mensajería. Hoy: Meta Cloud API. La implementación BSP (Chattigo/Atom)
// se agrega aquí cuando se decida la migración — el resto del sistema no cambia.
let instancia: MessagingProvider | null = null;

export function messagingProvider(): MessagingProvider {
  if (!instancia) {
    // WA_PROVIDER='' también devuelve el provider de Meta: sin credenciales, todo envío se omite
    // con {skipped:true} (comportamiento seguro para dev/tests, heredado del sistema anterior).
    void config;
    instancia = new MetaCloudProvider();
  }
  return instancia;
}
