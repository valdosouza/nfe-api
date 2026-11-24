import type { TechnicalResponsible } from 'fiscal-api'
import type {
  MerchandiseInvoiceHeader, MerchandiseItemFact, PartyAddressFact, PartyFact, PaymentFacts, ReturnOriginFact, ShippingFacts, TradeUnitFact,
} from '../facts/merchandise-facts'
import { OUT_OF_FIRST_RELEASE, Violations } from './errors'
import { decimalText, divideExact, FormatError, multiply, parseDecimal, roundToCents, subtract, toCents, type Decimal } from './formats'
import type { TpAmbCode } from './homologation'
import { ItemNumberingError, numberItems, type ItemNumbering } from './item-numbering'
import type { NfeAddressInput, NfeInput, NfeItemInput, NfePisCofinsInput } from './nfe-builder'
import type { CsrtProof } from './tech-responsible'

/**
 * A PONTE — fatos do ERP web (fonte de fatos do NFE.E5.P2) → entrada do builder, tipada pelo leiaute (NFE.E5.P3, S7 da ficha). PURA: não
 * lê banco, não sorteia, não assina. É aqui que as DERIVAÇÕES moram:
 *  - `finNFe` e `tpNF` (S10 — ninguém os grava no ERP): devolução = a nota tem elo de devolução; entrada/saída pelo 1º dígito do CFOP;
 *    `idDest` também pelo CFOP (1/5 interna, 2/6 interestadual, 3/7 exterior);
 *  - valores do item em DECIMAL EXATO, pela mesma fórmula do faturamento (S11 — `setes-api/src/modules/billing/billing.total.ts`):
 *    `vProd` = quantidade × unitário a 2 casas (meio para cima); `vDesc` = `vProd` − (quantidade × unitário − desconto, a 2 casas);
 *  - unidade tributável pelo fator (S8 — D-PR16): `qTrib` = `qCom` × fator vendido ÷ fator tributável; `vUnTrib` = `vProd` ÷ `qTrib`; se a
 *    divisão não fecha nas casas do leiaute, RECUSA — nunca arredonda calado;
 *  - pagamento e cobrança (S4 — D-NE272, D-NE48): `detPag` por forma, das parcelas do faturamento; `cobr` só na venda com parcela de
 *    vencimento posterior à emissão; devolução = forma 90 com valor zero, sem cobrança;
 *  - PIS/COFINS (S2): o CST tem de estar REGISTRADO pelo faturamento; ausente = violação com o item — nunca se assume o CST 07.
 * Devolve a entrada ou lança `HttpError` 422 `FISCAL_DOCUMENT_INVALID` com TODAS as violações de uma vez (D-NE43). O que é regra de
 * conteúdo do leiaute (campo vazio, tamanho, domínio) fica com o builder; a lista das 14 regras da camada 1 é do NFE.E5.P5.
 */

export interface NfeInputSources {
  environment: TpAmbCode
  /** `AAAA-MM-DDThh:mm:ss±hh:00` na zona do estabelecimento — gerado por quem compõe a transmissão. */
  dhEmi: string
  header: MerchandiseInvoiceHeader
  items: readonly MerchandiseItemFact[]
  /** natOp já lido (`readOperationNature` — D-NE268). */
  operationNature: string | null
  emitter: PartyFact
  recipient: PartyFact
  payments: PaymentFacts
  shipping: ShippingFacts
  returnOrigins: readonly ReturnOriginFact[]
  /** Devolução: por nota de origem — chave `originRef(id da nota, terminal)` —, a chave AUTORIZADA e a numeração dos itens dela. */
  origins?: ReadonlyMap<string, { accessKey: string; numbering: ItemNumbering }>
  techResponsible: TechnicalResponsible
  csrt?: CsrtProof | null
}

/** A identidade de uma nota de origem: o id sozinho não basta (o mesmo id pode existir em dois terminais). */
export const originRef = (invoiceId: number, terminal: number): string => `${invoiceId}|${terminal}`

const mainAddress = (party: PartyFact): PartyAddressFact | null => party.addresses.find(a => a.main === 'S') ?? party.addresses[0] ?? null

const addressInput = (a: PartyAddressFact | null): NfeAddressInput => ({
  xLgr: a?.street ?? null, nro: a?.number ?? null, xCpl: a?.complement ?? null, xBairro: a?.neighborhood ?? null,
  cMun: a?.cityIbge ?? null, xMun: a?.cityName ?? null, UF: a?.stateCode ?? null, CEP: a?.zipCode ?? null,
})

