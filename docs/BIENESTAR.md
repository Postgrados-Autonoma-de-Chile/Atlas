# Señales de riesgo vital: qué hace ATLAS y qué no

Registro de decisión. Existe porque este es el único punto del sistema donde equivocarse no tiene
un costo pedagógico, y porque lo que el sistema **no** hace es tan importante como lo que hace.

## Lo que pasó

En el piloto, una persona escribió `Tengo Pensamientos Suicidas Y Weas` en el campo del **nombre**,
durante el registro. El flujo lo aceptó como nombre, siguió pidiendo el apellido, y la frase quedó
guardada en su ficha de estudiante — habría salido impresa en un certificado de la Universidad.

El prompt del tutor ya tenía el protocolo correcto: dejar el rol académico, responder sin minimizar
y entregar ayuda real de Chile. No se activó porque **ese mensaje nunca llegó al modelo**: el
registro es un flujo determinista que intercepta antes.

## Lo que hace hoy

[`src/flows/bienestar.ts`](../src/flows/bienestar.ts) corre **antes que todos los flujos**, incluido
el registro. Cuando detecta una señal:

1. **Consume el turno.** La frase no se guarda como nombre ni como respuesta de nada, y la pregunta
   del flujo queda intacta para el mensaje siguiente.
2. **Responde** con las líneas de ayuda: `*4141*` (prevención del suicidio, 24 h), `600 360 7777`
   (Salud Responde) y `131` si hay peligro inmediato. Dice explícitamente que no es una persona y
   sugiere hablar con alguien de confianza cercano. No da consejería clínica, no promete
   confidencialidad y no promete que alguien va a llamar.
3. **Registra que ocurrió**, con la etiqueta (`suicidio` / `autolesion`) y nada más. El texto de la
   persona no se guarda en ninguna parte.

Si insiste, el segundo mensaje es breve pero conserva los tres números. Repetir el texto completo
suena a máquina.

### Alcance, acotado a propósito

Detecta expresiones **inequívocas**. No intenta cubrir violencia ni angustia general: eso depende
del contexto de la conversación, y el modelo —que sí lo tiene— lo maneja con la instrucción del
prompt. Esta capa no reemplaza ese protocolo, lo respalda donde el prompt no llega.

Hay tantas pruebas de que **no** se dispare como de que sí. «Me quiero morir de risa», «me muero de
hambre», «matar el tiempo», «me mata de sueño» son habla cotidiana en Chile; y «Interpretar un
diagnóstico médico personal» y «Actuar ante una emergencia» son ítems de la microcápsula 7. Una
contención que llega cuando no corresponde le enseña a la persona a ignorarla, y entonces no sirve
el día que importe.

## Lo que NO hace: no hay seguimiento humano

**Declarado por el programa el 7 de septiembre de 2026: nadie revisa estos casos.**

La consecuencia hay que decirla completa: **la respuesta automática es la intervención entera**.
ATLAS entrega las líneas, se detiene y ahí termina. Nadie de la Universidad se entera, nadie llama,
nadie mira el panel.

Por eso:

- El mensaje **no promete** que alguien va a contactar a la persona. Prometerlo sin que ocurra sería
  peor que no decir nada.
- La marca `contención ×N` del panel de cohorte es **informativa**, y la página lo dice: nadie es
  notificado.
- No se construyó ninguna alerta por correo ni turno de guardia. Una notificación que llega a un
  buzón que nadie abre no es un protocolo: es la apariencia de uno, y eso es peor que la ausencia
  declarada.

## Qué haría falta para cambiarlo

Si el programa decide tener seguimiento, el orden es este y no al revés:

1. **Alguien responsable, con nombre**, y un horario en que exista.
2. **Un procedimiento escrito**: qué se hace con un aviso, qué se le dice a la persona, cuándo se
   escala, qué queda registrado.
3. **Recién entonces**, el aviso técnico: un resumen diario a un buzón real, o una notificación al
   turno. Es la parte fácil y la última.

## Para revisar con quien corresponda

Dos cosas quedan fuera del alcance técnico y no deberían quedar sin dueño:

- **La redacción del mensaje de contención.** `*4141*` y `600 360 7777` venían del prompt original
  del proyecto; el `131` lo agregó el equipo de desarrollo. Conviene que lo valide quien tenga
  competencia clínica.
- **A escala.** El piloto son ~20 personas y ya ocurrió una vez. El programa apunta a 200.000: esto
  va a activarse muchas veces. Que una universidad opere un canal donde eso pasa y no exista
  seguimiento es una decisión institucional legítima de tomar, pero conviene tomarla explícitamente
  —con quien vea el marco legal y el deber de cuidado— y no heredarla de un detalle de
  implementación.
