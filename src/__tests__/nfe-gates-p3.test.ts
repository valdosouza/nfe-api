/**
 * G3 — os achados dos gates do NFE.E5.P3 viram sondas permanentes (socrático 0,74 · adversarial 0,74, sem HIGH — 2026-11-24). O gate
 * adversarial matou 133 de 180 mutações; as sondas abaixo fecham as barreiras que ficaram sem prova e os defeitos corrigidos.
 */
import type { MerchandiseItemFact, PartyFact } from '../facts/merchandise-facts'
import { validateMessage } from '../authority/xsd'
import { buildAccessKey } from '../nfe/access-key'
import { numberItems } from '../nfe/item-numbering'
import { buildNfeXml, type NfeInput, type NfeItemInput } from '../nfe/nfe-builder'
import { nfeInputFromFacts, originRef, type NfeInputSources } from '../nfe/nfe-input'
import { assertReturnMatchesOrigin, type ReturnItemCheck } from '../nfe/return-reference'
import { CLIENT_CNPJ, saleInput, saleItem, saleKey, signNfe, SETES_CNPJ } from './nfe-fixtures'

jest.setTimeout(60_000)

const KEY = saleKey()
const fieldsOf = (fn: () => unknown): string[] => {
  try { fn() } catch (e: any) { return e.statusCode === 422 ? (e.fields ?? []).map((f: any) => `${f.field}: ${f.message}`) : [`NÃO TIPADO: ${e.constructor?.name}: ${e.message}`] }
  return []
}
const built = (input: NfeInput, key = KEY): string[] => fieldsOf(() => buildNfeXml(input, key))
const base = saleInput()

