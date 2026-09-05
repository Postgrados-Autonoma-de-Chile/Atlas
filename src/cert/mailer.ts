import nodemailer from 'nodemailer';
import { config } from '../config';
import { log } from '../log';

// Envío de correo (Fase 8): SMTP genérico configurable por env — sirve igual para el SMTP
// institucional o para un proveedor API con endpoint SMTP (Brevo, SendGrid, Resend...).
// Sin configuración → skipped (dev), nunca lanza. Los destinatarios jamás se loguean en claro
// (la redacción global de PII cubre igualmente los logs).

export type CorreoAdjunto = { filename: string; content: Buffer };
export type ResultadoCorreo = { ok: boolean; skipped?: boolean; error?: string };

let transporter: nodemailer.Transporter | null | undefined;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter !== undefined) return transporter;
  if (!config.smtpHost || !config.smtpFrom) {
    transporter = null;
    return null;
  }
  transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
  return transporter;
}

export async function enviarCorreo(opts: {
  to: string;
  subject: string;
  html: string;
  adjuntos?: CorreoAdjunto[];
}): Promise<ResultadoCorreo> {
  const t = getTransporter();
  if (!t) {
    log.warn('mailer: SMTP sin configurar — correo omitido (solo dev)');
    return { ok: false, skipped: true };
  }
  try {
    await t.sendMail({
      from: config.smtpFrom,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      attachments: opts.adjuntos?.map((a) => ({ filename: a.filename, content: a.content })),
    });
    return { ok: true };
  } catch (e) {
    log.error('mailer: envío falló', { err: String(e) });
    return { ok: false, error: String(e) };
  }
}
