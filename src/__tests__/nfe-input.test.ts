/**
 * NFE.E5.P3 (mudança 8 da ficha, S7) — a ponte PURA fatos do ERP web → entrada do builder: finNFe/tpNF/idDest (S10), valores do item pela
 * fórmula do faturamento (S11), unidade tributável (S8), pagamento e cobrança (S4), PIS/COFINS registrados (S2) e a lista inteira de violações.
 */
import type { MerchandiseItemFact, PartyFact } from '../facts/merchandise-facts'
import { validateMessage } from '../authority/xsd'
import { numberItems } from '../nfe/item-numbering'
import { buildNfeXml } from '../nfe/nfe-builder'
import { nfeInputFromFacts, originRef, type NfeInputSources } from '../nfe/nfe-input'
import { CLIENT_CNPJ, saleKey, signNfe, SETES_CNPJ } from './nfe-fixtures'

jest.setTimeout(60_000)

const NIL_ICMS = {
  determBase: null, determBaseSt: null, discharge: null, aliqRdBase: null, baseValue: '0.000000', aliq: '0.00', aliqRd: null, value: '0.000000',
  aliqRdBaseSt: null, baseValueSt: null, aliqSt: null, aliqRdSt: null, valueSt: null, mva: null, withheldBaseValue: null, withheldValue: null,
  withheldBaseValueSt: null, withheldValueSt: null, operationValue: null, deferredAliq: null, deferredValue: null,
}
const unit = (abbr: string, level = 1, factor = '1.000000', gtin: string | null = null) => ({ level, measureAbbreviation: abbr, factor, gtin })
const contribution = (cst: string) => ({ cst, baseValue: '0.00', aliqValue: '0.00', tagValue: '0.00', qtSaleQtty: null, qtAliqValue: null })

const item = (itemId: number, over: Partial<MerchandiseItemFact> = {}): MerchandiseItemFact => ({
  itemId, kind: 'Sale', merchandiseId: 900 + itemId, description: `Peça ${itemId}`, ncm: '73259990', cest: null, source: '0', manufScale: 'S', factoryCnpj: null,
  saleUnit: unit('PC'), taxableUnit: unit('PC'), quantity: '2.0000', unitValue: '1500.000000', discountValue: '0.000000', approxTaxAliq: '13.4500',
  icms: { ...NIL_ICMS, cst: '101', origin: '0', cfopId: '5101', credCalcAliq: '2.86', credExplValue: '85.800000', freightValue: '0.00', insuranceValue: '0.00', expensesValue: '0.00', approximateTax: '403.50' },
  fcp: null, ipi: null, pis: contribution('07'), cofins: contribution('07'),
  ...over,
})

const address = (cityIbge: string, cityName: string, stateCode = 'PR') =>
  ({ kind: 'COMERCIAL', main: 'S', street: 'Rua A', number: '100', complement: null, neighborhood: 'Centro', zipCode: '81925530', cityName, cityIbge, stateCode })
const emitter: PartyFact = {
  entityId: 98, nameCompany: 'SETES USINAGEM DE TESTE LTDA', nickTrade: 'SETES', cnpj: SETES_CNPJ, cpf: null, stateRegistration: '9053273308',
  addresses: [{ ...address('4199999', 'Outra'), main: 'N' }, address('4106902', 'Curitiba')],
  tax: { taxRegime: '1 - Simples Nacional', crt: '1', indIeDest: null, consumer: 'N' },
}
const recipient: PartyFact = {
  entityId: 321, nameCompany: 'CLIENTE DE TESTE S.A.', nickTrade: null, cnpj: CLIENT_CNPJ, cpf: null, stateRegistration: '1234567890',
  addresses: [address('4125506', 'São José dos Pinhais')], tax: { taxRegime: null, crt: null, indIeDest: '1', consumer: 'N' },
}

