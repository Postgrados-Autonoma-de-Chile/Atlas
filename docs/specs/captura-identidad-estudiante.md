# Spec — Captura conversacional de identidad del estudiante (Fase 3)

Extraída y adaptada del diseño §11 de `data/capa-datos-postgrados.md` (eliminado en Fase 1): era el mejor
diseño de captura conversacional del sistema anterior. El destino ya no es Bitrix24 sino el esquema
propio (`person`, `person_identity`, `consent` en Cloud SQL).

## Campos y validaciones

| Campo | Obligatorio | Validación |
|---|---|---|
| Nombre | Sí | mín. 2 caracteres, sin dígitos |
| Primer apellido | Sí | mín. 2 caracteres, sin dígitos |
| E-mail | Sí | formato RFC; confirmar repitiéndolo; verificación por código antes de certificar (F8) |
| Teléfono | Sí | E.164; se PRELLENA con el wa_id del mensaje (normalizado con `+`) — no se pregunta |
| RUT | Solo para certificar (F8) | dígito verificador módulo 11 (acepta con/sin puntos); confirmar repitiéndolo; extranjeros: pasaporte/DNI |

## Reglas de flujo (probadas en el diseño anterior)

1. **Un dato por mensaje.** Nunca pedir dos campos en la misma pregunta.
2. **Persistencia por etapa**: apenas se completa la captura mínima (nombre + apellido + email) se crea
   la `person` — el estudiante no se pierde si abandona a mitad del flujo.
3. **Al retomar, no repreguntar** lo ya capturado: confirmar y continuar desde el punto de corte.
4. **Confirmar email y RUT** repitiéndolos al estudiante antes de guardar.
5. **Máximo 2 reintentos** por campo con validación fallida; al tercero, registrar el caso y continuar
   sin bloquear la conversación (el dato se puede completar después).
6. **Consentimiento primero**: antes de la captura, texto de consentimiento (tratamiento de datos +
   opt-in de recordatorios) registrado en `consent` con timestamp y versión del texto.

## Tratamiento de datos (obligaciones, no opcionales — Ley 21.719)

- RUT y email **cifrados en reposo** (tokenCrypto AES-256-GCM, clave en Secret Manager).
- RUT **enmascarado en logs y transcripciones** (ampliación de `obs/redact.ts`, F12).
- Retención y derecho de supresión: borrado por persona en cascada implementable.
- NO se captura cédula de identidad (archivo) en el piloto — queda fuera del alcance.
- Validar el texto de consentimiento con el área legal de la Universidad antes del piloto.
