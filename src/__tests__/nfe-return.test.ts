/**
 * NFE.E5.P3.T3 — a devolução (finNFe 4) referencia a origem por item, sai com tPag 90 e sem cobrança, e recusa a divergência com o procNFe
 * da origem (D-NE48, D-NE103, D-NE219; RF-DEV-03, proposta RF-DEV-05; ficha-nfe-e5-p3-builder-nfe.md §6-6 e S6).
 * A origem do teste é montada AQUI: a venda do builder, assinada com o A1 de teste, embrulhada num `nfeProc` com um `protNFe` de exemplo.
 */
import { ELEMENT, elementsOf, parseXml } from 'fiscal-api'
import { validateMessage } from '../authority/xsd'
import { numberItems } from '../nfe/item-numbering'
import { buildNfeXml, type NfeInput, type NfeItemInput } from '../nfe/nfe-builder'
import { assertReturnMatchesOrigin, readOriginSimples, type ReturnItemCheck } from '../nfe/return-reference'
import { CLIENT_CNPJ, sale2027, saleInput, saleItem, saleKey, signNfe, simplesFor, SETES_CNPJ } from './nfe-fixtures'

jest.setTimeout(60_000)

const NS = 'http://www.portalfiscal.inf.br/nfe'
const ORIGIN_KEY = saleKey()                                                   // a venda nº 15
const RETURN_KEY = saleKey({ number: 16, cnf: '70531942' })
const ORIGIN_ITEMS = numberItems([10, 30]).items                               // nItem 1 e 2 da origem

const procNfe = (signedNfe: string, key = ORIGIN_KEY, cStat = '100'): string =>
  `<nfeProc xmlns="${NS}" versao="4.00">${signedNfe}<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>PR-v4</verAplic><chNFe>${key}</chNFe>`
  + `<dhRecbto>2026-11-24T10:16:00-03:00</dhRecbto><nProt>141260000000001</nProt><digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>${cStat}</cStat>`
  + '<xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>'
const ORIGIN = () => procNfe(signNfe(buildNfeXml(saleInput(), ORIGIN_KEY)))

/** A devolução de 1 das 2 flanges (item 10 da origem) e das 3 buchas (item 30): nota de ENTRADA do mesmo emitente. */
const RETURN_NUMBERED = numberItems([1, 2]).items
const returnItem = (index: 0 | 1, over: Partial<NfeItemInput> = {}): NfeItemInput => ({
  ...saleItem(index),
  numbered: RETURN_NUMBERED[index], CFOP: '1201',
  qCom: index === 0 ? '1' : '3', qTrib: index === 0 ? '1' : '3', vProdCents: index === 0 ? 150000 : 100000, vTotTribCents: 0,
  icms: { orig: '0', CSOSN: '101', pCredSN: '0.00', vCredICMSSN: '0.00' },
  origin: { accessKey: ORIGIN_KEY, numbered: ORIGIN_ITEMS[index] },
  ...over,
})
const returnInput = (over: Partial<NfeInput> = {}): NfeInput => saleInput({
  natOp: 'Devolução de venda de produção do estabelecimento', dhEmi: '2026-11-25T09:00:00-03:00', tpNF: '0', finNFe: '4',
  items: [returnItem(0), returnItem(1)], erpTotalCents: 250000, installments: [], payments: [{ tPag: '90', cents: 0 }], note: null,
  ...over,
})
const checks = (over: Partial<ReturnItemCheck>[] = []): ReturnItemCheck[] => [returnItem(0), returnItem(1)].map((it, i) => ({
  itemId: it.numbered.itemId, cProd: it.cProd, qCom: it.qCom, vUnCom: it.vUnCom, origin: it.origin!, ...(over[i] ?? {}),
}))
const mismatch = (fn: () => void): { status?: number; code?: string; fields: string[] } => {
  try { fn() } catch (e: any) { return { status: e.statusCode, code: e.code, fields: (e.fields ?? []).map((f: any) => `${f.field}: ${f.message}`) } }
  return { fields: ['(não recusou)'] }
}
const refusedFields = (input: NfeInput): string[] => mismatch(() => buildNfeXml(input, RETURN_KEY)).fields

