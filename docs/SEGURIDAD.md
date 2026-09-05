# Seguridad y datos personales — estado del gate (Fase 12)

Checklist de la auditoría (Fase 0, §15) con su estado tras la Fase 12. Los ítems "F11" quedan
explícitamente pendientes del despliegue GCP y bloquean el sign-off de producción, no el del código.

## Controles implementados

| Control | Estado | Dónde |
|---|---|---|
| Minimización: la auditoría no persiste texto conversacional | ✔ F1 | `obs/audit.ts`, `routes/whatsapp.ts` (solo metadatos del turno) |
| Retención de auditoría activa por defecto (90 días, purga diaria con lock) | ✔ F1 | `store/db.ts` (`AUDIT_RETENTION_DAYS`) |
| Tokens SOLO por header (nunca query string) | ✔ F1 | `routes/guard.ts` + test |
| Config validada, fail-fast por valor malformado (cualquier entorno) | ✔ F2 | `config.ts` (zod) |
| Fail-fast por ausencia de secretos en producción | ✔ F2/F12 | `config.ts` (incluye `TOKEN_ENC_KEY` y credenciales WhatsApp) |
| Email y RUT cifrados en reposo (AES-256-GCM), lookup por hash SHA-256 | ✔ F3/F8 | `store/personas.ts`, `store/tokenCrypto.ts` |
| Consentimiento versionado (datos + recordatorios), opt-out y opt-in efectivos | ✔ F3/F9 | `consent`, `flows/registro.ts`, `routes/whatsapp.ts` |
| Verificación HMAC del webhook (X-Hub-Signature-256, timing-safe, rawBody) | ✔ F10a | `routes/whatsapp.ts` + tests |
| El LLM nunca toca RUT, emisión de certificados ni registro de notas | ✔ F7/F8 | flujos deterministas pre-motor |
| Antisuplantación de RUT (rut_en_uso → deriva + auditoría) | ✔ F8 | `flows/certificacion.ts` |
| Redacción de PII en logs e incluye RUT; estructura preservada | ✔ F12 | `obs/redact.ts` + tests |
| Redacción NO desactivable en producción (kill-switch solo dev) | ✔ F12 | `log.ts` |
| Fail-closed por defecto en guards y firma (fail-open exige `DEV_FAIL_OPEN=true`, prohibido en prod) | ✔ F12 | `guard.ts`, `whatsapp.ts`, `config.ts` + tests |
| `TOKEN_ENC_KEY` obligatoria y validada (64 hex) en producción | ✔ F12 | `config.ts`, `tokenCrypto.ts` |
| TLS de Postgres con certificado VALIDADO (`PGSSL=true`); `no-verify` solo legado explícito | ✔ F12 | `store/db.ts` |
| Derecho de supresión: borrado por persona en cascada + KV + auditoría correlacionada, con constancia | ✔ F12 | `scripts/eliminar-persona.ts` |
| Protocolo de cuidado (disclosures sensibles → líneas de ayuda de Chile) | ✔ F6 | prompt + golden set |
| Anti prompt-injection (contexto rehidratado marcado no-confiable) | ✔ F1/F6 | `agentLoop.ts`, prompt |
| Dedupe de efectos salientes fail-closed en Postgres (recordatorios) | ✔ F9/F9.1 | `reminder.clave_dedupe`, despacho at-most-once |

## Pendientes que bloquean el sign-off de PRODUCCIÓN (se resuelven en F11)

- **Secret Manager** para todos los secretos (hoy env vars) y rotación inicial completa según
  `docs/DECOMISO-VENTAS.md` (los secretos del sistema anterior se consideran comprometidos).
- **Cloud SQL connector** (o CA administrada) en lugar de `PGSSL`.
- **Pub/Sub** entre webhook y worker (hoy el procesamiento post-ACK es in-process: pérdida de turno
  si la instancia muere; el lock por conversación es fail-open ante caída de Redis).
- Service accounts de mínimo privilegio por servicio; `/metrics` detrás de IAP o token rotado.
- Backups + PITR de Cloud SQL con prueba de restauración (RPO ≤ 5 min, RTO ≤ 4 h).

## Pendientes institucionales (no de código)

- Validación del texto de consentimiento y del flujo de supresión con el área legal (Ley 21.719).
- DPA / revisión de encargados de tratamiento: Meta (WhatsApp), Anthropic, Google (embeddings), proveedor SMTP.
- Decisión sobre la historia de git del repo (contiene PII del equipo y datos comerciales; ver DECOMISO §4).
- Política de vinculación de cuentas cuando un email pertenece a otra persona (hoy: se registra sin
  identidad-email duplicada; el equipo resuelve manualmente).
