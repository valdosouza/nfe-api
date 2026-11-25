import type { Uf } from './authorizers'

/**
 * O prazo do cancelamento 110111 (NFE.E6.P2 — D-NE205, D-NE256; RF-NFE-18/83; Q3 da ficha): dado DATADO com fonte, fora da tabela dos autorizadores (D-NE205: "com quem o lê").
 *
 * - O AVISO e o teto do rodízio seguem o prazo da UF: 24 h nas demais (Ajuste SINIEF 07/05, cláusula 12ª — grau T) e 168 h no PR (RICMS/PR, grau T no fato de 23/11/2026 — vigência
 *   desde 01/10/2021). Vencido, a nfe-api AVISA e envia: a recusa é da SEFAZ (501), o aceite fora do prazo é o 155.
 * - A TRAVA é uma só, de 480 horas da autorização, para qualquer UF (D-NE256 — "o maior prazo permitido", o do SP: Portaria CAT 162/2008, art. 18): passou disso, a nfe-api RECUSA sem
 *   enviar. As 480 h são escolha do Valdo, não norma (RF-NFE-83, grau L).
 * Só 7 UFs tiveram a fonte lida (D-NE256): qualquer outra cai no padrão nacional de 24 h até a fonte ser lida.
 */
export const CANCEL_HARD_LIMIT_HOURS = 480

export interface CancelDeadlineRule {
  readonly hours: number
  /** `AAAA-MM-DD`: a regra vale a partir desta data (na UF). */
  readonly validFrom: string
  readonly source: string
}

export const NATIONAL_CANCEL_DEADLINE: CancelDeadlineRule = Object.freeze({ hours: 24, validFrom: '2005-01-01', source: 'Ajuste SINIEF 07/05, cláusula 12ª (24 horas)' })

export const CANCEL_DEADLINES: Readonly<Partial<Record<Uf, readonly CancelDeadlineRule[]>>> = Object.freeze({
  PR: Object.freeze([Object.freeze({
    hours: 168, validFrom: '2021-10-01',
    source: 'RICMS/PR (Decreto 7.871/2017), Anexo III, Subanexo I, art. 11, caput, redação do Decreto 8.470/2021 (art. 11-A, Decreto 12.427/2026, desde 05/01/2026: também 168 h com NF-e emitida em contingência)',
  })]),
})

/** O prazo de aviso da UF na data `at` (a regra mais recente com `validFrom` ≤ `at`; senão o padrão nacional). */
export function cancelDeadlineHours(uf: Uf, at: Date): number {
  const day = at.toISOString().slice(0, 10)
  const rules = (CANCEL_DEADLINES[uf] ?? []).filter(r => r.validFrom <= day).sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))
  return (rules[0] ?? NATIONAL_CANCEL_DEADLINE).hours
}
