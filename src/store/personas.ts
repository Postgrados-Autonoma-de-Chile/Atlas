import { getPool } from './db';
import { encryptToken, decryptToken } from './tokenCrypto';
import { hashLookup, normalizarEmail } from '../core/identidad';
import { log } from '../log';

// Repositorio de Personas (Fase 3). Escrituras de identidad SIEMPRE transaccionales
// (política de la auditoría: nada de fire-and-forget en datos académicos).

export type Persona = {
  id: string;
  nombre: string | null;
  apellido: string | null;
  /** Email en claro (descifrado) — usar solo para enviar; nunca loguear. */
  email: string | null;
  emailVerificado: boolean;
};

function rowToPersona(r: any, emailVerificado = false): Persona {
  return {
    id: r.id,
    nombre: r.nombre ?? null,
    apellido: r.apellido ?? null,
    email: (r.email_enc ? decryptToken(r.email_enc) : null) ?? null,
    emailVerificado,
  };
}

/**
 * Busca la persona vinculada a un wa_id (E.164 con '+').
 * null = NO existe (certeza) · undefined = ERROR de BD (no se sabe) — revisión F9.1: un error
 * transitorio no debe tratarse como "no registrado" (mandaría el flujo de consentimiento a un
 * estudiante ya registrado y consumiría su mensaje).
 */
export async function buscarPersonaPorWaId(waId: string): Promise<Persona | null | undefined> {
  const pool = getPool();
  if (!pool || !waId) return null;
  try {
    const r = await pool.query(
      `SELECT p.id, p.nombre, p.apellido, p.email_enc,
              COALESCE((SELECT verificado FROM person_identity e
                        WHERE e.person_id = p.id AND e.tipo = 'email' LIMIT 1), false) AS email_verificado
       FROM person_identity i
       JOIN person p ON p.id = i.person_id
       WHERE i.tipo = 'wa_id' AND i.valor_lookup = $1`,
      [waId],
    );
    return r.rows[0] ? rowToPersona(r.rows[0], r.rows[0].email_verificado) : null;
  } catch (e) {
    log.warn('personas: buscarPersonaPorWaId falló', { err: String(e) });
    return undefined;
  }
}

export type RegistroNuevo = {
  waId: string;
  nombre: string;
  apellido: string;
  email: string;
  consentVersion: string;
};

/**
 * Crea la persona registrada en UNA transacción: person + identidad wa_id (verificada: el mensaje
 * llegó desde ese número) + identidad email (hash, no verificada hasta F8) + consentimientos.
 * Si el wa_id ya existe (carrera entre dos mensajes), devuelve la persona existente.
 */
export async function crearPersonaRegistrada(reg: RegistroNuevo): Promise<Persona | null> {
  const pool = getPool();
  if (!pool) return null;
  const emailNorm = normalizarEmail(reg.email);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existente = await client.query(
      `SELECT person_id FROM person_identity WHERE tipo='wa_id' AND valor_lookup=$1 FOR UPDATE`,
      [reg.waId],
    );
    if (existente.rows[0]) {
      await client.query('ROLLBACK');
      return (await buscarPersonaPorWaId(reg.waId)) ?? null;
    }
    const p = await client.query(
      `INSERT INTO person (nombre, apellido, email_enc) VALUES ($1,$2,$3) RETURNING id, nombre, apellido, email_enc`,
      [reg.nombre, reg.apellido, encryptToken(emailNorm)],
    );
    const personId = p.rows[0].id;
    await client.query(
      `INSERT INTO person_identity (person_id, tipo, valor_lookup, verificado) VALUES ($1,'wa_id',$2,true)`,
      [personId, reg.waId],
    );
    // El email puede pertenecer YA a otra persona (número nuevo del mismo estudiante, correo
    // familiar compartido): eso NO debe romper el registro (revisión F9.1). La identidad email
    // queda con su primer dueño; el email en claro-cifrado vive igual en person.email_enc, y la
    // política de vinculación de cuentas se define en F8 (certificación exige email verificado).
    await client.query(
      `INSERT INTO person_identity (person_id, tipo, valor_lookup, verificado) VALUES ($1,'email',$2,false)
       ON CONFLICT ON CONSTRAINT person_identity_unico DO NOTHING`,
      [personId, hashLookup(emailNorm)],
    );
    await client.query(
      `INSERT INTO consent (person_id, tipo, version_texto, otorgado) VALUES
       ($1,'datos',$2,true), ($1,'recordatorios',$2,true)`,
      [personId, reg.consentVersion],
    );
    await client.query('COMMIT');
    return rowToPersona(p.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('personas: crearPersonaRegistrada falló', { err: String(e) });
    return null;
  } finally {
    client.release();
  }
}

/** Registra la baja o reactivación de recordatorios. Devuelve true si se persistió. */
async function registrarConsentRecordatorios(personId: string, version: string, otorgado: boolean): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO consent (person_id, tipo, version_texto, otorgado) VALUES ($1,'recordatorios',$2,$3)`,
      [personId, version, otorgado],
    );
    return true;
  } catch (e) {
    log.warn('personas: registrarConsentRecordatorios falló', { err: String(e) });
    return false;
  }
}

export const registrarOptOut = (personId: string, version: string) => registrarConsentRecordatorios(personId, version, false);
/** Reactivación prometida en el mensaje de opt-out ("quiero recordatorios") — revisión F9.1. */
export const registrarOptIn = (personId: string, version: string) => registrarConsentRecordatorios(personId, version, true);