describe('G3 [FIXED] builder — o que não fecha vira RECUSA, nunca XML que o XSD rejeita', () => {
  it('PIS/COFINS "Outr": só os CST que o XSD enumera (57 a 59, 68, 69 e 76 a 97 ficam fora)', async () => {
    for (const cst of ['57', '58', '59', '68', '69', '76', '97', '10', '48']) {
      expect(built(saleInput({ items: [saleItem(0, { pis: { CST: cst } }), saleItem(1)] }))).toEqual([`det[10].pis.CST: CST ${cst} — fora-do-primeiro-release`])
    }
    for (const cst of ['49', '56', '60', '67', '70', '75', '98', '99']) {
      const input = saleInput({ items: [saleItem(0, { pis: { CST: cst }, cofins: { CST: cst } }), saleItem(1)] })
      expect(await validateMessage('NFe', signNfe(buildNfeXml(input, KEY)))).toEqual({ ok: true })
    }
  })

  it('mais de 990 itens → recusa (rej. 927)', () => {
    const numbered = numberItems(Array.from({ length: 991 }, (_, i) => i + 1)).items
    const items = numbered.map(n => saleItem(0, { numbered: n, vProdCents: 100, qCom: '1', vUnCom: '1', qTrib: '1', vUnTrib: '1', vTotTribCents: 0 }))
    expect(built(saleInput({ items, erpTotalCents: 99100, installments: [], payments: [{ tPag: '01', cents: 99100 }] }))).toContain('det: Mais de 990 itens (rej. 927)')
  })

  it('devolução: nItem da origem fora de 1 a 990 → recusa', () => {
    const ret = (nItem: number) => saleInput({
      tpNF: '0', finNFe: '4', installments: [], payments: [{ tPag: '90', cents: 0 }],
      items: [saleItem(0, { CFOP: '1201', origin: { accessKey: KEY, numbered: { itemId: 10, nItem } } }), saleItem(1, { CFOP: '1201', origin: { accessKey: KEY, numbered: { itemId: 30, nItem: 2 } } })],
    })
    for (const n of [0, 991, 1.5, NaN, -1]) expect(built(ret(n))[0]).toMatch(/^det\[10\]\.origin: Valor inválido \(texto-invalido: item da nota de origem fora de 1 a 990\)/)
    expect(built(ret(990))).toEqual([])
  })

  it('CFOP fora do padrão do leiaute, vencimento e data de emissão inexistentes no calendário, mais de 100 formas de pagamento', () => {
    for (const cfop of ['0101', '4101', '8101', '9999']) expect(built(saleInput({ items: [saleItem(0, { CFOP: cfop }), saleItem(1)] }))[0]).toMatch(/^det\[10\]\.CFOP: Valor inválido/)
    expect(built(saleInput({ installments: [{ dueDate: '2027-02-30', cents: 400000 }] }))).toEqual(['cobr.dup[1].dVenc: Vencimento fora da forma AAAA-MM-DD ou inexistente no calendário'])
    expect(built(saleInput({ dhEmi: '2026-11-31T10:00:00-03:00', installments: [] }))).toEqual(['ide.dhEmi: Data da emissão inexistente no calendário'])
    const many = Array.from({ length: 101 }, () => ({ tPag: '01', cents: 0 }))
    expect(built(saleInput({ payments: [...many.slice(0, 100), { tPag: '01', cents: 400000 }] }))).toContain('pag: Mais de 100 formas de pagamento')
  })

  it('opcional só com espaços é AUSENTE (complemento em branco não bloqueia a nota)', async () => {
    const input = saleInput({ emit: { ...base.emit, xFant: '   ' }, dest: { ...base.dest, ender: { ...base.dest.ender, xCpl: ' ' } } })
    const xml = buildNfeXml(input, KEY).xml
    expect(xml).not.toMatch(/<xFant>|<xCpl>/)
    expect(await validateMessage('NFe', signNfe(buildNfeXml(input, KEY)))).toEqual({ ok: true })
  })

  it('a rej. 600 (CSOSN 101 × não contribuinte) só vale na SAÍDA: a devolução para pessoa física com CSOSN 101 monta', () => {
    const input = saleInput({
      tpNF: '0', finNFe: '4', indFinal: '1', installments: [], payments: [{ tPag: '90', cents: 0 }],
      dest: { CPF: '52998224725', xNome: 'Fulano de Tal', ender: base.dest.ender, indIEDest: '9' },
      items: [saleItem(0, { CFOP: '1201', origin: { accessKey: KEY, numbered: { itemId: 10, nItem: 1 } } }), saleItem(1, { CFOP: '1201', origin: { accessKey: KEY, numbered: { itemId: 30, nItem: 2 } } })],
    })
    expect(built(input, saleKey({ number: 16, cnf: '70531942' }))).toEqual([])
  })

  it('transportadora com IE e sem UF → recusa (rej. 559)', () => {
    expect(built(saleInput({ transp: { modFrete: '1', carrier: { CNPJ: '11444777000161', xNome: 'TRANSPORTES Y', IE: '123456789' } } })))
      .toEqual(['transp.carrier.UF: Transportadora com IE exige a UF (rej. 559)'])
  })

  it('contingência (tpEmis ≠ 1 na chave) → recusa; indPres 9 leva o indIntermed', () => {
    const contingency = buildAccessKey({ uf: 'PR', emissionDate: '2026-11-24', cnpj: SETES_CNPJ, model: '55', serie: 1, number: 15, emissionType: 6, cnf: '48213057' })
    expect(built(saleInput(), contingency)).toEqual(['ide.tpEmis: Emissão em contingência — fora-do-primeiro-release'])
    expect(buildNfeXml(saleInput({ indPres: '9' }), KEY).xml).toContain('<indPres>9</indPres><indIntermed>0</indIntermed>')
    expect(buildNfeXml(saleInput({ indPres: '1' }), KEY).xml).toContain('<indPres>1</indPres><procEmi>')
  })

  it('forma errada da entrada (null, tipo trocado) → 422 tipado com o caminho, nunca TypeError', () => {
    const broken: [Partial<Record<keyof NfeInput, unknown>>, string][] = [
      [{ emit: null }, 'emit'], [{ dest: null }, 'dest'], [{ items: null }, 'det'], [{ payments: null }, 'pag'], [{ installments: null }, 'cobr'], [{ transp: null }, 'transp'],
      [{ techResponsible: null }, 'infRespTec'], [{ note: 5 }, 'ide.note'], [{ natOp: {} }, 'ide.natOp'],
      [{ emit: { ...base.emit, ender: null } }, 'emit.ender'], [{ items: [{ ...saleItem(0), icms: null }, saleItem(1)] }, 'det[#1].icms'],
      [{ items: [{ ...saleItem(0), pis: { CST: 7 } }, saleItem(1)] }, 'det[#1].pis.CST'], [{ items: [{ ...saleItem(0), numbered: null }, saleItem(1)] }, 'det[#1].numbered'],
      [{ payments: [{ tPag: 15, cents: 400000 }] }, 'pag.detPag[1].tPag'],
    ]
    for (const [over, field] of broken) expect(built(saleInput(over as Partial<NfeInput>))).toContain(`${field}: Entrada malformada`)
    expect(fieldsOf(() => buildNfeXml(null as any, KEY))).toEqual(['entrada: Entrada malformada'])
  })

  it('a recusa do responsável técnico tem mensagem FIXA (nunca repassa a mensagem de um erro qualquer)', () => {
    const leaky = { get cnpj(): string { throw new Error('SEGREDO-DO-GETTER') }, contactName: 'x', email: 'a@b.cd', phone: '4133334444' }
    const out = built(saleInput({ techResponsible: leaky as any }))
    expect(out).toEqual(['infRespTec: Valor inválido (texto-invalido: dados do responsável técnico inválidos)'])
    expect(out.join(' ')).not.toContain('SEGREDO')
  })

  it('soma de totais fora do limite → 422 tipado, não erro interno', () => {
    const huge = (i: 0 | 1) => saleItem(i, { vProdCents: 9_000_000_000_000_000, vTotTribCents: 0 })
    expect(built(saleInput({ items: [huge(0), huge(1)], installments: [] }))[0]).toMatch(/^(total: Soma dos itens fora do limite|det\[10\]\.vProd: Valor inválido)/)
  })
})

