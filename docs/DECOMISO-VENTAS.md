# Checklist operacional — Decomiso del sistema de ventas

El código comercial fue eliminado del repo en la Fase 1, pero la BAJA OPERACIONAL del sistema
desplegado es un proceso aparte que requiere acceso a las cuentas institucionales. Sin completarlo,
quedan secretos vigentes y datos personales de prospectos fuera de control.

## 1. Servicios a apagar / desconectar

- [ ] **Railway**: detener el servicio `botbitrix24-production` y eliminar el proyecto (la URL pública quedó expuesta en docs históricos).
- [ ] **Bitrix24**: desinstalar la aplicación local (o `GET /setup/unregister-bot` antes de apagar), revocar el OAuth (client id/secret) y eliminar los webhooks entrantes.
- [ ] **ChatApp**: desconectar el número de WhatsApp del canal Open Lines (el número NO se reutiliza: ATLAS usa número nuevo).
- [ ] **Vapi**: eliminar asistentes, phone numbers importados y la API key. **Twilio**: liberar el número si no se usa en otra cosa.
- [ ] **Meta (app IG/Messenger)**: desuscribir webhooks y revocar el Page Access Token.

## 2. Datos personales (Ley 21.719 — cambio de finalidad)

- [ ] Railway Postgres: exportar/archivar según decisión institucional y **destruir** `audit_log` (conversaciones completas con PII), `calls` y `campaign_target`/`call_attempt` (teléfonos en claro). Recomendación de la auditoría: archivar/destruir con acta, NO migrar a ATLAS (finalidad distinta).
- [ ] Railway Redis: destruir (memoria conversacional y sesiones con PII).
- [ ] Bitrix24: los datos del CRM quedan bajo la gobernanza comercial existente (fuera del alcance de ATLAS).

## 3. Rotación de secretos (todos se consideran comprometidos)

Varios viajaron por query string o figuran en docs versionados; ninguno debe reutilizarse en GCP:

- [ ] `ANTHROPIC_API_KEY` (era compartida con el bot de ventas) → key nueva y dedicada para ATLAS.
- [ ] `DASHBOARD_TOKEN`, `ADMIN_TOKEN`, `WHATSAPP_CALLBACK_SECRET`, `VAPI_SECRET` → obsoletos, no recrear con los mismos valores.
- [ ] `META_APP_SECRET` / `META_PAGE_ACCESS_TOKEN` de la app antigua → app de Meta nueva para ATLAS.
- [ ] `TOKEN_ENC_KEY`, `DEEPGRAM_API_KEY`, credenciales de Railway → rotar.

## 4. Repositorio

- [ ] La historia de git retiene: teléfonos personales reales (scripts eliminados), la planilla comercial completa y URLs de producción. Decidir **antes de abrir el repo**: `git filter-repo` o repo nuevo con historia fresca (pregunta 6 de la auditoría).
