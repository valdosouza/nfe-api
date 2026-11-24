import { dec0302a04, toCents } from './formats'

/**
 * DIZERES DO SIMPLES NACIONAL no `infCpl` (NFE.E5.P3 — D-NE271; proposta RF-SN-28). Derivados pelo regime do emitente (CRT) e pela data
 * da emissão — regra de norma com data para acabar, não texto digitado por usuário:
 *  - Resolução CGSN 140/2018, art. 59 § 4º: "DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL" e "NÃO GERA DIREITO A CRÉDITO
 *    FISCAL DE IPI" — exigidos ATÉ 31/12/2026; a Resolução CGSN 190/2026 tira a exigência do documento eletrônico em 01/01/2027;
 *  - art. 60: a expressão do crédito de ICMS, quando a operação o permite (CSOSN 101) e há crédito maior que zero — segue valendo depois
 *    de 2026. Pelo § 5º, na NF-e o valor e a alíquota vão também nos campos próprios (`pCredSN`, `vCredICMSSN`), que o builder escreve.
 * Só o CRT 1 no 1º release. A SEFAZ não valida o `infCpl`; é exigência da norma. Texto COM acento (D-NE28).
 */
export const SIMPLES_ISSUER_TEXT = 'DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. NÃO GERA DIREITO A CRÉDITO FISCAL DE IPI.'
/** O último dia em que os dizeres do art. 59 § 4º são exigidos no documento eletrônico. */
export const SIMPLES_ISSUER_TEXT_UNTIL = '2026-12-31'

export interface SimplesCreditItem {
  /** CSOSN do item (`icms.cst`). */
  csosn: string | null
  /** `pCredSN` como texto decimal. */
  creditAliq: string | null
  /** `vCredICMSSN` como texto decimal. */
  creditValue: string | null
}

const brMoney = (cents: number): string => {
  const int = String(Math.trunc(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${int},${String(cents % 100).padStart(2, '0')}`
}

/** As frases do Simples para a nota, na ordem; vazio quando nenhuma se aplica. `emissionDate` = `AAAA-MM-DD` na zona do estabelecimento. */
export function simplesTexts(crt: string | null, emissionDate: string, items: readonly SimplesCreditItem[]): string[] {
  if (crt !== '1') return []
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(emissionDate)) throw new Error('simplesTexts: emissionDate AAAA-MM-DD')
  const out: string[] = []
  if (emissionDate <= SIMPLES_ISSUER_TEXT_UNTIL) out.push(SIMPLES_ISSUER_TEXT)
  // Uma frase por alíquota (itens de alíquotas diferentes não se somam numa alíquota só), na ordem em que a alíquota aparece.
  const byAliq = new Map<string, number>()
  for (const it of items) {
    if (it.csosn !== '101' || it.creditValue == null || it.creditAliq == null) continue
    const cents = toCents(it.creditValue)
    if (cents === 0) continue
    const aliq = dec0302a04(it.creditAliq)
    byAliq.set(aliq, (byAliq.get(aliq) ?? 0) + cents)
  }
  for (const [aliq, cents] of byAliq) {
    out.push(`PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R$ ${brMoney(cents)}; CORRESPONDENTE À ALÍQUOTA DE ${aliq.replace('.', ',')}%, `
      + 'NOS TERMOS DO ART. 23 DA LEI COMPLEMENTAR Nº 123, DE 2006.')
  }
  return out
}

/** O `infCpl`: os dizeres derivados e, depois, a observação da nota que vier do ERP, separados por " | "; `null` quando não há nada. */
export function complementaryInfo(derived: readonly string[], note: string | null): string | null {
  const parts = [...derived, ...(note != null && note.trim() !== '' ? [note] : [])]
  return parts.length ? parts.join(' | ') : null
}
