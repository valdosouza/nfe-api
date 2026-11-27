/**
 * NFE.E5.P3 (mudança 8 da ficha, S7) — a ponte PURA fatos do ERP web → entrada do builder: finNFe/tpNF/idDest (S10), valores do item pela
 * fórmula do faturamento (S11), unidade tributável (S8), pagamento e cobrança (S4), PIS/COFINS registrados (S2) e a lista inteira de violações.
 */
import type { ItemSimplesFact, MerchandiseItemFact, PartyFact } from '../facts/merchandise-facts'
import { validateMessage } from '../authority/xsd'
import { numberItems } from '../nfe/item-numbering'
import { buildNfeXml } from '../nfe/nfe-builder'
import { nfeInputFromFacts, originRef, type NfeInputSources } from '../nfe/nfe-input'
import { CLIENT_CNPJ, saleKey, signNfe, simplesFor, SETES_CNPJ } from './nfe-fixtures'
import { address, emitter, item, recipient, sources, unit } from './nfe-source-fixtures'

jest.setTimeout(60_000)

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

  it('S8 e D-NE276: unidade tributável por fator — fecha → converte exato; não fecha → vUnTrib arredondado em 10 casas, dentro de R$ 0,01', () => {
    const boxed = (q: string, u: string) => item(10, { quantity: q, unitValue: u, saleUnit: unit('CX', 2, '12.000000', '17891234567892'), taxableUnit: unit('UN', 1, '1.000000', '7891234567895') })
    const src = (it: MerchandiseItemFact, total: string) => sources({ items: [it], header: { ...sources().header, totalValue: total }, payments: { billing: { paymentTypeId: 1, nfePaymentCode: '01', plots: null, deadline: null }, installments: [] } })
    const i = nfeInputFromFacts(src(boxed('2', '60.000000'), '120.00')).items[0]
    expect([i.uCom, i.qCom, i.vUnCom, i.cEAN, i.uTrib, i.qTrib, i.vUnTrib, i.cEANTrib]).toEqual(['CX', '2', '60.000000', '17891234567892', 'UN', '24', '5', '7891234567895'])
    const rounded = nfeInputFromFacts(src(boxed('1', '100.000000'), '100.00')).items[0]               // 100,00 ÷ 12 não fecha: 8,3333333333
    expect([rounded.qTrib, rounded.vUnTrib]).toEqual(['12', '8.3333333333'])
    expect(violations(src(boxed('1', '100.000000'), '100.00'))).toEqual([])
    // A conta que o arredondamento faz: 12 × 8,3333333333 = 99,9999999996 — a menos de R$ 0,01 de 100,00 (tolerância do MOC, rej. 630).
    expect(12n * 83333333333n).toBe(999999999996n)
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
    expect([noParcel.payments, noParcel.installments]).toEqual([[{ tPag: '90', cents: 0 }], []])          // D-NE275: sem parcela = 90, nunca a forma do pedido como paga
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
    expect(violations(sources({ payments: { billing: { paymentTypeId: 6, nfePaymentCode: null, plots: null, deadline: null }, installments: [] } }))).toEqual([])
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

describe('NFE.E5.P6 — ponte: o IBS/CBS do Simples de 2027 (D-NE286, D-NE288 a D-NE290)', () => {
  const fact = (itemId: number, over: Partial<ItemSimplesFact> = {}): ItemSimplesFact => ({
    itemId, activityCode: itemId === 10 ? '01' : '02', competence: '2027-01', ibsRate: '0.1000', cbsRate: '0.9000',
    baseValue: itemId === 10 ? '3000.00' : '1000.00', ibsValue: itemId === 10 ? '3.00' : '1.00', cbsValue: itemId === 10 ? '27.00' : '9.00', classificationCode: '000001', ...over,
  })
  const KEY27 = saleKey({ emissionDate: '2027-01-15' })
  const sale27 = (over: Partial<NfeInputSources> = {}) => sources({
    dhEmi: '2027-01-15T10:15:30-03:00', header: { ...sources().header, dtEmission: '2027-01-15' },
    payments: { billing: sources().payments.billing, installments: [{ parcel: 1, dueDate: '2027-02-20', value: '4000.00', paymentTypeId: 4, nfePaymentCode: '15' }] },
    simples: [fact(10), fact(30)], ...over,
  })
  it('ponta a ponta: fatos congelados → entrada → XML assinado válido no 010h, com os totais do grupo', async () => {
    const input = nfeInputFromFacts(sale27())
    expect(input.items.map(i => i.simples)).toEqual([
      { activity: '01', classification: '000001', ibsRate: '0.1000', cbsRate: '0.9000', ibsCents: 300, cbsCents: 2700, baseCents: 300000 },
      { activity: '02', classification: '000001', ibsRate: '0.1000', cbsRate: '0.9000', ibsCents: 100, cbsCents: 900, baseCents: 100000 },
    ])
    const built = buildNfeXml(input, KEY27)
    expect(built.xml).toContain('<IBSCBSTot><vBCIBSCBS>4000.00</vBCIBSCBS><gTribSN><vIBSSN>4.00</vIBSSN><vCBSSN>36.00</vCBSSN></gTribSN></IBSCBSTot>')
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })
  it('item sem linha congelada (ou regime regular) → violação citando o item; a lista vem inteira', () => {
    expect(violations(sale27({ simples: [fact(10)] }))).toEqual(['det[30].simples: O faturamento não guardou o IBS/CBS do Simples do item (ou regime regular) — fora-do-primeiro-release'])
    expect(violations(sale27({ simples: [] }))).toHaveLength(2)
  })
  it('valor ilegível na linha congelada → violação com o campo', () => {
    expect(violations(sale27({ simples: [fact(10, { ibsValue: 'abc' }), fact(30)] }))).toEqual([expect.stringMatching(/^det\[10\]\.vIBSSN: IBS do Simples: valor inválido/)])
  })
  it('sem a leitura (campo opcional ausente) a ponte não inventa: o BUILDER recusa o item sem o grupo (D-NE290)', () => {
    const input = nfeInputFromFacts(sale27({ simples: undefined }))
    expect(input.items.every(i => i.simples === undefined)).toBe(true)
    expect(() => buildNfeXml(input, KEY27)).toThrow(/não pode ser montada: 2 problema/)
  })
  it('nota de 2026 ignora a leitura (o grupo não vai antes de 01/01/2027) e CRT ≠ 1 também', () => {
    expect(nfeInputFromFacts(sources({ simples: [fact(10), fact(30)] })).items.every(i => i.simples === undefined)).toBe(true)
    const crt3 = { ...emitter, tax: { ...emitter.tax!, crt: '3' } }
    expect(nfeInputFromFacts(sale27({ emitter: crt3 })).items.every(i => i.simples === undefined)).toBe(true)
  })
})

describe('NFE.E5.P6 — ponte: o que os gates mostraram que faltava', () => {
  const fact = (itemId: number, over: Partial<ItemSimplesFact> = {}): ItemSimplesFact => ({
    itemId, activityCode: '01', competence: '2027-01', ibsRate: '0.1000', cbsRate: '0.9000', baseValue: '3000.00', ibsValue: '3.00', cbsValue: '27.00', classificationCode: '000001', ...over,
  })
  const at = (dhEmi: string, over: Partial<NfeInputSources> = {}) => sources({
    dhEmi, header: { ...sources().header, dtEmission: dhEmi.slice(0, 10) },
    payments: { billing: sources().payments.billing, installments: [{ parcel: 1, dueDate: '2027-03-20', value: '4000.00', paymentTypeId: 4, nfePaymentCode: '15' }] },
    simples: [fact(10), fact(30, { baseValue: '1000.00', ibsValue: '1.00', cbsValue: '9.00' })], ...over,
  })
  it('a fronteira na PONTE: 01/01/2027T00:00:00 já leva o grupo; 31/12/2026T23:59:59 não (a mutação >= → > da ponte morre)', () => {
    expect(nfeInputFromFacts(at('2027-01-01T00:00:00-03:00', { header: { ...sources().header, dtEmission: '2027-01-01' } })).items.every(i => i.simples !== undefined)).toBe(true)
    expect(nfeInputFromFacts(sources({ dhEmi: '2026-12-31T23:59:59-03:00', simples: [fact(10), fact(30)] })).items.every(i => i.simples === undefined)).toBe(true)
  })
  it('competência diferente do mês da emissão, linha duplicada do item e valor ausente → violação (nada de silêncio)', () => {
    const at15 = (s: ItemSimplesFact[]) => at('2027-01-15T10:15:30-03:00', { simples: s })
    expect(violations(at15([fact(10, { competence: '2026-12' }), fact(30)]))).toEqual(['det[10].simples: A competência do percentual congelado é diferente do mês da emissão (A-IB138a)'])
    expect(violations(at15([fact(10), fact(10), fact(30)]))).toEqual(['det[10].simples: Mais de uma linha do IBS/CBS do Simples para o item'])
    expect(violations(at15([fact(10, { baseValue: null as unknown as string }), fact(30)]))).toEqual(['det[10].simples: Linha do IBS/CBS do Simples com valor ausente'])
  })
  it('a leitura que não é lista (ou traz null) não derruba a ponte: o builder recusa o item sem o grupo', () => {
    expect(nfeInputFromFacts(at('2027-01-15T10:15:30-03:00', { simples: null as unknown as ItemSimplesFact[] })).items.every(i => i.simples === undefined)).toBe(true)
  })
})

describe('NFE.E5.P6 — ponte: a devolução de 2027 copia o grupo do XML da origem (D-NE288, D-NE289, S6)', () => {
  const ORIGIN_KEY = saleKey({ emissionDate: '2027-01-15' })
  const RET_KEY = saleKey({ number: 16, cnf: '70531942', emissionDate: '2027-01-05' })
  const entries = (g: boolean) => new Map([[1, { qCom: '2.0000', simples: g ? simplesFor(0) : null }], [2, { qCom: '3', simples: g ? simplesFor(1) : null }]])
  const originsOf = (simples?: ReturnType<typeof entries>) => new Map([[originRef(4000, 0), { accessKey: ORIGIN_KEY, numbering: numberItems([10, 30]), ...(simples ? { simples } : {}) }]])
  const returned = (itemId: number, q: string, u: string) => item(itemId, { kind: 'Adjust', quantity: q, unitValue: u, icms: { ...item(itemId).icms, cfopId: '1201', credCalcAliq: '0.00', credExplValue: '0.00', approximateTax: '0.00' } })
  const src = (q1: string, simples?: ReturnType<typeof entries>): NfeInputSources => sources({
    dhEmi: '2027-01-05T09:00:00-03:00', header: { ...sources().header, invoiceId: 5002, dtEmission: '2027-01-05', totalValue: q1 === '2' ? '4000.00' : '2500.00', note: null },
    items: [returned(1, q1, '1500.000000'), returned(2, '3', '333.333333')], operationNature: 'Devolução de venda de produção do estabelecimento',
    returnOrigins: [
      { itemId: 1, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 0, originItemId: 10, originKind: 'Sale' },
      { itemId: 2, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 0, originItemId: 30, originKind: 'Sale' },
    ],
    origins: originsOf(simples),
  })
  it('origem com o grupo, devolução da quantidade inteira → o grupo é copiado, o total soma o grupo e o XML passa no XSD', async () => {
    const input = nfeInputFromFacts(src('2', entries(true)))
    expect(input.items.map(i => i.simples)).toEqual([simplesFor(0), simplesFor(1)])
    const built = buildNfeXml(input, RET_KEY)
    expect(built.xml).toContain('<IBSCBSTot><vBCIBSCBS>4000.00</vBCIBSCBS><gTribSN><vIBSSN>4.00</vIBSSN><vCBSSN>36.00</vCBSSN></gTribSN></IBSCBSTot>')
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })
  it('origem de 2026 (sem grupo) → a devolução de 2027 sai SEM o grupo (D-NE289), válida no XSD', async () => {
    const input = nfeInputFromFacts(src('2', entries(false)))
    expect(input.items.map(i => i.simples)).toEqual([null, null])
    const built = buildNfeXml(input, RET_KEY)
    expect(built.xml).not.toMatch(/<(IBSCBS|IBSCBSTot|cAtivSN|gTribSN)[\s>/]/)
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })
  it('S6: devolução PARCIAL de item que leva o grupo é recusada; parcial de item sem grupo passa', () => {
    expect(violations(src('1', entries(true)))).toEqual(['det[1].qCom: Devolução parcial de item com o grupo do Simples — fora-do-primeiro-release'])
    expect(violations(src('1', entries(false)))).toEqual([])
  })
  it('origem sem a leitura do grupo, ou sem o item no XML → violação; a composição de 2026 não precisa dela', () => {
    expect(violations(src('2'))).toEqual([
      'det[1].origin: O grupo do Simples da nota de origem não foi lido do XML autorizado (D-NE288)', 'det[2].origin: O grupo do Simples da nota de origem não foi lido do XML autorizado (D-NE288)'])
    expect(violations(src('2', new Map([[1, { qCom: '2.0000', simples: null }]])))).toEqual(['det[2].origin: O item de origem não está no XML autorizado da nota de origem'])
  })
})