describe('G3 [FIXED] dinheiro — cada parcela no campo certo (mutações de troca de campo sobreviviam)', () => {
  const input = saleInput({
    items: [
      saleItem(0, { vFreteCents: 1500, vSegCents: 700, vDescCents: 500, vOutroCents: 100 }),
      saleItem(1, { pis: { CST: '49', vBC: '1000.00', pAliq: '0.65', value: '6.50' }, cofins: { CST: '49', vBC: '1000.00', pAliq: '3.00', value: '30.00' } }),
    ],
    erpTotalCents: 400000 + 1500 + 700 - 500 + 100,
    installments: [{ dueDate: '2026-11-24', cents: 100000 }, { dueDate: '2026-12-22', cents: 301800 }],
    payments: [{ tPag: '01', cents: 100000 }, { tPag: '15', cents: 301800 }],
  })

  it('item e total: frete, seguro, desconto e outras despesas distintos; PIS ≠ COFINS; o vNF pela fórmula — e a nota é válida', async () => {
    const xml = buildNfeXml(input, KEY).xml
    expect(xml).toContain('<vProd>3000.00</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>PC</uTrib><qTrib>2</qTrib><vUnTrib>1500</vUnTrib>'
      + '<vFrete>15.00</vFrete><vSeg>7.00</vSeg><vDesc>5.00</vDesc><vOutro>1.00</vOutro><indTot>1</indTot>')
    expect(xml).toContain('<PIS><PISOutr><CST>49</CST><vBC>1000.00</vBC><pPIS>0.65</pPIS><vPIS>6.50</vPIS></PISOutr></PIS>'
      + '<COFINS><COFINSOutr><CST>49</CST><vBC>1000.00</vBC><pCOFINS>3.00</pCOFINS><vCOFINS>30.00</vCOFINS></COFINSOutr></COFINS>')
    expect(xml).toContain('<vProd>4000.00</vProd><vFrete>15.00</vFrete><vSeg>7.00</vSeg><vDesc>5.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol>'
      + '<vPIS>6.50</vPIS><vCOFINS>30.00</vCOFINS><vOutro>1.00</vOutro><vNF>4018.00</vNF>')
    expect(xml).toContain('<pag><detPag><tPag>01</tPag><vPag>1000.00</vPag></detPag><detPag><tPag>15</tPag><vPag>3018.00</vPag></detPag></pag>')
    expect(await validateMessage('NFe', signNfe(buildNfeXml(input, KEY)))).toEqual({ ok: true })
  })

  it('a soma do pagamento é de TODAS as formas; vencimento igual à emissão é aceito; 120 duplicatas cabem e 121 não', () => {
    expect(built({ ...input, payments: [{ tPag: '01', cents: 100000 }, { tPag: '15', cents: 301799 }] }))
      .toEqual(['pag: A soma das formas de pagamento é diferente do total da nota (sem troco no 1º release)'])
    const dups = (n: number) => Array.from({ length: n }, (_, i) => ({ dueDate: '2026-12-22', cents: i === 0 ? 401800 - (n - 1) : 1 }))
    expect(built({ ...input, installments: dups(120) })).toEqual([])
    expect(built({ ...input, installments: dups(121) })).toContain('cobr: Mais de 120 duplicatas')
  })

  it('sem o seguro ou sem as outras despesas o vNF do ERP deixa de conferir (cada parcela entra na fórmula)', () => {
    for (const over of [{ vSegCents: 0 }, { vOutroCents: 0 }, { vFreteCents: 0 }, { vDescCents: 0 }] as Partial<NfeItemInput>[]) {
      const changed = { ...input, items: [{ ...input.items[0], ...over }, input.items[1]] }
      try { buildNfeXml(changed, KEY); throw new Error('não recusou') } catch (e: any) { expect(e.code).toBe('FISCAL_TOTALS_MOTOR_DEFECT') }
    }
  })
})