const dec = (v: Violations, field: string, text: string | null, label: string): Decimal | null => {
  try { return parseDecimal(text) } catch (e) {
    if (!(e instanceof FormatError)) throw e
    v.add(field, e.reason === 'vazio' ? `${label}: campo obrigatório vazio` : `${label}: valor inválido (${e.reason})`)
    return null
  }
}
const cents = (v: Violations, field: string, text: string | null, label: string): number => {
  if (text === null || text === '') return 0
  try { return toCents(text) } catch (e) {
    if (!(e instanceof FormatError)) throw e
    v.add(field, `${label}: valor inválido (${e.reason})`)
    return 0
  }
}
const positive = (text: string | null | undefined): boolean => {
  try { return text != null && text !== '' && parseDecimal(text).units > 0n } catch { return true }      // ilegível conta como "tem valor": recusa
}

const pisCofins = (v: Violations, field: string, label: string, r: MerchandiseItemFact['pis']): NfePisCofinsInput => {
  if (!r) { v.add(field, `${label}: o faturamento não registrou o CST do item`); return { CST: null } }
  return { CST: r.cst, vBC: r.baseValue, pAliq: r.aliqValue, value: r.tagValue }
}

function tributable(v: Violations, p: string, sale: TradeUnitFact, taxable: TradeUnitFact, q: Decimal | null, vProdCents: number, item: MerchandiseItemFact) {
  const same = { uTrib: taxable.measureAbbreviation ?? sale.measureAbbreviation, qTrib: item.quantity, vUnTrib: item.unitValue }
  if (sale.level === taxable.level || sale.factor === taxable.factor || q === null) return same
  const sf = dec(v, `${p}.uCom`, sale.factor, 'Fator da unidade vendida'), tf = dec(v, `${p}.uTrib`, taxable.factor, 'Fator da unidade tributável')
  if (!sf || !tf) return same
  const qTrib = divideExact(multiply(q, sf), tf, 4)
  if (!qTrib || qTrib.units <= 0n) { v.add(`${p}.qTrib`, 'A quantidade na unidade tributável não fecha em 4 casas decimais'); return same }
  const vUnTrib = divideExact({ units: BigInt(vProdCents), scale: 2 }, qTrib, 10)
  if (!vUnTrib) { v.add(`${p}.vUnTrib`, 'O valor unitário na unidade tributável não fecha em 10 casas decimais'); return same }
  return { uTrib: taxable.measureAbbreviation, qTrib: decimalText(qTrib, 11, 4), vUnTrib: decimalText(vUnTrib, 11, 10) }
}

