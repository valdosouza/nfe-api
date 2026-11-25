/**
 * NFE.E5.P6.T1 — a NF-e do Simples (CRT 1) de 01/01/2027 em diante leva o grupo do Simples: `cAtivSN` por item, `IBSCBS` (CST, `cClassTrib`, `gTribSN`) e o total
 * `IBSCBSTot` (NT 2026.005; D-NE286, D-NE287, D-NE288, D-NE289, D-NE290; ficha-nfe-e5-p6-simples-2027.md §6-3). A trava da NFE.E5.P4.T1 saiu. O esquema é o PL_010h.
 * Cada caso monta a chave e as parcelas da PRÓPRIA data. O builder só ESCREVE o que o faturamento congelou: nunca calcula (D-F10/D-F11).
 */
import { validateMessage } from '../authority/xsd'
import { buildAccessKey } from '../nfe/access-key'
import { numberItems } from '../nfe/item-numbering'
import { buildNfeXml, type NfeInput, type NfeItemInput } from '../nfe/nfe-builder'
import { returnKey, returnSaleInput, sale2027, saleInput, saleItem, saleKey, SETES_CNPJ, signNfe, simplesFor } from './nfe-fixtures'

jest.setTimeout(120_000)

const refusedOn = (input: NfeInput, key: string) => {
  try { buildNfeXml(input, key) } catch (e: any) { return { status: e.statusCode as number, code: e.code as string, fields: (e.fields ?? []).map((f: any) => `${f.field}: ${f.message}`) as string[] } }
  return { status: 0, code: '', fields: ['(não recusou)'] }
}
const OUT = 'fora-do-primeiro-release'
// Ancorado no ELEMENTO (`<tag` seguido de espaço, `>` ou `/`): texto com a palavra (xProd, observação) não derruba o teste sem defeito do código.
const NEVER_IN_DAS = /<(gIBSCBS|tpRegimeIBSCBS|vNFTot|gIBSCBSMono|gEstornoCred)[\s>/]/
const ITEM_GROUP_1 = '<IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib><gTribSN><gIBSSN><pIBSSN>0.10</pIBSSN><vIBSSN>3.00</vIBSSN></gIBSSN><gCBSSN><pCBSSN>0.90</pCBSSN><vCBSSN>27.00</vCBSSN></gCBSSN></gTribSN></IBSCBS>'
const TOTAL_GROUP = '<IBSCBSTot><vBCIBSCBS>4000.00</vBCIBSCBS><gTribSN><vIBSSN>4.00</vIBSSN><vCBSSN>36.00</vCBSSN></gTribSN></IBSCBSTot>'
const withSimples = (index: 0 | 1, over: Parameters<typeof simplesFor>[1]): NfeItemInput => saleItem(index, { simples: simplesFor(index, over) })