describe('G3 [FIXED] devolução × origem — endurecimento', () => {
  const NS = 'http://www.portalfiscal.inf.br/nfe'
  const ORIGIN_ITEMS = numberItems([10, 30]).items
  const prot = (key: string, cStat = '100') => `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>x</verAplic><chNFe>${key}</chNFe><dhRecbto>2026-11-24T10:16:00-03:00</dhRecbto>`
    + `<nProt>141260000000001</nProt><digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>${cStat}</cStat><xMotivo>ok</xMotivo></infProt></protNFe>`
  const signedSale = signNfe(buildNfeXml(saleInput(), KEY))
  const origin = `<nfeProc xmlns="${NS}" versao="4.00">${signedSale}${prot(KEY)}</nfeProc>`
  const check = (over: Partial<ReturnItemCheck> = {}, index: 0 | 1 = 0): ReturnItemCheck => ({
    itemId: index + 1, cProd: index === 0 ? '910' : '930', qCom: '1', vUnCom: index === 0 ? '1500' : '333.333333', origin: { accessKey: KEY, numbered: ORIGIN_ITEMS[index] }, ...over,
  })
  const run = (items: ReturnItemCheck[], xml = origin) => fieldsOf(() => assertReturnMatchesOrigin(items, xml, SETES_CNPJ))

  it('dois itens da devolução no MESMO item da origem somam: 1 + 1 de 2 confere; 2 + 2 de 2 não', () => {
    expect(run([check(), check({ itemId: 2 })])).toEqual([])
    expect(run([check({ qCom: '2' }), check({ itemId: 2, qCom: '2' })])).toEqual(['det[2]: Não confere com o item 1 da nota de origem: quantidade maior que a da origem'])
    expect(run([check({ qCom: '1.5' }), check({ itemId: 2, qCom: '0.5001' })])).toEqual(['det[2]: Não confere com o item 1 da nota de origem: quantidade maior que a da origem'])
  })

  it('quantidade devolvida zero ou negativa, e valor unitário ilegível ou menor, são recusados', () => {
    for (const q of ['0', '0.0000', '-1', '-999999']) expect(run([check({ qCom: q })])).toEqual(['det[1]: Não confere com o item 1 da nota de origem: quantidade'])
    for (const u of [null, 'abc', '1499.999999']) expect(run([check({ vUnCom: u as any })])).toEqual(['det[1]: Não confere com o item 1 da nota de origem: valor unitário'])
  })

  it('a forma do procNFe é fixa: protocolo dentro do infNFe, duas NF-e, det repetido, raiz que não é nfeProc → recusa', () => {
    const inside = `<nfeProc xmlns="${NS}" versao="4.00">${signedSale.replace('</infNFe>', `${prot(KEY)}</infNFe>`)}</nfeProc>`
    expect(run([check()], inside)[0]).toMatch(/^origin: A nota de origem não tem o protocolo de autorização dela/)
    expect(run([check()], `<nfeProc xmlns="${NS}" versao="4.00">${signedSale}${signedSale}${prot(KEY)}</nfeProc>`)).toEqual(['origin: O XML da origem deve ser um procNFe com exatamente uma NF-e'])
    expect(run([check()], `<outro xmlns="${NS}">${signedSale}${prot(KEY)}</outro>`)).toEqual(['origin: O XML da origem deve ser um procNFe com exatamente uma NF-e'])
    expect(run([check()], signedSale)).toEqual(['origin: O XML da origem deve ser um procNFe com exatamente uma NF-e'])
    const firstDet = /<det nItem="1">[\s\S]*?<\/det>/.exec(signedSale)![0]
    const duplicated = `<nfeProc xmlns="${NS}" versao="4.00">${signedSale.replace(firstDet, firstDet + firstDet)}${prot(KEY)}</nfeProc>`
    expect(run([check()], duplicated)).toEqual(['origin: A nota de origem tem item repetido'])
    expect(run([check()], `<nfeProc xmlns="${NS}" versao="4.00">${signedSale}${prot(KEY)}${prot(KEY)}</nfeProc>`)[0]).toMatch(/protocolo de autorização/)
  })

  it('a origem tem de ser uma VENDA: outra devolução (ou nota de entrada) não serve de origem', () => {
    const returnKey = saleKey({ number: 16, cnf: '70531942' })
    const asReturn = saleInput({
      tpNF: '0', finNFe: '4', installments: [], payments: [{ tPag: '90', cents: 0 }],
      items: [saleItem(0, { CFOP: '1201', origin: { accessKey: KEY, numbered: ORIGIN_ITEMS[0] } }), saleItem(1, { CFOP: '1201', origin: { accessKey: KEY, numbered: ORIGIN_ITEMS[1] } })],
    })
    const xml = `<nfeProc xmlns="${NS}" versao="4.00">${signNfe(buildNfeXml(asReturn, returnKey))}${prot(returnKey)}</nfeProc>`
    expect(run([check({ origin: { accessKey: returnKey, numbered: ORIGIN_ITEMS[0] } })], xml)).toEqual(['origin: A nota de origem não é uma venda (saída, finalidade normal)'])
  })

  it('elemento de OUTRO namespace com o nome certo não serve: prod e det falsos são ignorados e o verdadeiro é que vale', () => {
    const fakeProd = signedSale.replace('<det nItem="1"><prod>', '<det nItem="1"><x:prod xmlns:x="urn:outro"><x:cProd>999</x:cProd></x:prod><prod>')
    expect(run([check({ cProd: '999' })], `<nfeProc xmlns="${NS}" versao="4.00">${fakeProd}${prot(KEY)}</nfeProc>`)).toEqual(['det[1]: Não confere com o item 1 da nota de origem: código do produto'])
  })
})