const sources = (over: Partial<NfeInputSources> = {}): NfeInputSources => ({
  environment: '2', dhEmi: '2026-11-24T10:15:30-03:00',
  header: { invoiceId: 5001, number: null, serie: '1', model: '55', dtEmission: '2026-11-24', entityId: 321, status: '0', note: 'Pedido 5001', totalValue: '4000.00', indPres: 3 },
  items: [item(30, { quantity: '3', unitValue: '333.333333', icms: { ...item(30).icms, credExplValue: '28.600000', approximateTax: '134.50' } }), item(10)],
  operationNature: 'Venda de produção do estabelecimento', emitter, recipient,
  payments: {
    billing: { paymentTypeId: 4, nfePaymentCode: '15', plots: '2', deadline: '028/056' },
    installments: [
      { parcel: 1, dueDate: '2026-12-22', value: '2000.00', paymentTypeId: 4, nfePaymentCode: '15' },
      { parcel: 2, dueDate: '2027-01-19', value: '2000.00', paymentTypeId: 4, nfePaymentCode: '15' },
    ],
  },
  shipping: { freightMode: '0', carrierId: null, carrier: null }, returnOrigins: [],
  techResponsible: { cnpj: SETES_CNPJ, contactName: 'Suporte Setes', email: 'suporte@setes.example', phone: '4133334444' },
  ...over,
})
const violations = (src: NfeInputSources): string[] => {
  try { nfeInputFromFacts(src) } catch (e: any) { return e.code === 'FISCAL_DOCUMENT_INVALID' ? e.fields.map((f: any) => `${f.field}: ${f.message}`) : [`outro erro: ${e.message}`] }
  return []
}