describe('NFE.E5.P3.T3 — o XML da devolução', () => {
  it('nota de entrada, finNFe 4, referência por item, tPag 90 com vPag 0.00, sem cobrança e sem NFref → passa no XSD local, assinada', async () => {
    const built = buildNfeXml(returnInput(), RETURN_KEY)
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
    expect(built.xml).toContain('<tpNF>0</tpNF>')
    expect(built.xml).toContain('<finNFe>4</finNFe>')
    expect(built.xml).toContain('<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>')
    expect(built.xml).not.toMatch(/<cobr>|<NFref>|refNFe/)
  })

  it('DFeReferenciado (chave + nItem da ORIGEM) é o último filho de cada det', () => {
    const xml = buildNfeXml(returnInput(), RETURN_KEY).xml
    const dets = elementsOf(parseXml(xml), false).filter(e => e.nodeType === ELEMENT && (e.localName ?? e.nodeName) === 'det')
    const lastChild = (n: any) => { let last = null; for (let i = 0; i < n.childNodes.length; i++) if (n.childNodes[i].nodeType === ELEMENT) last = n.childNodes[i]; return last }
    expect(dets.map(d => (lastChild(d).localName ?? lastChild(d).nodeName))).toEqual(['DFeReferenciado', 'DFeReferenciado'])
    expect(xml).toContain(`</imposto><DFeReferenciado><chaveAcesso>${ORIGIN_KEY}</chaveAcesso><nItem>1</nItem></DFeReferenciado></det>`)
    expect(xml).toContain(`</imposto><DFeReferenciado><chaveAcesso>${ORIGIN_KEY}</chaveAcesso><nItem>2</nItem></DFeReferenciado></det>`)
  })

  it('o nItem referenciado é o da ORIGEM, não o da devolução (itens em outra ordem)', () => {
    const swapped = returnInput({ items: [returnItem(0, { ...saleItem(1), numbered: RETURN_NUMBERED[0], CFOP: '1201', vTotTribCents: 0, origin: { accessKey: ORIGIN_KEY, numbered: ORIGIN_ITEMS[1] } })], erpTotalCents: 100000 })
    expect(buildNfeXml(swapped, RETURN_KEY).xml).toContain(`<det nItem="1">`)
    expect(buildNfeXml(swapped, RETURN_KEY).xml).toContain(`<chaveAcesso>${ORIGIN_KEY}</chaveAcesso><nItem>2</nItem>`)
  })

  it('recusas: item sem origem, cobrança na devolução, pagamento diferente de 90/zero, devolução de saída, chave de origem malformada', () => {
    expect(refusedFields(returnInput({ items: [returnItem(0, { origin: null }), returnItem(1)] }))).toContain('det[1].origin: Devolução sem a nota de origem do item')
    expect(refusedFields(returnInput({ installments: [{ dueDate: '2026-12-25', cents: 250000 }] }))).toContain('cobr: Devolução não leva cobrança (D-NE48)')
    expect(refusedFields(returnInput({ payments: [{ tPag: '01', cents: 250000 }] }))).toContain('pag: Devolução: forma de pagamento 90 (sem pagamento) com valor zero (rej. 871, 904)')
    expect(refusedFields(returnInput({ tpNF: '1' }))).toContain('ide.tpNF: Devolução de saída (a fornecedor) — fora-do-primeiro-release')
    expect(refusedFields(returnInput({ items: [returnItem(0, { origin: { accessKey: ORIGIN_KEY.slice(0, 43) + 'X', numbered: ORIGIN_ITEMS[0] } }), returnItem(1)] }))[0])
      .toMatch(/^det\[1\]\.origin: Valor inválido \(texto-invalido: chave da nota de origem fora da forma\)/)
  })

  it('origem informada numa venda (finNFe 1) é recusada', () => {
    expect(mismatch(() => buildNfeXml(saleInput({ items: [saleItem(0, { origin: { accessKey: ORIGIN_KEY, numbered: ORIGIN_ITEMS[0] } }), saleItem(1)] }), saleKey())).fields)
      .toContain('det[10].origin: Nota de origem informada numa nota que não é devolução')
  })
})