/** Monta a entrada do builder a partir dos fatos; violações → `HttpError` 422 `FISCAL_DOCUMENT_INVALID` com a lista inteira. */
export function nfeInputFromFacts(src: NfeInputSources): NfeInput {
  const v = new Violations()
  if (src.header.model !== '55') v.add('ide.mod', `Modelo ${String(src.header.model).slice(0, 2)} — ${OUT_OF_FIRST_RELEASE}`)
  const emissionDate = /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.exec(src.dhEmi ?? '')?.[0] ?? ''

  let numbering: ItemNumbering | null = null
  try { numbering = numberItems(src.items.map(i => i.itemId)) } catch (e) {
    if (!(e instanceof ItemNumberingError)) throw e
    v.add('det', e.code === 'EMPTY' ? 'Nota sem item' : 'Itens com id repetido ou inválido')
  }
  const isReturn = src.returnOrigins.length > 0
  const originOf = new Map<number, ReturnOriginFact>()
  for (const r of src.returnOrigins) {
    if (originOf.has(r.itemId)) v.add(`det[${r.itemId}].origin`, 'Item de devolução com mais de um elo de origem')
    originOf.set(r.itemId, r)
  }

  // ---- itens ------------------------------------------------------------------------------------------------------------------------
  const directions = new Set<string>(), destinations = new Set<string>()
  const items: NfeItemInput[] = []
  for (const numbered of numbering?.items ?? []) {
    const it = src.items.find(i => i.itemId === numbered.itemId) as MerchandiseItemFact
    const p = `det[${it.itemId}]`
    const cfop = it.icms.cfopId
    if (cfop && /^[1-7]/.test(cfop)) { directions.add('123'.includes(cfop[0]) ? '0' : '1'); destinations.add({ 1: '1', 5: '1', 2: '2', 6: '2', 3: '3', 7: '3' }[cfop[0] as '1'] ?? '') }

    // O que o 1º release não escreve (S1): imposto com valor fora do Simples "puro".
    if (positive(it.icms.value) || positive(it.icms.valueSt)) v.add(`${p}.icms`, `ICMS próprio ou ST com valor — ${OUT_OF_FIRST_RELEASE}`)
    if (it.ipi && positive(it.ipi.tagValue)) v.add(`${p}.ipi`, `IPI com valor — ${OUT_OF_FIRST_RELEASE}`)
    if (it.fcp && [it.fcp.vfcp, it.fcp.vfcpst, it.fcp.vfcpstret].some(positive)) v.add(`${p}.fcp`, `FCP com valor — ${OUT_OF_FIRST_RELEASE}`)

    const q = dec(v, `${p}.qCom`, it.quantity, 'Quantidade'), u = dec(v, `${p}.vUnCom`, it.unitValue, 'Valor unitário')
    let vProdCents = 0, vDescCents = 0
    if (q && u) {
      try {
        const gross = multiply(q, u)
        vProdCents = roundToCents(gross)
        const discount = it.discountValue === null || it.discountValue === '' ? parseDecimal('0') : parseDecimal(it.discountValue)
        vDescCents = vProdCents - roundToCents(subtract(gross, discount))
        if (vDescCents < 0) { v.add(`${p}.vDesc`, 'Desconto negativo'); vDescCents = 0 }
      } catch (e) { if (!(e instanceof FormatError)) throw e; v.add(`${p}.vProd`, `Valor do item inválido (${e.reason})`) }
    }
    const trib = tributable(v, p, it.saleUnit, it.taxableUnit, q, vProdCents, it)

    let origin: NfeItemInput['origin'] = null
    if (isReturn) {
      const link = originOf.get(it.itemId)
      const source = link ? src.origins?.get(originRef(link.originInvoiceId, link.originTerminal)) : undefined
      const originNumbered = source?.numbering.items.find(n => n.itemId === link!.originItemId)
      if (!link) v.add(`${p}.origin`, 'Item de devolução sem o elo com o item de origem')
      else if (!source) v.add(`${p}.origin`, 'A nota de origem do item não tem NF-e autorizada conhecida')
      else if (!originNumbered) v.add(`${p}.origin`, 'O item de origem não está na nota de origem')
      else origin = { accessKey: source.accessKey, numbered: originNumbered }
    }

    items.push({
      numbered,
      cProd: it.merchandiseId === null ? null : String(it.merchandiseId),
      cEAN: it.saleUnit.gtin, xProd: it.description, NCM: it.ncm, CEST: it.cest, indEscala: it.manufScale, CNPJFab: it.factoryCnpj,
      CFOP: cfop, uCom: it.saleUnit.measureAbbreviation, qCom: it.quantity, vUnCom: it.unitValue, vProdCents,
      cEANTrib: it.taxableUnit.gtin ?? (it.saleUnit.level === it.taxableUnit.level ? it.saleUnit.gtin : null),
      uTrib: trib.uTrib, qTrib: trib.qTrib, vUnTrib: trib.vUnTrib,
      vFreteCents: cents(v, `${p}.vFrete`, it.icms.freightValue, 'Frete'), vSegCents: cents(v, `${p}.vSeg`, it.icms.insuranceValue, 'Seguro'),
      vDescCents, vOutroCents: cents(v, `${p}.vOutro`, it.icms.expensesValue, 'Outras despesas'),
      vTotTribCents: cents(v, `${p}.vTotTrib`, it.icms.approximateTax, 'Tributos aproximados'),
      icms: { orig: it.icms.origin, CSOSN: it.icms.cst, pCredSN: it.icms.credCalcAliq ?? '0', vCredICMSSN: it.icms.credExplValue ?? '0' },
      pis: pisCofins(v, `${p}.pis`, 'PIS', it.pis), cofins: pisCofins(v, `${p}.cofins`, 'COFINS', it.cofins),
      origin,
    })
  }
  // GTIN: quem tem o da unidade comercial tem de ter o da tributável, e o inverso (rej. 885, 886).
  for (const it of items) {
    if ((it.cEAN === null || it.cEAN === '') !== (it.cEANTrib === null || it.cEANTrib === '')) v.add(`det[${it.numbered.itemId}].cEANTrib`, 'GTIN informado só numa das unidades, comercial ou tributável (rej. 885, 886)')
  }
  if (directions.size > 1) v.add('ide.tpNF', 'Itens com CFOP de entrada e de saída na mesma nota')
  if (destinations.size > 1) v.add('ide.idDest', 'Itens com CFOP interno e interestadual na mesma nota')
  const tpNF = ([...directions][0] ?? (isReturn ? '0' : '1')) as '0' | '1'
  const idDest = ([...destinations][0] || '1') as '1' | '2' | '3'

  // ---- pagamento e cobrança ---------------------------------------------------------------------------------------------------------
  const erpTotalCents = cents(v, 'total.vNF', src.header.totalValue, 'Total da nota')
  if (src.header.totalValue === null || src.header.totalValue === '') v.add('total.vNF', 'O faturamento não gravou o total da nota')
  let payments: NfeInput['payments'] = [{ tPag: '90', cents: 0 }]
  let installments: NfeInput['installments'] = []
  if (!isReturn) {
    const parcels = src.payments.installments.map((i, n) => {
      if (i.value === null || i.value === '') v.add(`cobr.dup[${n + 1}].vDup`, 'Parcela sem valor')
      return { dueDate: i.dueDate, cents: cents(v, `cobr.dup[${n + 1}].vDup`, i.value, 'Parcela'), code: i.nfePaymentCode }
    })
    if (parcels.length) {
      const byCode = new Map<string, number>()
      parcels.forEach((pc, n) => {
        if (!pc.code) v.add(`pag.detPag[${n + 1}].tPag`, 'A forma de pagamento da parcela não tem o código da NF-e no cadastro')
        else byCode.set(pc.code, (byCode.get(pc.code) ?? 0) + pc.cents)
      })
      payments = [...byCode].map(([tPag, c]) => ({ tPag, cents: c }))
      // Cobrança só quando há parcela A PRAZO (vencimento depois da emissão); à vista não leva duplicata.
      if (emissionDate && parcels.some(pc => typeof pc.dueDate === 'string' && pc.dueDate > emissionDate)) installments = parcels.map(pc => ({ dueDate: pc.dueDate, cents: pc.cents }))
    } else {
      const code = src.payments.billing?.nfePaymentCode ?? null
      if (!code) v.add('pag.detPag[1].tPag', 'O pedido não tem forma de pagamento com o código da NF-e')
      payments = [{ tPag: code, cents: erpTotalCents }]
    }
  }

  // ---- transporte -------------------------------------------------------------------------------------------------------------------
  const carrier = src.shipping.carrier
  if (!carrier && src.shipping.carrierId !== null && src.shipping.carrierId > 0) v.add('transp.carrier', 'A transportadora do pedido não tem cadastro de entidade')
  const ca = carrier ? mainAddress(carrier) : null

  const emitAddr = mainAddress(src.emitter), destAddr = mainAddress(src.recipient)
  // O `idDest` saiu do CFOP; a UF real do destinatário tem de concordar (rej. 772, 773) — dois fatos que podem discordar não se escolhem calados.
  if (emitAddr?.stateCode && destAddr?.stateCode && destinations.size === 1) {
    const sameState = emitAddr.stateCode === destAddr.stateCode
    if (idDest === '1' && !sameState) v.add('ide.idDest', 'CFOP de operação interna com destinatário de outra UF (rej. 773)')
    if (idDest === '2' && sameState) v.add('ide.idDest', 'CFOP de operação interestadual com destinatário da mesma UF (rej. 772)')
  }
  const indIEDest = src.recipient.tax?.indIeDest ?? null
  v.throwIfAny(`A NF-e não pode ser montada: os dados da nota ${src.header.invoiceId} têm problema(s)`)

  return {
    environment: src.environment, natOp: src.operationNature, dhEmi: src.dhEmi, tpNF, idDest, finNFe: isReturn ? '4' : '1',
    indFinal: src.recipient.tax?.consumer === 'S' ? '1' : '0', indPres: src.header.indPres === null ? '' : String(src.header.indPres),
    emit: {
      CNPJ: src.emitter.cnpj, xNome: src.emitter.nameCompany, xFant: src.emitter.nickTrade, ender: addressInput(emitAddr),
      IE: src.emitter.stateRegistration, CRT: src.emitter.tax?.crt ?? null,
    },
    dest: {
      CNPJ: src.recipient.cnpj, CPF: src.recipient.cnpj ? null : src.recipient.cpf, xNome: src.recipient.nameCompany, ender: addressInput(destAddr),
      indIEDest, IE: indIEDest === '1' ? src.recipient.stateRegistration : null,
    },
    items, erpTotalCents,
    transp: {
      modFrete: src.shipping.freightMode ?? '9',
      carrier: carrier ? {
        CNPJ: carrier.cnpj, CPF: carrier.cnpj ? null : carrier.cpf, xNome: carrier.nameCompany, IE: carrier.stateRegistration,
        xEnder: ca && ca.street ? [ca.street, ca.number].filter(Boolean).join(', ') : null, xMun: ca?.cityName ?? null, UF: ca?.stateCode ?? null,
      } : null,
    },
    installments, payments, note: src.header.note, techResponsible: src.techResponsible, csrt: src.csrt ?? null,
  }
}