describe('NFE.E5.P6.T1 — 2027: a venda do Simples sai com o grupo do Simples', () => {
  it('(a) venda de 15/01/2027, assinada, passa no XSD do 010h; cAtivSN, IBSCBS e IBSCBSTot nos lugares e com os valores congelados', async () => {
    const { input, key } = sale2027()
    const built = buildNfeXml(input, key)
    expect(built.xml).toContain('<indTot>1</indTot><cAtivSN>01</cAtivSN>')
    expect(built.xml).toContain('<indTot>1</indTot><cAtivSN>02</cAtivSN>')
    expect(built.xml).toContain(`</COFINS>${ITEM_GROUP_1}</imposto>`)
    expect(built.xml).toContain('<IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib><gTribSN><gIBSSN><pIBSSN>0.10</pIBSSN><vIBSSN>1.00</vIBSSN></gIBSSN><gCBSSN><pCBSSN>0.90</pCBSSN><vCBSSN>9.00</vCBSSN></gCBSSN></gTribSN></IBSCBS></imposto>')
    expect(built.xml).toContain(`</ICMSTot>${TOTAL_GROUP}</total>`)
    expect(built.xml).toContain('<vNF>4000.00</vNF>')                                  // o vNF segue a fórmula atual: nada de IBS/CBS dentro (D-NE286)
    expect(built.xml).not.toMatch(NEVER_IN_DAS)
    expect(built.xml).not.toContain('DOCUMENTO EMITIDO POR ME OU EPP')                 // a frase fixa do art. 59 § 4º caiu em 01/01/2027 (CGSN 190)
    expect(built.xml).toContain('<infCpl>Pedido 5001</infCpl>')
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })

  it('o total é a soma EXATA dos itens ao centavo (3 itens de 1 centavo: 0,03), em qualquer ordem de valores', async () => {
    const numbered = numberItems([10, 20, 30]).items
    const item = (n: number, over: Parameters<typeof simplesFor>[1]) => saleItem(0, { numbered: numbered[n], simples: simplesFor(0, over) })
    const { input, key } = sale2027('2027-01-15T10:15:30-03:00', {
      items: [item(0, { ibsCents: 1, cbsCents: 7, baseCents: 300000 }), item(1, { ibsCents: 1, cbsCents: 8, baseCents: 300000 }), item(2, { ibsCents: 1, cbsCents: 9, baseCents: 300000 })],
      erpTotalCents: 900000, installments: [{ dueDate: '2027-02-20', cents: 900000 }], payments: [{ tPag: '15', cents: 900000 }],
    })
    const built = buildNfeXml(input, key)
    expect(built.xml).toContain('<IBSCBSTot><vBCIBSCBS>9000.00</vBCIBSCBS><gTribSN><vIBSSN>0.03</vIBSSN><vCBSSN>0.24</vCBSSN></gTribSN></IBSCBSTot>')
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })

  it('(b) a fronteira: 31/12/2026T23:59:59-03:00 sai SEM o grupo; 01/01/2027T00:00:00-03:00 sai COM o grupo (a mutação >= → > derruba o 2º)', async () => {
    const dec = buildNfeXml(saleInput({ dhEmi: '2026-12-31T23:59:59-03:00', installments: [{ dueDate: '2027-01-30', cents: 400000 }] }), saleKey({ emissionDate: '2026-12-31' }))
    expect(dec.xml).not.toMatch(/<(IBSCBS|IBSCBSTot|cAtivSN|gTribSN)[\s>/]/)
    const jan = sale2027('2027-01-01T00:00:00-03:00')
    expect(jan.key.slice(2, 6)).toBe('2701')
    const built = buildNfeXml(jan.input, jan.key)
    expect(built.xml).toContain('<cAtivSN>01</cAtivSN>')
    expect(built.xml).toContain(TOTAL_GROUP)
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })

  it('o fuso conta pela data LOCAL do texto: 00:30+02:00 de 01/01/2027 já é 2027 (exige o grupo); 23:59:59-03:00 de 31/12/2026 ainda é 2026 (recusa o grupo)', () => {
    const early = saleInput({ dhEmi: '2027-01-01T00:30:00+02:00', installments: [{ dueDate: '2027-02-01', cents: 400000 }] })
    expect(refusedOn(early, saleKey({ emissionDate: '2027-01-01' })).fields.sort()).toEqual([
      `det[10].simples: Item sem o IBS/CBS do Simples guardado pelo faturamento (ou regime regular) — ${OUT}`,
      `det[30].simples: Item sem o IBS/CBS do Simples guardado pelo faturamento (ou regime regular) — ${OUT}`,
    ])
    const late = saleInput({ dhEmi: '2026-12-31T23:59:59-03:00', installments: [{ dueDate: '2027-01-30', cents: 400000 }], items: [withSimples(0, {}), saleItem(1)] })
    expect(refusedOn(late, saleKey({ emissionDate: '2026-12-31' })).fields).toEqual(['det[10].simples: IBS/CBS do Simples não vai em nota anterior a 01/01/2027 (RF-NFE-69)'])
  })

  it('2028 (bissexto) também leva o grupo: a regra é "a partir de", sem fim', async () => {
    const { input, key } = sale2027('2028-02-29T10:00:00-03:00')
    const built = buildNfeXml(input, key)
    expect(built.xml).toContain(TOTAL_GROUP)
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })

  it('1 item e 3 itens: o grupo vai em todos e o total soma só os que existem', async () => {
    const one = sale2027('2027-03-10T08:00:00-03:00', { items: [saleItem(0, { simples: simplesFor(0) })], erpTotalCents: 300000, installments: [{ dueDate: '2027-04-10', cents: 300000 }], payments: [{ tPag: '15', cents: 300000 }] })
    const built = buildNfeXml(one.input, one.key)
    expect(built.xml).toContain('<IBSCBSTot><vBCIBSCBS>3000.00</vBCIBSCBS><gTribSN><vIBSSN>3.00</vIBSSN><vCBSSN>27.00</vCBSSN></gTribSN></IBSCBSTot>')
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })
})