describe('G3 [FIXED] ponte — dois fatos que podem discordar não se escolhem calados', () => {
  const NIL = { determBase: null, determBaseSt: null, discharge: null, aliqRdBase: null, baseValue: '0', aliq: '0', aliqRd: null, value: '0', aliqRdBaseSt: null, baseValueSt: null,
    aliqSt: null, aliqRdSt: null, valueSt: null, mva: null, withheldBaseValue: null, withheldValue: null, withheldBaseValueSt: null, withheldValueSt: null, operationValue: null, deferredAliq: null, deferredValue: null }
  const contribution = (cst: string) => ({ cst, baseValue: '0.00', aliqValue: '0.00', tagValue: '0.00', qtSaleQtty: null, qtAliqValue: null })
  const item = (itemId: number, over: Partial<MerchandiseItemFact> = {}): MerchandiseItemFact => ({
    itemId, kind: 'Sale', merchandiseId: 900 + itemId, description: `Peça ${itemId}`, ncm: '73259990', cest: null, source: '0', manufScale: 'S', factoryCnpj: null,
    saleUnit: { level: 1, measureAbbreviation: 'PC', factor: '1.000000', gtin: null }, taxableUnit: { level: 1, measureAbbreviation: 'PC', factor: '1.000000', gtin: null },
    quantity: '2', unitValue: '500.000000', discountValue: '4.000000', approxTaxAliq: null,
    icms: { ...NIL, cst: '102', origin: '2', cfopId: '5101', credCalcAliq: null, credExplValue: null, freightValue: '15.00', insuranceValue: '7.00', expensesValue: '1.00', approximateTax: '9.00' },
    fcp: null, ipi: null, pis: contribution('07'), cofins: contribution('08'), ...over,
  })
  const address = (stateCode: string, cityIbge: string) => ({ kind: 'C', main: 'S', street: 'Rua A', number: '100', complement: null, neighborhood: 'Centro', zipCode: '81925530', cityName: 'Cidade', cityIbge, stateCode })
  const party = (entityId: number, cnpj: string, stateCode = 'PR', cityIbge = '4106902'): PartyFact => ({
    entityId, nameCompany: `RAZAO ${entityId}`, nickTrade: `FANTASIA ${entityId}`, cnpj, cpf: null, stateRegistration: '9053273308', addresses: [address(stateCode, cityIbge)],
    tax: { taxRegime: '1 - Simples Nacional', crt: '1', indIeDest: '1', consumer: 'N' },
  })
  const src = (over: Partial<NfeInputSources> = {}): NfeInputSources => ({
    environment: '2', dhEmi: '2026-11-24T10:15:30-03:00',
    header: { invoiceId: 5001, number: null, serie: '1', model: '55', dtEmission: '2026-11-24', entityId: 321, status: '0', note: null, totalValue: '1019.00', indPres: 3 },
    items: [item(10)], operationNature: 'Venda', emitter: party(98, SETES_CNPJ), recipient: party(321, CLIENT_CNPJ),
    payments: { billing: { paymentTypeId: 1, nfePaymentCode: '01', plots: null, deadline: null }, installments: [] },
    shipping: { freightMode: '0', carrierId: null, carrier: null }, returnOrigins: [],
    techResponsible: { cnpj: SETES_CNPJ, contactName: 'Suporte Setes', email: 'suporte@setes.example', phone: '4133334444' }, ...over,
  })
  const violations = (s: NfeInputSources) => fieldsOf(() => nfeInputFromFacts(s))

  it('cada fato no campo certo: frete ≠ seguro ≠ outras ≠ desconto ≠ tributos; origem do CÁLCULO (não a do cadastro); razão ≠ fantasia', async () => {
    const input = nfeInputFromFacts(src())
    expect(input.items[0]).toMatchObject({ vProdCents: 100000, vDescCents: 400, vFreteCents: 1500, vSegCents: 700, vOutroCents: 100, vTotTribCents: 900,
      icms: { orig: '2', CSOSN: '102' }, pis: { CST: '07' }, cofins: { CST: '08' } })
    expect([input.emit.xNome, input.emit.xFant, input.dest.xNome]).toEqual(['RAZAO 98', 'FANTASIA 98', 'RAZAO 321'])
    expect([input.dest.CNPJ, input.dest.CPF]).toEqual([CLIENT_CNPJ, null])
    expect(await validateMessage('NFe', signNfe(buildNfeXml(input, KEY)))).toEqual({ ok: true })
  })

  it('idDest (do CFOP) × UF real do destinatário: interna com outra UF (rej. 773) e interestadual com a mesma UF (rej. 772)', () => {
    expect(violations(src({ recipient: party(321, CLIENT_CNPJ, 'SP', '3550308') }))).toEqual(['ide.idDest: CFOP de operação interna com destinatário de outra UF (rej. 773)'])
    expect(violations(src({ items: [item(10, { icms: { ...item(10).icms, cfopId: '6101' } })] }))).toEqual(['ide.idDest: CFOP de operação interestadual com destinatário da mesma UF (rej. 772)'])
    expect(nfeInputFromFacts(src({ items: [item(10, { icms: { ...item(10).icms, cfopId: '6101' } })], recipient: party(321, CLIENT_CNPJ, 'SP', '3550308') })).idDest).toBe('2')
  })

  it('GTIN só numa das unidades (rej. 885, 886) → violação; nas duas ou em nenhuma → passa', () => {
    const units = (sale: string | null, tax: string | null) => item(10, { quantity: '1', unitValue: '1000.000000', discountValue: '4.000000',
      saleUnit: { level: 2, measureAbbreviation: 'CX', factor: '10.000000', gtin: sale }, taxableUnit: { level: 1, measureAbbreviation: 'UN', factor: '1.000000', gtin: tax } })
    expect(violations(src({ items: [units('17891234567892', null)] }))).toEqual(['det[10].cEANTrib: GTIN informado só numa das unidades, comercial ou tributável (rej. 885, 886)'])
    expect(violations(src({ items: [units(null, '7891234567895')] }))).toEqual(['det[10].cEANTrib: GTIN informado só numa das unidades, comercial ou tributável (rej. 885, 886)'])
    expect(violations(src({ items: [units('17891234567892', '7891234567895')] }))).toEqual([])
  })

  it('parcela sem valor, total vazio, desconto negativo e dois elos no mesmo item → violações (nada vira zero calado)', () => {
    expect(violations(src({ payments: { billing: null, installments: [{ parcel: 1, dueDate: '2026-12-22', value: '', paymentTypeId: 1, nfePaymentCode: '01' }] } })))
      .toEqual(['cobr.dup[1].vDup: Parcela sem valor'])
    expect(violations(src({ header: { ...src().header, totalValue: '' } }))).toContain('total.vNF: O faturamento não gravou o total da nota')
    expect(violations(src({ items: [item(10, { discountValue: '-4.000000' })] }))).toEqual(['det[10].vDesc: Desconto negativo'])
    const link = { itemId: 10, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 0, originItemId: 10, originKind: 'Sale' }
    const origins = new Map([[originRef(4000, 0), { accessKey: KEY, numbering: numberItems([10]) }]])
    expect(violations(src({ items: [item(10, { icms: { ...item(10).icms, cfopId: '1201' } })], returnOrigins: [link, { ...link, originItemId: 10 }], origins })))
      .toContain('det[10].origin: Item de devolução com mais de um elo de origem')
  })

  it('a nota de origem é achada por id E terminal: o mesmo id em outro terminal não serve', () => {
    const link = { itemId: 10, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 3, originItemId: 10, originKind: 'Sale' }
    const ret = (origins: Map<string, { accessKey: string; numbering: ReturnType<typeof numberItems> }>) =>
      src({ items: [item(10, { icms: { ...item(10).icms, cfopId: '1201' } })], returnOrigins: [link], origins })
    expect(violations(ret(new Map([[originRef(4000, 0), { accessKey: KEY, numbering: numberItems([10]) }]])))).toEqual(['det[10].origin: A nota de origem do item não tem NF-e autorizada conhecida'])
    expect(nfeInputFromFacts(ret(new Map([[originRef(4000, 3), { accessKey: KEY, numbering: numberItems([10]) }]]))).items[0].origin).toEqual({ accessKey: KEY, numbered: { itemId: 10, nItem: 1 } })
  })

  it('S11 no meio centavo: 7 × 0,305 = 2,135 → 2,14 (meio para cima, exato); o ponto flutuante do faturamento daria 2,13', () => {
    const i = nfeInputFromFacts(src({ items: [item(10, { quantity: '7', unitValue: '0.305', discountValue: null, icms: { ...item(10).icms, freightValue: null, insuranceValue: null, expensesValue: null } })], header: { ...src().header, totalValue: '2.14' } })).items[0]
    expect([i.vProdCents, i.vDescCents]).toEqual([214, 0])
  })
})
