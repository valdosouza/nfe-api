import { FieldError, HttpError } from 'fiscal-api'

/**
 * Códigos de recusa das peças da NE-4 que o núcleo não lista; os três já estão no contrato do `transmit` (`openapi/nfe-api.v1.yaml`).
 * As peças lançam `HttpError` 422 do núcleo com `fields[]` (campo + motivo), como a fonte de fatos.
 */
export const NfeErrors = Object.freeze({
  /** O candidato não pode ser escrito: campo obrigatório vazio, formato impossível ou perfil fora do 1º release. */
  DOCUMENT_INVALID:          'FISCAL_DOCUMENT_INVALID',
  /** O vNF do ERP não confere com a fórmula oficial (D-NE27 — tolerância zero): defeito do motor, alarme operacional. */
  TOTALS_MOTOR_DEFECT:       'FISCAL_TOTALS_MOTOR_DEFECT',
  /** O item da devolução não confere com o `det` do procNFe da origem (D-NE103). */
  RETURN_REFERENCE_MISMATCH: 'FISCAL_RETURN_REFERENCE_MISMATCH',
  /** A família da NF-e não está no catálogo de leituras do núcleo (D-NE158): a nfe-api não monta a reserva (NFE.E6.P1.T3). */
  FAMILY_NOT_IN_CATALOG:     'FISCAL_FAMILY_NOT_IN_CATALOG',
} as const)

/** Motivo (dentro de `fields[].message`) do que o builder do 1º release não escreve — nunca XML incompleto. */
export const OUT_OF_FIRST_RELEASE = 'fora-do-primeiro-release'

/** Teto de campos num erro com lista (uma nota com milhares de itens ruins não devolve um corpo de centenas de KB). */
export const MAX_FIELDS = 50

export function documentInvalid(message: string, fields: FieldError[]): HttpError {
  return new HttpError(422, message, fields.slice(0, MAX_FIELDS), NfeErrors.DOCUMENT_INVALID)
}

export function returnMismatch(message: string, fields: FieldError[]): HttpError {
  return new HttpError(422, message, fields.slice(0, MAX_FIELDS), NfeErrors.RETURN_REFERENCE_MISMATCH)
}

export function totalsMotorDefect(message: string, fields: FieldError[]): HttpError {
  return new HttpError(422, message, fields.slice(0, MAX_FIELDS), NfeErrors.TOTALS_MOTOR_DEFECT)
}

/** Recolhe violações sem lançar na primeira: quem monta devolve a lista INTEIRA (D-NE43). */
export class Violations {
  private readonly list: FieldError[] = []
  add(field: string, message: string): void { this.list.push({ field, message }) }
  get empty(): boolean { return this.list.length === 0 }
  get fields(): readonly FieldError[] { return this.list }
  /** Lança `FISCAL_DOCUMENT_INVALID` com tudo o que foi recolhido; não faz nada se a lista está vazia. */
  throwIfAny(message: string): void { if (this.list.length) throw documentInvalid(message, [...this.list]) }
}