describe('NFE.E5.P6.T1 — D-NE290: o que o 1º release do Simples não cobre é RECUSADO, com a lista inteira', () => {
  it('venda de 2027 com item sem o grupo guardado (ou `null`): recusa citando CADA item', () => {
    const none = sale2027('2027-01-15T10:15:30-03:00', { items: [saleItem(0, { simples: simplesFor(0) }), saleItem(1)] })
    expect(refusedOn(none.input, none.key).fields).toEqual([`det[30].simples: Item sem o IBS/CBS do Simples guardado pelo faturamento (ou regime regular) — ${OUT}`])
    const nulls = sale2027('2027-01-15T10:15:30-03:00', { items: [saleItem(0, { simples: null }), saleItem(1, { simples: null })] })
    expect(refusedOn(nulls.input, nulls.key)).toMatchObject({ status: 422, code: 'FISCAL_DOCUMENT_INVALID' })
    expect(refusedOn(nulls.input, nulls.key).fields).toHaveLength(2)
  })

  it('atividade 90 (RF-SN-16) e atividade fora do domínio são recusadas; a vazia também', () => {
    const run = (activity: string | null) => { const s = sale2027('2027-01-15T10:15:30-03:00', { items: [withSimples(0, { activity }), saleItem(1, { simples: simplesFor(1) })] }); return refusedOn(s.input, s.key).fields }
    expect(run('90')).toEqual([`det[10].cAtivSN: Atividade 90 (não tributável) — ${OUT}`])
    expect(run('07')).toEqual(['det[10].cAtivSN: Valor fora do domínio do leiaute'])
    expect(run(null)).toEqual(['det[10].cAtivSN: Campo obrigatório vazio'])
  })

  it('classificação malformada, percentual acima de 100 ou ausente, valor e base negativos: cada um recusado com o campo', () => {
    const run = (over: Parameters<typeof simplesFor>[1]) => { const s = sale2027('2027-01-15T10:15:30-03:00', { items: [withSimples(0, over), saleItem(1, { simples: simplesFor(1) })] }); return refusedOn(s.input, s.key).fields }
    expect(run({ classification: '12345' })).toEqual(['det[10].cClassTrib: Valor inválido (6 dígitos)'])
    expect(run({ classification: null })).toEqual(['det[10].cClassTrib: Campo obrigatório vazio'])
    expect(run({ ibsRate: '100.01' })).toEqual([expect.stringMatching(/^det\[10\]\.pIBSSN: Valor inválido/)])
    expect(run({ cbsRate: null })).toEqual(['det[10].pCBSSN: Campo obrigatório vazio'])
    expect(run({ ibsCents: -1 })[0]).toMatch(/^det\[10\]\.vIBSSN:/)
    expect(run({ baseCents: -1 })).toEqual(['det[10].vBCIBSCBS: Base do item inválida'])
    const hundred = sale2027('2027-01-15T10:15:30-03:00', { items: [withSimples(0, { ibsRate: '100.0000' }), saleItem(1, { simples: simplesFor(1) })] })
    expect(() => buildNfeXml(hundred.input, hundred.key)).not.toThrow()                           // 100 % ainda é percentual válido
  })

  it('CRT 2, 3 e 4 seguem recusados em 2027 (o builder só escreve o CRT 1)', () => {
    for (const crt of ['2', '3', '4']) {
      const s = sale2027()
      s.input.emit.CRT = crt
      expect(refusedOn(s.input, s.key).fields).toEqual([`emit.CRT: Regime ${crt} — ${OUT}`])
    }
  })

  it('em 2026 o dado do Simples é recusado (RF-NFE-69) e `null` é aceito (sem grupo); a recusa do item de 2027 convive com outro campo ruim', () => {
    const dec = saleInput({ items: [saleItem(0, { simples: simplesFor(0) }), saleItem(1, { simples: null })] })
    expect(refusedOn(dec, saleKey()).fields).toEqual(['det[10].simples: IBS/CBS do Simples não vai em nota anterior a 01/01/2027 (RF-NFE-69)'])
    const both = sale2027('2027-03-10T08:00:00-03:00', { natOp: '', items: [saleItem(0), saleItem(1, { simples: simplesFor(1) })] })
    expect(refusedOn(both.input, both.key).fields.sort()).toEqual(['ide.natOp: Campo obrigatório vazio', `det[10].simples: Item sem o IBS/CBS do Simples guardado pelo faturamento (ou regime regular) — ${OUT}`].sort())
  })

  it('entrada malformada no grupo do Simples (texto que não é texto) é recusa tipada, nunca erro interno', () => {
    const s = sale2027('2027-01-15T10:15:30-03:00', { items: [saleItem(0, { simples: { ...simplesFor(0), activity: 1 as unknown as string } }), saleItem(1, { simples: simplesFor(1) })] })
    expect(refusedOn(s.input, s.key)).toMatchObject({ status: 422, code: 'FISCAL_DOCUMENT_INVALID', fields: ['det[#1].simples.activity: Entrada malformada'] })
  })
})