describe('ponte fatos → entrada: a venda', () => {
  it('ponta a ponta: fatos → entrada → XML assinado → válido no XSD local', async () => {
    const input = nfeInputFromFacts(sources())
    expect(await validateMessage('NFe', signNfe(buildNfeXml(input, saleKey())))).toEqual({ ok: true })
  })

  it('os itens saem na ordem do id (peça do nItem), com o cProd = id da mercadoria (D-NE269) e o cálculo registrado', () => {
    const input = nfeInputFromFacts(sources())
    expect(input.items.map(i => [i.numbered.itemId, i.numbered.nItem, i.cProd])).toEqual([[10, 1, '910'], [30, 2, '930']])
    expect(input.items[0]).toMatchObject({
      xProd: 'Peça 10', NCM: '73259990', CFOP: '5101', uCom: 'PC', qCom: '2.0000', vUnCom: '1500.000000', vProdCents: 300000, vDescCents: 0,
      uTrib: 'PC', qTrib: '2.0000', vUnTrib: '1500.000000', vTotTribCents: 40350, cEAN: null, cEANTrib: null,
      icms: { orig: '0', CSOSN: '101', pCredSN: '2.86', vCredICMSSN: '85.800000' }, pis: { CST: '07' }, cofins: { CST: '07' }, origin: null,
    })
  })

  it('S10: venda = finNFe 1; tpNF e idDest pelo 1º dígito do CFOP; indFinal e indIEDest do cadastro; indPres do ramo', () => {
    expect(nfeInputFromFacts(sources())).toMatchObject({ finNFe: '1', tpNF: '1', idDest: '1', indFinal: '0', indPres: '3', natOp: 'Venda de produção do estabelecimento' })
    const inter = sources({ items: [item(10, { icms: { ...item(10).icms, cfopId: '6101' } })], header: { ...sources().header, totalValue: '3000.00' }, payments: { billing: null, installments: [{ parcel: 1, dueDate: '2026-11-24', value: '3000.00', paymentTypeId: 1, nfePaymentCode: '01' }] } })
    expect(nfeInputFromFacts({ ...inter, recipient: { ...recipient, addresses: [address('3550308', 'São Paulo', 'SP')] } })).toMatchObject({ tpNF: '1', idDest: '2' })
    expect(nfeInputFromFacts(sources({ recipient: { ...recipient, tax: { ...recipient.tax!, consumer: 'S' } } })).indFinal).toBe('1')
    expect(violations(sources({ items: [item(10), item(30, { icms: { ...item(30).icms, cfopId: '6101' } })] }))).toContain('ide.idDest: Itens com CFOP interno e interestadual na mesma nota')
    expect(violations(sources({ items: [item(10), item(30, { icms: { ...item(30).icms, cfopId: '1201' } })] }))).toContain('ide.tpNF: Itens com CFOP de entrada e de saída na mesma nota')
  })

  it('emitente e destinatário: o endereço PRINCIPAL, a IE só do contribuinte, o CRT do cadastro tributário', () => {
    const input = nfeInputFromFacts(sources())
    expect(input.emit).toMatchObject({ CNPJ: SETES_CNPJ, IE: '9053273308', CRT: '1', ender: { cMun: '4106902', xMun: 'Curitiba', UF: 'PR', CEP: '81925530' } })
    expect(input.dest).toMatchObject({ CNPJ: CLIENT_CNPJ, CPF: null, indIEDest: '1', IE: '1234567890', ender: { cMun: '4125506' } })
    const pf = nfeInputFromFacts(sources({ recipient: { ...recipient, cnpj: null, cpf: '52998224725', tax: { taxRegime: null, crt: null, indIeDest: '9', consumer: 'S' } } }))
    expect(pf.dest).toMatchObject({ CNPJ: null, CPF: '52998224725', indIEDest: '9', IE: null })
  })

  it('S11: vProd = quantidade × unitário a 2 casas (meio para cima) e vDesc pela fórmula do faturamento, sem ponto flutuante', () => {
    const one = (q: string, u: string, d: string | null) => {
      const total = '0.00'
      const i = nfeInputFromFacts(sources({ items: [item(10, { quantity: q, unitValue: u, discountValue: d })], header: { ...sources().header, totalValue: total }, payments: { billing: { paymentTypeId: 1, nfePaymentCode: '01', plots: null, deadline: null }, installments: [] } })).items[0]
      return [i.vProdCents, i.vDescCents]
    }
    expect(one('3', '33.333333', '0.500000')).toEqual([10000, 50])
    expect(one('1', '1.005', null)).toEqual([101, 0])                          // desconto nulo = zero, como o faturamento lê
    expect(one('1.5', '0.33', '0')).toEqual([50, 0])
    expect(one('2', '10.00', '20.00')).toEqual([2000, 2000])
  })

  it('S8: unidade tributável por fator — fecha → converte; não fecha → recusa (nunca arredonda calado)', () => {
    const boxed = (q: string, u: string) => item(10, { quantity: q, unitValue: u, saleUnit: unit('CX', 2, '12.000000', '17891234567892'), taxableUnit: unit('UN', 1, '1.000000', '7891234567895') })
    const src = (it: MerchandiseItemFact, total: string) => sources({ items: [it], header: { ...sources().header, totalValue: total }, payments: { billing: { paymentTypeId: 1, nfePaymentCode: '01', plots: null, deadline: null }, installments: [] } })
    const i = nfeInputFromFacts(src(boxed('2', '60.000000'), '120.00')).items[0]
    expect([i.uCom, i.qCom, i.vUnCom, i.cEAN, i.uTrib, i.qTrib, i.vUnTrib, i.cEANTrib]).toEqual(['CX', '2', '60.000000', '17891234567892', 'UN', '24', '5', '7891234567895'])
    expect(violations(src(boxed('1', '100.000000'), '100.00'))).toEqual(['det[10].vUnTrib: O valor unitário na unidade tributável não fecha em 10 casas decimais'])
  })

  it('S4: pagamento por forma, da soma das parcelas; cobrança só com parcela a prazo; à vista não leva duplicata', () => {
    const term = nfeInputFromFacts(sources())
    expect(term.payments).toEqual([{ tPag: '15', cents: 400000 }])
    expect(term.installments).toEqual([{ dueDate: '2026-12-22', cents: 200000 }, { dueDate: '2027-01-19', cents: 200000 }])
    const mixed = nfeInputFromFacts(sources({ payments: { billing: null, installments: [
      { parcel: 1, dueDate: '2026-11-24', value: '1000.00', paymentTypeId: 1, nfePaymentCode: '01' },
      { parcel: 2, dueDate: '2026-12-24', value: '3000.00', paymentTypeId: 4, nfePaymentCode: '15' },
    ] } }))
    expect(mixed.payments).toEqual([{ tPag: '01', cents: 100000 }, { tPag: '15', cents: 300000 }])
    expect(mixed.installments).toHaveLength(2)
    const cash = nfeInputFromFacts(sources({ payments: { billing: null, installments: [{ parcel: 1, dueDate: '2026-11-24', value: '4000.00', paymentTypeId: 1, nfePaymentCode: '01' }] } }))
    expect([cash.payments, cash.installments]).toEqual([[{ tPag: '01', cents: 400000 }], []])
    const noParcel = nfeInputFromFacts(sources({ payments: { billing: { paymentTypeId: 1, nfePaymentCode: '01', plots: null, deadline: null }, installments: [] } }))
    expect([noParcel.payments, noParcel.installments]).toEqual([[{ tPag: '01', cents: 400000 }], []])
  })

  it('transporte: sem linha → modFrete 9; com transportadora → documento, nome, IE e endereço numa linha', () => {
    expect(nfeInputFromFacts(sources({ shipping: { freightMode: null, carrierId: null, carrier: null } })).transp).toEqual({ modFrete: '9', carrier: null })
    const carrier: PartyFact = { ...recipient, entityId: 77, nameCompany: 'TRANSPORTES Y', cnpj: '11444777000161', stateRegistration: '555', tax: null }
    expect(nfeInputFromFacts(sources({ shipping: { freightMode: '1', carrierId: 77, carrier } })).transp).toEqual({
      modFrete: '1', carrier: { CNPJ: '11444777000161', CPF: null, xNome: 'TRANSPORTES Y', IE: '555', xEnder: 'Rua A, 100', xMun: 'São José dos Pinhais', UF: 'PR' },
    })
  })
})

