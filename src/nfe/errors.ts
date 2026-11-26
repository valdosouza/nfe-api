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
  /** NFE.E6.P2: a NF-e foi denegada — a nota existe no fisco e não se cancela no fisco (RF-NFE-82; o cancelamento é local, no ERP). */
  DENIED:                    'FISCAL_DENIED',
  /** NFE.E6.P2 (D-NE256): passaram mais de 480 horas da autorização — recusa local, nada vai ao fisco (RF-NFE-83). */
  CANCEL_DEADLINE_EXCEEDED:  'FISCAL_CANCEL_DEADLINE_EXCEEDED',
  /** NFE.E6.P2 (D-NE169): o 1062 da UNIQUE da prova da faixa retirada (um `ProcInutNFe` por Id e ambiente) — a faixa já está retirada. */
  NUMBER_VOID_ALREADY_WITHDRAWN: 'NUMBER_VOID_ALREADY_WITHDRAWN',
  /** NFE.E6.P2: a faixa cobre número de que alguma tentativa ainda é dona (viva, autorizada, denegada, rejeitada, ou com o 217 provado). */
  VOID_RANGE_IN_USE:         'FISCAL_VOID_RANGE_IN_USE',
  /** NFE.E6.P2: a faixa já tem pedido pendente (reserva sem resposta). */
  VOID_IN_FLIGHT:            'FISCAL_VOID_IN_FLIGHT',
  /** NFE.E6.P2: o fisco rejeitou a inutilização (256, 241, 201…): história, a faixa não é retirada (D-NE207). */
  VOID_REJECTED:             'FISCAL_VOID_REJECTED',
  /** NFE.E6.P4: o arquivo fiscal que a tentativa diz ter (procNFe) não está no armazenamento — defeito de operação, nunca refeito (N10). */
  FILE_MISSING:              'FISCAL_FILE_MISSING',
  /** NFE.E6.P4: o destinatário não tem e-mail no cadastro (grupo nfe ou principal) e o pedido não trouxe `to`. */
  RECIPIENT_EMAIL_MISSING:   'FISCAL_RECIPIENT_EMAIL_MISSING',
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
