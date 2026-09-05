import { dbInsertAudit, type AuditEntry } from '../store/db';
import { inc } from './metrics';
import { redactPII } from './redact';
import { log } from '../log';

// Auditoría: registra en logs + Postgres (si está) + incrementa una métrica por tipo.
// El `detail` se redacta antes de loguear y persistir. Regla de ATLAS (hallazgo ALTA de la
// auditoría): el detail se MINIMIZA en origen — eventos y metadatos, nunca el texto completo
// de la conversación. TODO(F12): ampliar redact.ts a RUT y nombres.
export async function audit(entry: AuditEntry): Promise<void> {
  inc(`audit:${entry.type}`);
  const safe: AuditEntry = {
    ...entry,
    detail: entry.detail !== undefined ? redactPII(entry.detail) : undefined,
  };
  log.info(`AUDIT ${entry.type}`, {
    dialogId: safe.dialogId,
    detail: safe.detail,
  });
  await dbInsertAudit(safe);
}