describe('NFE.E5.P3.T3 — a devolução confere com o procNFe da origem (D-NE103)', () => {
  it('devolução parcial do item 1 e total do item 2 → confere', () => {
    expect(() => assertReturnMatchesOrigin(checks(), ORIGIN(), SETES_CNPJ)).not.toThrow()
  })

  it('valor unitário igual em outra escrita decimal (1500 × 1500.000000) confere', () => {
    expect(() => assertReturnMatchesOrigin(checks([{ vUnCom: '1500' }, { vUnCom: '333.3333330' }]), ORIGIN(), SETES_CNPJ)).not.toThrow()
  })

  it('cada divergência cita o item: produto, valor unitário, quantidade maior, item inexistente na origem', () => {
    const r = mismatch(() => assertReturnMatchesOrigin(checks([{ cProd: '911' }, { vUnCom: '333.333334' }]), ORIGIN(), SETES_CNPJ))
    expect([r.status, r.code]).toEqual([422, 'FISCAL_RETURN_REFERENCE_MISMATCH'])
    expect(r.fields).toEqual([
      'det[1]: Não confere com o item 1 da nota de origem: código do produto',
      'det[2]: Não confere com o item 2 da nota de origem: valor unitário',
    ])
    expect(mismatch(() => assertReturnMatchesOrigin(checks([{ qCom: '2.0001' }]), ORIGIN(), SETES_CNPJ)).fields)
      .toEqual(['det[1]: Não confere com o item 1 da nota de origem: quantidade maior que a da origem'])
    expect(mismatch(() => assertReturnMatchesOrigin(checks([{ origin: { accessKey: ORIGIN_KEY, numbered: { itemId: 99, nItem: 3 } } }]), ORIGIN(), SETES_CNPJ)).fields)
      .toEqual(['det[1]: A nota de origem não tem o item 3'])
    expect(mismatch(() => assertReturnMatchesOrigin(checks([{ qCom: null }, { cProd: null }]), ORIGIN(), SETES_CNPJ)).fields).toEqual([
      'det[1]: Não confere com o item 1 da nota de origem: quantidade',
      'det[2]: Não confere com o item 2 da nota de origem: código do produto',
    ])
  })

  it('o item que referencia OUTRA nota é recusado (nunca se chuta o par)', () => {
    const other = saleKey({ number: 99, cnf: '13572468' })
    expect(mismatch(() => assertReturnMatchesOrigin(checks([{ origin: { accessKey: other, numbered: ORIGIN_ITEMS[0] } }]), ORIGIN(), SETES_CNPJ)).fields)
      .toEqual(['det[1]: O item referencia outra nota de origem'])
  })

  it('origem emitida por outro estabelecimento → recusa (devolução de venda própria — rej. 1193)', () => {
    const r = mismatch(() => assertReturnMatchesOrigin(checks(), ORIGIN(), CLIENT_CNPJ))
    expect(r.code).toBe('FISCAL_RETURN_REFERENCE_MISMATCH')
    expect(r.fields[0]).toMatch(/^origin: A nota de origem foi emitida por outro estabelecimento/)
  })

  it('origem sem protocolo, com protocolo de outra chave, rejeitada, ilegível ou vazia → recusa', () => {
    const signed = signNfe(buildNfeXml(saleInput(), ORIGIN_KEY))
    const noProt = /^origin: A nota de origem não tem o protocolo de autorização dela/
    expect(mismatch(() => assertReturnMatchesOrigin(checks(), signed, SETES_CNPJ)).fields).toEqual(['origin: O XML da origem deve ser um procNFe com exatamente uma NF-e'])
    expect(mismatch(() => assertReturnMatchesOrigin(checks(), procNfe(signed, RETURN_KEY), SETES_CNPJ)).fields[0]).toMatch(noProt)
    expect(mismatch(() => assertReturnMatchesOrigin(checks(), procNfe(signed, ORIGIN_KEY, '110'), SETES_CNPJ)).fields[0]).toMatch(noProt)
    expect(mismatch(() => assertReturnMatchesOrigin(checks(), procNfe(signed, ORIGIN_KEY, '150'), SETES_CNPJ)).fields).toEqual(['(não recusou)'])
    expect(mismatch(() => assertReturnMatchesOrigin(checks(), '<nfeProc', SETES_CNPJ)).fields).toEqual(['origin: XML da nota de origem ilegível'])
    expect(mismatch(() => assertReturnMatchesOrigin([], ORIGIN(), SETES_CNPJ)).fields).toEqual(['origin: Devolução sem item para conferir'])
  })

  it('elemento de outro namespace com o mesmo nome não engana a conferência', () => {
    const forged = ORIGIN().replace('<protNFe versao="4.00">', `<x:det xmlns:x="urn:outro" nItem="1"><x:prod><x:cProd>911</x:cProd></x:prod></x:det><protNFe versao="4.00">`)
    expect(() => assertReturnMatchesOrigin(checks(), forged, SETES_CNPJ)).not.toThrow()
  })
})

