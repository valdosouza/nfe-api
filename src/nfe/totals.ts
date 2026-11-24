import { merchandiseInvoiceTotal, MerchandiseTotalError, type MerchandiseTotalsCents } from 'fiscal-api'
import { totalsMotorDefect } from './errors'

/**
 * TOTAIS da NF-e (NFE.E5.P3.T2 — RF-NFE-28; D-NE27, D-NE178, D-NE215). Cada campo do `ICMSTot` é escrito COMO a soma dos itens, em
 * centavos inteiros (as rej. 531 a 564 e 601 a 604 morrem por construção); do ERP vem só o vNF, que é CONFERIDO contra a fórmula oficial
 * do núcleo (`fiscal-api/merchandise-total` — a mesma peça com que o faturamento o cunhou), na tolerância ZERO. Divergência =
 * 422 `FISCAL_TOTALS_MOTOR_DEFECT`: defeito do motor, alarme operacional — a nfe-api nunca "corrige" o vNF nem calcula imposto.
 */

/** As parcelas de UM item, em centavos (o que o 1º release soma; o resto do `ICMSTot` sai zero por construção). */
export interface ItemTotalsCents {
  /** Só os itens com `indTot` = 1 compõem o `vProd` (todos, no 1º release). */
  vProd: number
  vDesc: number
  vFrete: number
  vSeg: number
  vOutro: number
  vBC: number
  vICMS: number
  vPIS: number
  vCOFINS: number
  vTotTrib: number
}

/** Os 19 campos 1-1 do `ICMSTot` (PL_010f) mais o `vTotTrib` opcional, em centavos. */
export interface IcmsTotCents {
  vBC: number; vICMS: number; vICMSDeson: number; vFCP: number; vBCST: number; vST: number; vFCPST: number; vFCPSTRet: number
  vProd: number; vFrete: number; vSeg: number; vDesc: number; vII: number; vIPI: number; vIPIDevol: number; vPIS: number; vCOFINS: number
  vOutro: number; vNF: number; vTotTrib: number
}

const sum = (items: readonly ItemTotalsCents[], field: keyof ItemTotalsCents): number => {
  let total = 0
  for (const it of items) {
    const v = it[field]
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`totais: parcela ${field} inválida num item (centavos inteiros ≥ 0)`)
    total += v
  }
  if (!Number.isSafeInteger(total)) throw new Error(`totais: soma de ${field} fora do limite`)
  return total
}

/** As parcelas da fórmula oficial do vNF, somadas dos itens (o que não existe no 1º release entra zero). */
export function merchandiseTotalsOf(items: readonly ItemTotalsCents[]): MerchandiseTotalsCents {
  return {
    vProd: sum(items, 'vProd'), vDesc: sum(items, 'vDesc'), vFrete: sum(items, 'vFrete'), vSeg: sum(items, 'vSeg'), vOutro: sum(items, 'vOutro'),
    vICMSDesonDeducted: 0, vST: 0, vFCPST: 0, vICMSMonoReten: 0, vII: 0, vIPI: 0, vIPIDevol: 0, vServ: 0, vPISSTSummed: 0, vCOFINSSTSummed: 0,
    newVehicleSale: false,
  }
}

/**
 * O `ICMSTot` pela soma dos itens, com o vNF do ERP conferido contra a fórmula vigente na data do fato (a data do `dhEmi` na zona do
 * estabelecimento, `AAAA-MM-DD`). `erpTotalCents` = o `tb_invoice_merchandise.total_value` em centavos.
 */
export function icmsTotOf(items: readonly ItemTotalsCents[], erpTotalCents: number, factDate: string): IcmsTotCents {
  if (items.length === 0) throw new Error('totais: nota sem item')
  const parts = merchandiseTotalsOf(items)
  let derived: { cents: number; formula: string }
  try {
    derived = merchandiseInvoiceTotal(parts, factDate)
  } catch (err) {
    if (err instanceof MerchandiseTotalError) {
      throw totalsMotorDefect('Total da nota inválido pela fórmula oficial', [{ field: `total.${err.field}`, message: err.message }])
    }
    throw err
  }
  if (!Number.isSafeInteger(erpTotalCents) || derived.cents !== erpTotalCents) {
    throw totalsMotorDefect('O total da nota (vNF) gravado pelo faturamento não confere com a fórmula oficial', [{
      field: 'total.vNF',
      message: `vNF do ERP ${erpTotalCents} centavos × ${derived.cents} centavos pela fórmula ${derived.formula} (tolerância zero — D-NE27)`,
    }])
  }
  return {
    vBC: sum(items, 'vBC'), vICMS: sum(items, 'vICMS'), vICMSDeson: 0, vFCP: 0, vBCST: 0, vST: 0, vFCPST: 0, vFCPSTRet: 0,
    vProd: parts.vProd, vFrete: parts.vFrete, vSeg: parts.vSeg, vDesc: parts.vDesc, vII: 0, vIPI: 0, vIPIDevol: 0,
    vPIS: sum(items, 'vPIS'), vCOFINS: sum(items, 'vCOFINS'), vOutro: parts.vOutro, vNF: derived.cents, vTotTrib: sum(items, 'vTotTrib'),
  }
}