describe('ponte fatos → entrada: violações, TODAS de uma vez', () => {
  it('S2: PIS/COFINS não registrados pelo faturamento → violação com o item; nunca assume o CST 07', () => {
    expect(violations(sources({ items: [item(10, { pis: null, cofins: null }), item(30, { quantity: '3', unitValue: '333.333333', cofins: null })] }))).toEqual([
      'det[10].pis: PIS: o faturamento não registrou o CST do item', 'det[10].cofins: COFINS: o faturamento não registrou o CST do item',
      'det[30].cofins: COFINS: o faturamento não registrou o CST do item',
    ])
  })

  it('fora do 1º release: ICMS próprio, ST, IPI ou FCP com valor; modelo 65', () => {
    const out = violations(sources({
      header: { ...sources().header, model: '65' },
      items: [
        item(10, { icms: { ...item(10).icms, value: '36.000000' }, ipi: { cst: '50', classFrameCode: '999', baseValue: '100.00', aliqValue: '5.00', tagValue: '5.00', unitQtty: null, unitValue: null } }),
        item(30, { quantity: '3', unitValue: '333.333333', icms: { ...item(30).icms, valueSt: '1.000000' }, fcp: { vbcfcp: null, pfcp: null, vfcp: '0.40', vbcfcpst: null, pfcpst: null, vfcpst: null, pst: null, vbcfcpstret: null, pfcpstret: null, vfcpstret: null } }),
      ],
    }))
    expect(out).toEqual([
      'ide.mod: Modelo 65 — fora-do-primeiro-release',
      'det[10].icms: ICMS próprio ou ST com valor — fora-do-primeiro-release', 'det[10].ipi: IPI com valor — fora-do-primeiro-release',
      'det[30].icms: ICMS próprio ou ST com valor — fora-do-primeiro-release', 'det[30].fcp: FCP com valor — fora-do-primeiro-release',
    ])
  })

  it('IPI e FCP registrados com valor ZERO não recusam', () => {
    const zeroIpi = { cst: '53', classFrameCode: '999', baseValue: '0.00', aliqValue: '0.00', tagValue: '0.00', unitQtty: null, unitValue: null }
    expect(violations(sources({ items: [item(10, { ipi: zeroIpi }), item(30, { quantity: '3', unitValue: '333.333333' })] }))).toEqual([])
  })

  it('forma de pagamento sem o código da NF-e, transportadora sem cadastro, total não gravado, quantidade ilegível, nota sem item', () => {
    expect(violations(sources({ payments: { billing: null, installments: [{ parcel: 1, dueDate: '2026-12-22', value: '4000.00', paymentTypeId: 6, nfePaymentCode: null }] } })))
      .toEqual(['pag.detPag[1].tPag: A forma de pagamento da parcela não tem o código da NF-e no cadastro'])
    expect(violations(sources({ payments: { billing: { paymentTypeId: 6, nfePaymentCode: null, plots: null, deadline: null }, installments: [] } })))
      .toEqual(['pag.detPag[1].tPag: O pedido não tem forma de pagamento com o código da NF-e'])
    expect(violations(sources({ shipping: { freightMode: '1', carrierId: 77, carrier: null } }))).toEqual(['transp.carrier: A transportadora do pedido não tem cadastro de entidade'])
    expect(violations(sources({ header: { ...sources().header, totalValue: null } }))).toContain('total.vNF: O faturamento não gravou o total da nota')
    expect(violations(sources({ items: [item(10, { quantity: null })] }))).toContain('det[10].qCom: Quantidade: campo obrigatório vazio')
    expect(violations(sources({ items: [] }))).toContain('det: Nota sem item')
  })

  it('o que é do leiaute fica com o builder: natOp nulo passa pela ponte e é recusado lá, com o campo', () => {
    const input = nfeInputFromFacts(sources({ operationNature: null }))
    expect(input.natOp).toBeNull()
    try { buildNfeXml(input, saleKey()); throw new Error('não recusou') } catch (e: any) { expect(e.fields.map((f: any) => f.field)).toEqual(['ide.natOp']) }
  })
})