describe('NFE.E5.P6.T1 — a devolução de 2027 (D-NE288, D-NE289)', () => {
  const returnOn = (items: NfeItemInput[]) => {
    const base = returnSaleInput()
    return { input: returnSaleInput({ dhEmi: '2027-01-05T09:00:00-03:00', items: items.map((it, i) => ({ ...base.items[i], ...it })) }), key: returnKey({ emissionDate: '2027-01-05' }) }
  }
  it('origem de 2026 sem o grupo → devolução de 2027 SEM o grupo (`simples: null`), válida no XSD e sem IBSCBSTot', async () => {
    const { input, key } = returnOn([{ simples: null } as NfeItemInput, { simples: null } as NfeItemInput])
    const built = buildNfeXml(input, key)
    expect(built.xml).not.toMatch(/<(IBSCBS|IBSCBSTot|cAtivSN|gTribSN|vNFTot)[\s>/]/)
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })
  it('origem de 2027 com o grupo → a devolução copia o grupo; o total soma o grupo copiado (base, IBS e CBS)', async () => {
    const { input, key } = returnOn([{ simples: simplesFor(0, { ibsCents: 150, cbsCents: 1350, baseCents: 150000 }) } as NfeItemInput, { simples: simplesFor(1, { ibsCents: 100, cbsCents: 900, baseCents: 100000 }) } as NfeItemInput])
    const built = buildNfeXml(input, key)
    expect(built.xml).toContain('<IBSCBSTot><vBCIBSCBS>2500.00</vBCIBSCBS><gTribSN><vIBSSN>2.50</vIBSSN><vCBSSN>22.50</vCBSSN></gTribSN></IBSCBSTot>')
    expect(built.xml).toContain('<cAtivSN>01</cAtivSN>')
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })
  it('devolução de 2027 sem a decisão (campo ausente) é recusada citando o item', () => {
    const { input, key } = returnOn([{ simples: null } as NfeItemInput, {} as NfeItemInput])
    expect(refusedOn(input, key).fields).toEqual([`det[2].simples: Devolução sem a decisão do grupo do Simples da origem — ${OUT}`])
  })
  it('em 2027, `null` na VENDA é recusado (só a devolução de origem sem grupo pode ir sem ele)', () => {
    const s = sale2027('2027-01-15T10:15:30-03:00', { items: [saleItem(0, { simples: null }), saleItem(1, { simples: simplesFor(1) })] })
    expect(refusedOn(s.input, s.key).fields).toEqual([`det[10].simples: Item sem o IBS/CBS do Simples guardado pelo faturamento (ou regime regular) — ${OUT}`])
  })
})

