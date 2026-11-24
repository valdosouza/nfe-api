/**
 * DIZERES DO SIMPLES NACIONAL no `infCpl` (NFE.E5.P3 — D-NE271, ajustada pela D-NE274; proposta RF-SN-28). A nfe-api deriva SÓ a frase
 * FIXA do art. 59 § 4º da Resolução CGSN 140/2018 — "DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL" e "NÃO GERA DIREITO A
 * CRÉDITO FISCAL DE IPI" —, pelo regime do emitente (CRT) e pela data da emissão: exigida ATÉ 31/12/2026; a Resolução CGSN 190/2026 tira a
 * exigência do documento eletrônico em 01/01/2027. Regra de norma com data para acabar, não texto digitado por usuário.
 *
 * A frase do CRÉDITO de ICMS (art. 60 — "PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R$…") NÃO é escrita aqui (D-NE274): o
 * faturamento do ERP web já a compõe na observação da nota, com o cadastro de observações do cliente e a alíquota da configuração
 * (`setes-api/src/modules/billing/billing.observations.ts`), e ela chega pronta em `tb_invoice.note`. Escrevê-la aqui também a duplicaria.
 * O valor e a alíquota do crédito seguem nos campos próprios do item (`pCredSN`, `vCredICMSSN` — art. 60 § 5º), que o builder escreve.
 *
 * Só o CRT 1 no 1º release. A SEFAZ não valida o `infCpl`; é exigência da norma. Texto COM acento (D-NE28).
 */
export const SIMPLES_ISSUER_TEXT = 'DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. NÃO GERA DIREITO A CRÉDITO FISCAL DE IPI.'
/** O último dia em que os dizeres do art. 59 § 4º são exigidos no documento eletrônico. */
export const SIMPLES_ISSUER_TEXT_UNTIL = '2026-12-31'

/** As frases do Simples que a nfe-api deriva para a nota; vazio quando nenhuma se aplica. `emissionDate` = `AAAA-MM-DD` na zona do estabelecimento. */
export function simplesTexts(crt: string | null, emissionDate: string): string[] {
  if (crt !== '1') return []
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(emissionDate)) throw new Error('simplesTexts: emissionDate AAAA-MM-DD')
  return emissionDate <= SIMPLES_ISSUER_TEXT_UNTIL ? [SIMPLES_ISSUER_TEXT] : []
}

/** O `infCpl`: os dizeres derivados e, depois, a observação da nota que vier do ERP, separados por " | "; `null` quando não há nada. */
export function complementaryInfo(derived: readonly string[], note: string | null): string | null {
  const parts = [...derived, ...(typeof note === 'string' && note.trim() !== '' ? [note] : [])]
  return parts.length ? parts.join(' | ') : null
}