describe('ponte fatos → entrada: a devolução', () => {
  const ORIGIN_KEY = saleKey()
  const origins = new Map([[originRef(4000, 0), { accessKey: ORIGIN_KEY, numbering: numberItems([10, 30]) }]])
  const returned = (itemId: number, originItemId: number, q: string, u: string) => item(itemId, { kind: 'Adjust', quantity: q, unitValue: u, icms: { ...item(itemId).icms, cfopId: '1201', credCalcAliq: '0.00', credExplValue: '0.00', approximateTax: '0.00' } })
  const src = (over: Partial<NfeInputSources> = {}) => sources({
    dhEmi: '2026-11-25T09:00:00-03:00', header: { ...sources().header, invoiceId: 5002, totalValue: '2500.00', note: null },
    items: [returned(1, 10, '1', '1500.000000'), returned(2, 30, '3', '333.333333')], operationNature: 'Devolução de venda de produção do estabelecimento',
    returnOrigins: [
      { itemId: 1, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 0, originItemId: 10, originKind: 'Sale' },
      { itemId: 2, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 0, originItemId: 30, originKind: 'Sale' },
    ],
    origins, ...over,
  })

  it('finNFe 4, tpNF 0 pelo CFOP de entrada, forma 90 com zero, sem cobrança, cada item com a chave e o nItem da ORIGEM', async () => {
    const input = nfeInputFromFacts(src())
    expect(input).toMatchObject({ finNFe: '4', tpNF: '0', idDest: '1', payments: [{ tPag: '90', cents: 0 }], installments: [] })
    expect(input.items.map(i => [i.numbered.nItem, i.origin?.accessKey, i.origin?.numbered])).toEqual([[1, ORIGIN_KEY, { itemId: 10, nItem: 1 }], [2, ORIGIN_KEY, { itemId: 30, nItem: 2 }]])
    expect(await validateMessage('NFe', signNfe(buildNfeXml(input, saleKey({ number: 16, cnf: '70531942' }))))).toEqual({ ok: true })
  })

  it('item sem elo, origem sem NF-e autorizada conhecida e item de origem inexistente → violações', () => {
    expect(violations(src({ returnOrigins: [src().returnOrigins[0]] }))).toEqual(['det[2].origin: Item de devolução sem o elo com o item de origem'])
    expect(violations(src({ origins: new Map() }))).toEqual([
      'det[1].origin: A nota de origem do item não tem NF-e autorizada conhecida', 'det[2].origin: A nota de origem do item não tem NF-e autorizada conhecida'])
    expect(violations(src({ returnOrigins: [src().returnOrigins[0], { ...src().returnOrigins[1], originItemId: 99 }] }))).toEqual(['det[2].origin: O item de origem não está na nota de origem'])
  })
})