describe('NFE.E5.P6 — o grupo do Simples da origem, lido do procNFe autorizado (D-NE288, D-NE289; S9)', () => {
  const s27 = sale2027()
  const origin27 = (mutate: (x: string) => string = x => x) => procNfe(mutate(signNfe(buildNfeXml(s27.input, s27.key))), s27.key)
  const group = (index: 0 | 1) => { const s = simplesFor(index); return { activity: s.activity, classification: s.classification, ibsRate: '0.10', cbsRate: '0.90', ibsCents: s.ibsCents, cbsCents: s.cbsCents, baseCents: s.baseCents } }
  it('origem de 2027: por nItem, o cAtivSN, o CST/cClassTrib, os percentuais, os valores e a base (vProd + frete + outras − desconto) do XML', () => {
    const map = readOriginSimples(origin27())
    expect([...map.keys()]).toEqual([1, 2])
    expect(map.get(1)).toEqual({ qCom: '2', simples: group(0) })
    expect(map.get(2)).toEqual({ qCom: '3', simples: group(1) })
  })
  it('a base do item sai do prod da origem: frete e outras despesas somam, desconto subtrai, o seguro fica fora (S9, S10)', () => {
    const withParcels = sale2027('2027-01-15T10:15:30-03:00', { items: [saleItem(0, { simples: simplesFor(0, { baseCents: 301000 }), vFreteCents: 2000, vOutroCents: 500, vDescCents: 1500, vSegCents: 700 }), saleItem(1, { simples: simplesFor(1) })], erpTotalCents: 401700, installments: [{ dueDate: '2027-02-20', cents: 401700 }], payments: [{ tPag: '15', cents: 401700 }] })
    const xml = procNfe(signNfe(buildNfeXml(withParcels.input, withParcels.key)), withParcels.key)
    expect(readOriginSimples(xml).get(1)?.simples?.baseCents).toBe(300000 + 2000 + 500 - 1500)
  })
  it('origem de 2026, sem o grupo → `simples: null` em todos os itens', () => {
    const map = readOriginSimples(ORIGIN())
    expect([...map.values()].map(x => x.simples)).toEqual([null, null])
  })
  it('grupo incompleto na origem (sem gCBSSN, sem cClassTrib) ou procNFe fora da forma → recusa citando o item', () => {
    const noCbs = readOriginSimples
    expect(mismatch(() => noCbs(origin27(x => x.replace(/<gCBSSN>.*?<\/gCBSSN>/, '')))).fields).toEqual(['origin.det[1]: O grupo do Simples da origem está incompleto ou malformado'])
    expect(mismatch(() => readOriginSimples(origin27(x => x.replace('<cClassTrib>000001</cClassTrib>', '')))).fields).toEqual(['origin.det[1]: O grupo do Simples da origem está incompleto ou malformado'])
    expect(mismatch(() => readOriginSimples('<NFe xmlns="http://www.portalfiscal.inf.br/nfe"></NFe>')).fields).toEqual(['origin: O XML da origem deve ser um procNFe com exatamente uma NF-e'])
    expect(mismatch(() => readOriginSimples('<x')).fields).toEqual(['origin: XML da nota de origem ilegível'])
  })
})

describe('NFE.E5.P6 — a leitura da origem recusa o que não espelha com fidelidade (gates)', () => {
  const s27 = sale2027()
  const origin27 = (mutate: (x: string) => string) => procNfe(mutate(signNfe(buildNfeXml(s27.input, s27.key))), s27.key)
  const fieldsOf = (xml: string) => mismatch(() => readOriginSimples(xml)).fields
  it('IBSCBS sem gTribSN na origem (regime regular) → recusa, não "sem grupo"', () => {
    expect(fieldsOf(origin27(x => x.replace(/<gTribSN>.*?<\/gTribSN>/, '')))).toEqual(['origin.det[1]: O IBSCBS da origem não é o do Simples (regime regular) — fora-do-primeiro-release'])
  })
  it('origem sem gIBSSN → o item sai `withoutIbs` (a devolução o espelha sem gIBSSN)', () => {
    const map = readOriginSimples(origin27(x => x.replace(/<gIBSSN>.*?<\/gIBSSN>/, '')))
    expect(map.get(1)?.simples).toMatchObject({ withoutIbs: true, ibsRate: null, ibsCents: 0, cbsCents: 2700 })
    expect(map.get(2)?.simples?.withoutIbs).toBeUndefined()
  })
  it('qCom ilegível com grupo, nItem 0 e desconto maior que o item → recusa citando o item', () => {
    expect(fieldsOf(origin27(x => x.replace(/<qCom>[^<]*<\/qCom>/, '<qCom>abc</qCom>')))).toEqual(['origin.det[1]: A quantidade do item da origem está ilegível'])
    expect(fieldsOf(origin27(x => x.replace('nItem="1"', 'nItem="0"')))).toEqual(['origin: A nota de origem tem item sem número ou repetido'])
    expect(fieldsOf(origin27(x => x.replace('<indTot>1</indTot><cAtivSN>01</cAtivSN>', '<vDesc>5000.00</vDesc><indTot>1</indTot><cAtivSN>01</cAtivSN>')))).toEqual(['origin.det[1]: Desconto do item da origem maior que o valor do item'])
  })
})