describe('NFE.E5.P6.T1 — gates: o que os revisores mostraram que faltava provar', () => {
  it('o CST é o prefixo de 3 dígitos do cClassTrib (S1), com dígitos distintos', () => {
    const s = sale2027('2027-01-15T10:15:30-03:00', { items: [withSimples(0, { classification: '123456' }), saleItem(1, { simples: simplesFor(1, { classification: '410004' }) })] })
    const xml = buildNfeXml(s.input, s.key).xml
    expect(xml).toContain('<IBSCBS><CST>123</CST><cClassTrib>123456</cClassTrib>')
    expect(xml).toContain('<IBSCBS><CST>410</CST><cClassTrib>410004</cClassTrib>')
  })

  it('as atividades 03 e 04 saem (01 a 04 são as do 1º release) e a base 0 é aceita', async () => {
    const s = sale2027('2027-01-15T10:15:30-03:00', { items: [withSimples(0, { activity: '03' }), saleItem(1, { simples: simplesFor(1, { activity: '04', baseCents: 0, ibsCents: 0, cbsCents: 0 }) })] })
    const built = buildNfeXml(s.input, s.key)
    expect(built.xml).toContain('<cAtivSN>03</cAtivSN>')
    expect(built.xml).toContain('<cAtivSN>04</cAtivSN>')
    expect(built.xml).toContain('<vBCIBSCBS>3000.00</vBCIBSCBS>')
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })

  it('[FIXED] o grupo do Simples é lido UMA vez: um accessor que muda de valor não faz sair a atividade 90 nem item e total divergentes', () => {
    let reads = 0
    const hostile: any = { ...simplesFor(0) }
    Object.defineProperty(hostile, 'activity', { get() { reads++; return reads <= 5 ? '01' : '90' }, enumerable: true })
    let cents = 0
    Object.defineProperty(hostile, 'ibsCents', { get() { cents++; return cents <= 1 ? 300 : 99900 }, enumerable: true })
    const s = sale2027('2027-01-15T10:15:30-03:00', { items: [saleItem(0, { simples: hostile }), saleItem(1, { simples: simplesFor(1) })] })
    const xml = buildNfeXml(s.input, s.key).xml
    expect(xml).not.toContain('<cAtivSN>90</cAtivSN>')
    expect(xml).toContain('<vIBSSN>3.00</vIBSSN>')
    expect(xml).toContain('<gTribSN><vIBSSN>4.00</vIBSSN><vCBSSN>36.00</vCBSSN></gTribSN></IBSCBSTot>')
  })

  it('o item de origem sem gIBSSN (withoutIbs) é espelhado SEM gIBSSN, e o total soma só o CBS', async () => {
    const s = sale2027('2027-01-15T10:15:30-03:00', { items: [saleItem(0, { simples: { ...simplesFor(0), withoutIbs: true, ibsRate: null, ibsCents: 0 } }), saleItem(1, { simples: simplesFor(1) })] })
    const built = buildNfeXml(s.input, s.key)
    expect(built.xml).toContain('<gTribSN><gCBSSN><pCBSSN>0.90</pCBSSN><vCBSSN>27.00</vCBSSN></gCBSSN></gTribSN>')
    expect(built.xml).toContain('<gTribSN><vIBSSN>1.00</vIBSSN><vCBSSN>36.00</vCBSSN></gTribSN></IBSCBSTot>')
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })

  it('a recusa do item convive com outro erro anterior (contingência na chave), e dhEmi malformado em 2027 só falha no dhEmi', () => {
    const { input } = sale2027('2027-03-10T08:00:00-03:00', { items: [saleItem(0), saleItem(1, { simples: simplesFor(1) })] })
    const contingency = buildAccessKey({ uf: 'PR', emissionDate: '2027-03-10', cnpj: SETES_CNPJ, model: '55', serie: 1, number: 15, emissionType: 6, cnf: '48213057' })
    expect(refusedOn(input, contingency).fields.sort()).toEqual([`det[10].simples: Item sem o IBS/CBS do Simples guardado pelo faturamento (ou regime regular) — ${OUT}`, 'ide.tpEmis: Emissão em contingência — fora-do-primeiro-release'].sort())
    const bad = sale2027('2027-03-10 08:00:00')
    expect(refusedOn(bad.input, bad.key).fields.every(f => f.startsWith('ide.dhEmi') || f.startsWith('det[') || f.startsWith('cobr'))).toBe(true)
  })

  // S7 (ficha do P6): nenhum fato de ente governamental existe no ERP web — a recusa da D-NE290 não é implementável até o setes-api gravar o sinal.
  it.todo('venda a órgão público (compra governamental, RF-SN-18: com a União pIBSSN 0 e pCBSSN = a soma) é recusada — depende do sinal no setes-api')
})
