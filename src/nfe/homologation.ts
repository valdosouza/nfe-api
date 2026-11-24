/**
 * TEXTOS DE HOMOLOGAÇÃO (NFE.E5.P3 — RF-NFE-29; D-NE216, que anota a D-NE45 e a D-NE188-2): a peça é f(tpAmb, modelo, tpImp).
 *  - em homologação (`tpAmb` 2) o `dest/xNome` é SEMPRE o texto fixo (MOC 7.00, Anexo I, E04-10 — rej. 598);
 *  - o `xProd` do item 1 só leva o texto no modelo 65 ou no 55 com `tpImp` 6 (NT 2026.002 v1.11, I04-10 — rej. 373);
 *  - em produção nada muda (o texto fixo não pode aparecer).
 */
export const HOMOLOGATION_TEXT = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
export const HOMOLOGATION_FIRST_ITEM_TEXT = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'

export type TpAmbCode = '1' | '2'

/** O `dest/xNome`: em homologação, o texto fixo; em produção, o nome do cadastro. */
export function recipientNameFor(tpAmb: TpAmbCode, realName: string | null): string | null {
  return tpAmb === '2' ? HOMOLOGATION_TEXT : realName
}

/** O `xProd` do item de nItem `position` (1 = o primeiro). */
export function productDescriptionFor(tpAmb: TpAmbCode, model: '55' | '65', tpImp: string, position: number, realDescription: string | null): string | null {
  return tpAmb === '2' && position === 1 && (model === '65' || tpImp === '6') ? HOMOLOGATION_FIRST_ITEM_TEXT : realDescription
}
