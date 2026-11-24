/// <reference types="jest" />
// nfe-api:NFE.E6.P3.T1/T2 — o que os gates (socrático 0,60 e adversarial com 1 HIGH) acharam no commit 24bfd59, agora fixado: a nota de CRT 3 com ICMS,
// cada coluna do item, as peças que os mutantes deixavam vivas (infAdFisco, IE ST, hora de saída, transportador, duplicatas, carimbo em toda folha),
// o texto comprido sem espaço (H1, em tempo), valor fiscal nunca abreviado (M2), ISSQN depois dos itens, o tributável diferente do comercial,
// o CNPJ alfanumérico e as marcas só as emitidas por `danfeMarksOf`. Ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e6-p3-danfe.md`, §11.
import { HttpError } from 'fiscal-api'
import { buildAccessKey } from '../nfe/access-key'
import { renderDanfe } from '../nfe/danfe/danfe'
import { type DanfeVoice } from '../nfe/danfe/danfe-marks'
import { authorizedProc, insertBefore, longInput } from './danfe-fixtures'
import { saleInput, saleKey } from './nfe-fixtures'
import { pdfContentOps, pdfPageCount, pdfTextRuns, type TextRun } from './pdf-text'

jest.setTimeout(240_000)
const FIXED = new Date('2026-11-24T15:00:00Z')

interface Rendered { pdf: Buffer; pages: TextRun[][]; texts: string[][] }
async function render(xml: string, voice: DanfeVoice = 'A', tpAmb: '1' | '2' = '2'): Promise<Rendered> {
  const pdf = await renderDanfe({ procNfeXml: xml, voice, creationDate: FIXED })
  const pages = pdfContentOps(pdf).map(ops => pdfTextRuns(ops))
  return { pdf, pages, texts: pages.map(p => p.map(r => r.text)) }
}
/** Os trechos da MESMA linha de base do trecho âncora, da esquerda para a direita. */
const rowOf = (runs: TextRun[], anchor: string): string[] => {
  const a = runs.find(r => r.text === anchor)
  if (!a) throw new Error(`âncora ausente: ${anchor}`)
  return runs.filter(r => Math.abs(r.yPdf - a.yPdf) < 0.6).sort((x, y) => x.x - y.x).map(r => r.text)
}
const barRects = (ops: string): number[][] => [...ops.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g)].map(m => [Number(m[3]), Number(m[4])]).filter(([, h]) => Math.abs(h - 28.346) < 0.01)

/** Passa a venda para o regime normal: CRT 3 e o ICMS00 com base, alíquota e valor em cada item. */
function normalRegime(xml: string): string {
  let n = 0
  return xml.replace('<CRT>1</CRT>', '<CRT>3</CRT>').replace(/<ICMSSN101>[\s\S]*?<\/ICMSSN101>/g, () => {
    n++
    return n === 1
      ? '<ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>3000.00</vBC><pICMS>18.00</pICMS><vICMS>540.00</vICMS></ICMS00>'
      : '<ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>1000.00</vBC><pICMS>18.00</pICMS><vICMS>180.00</vICMS></ICMS00>'
  })
}

describe('gates — cada coluna do item sai com o valor do SEU campo (mutantes: total, BC/ICMS trocados, qCom cru, CST/CSOSN)', () => {
  it('Simples: código, descrição, NCM, CSOSN, CFOP, un., quantidade, unitário e total, em ordem; BC, ICMS e alíquota vazios', async () => {
    const r = await render(authorizedProc().xml)
    expect(rowOf(r.pages[0], '910')).toEqual(['910', 'Flange usinada em aço Ø 50 mm', '73259990', '101', '5101', 'PC', '2', '1.500', '3.000,00'])
    // quantidade e valor unitário COM decimais e milhar (mutante: qCom impresso cru): 1234.5678 → 1.234,5678
    const dec = await render(authorizedProc().xml.replace('<qCom>2</qCom>', '<qCom>1234.5678</qCom>').replace('<qTrib>2</qTrib>', '<qTrib>1234.5678</qTrib>'))
    expect(rowOf(dec.pages[0], '910')).toContain('1.234,5678')
    expect(rowOf(dec.pages[0], '910')).not.toContain('1234.5678')
    expect(rowOf(r.pages[0], '930')).toEqual(['930', 'Bucha de bronze', '73259990', '101', '5101', 'PC', '3', '333,333333', '1.000,00'])
  })

  it('regime normal (CRT 3, ICMS00): rótulo CST, o CST do item, e BC, valor e alíquota do ICMS nas colunas certas', async () => {
    const r = await render(normalRegime(authorizedProc().xml))
    const t = r.texts[0]
    expect(t).toContain('CST')
    expect(t).not.toContain('CSOSN')
    expect(t).toContain('3 - REGIME NORMAL')
    expect(t).toContain('CÓDIGO DO REGIME TRIBUTÁRIO')
    expect(rowOf(r.pages[0], '910')).toEqual(['910', 'Flange usinada em aço Ø 50 mm', '73259990', '00', '5101', 'PC', '2', '1.500', '3.000,00', '3.000,00', '540,00', '18,00'])
    expect(rowOf(r.pages[0], '930')).toEqual(['930', 'Bucha de bronze', '73259990', '00', '5101', 'PC', '3', '333,333333', '1.000,00', '1.000,00', '180,00', '18,00'])
  })
})

describe('gates — o que os mutantes deixavam vivo agora é provado', () => {
  it('o `infAdFisco` inteiro sai antes do `infCpl`, nas informações complementares', async () => {
    const xml = insertBefore(authorizedProc().xml, '<infCpl>', '<infAdFisco>Texto ao fisco XYZ 123</infAdFisco>')
    const t = (await render(xml)).texts[0]
    const joined = t.join(' ')
    expect(joined).toContain('Texto ao fisco XYZ 123')
    expect(joined.indexOf('Texto ao fisco XYZ 123')).toBeLessThan(joined.indexOf('Pedido 5001'))
  })

  it('a hora de saída, a IE do substituto tributário e o transportador com CNPJ, endereço, município, UF e IE', async () => {
    let xml = authorizedProc().xml
    xml = insertBefore(xml, '<tpNF>', '<dhSaiEnt>2026-11-25T08:30:15-03:00</dhSaiEnt>')
    xml = insertBefore(xml, '<CRT>', '<IEST>1234567</IEST>')
    xml = insertBefore(xml, '</transp>', '<transporta><CNPJ>99888777000166</CNPJ><xNome>TRANSPORTES RAPIDO LTDA</xNome><IE>7766554433</IE><xEnder>Rodovia BR 277 km 10</xEnder><xMun>Curitiba</xMun><UF>PR</UF></transporta><veicTransp><placa>ABC1D23</placa><UF>PR</UF><RNTC>12345678</RNTC></veicTransp>')
    const r = await render(xml)
    const t = r.texts[0]
    expect(t).toEqual(expect.arrayContaining(['25/11/2026', '08:30:15', '1234567']))
    expect(t).toEqual(expect.arrayContaining(['TRANSPORTES RAPIDO LTDA', '99.888.777/0001-66', '7766554433', 'Rodovia BR 277 km 10', 'ABC1D23', '12345678']))
    expect(t).toContain('TRANSPORTADOR / VOLUMES TRANSPORTADOS')
    // a IE ST fica no quadro dela (a 2ª caixa da linha de IE), não no da IE
    expect(rowOf(r.pages[0], '9053273308')).toEqual(['9053273308', '1 - SIMPLES NACIONAL', '1234567', '07.742.094/0001-13'])   // IE, CRT, IE ST, CNPJ: a ordem do modelo da NT
  })

  it('mais de 5 duplicatas: todas saem (a 6ª em linha nova)', async () => {
    const base = saleInput()
    const parcels = [66666, 66666, 66666, 66666, 66666, 66670].map((cents, i) => ({ dueDate: `2026-12-${String(10 + i).padStart(2, '0')}`, cents }))
    const t = (await render(authorizedProc({ ...base, installments: parcels }).xml)).texts[0]
    for (let n = 1; n <= 5; n++) expect(t).toContain(`00${n}  ${10 + n - 1}/12/2026  666,66`)
    expect(t).toContain('006  15/12/2026  666,70')
  })

  it('o carimbo CANCELADA, o cabeçalho com emitente e as barras da chave saem em TODA folha da nota cancelada de várias folhas', async () => {
    const r = await render(authorizedProc(longInput(90)).xml, 'C')
    const ops = pdfContentOps(r.pdf)
    expect(ops.length).toBeGreaterThanOrEqual(2)
    r.texts.forEach((t, i) => {
      expect(t).toContain('CANCELADA')
      expect(t).toContain('SETES USINAGEM DE TESTE LTDA')
      expect(t).toContain('9053273308')
      expect(barRects(ops[i]).length).toBeGreaterThan(20)
    })
  })

  it('o carimbo vem da VOZ: voz C leva CANCELADA; qualquer outra voz de nota autorizada não; não há como passar marca montada por fora (a entrada é a voz)', async () => {
    const xml = authorizedProc().xml
    expect((await render(xml, 'C')).texts[0]).toContain('CANCELADA')
    for (const voice of ['A', 'K', 'N'] as const) expect((await render(xml, voice)).texts[0]).not.toContain('CANCELADA')
    // um objeto de entrada com `marks` forjado não muda nada: o campo nem existe no contrato (o carimbo sai só da voz)
    const forged = { procNfeXml: xml, voice: 'A', marks: { homologation: false, cancelled: true }, creationDate: FIXED } as unknown as Parameters<typeof renderDanfe>[0]
    expect(pdfTextRuns(pdfContentOps(await renderDanfe(forged))[0]).map(r => r.text)).not.toContain('CANCELADA')
  })
})

describe('gates — a ordem do modelo vertical da NT 2026.010 (D-NE100)', () => {
  it('destinatário, fatura, totais dos produtos e da nota, total do ICMS/IPI, ISSQN, transportador, itens e dados adicionais — de cima para baixo', async () => {
    let xml = insertBefore(authorizedProc().xml, '</total>', '<ISSQNtot><vServ>50.00</vServ><vBC>50.00</vBC><vISS>2.50</vISS></ISSQNtot>')
    xml = insertBefore(xml, '</transp>', '<vol><qVol>2</qVol><esp>CAIXA</esp></vol>')
    const runs = (await render(xml)).pages[0]
    const y = (text: string): number => runs.find(r => r.text === text)!.yPdf                  // y de baixo para cima: maior = mais acima
    const order = ['DESTINATÁRIO / REMETENTE', 'FATURA / DUPLICATAS', 'TOTAL DOS PRODUTOS E TOTAL DA NOTA', 'TOTAL DO ICMS / IPI', 'CÁLCULO DO ISSQN',
      'TRANSPORTADOR / VOLUMES TRANSPORTADOS', 'DADOS DOS PRODUTOS / SERVIÇOS', 'DADOS ADICIONAIS']
    for (let i = 1; i < order.length; i++) expect([order[i - 1], order[i], y(order[i - 1]) > y(order[i])]).toEqual([order[i - 1], order[i], true])
    expect(y('CÁLCULO DO ISSQN')).toBeGreaterThan(y('Bucha de bronze'))                       // o ISSQN vem ANTES dos itens (modelo da NT)
  })

  it('totais condicionais da NT 4.4 (FCP, DIFAL, monofásico) saem quando o XML os traz com valor, e só então', async () => {
    const plain = (await render(authorizedProc().xml)).texts[0]
    expect(plain.join(' ')).not.toMatch(/FCP|DIFAL|MONOFÁSICO/)
    const xml = authorizedProc().xml.replace('<vFCP>0.00</vFCP>', '<vFCP>12.34</vFCP>').replace('<vFCPST>0.00</vFCPST>', '<vFCPST>5.00</vFCPST>')
      .replace('</ICMSTot>', '<vICMSUFDest>56.78</vICMSUFDest><vFCPUFDest>1.23</vFCPUFDest><vICMSMono>9.99</vICMSMono></ICMSTot>')
    const t = (await render(xml)).texts[0]
    expect(t).toEqual(expect.arrayContaining(['VALOR DO FCP', '12,34', 'VALOR DO FCP RETIDO POR ST', '5,00', 'VALOR DO DIFAL NA UF DE DESTINO', '56,78', 'VALOR DO FCP NA UF DE DESTINO', '1,23', 'VALOR DO ICMS MONOFÁSICO', '9,99']))
  })
})

describe('gates — rótulos de campo nunca abaixo de 6 pt, número da duplicata nunca abreviado, emitente do tamanho máximo do XSD', () => {
  it('só os títulos de bloco e de coluna saem em 5 pt; todo rótulo de campo (inclusive INFORMAÇÕES COMPLEMENTARES e RESERVADO AO FISCO) sai em 6 pt', async () => {
    const r = await render(authorizedProc().xml)
    const five = new Set(r.pages[0].filter(x => x.size === 5).map(x => x.text))
    const blockAndColumn = new Set(['DESTINATÁRIO / REMETENTE', 'FATURA / DUPLICATAS', 'TOTAL DOS PRODUTOS E TOTAL DA NOTA', 'TOTAL DO ICMS / IPI', 'TRANSPORTADOR / VOLUMES TRANSPORTADOS',
      'DADOS DOS PRODUTOS / SERVIÇOS', 'DADOS ADICIONAIS', 'CÓDIGO', 'DESCRIÇÃO DO PRODUTO / SERVIÇO', 'NCM/SH', 'CSOSN', 'CFOP', 'UN', 'QUANT.', 'VALOR UNIT.', 'VALOR TOTAL', 'BC ICMS', 'VALOR', 'ICMS', 'ALÍQ.', 'VALOR ICMS'])
    for (const text of five) expect([text, blockAndColumn.has(text)]).toEqual([text, true])
    const six = new Set(r.pages[0].filter(x => x.size === 6).map(x => x.text))
    expect(six).toEqual(expect.objectContaining(new Set(['INFORMAÇÕES COMPLEMENTARES', 'RESERVADO AO FISCO', 'NATUREZA DA OPERAÇÃO', 'CÓDIGO DO REGIME TRIBUTÁRIO'])))
    for (const label of ['INFORMAÇÕES COMPLEMENTARES', 'RESERVADO AO FISCO', 'NATUREZA DA OPERAÇÃO', 'CÓDIGO DO REGIME TRIBUTÁRIO']) expect([label, six.has(label)]).toEqual([label, true])
    expect(r.texts[0].join(' ')).not.toContain('...')
  })

  it('nDup de 60 caracteres sai inteiro, no valor (10 pt, quebrado), e o rótulo da duplicata fica fixo', async () => {
    const nDup = 'D'.repeat(60)
    const xml = authorizedProc().xml.replace('<nDup>001</nDup>', `<nDup>${nDup}</nDup>`)
    const r = await render(xml)
    expect(r.texts[0].join('')).toContain(nDup)
    expect(r.texts[0].join(' ')).not.toContain('...')
    const piece = r.pages[0].find(x => /^D+$/.test(x.text))!
    expect(piece.size).toBe(10)
    expect(r.texts[0]).toContain('FATURA / DUPLICATA  VENCIMENTO  VALOR')
  })

  it('emitente com nome e endereço no máximo do XSD: o quadro cresce e o CRT/IE não ficam sobre o texto dele', async () => {
    const xml = authorizedProc().xml.replace('SETES USINAGEM DE TESTE LTDA', 'W'.repeat(60)).replace('<xLgr>Rua Clemente Mendes</xLgr>', `<xLgr>${'R'.repeat(60)}</xLgr>`)
      .replace('<xMun>Curitiba</xMun>', `<xMun>${'M'.repeat(60)}</xMun>`)
    const r = await render(xml)
    const runs = r.pages[0]
    const issuerLines = runs.filter(x => /^[WRM]{20,}/.test(x.text) && x.x < 280)
    expect(issuerLines.length).toBeGreaterThanOrEqual(4)
    const lowestIssuer = Math.min(...issuerLines.map(x => x.yPdf))
    const natOpLabel = runs.find(x => x.text === 'NATUREZA DA OPERAÇÃO')!
    expect(lowestIssuer).toBeGreaterThan(natOpLabel.yPdf + 6)                                 // a última linha do emitente fica ACIMA do quadro da natureza
    expect(runs.find(x => x.text === 'DANFE')!.yPdf).toBeGreaterThan(natOpLabel.yPdf)
  })
})

describe('gates — o tributável diferente do comercial aparece junto (AII 3.1.7)', () => {
  it('uTrib, qTrib e vUnTrib diferentes dos comerciais saem abaixo da descrição; iguais não geram linha', async () => {
    let xml = authorizedProc().xml
    xml = xml.replace('<uTrib>PC</uTrib><qTrib>2</qTrib><vUnTrib>1500</vUnTrib>', '<uTrib>KG</uTrib><qTrib>10</qTrib><vUnTrib>300</vUnTrib>')
    const r = await render(xml)
    const t = r.texts[0]
    expect(t).toContain('Trib.: 10 KG x 300')
    expect(t.filter(x => x.startsWith('Trib.:'))).toHaveLength(1)                           // o item 2 tem tributável igual ao comercial
  })
})

describe('gates — valor fiscal nunca é abreviado (M2) e entrada hostil é 422, nunca erro de desenho (M4)', () => {
  it('vUnCom de 10 casas e cProd de 36 caracteres saem INTEIROS (quebrados em linhas, sem reticências)', async () => {
    let xml = authorizedProc().xml
    xml = xml.replace('<vUnCom>1500</vUnCom>', '<vUnCom>12345.1234567890</vUnCom>').replace('<cProd>910</cProd>', '<cProd>ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789</cProd>')
    const r = await render(xml)
    const stream = r.texts[0].join('')
    expect(stream).not.toContain('...')
    expect(stream).toContain('12.345,1234567890')
    expect(stream).toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
  })

  it('controle em campo de linha única (CR, LF, TAB) vira espaço, e tpNF fora de 0/1 é 422 no campo procNfeXml', async () => {
    const ok = await render(authorizedProc().xml.replace('Venda de produção do estabelecimento', 'Venda&#13;de&#9;produção'))
    expect(ok.texts[0]).toContain('Venda de produção')
    let e: HttpError | null = null
    try { await render(authorizedProc().xml.replace('<tpNF>1</tpNF>', '<tpNF>XXXXXXXX</tpNF>')) } catch (x) { e = x as HttpError }
    expect(e).toBeInstanceOf(HttpError)
    expect(e?.statusCode).toBe(422)
    expect(e?.fields?.[0]?.field).toBe('procNfeXml')
  })

  it('um nome de emitente de 3.000 caracteres (fora do XSD) é 422 rápido, não cabeçalho que come a folha nem erro 500', async () => {
    const xml = authorizedProc().xml.replace('SETES USINAGEM DE TESTE LTDA', 'S'.repeat(3000))
    const started = Date.now()
    let e: HttpError | null = null
    try { await render(xml) } catch (x) { e = x as HttpError }
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(e).toBeInstanceOf(HttpError)
    expect(e?.statusCode).toBe(422)
    expect(e?.fields?.[0]?.field).toBe('procNfeXml')
  })

  it('o tributável é comparado como NÚMERO: `2` e `2.0000` são o mesmo valor e não geram a linha Trib.', async () => {
    const xml = authorizedProc().xml.replace('<qTrib>2</qTrib>', '<qTrib>2.0000</qTrib>').replace('<vUnTrib>1500</vUnTrib>', '<vUnTrib>1500.000000</vUnTrib>')
    expect((await render(xml)).texts[0].filter(x => x.startsWith('Trib.:'))).toEqual([])
  })
})

describe('gates — H1: texto comprido SEM espaço não trava o desenho (custo era cúbico; agora busca binária)', () => {
  it('infCpl de 5.000 caracteres sem espaço (o máximo do XSD) desenha em poucos segundos e sem perder caractere', async () => {
    const run = 'A'.repeat(5000)
    const xml = authorizedProc().xml.replace(/<infCpl>[\s\S]*?<\/infCpl>/, `<infCpl>${run}</infCpl>`)
    const started = Date.now()
    const r = await render(xml)
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(15_000)
    const written = r.texts.flat().filter(t => /^A+$/.test(t)).join('')
    expect(written).toHaveLength(5000)
  })

  it('infCpl de 400 palavras numeradas atravessando folhas: TODAS saem, uma vez, em ordem (o cabeçalho repetido não se mistura)', async () => {
    const tokens = Array.from({ length: 400 }, (_, i) => `N${String(i + 1).padStart(3, '0')}`)
    const filler = 'texto de observação da nota para ocupar a linha inteira e forçar a quebra '.repeat(1)
    const body = tokens.map(t => `${t} ${filler}`).join(' ')
    const xml = authorizedProc().xml.replace(/<infCpl>[\s\S]*?<\/infCpl>/, `<infCpl>${body}</infCpl>`)
    const r = await render(xml)
    expect(pdfPageCount(r.pdf)).toBeGreaterThanOrEqual(3)
    const found = r.texts.flat().join(' ').split(' ').filter(t => /^N\d{3}$/.test(t))
    expect(found).toEqual(tokens)
  })
})

describe('gates — CNPJ alfanumérico, nota de 400 itens e o cabeçalho dentro do quadro', () => {
  it('emitente com CNPJ alfanumérico: chave, CNPJ formatado e barras com módulo ≥ 0,02 cm', async () => {
    const cnpj = '12ABC34501DE35'
    const key = buildAccessKey({ uf: 'PR', emissionDate: '2026-11-24', cnpj, model: '55', serie: 1, number: 15, emissionType: 1, cnf: '48213057' })
    const base = saleInput()
    const proc = authorizedProc({ ...base, emit: { ...base.emit, CNPJ: cnpj } }, { key })
    const r = await render(proc.xml)
    expect(r.texts[0]).toContain(key.match(/.{4}/g)!.join(' '))
    expect(r.texts[0]).toContain('12.ABC.345/01DE-35')
    const widths = barRects(pdfContentOps(r.pdf)[0]).map(([w]) => w)
    expect(widths.length).toBeGreaterThan(20)
    expect(Math.min(...widths) / 28.3465).toBeGreaterThanOrEqual(0.02)
    expect(widths.reduce((a, b) => a + b, 0) / 28.3465).toBeGreaterThan(0) // barras desenhadas
  })

  it('400 itens: todos saem uma vez, em ordem, com FOLHA k/N certa, e em tempo razoável', async () => {
    const started = Date.now()
    const r = await render(authorizedProc(longInput(400)).xml)
    expect(Date.now() - started).toBeLessThan(120_000)
    const total = pdfPageCount(r.pdf)
    expect(total).toBeGreaterThanOrEqual(6)
    r.texts.forEach((t, i) => expect(t).toContain(`FOLHA ${i + 1}/${total}`))
    const items = r.texts.flat().filter(x => /^Item de teste número \d+$/.test(x))
    expect(items).toEqual(Array.from({ length: 400 }, (_, i) => `Item de teste número ${i + 1}`))
  })

  it('o quadro de identificação (DANFE, subtítulo em 8 pt, tpNF, número, série, folha) cabe na caixa do cabeçalho', async () => {
    const r = await render(authorizedProc().xml)
    const runs = r.pages[0]
    const boxBottom = 841.89 - (0.25 + 3.9) * 28.3465                                     // y (de baixo para cima) do pé do quadro
    for (const text of ['DANFE', '1 - SAÍDA', 'Nº 000.000.015', 'SÉRIE 1', 'FOLHA 1/1']) {
      expect([text, runs.find(x => x.text === text)!.yPdf > boxBottom]).toEqual([text, true])
    }
    const subtitle = runs.filter(x => x.yPdf < runs.find(y => y.text === 'DANFE')!.yPdf && x.yPdf > runs.find(y => y.text === '0 - ENTRADA')!.yPdf && x.x > 276.5 && x.x < 361)
    expect(subtitle.map(x => x.text).join(' ')).toBe('DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRÔNICA')
    expect([...new Set(subtitle.map(x => x.size))]).toEqual([8])
  })

  it('as marcas usam fonte Times (AII 3.6): nenhuma fonte do PDF é Helvetica', async () => {
    const r = await render(authorizedProc().xml, 'C')
    const text = r.pdf.toString('latin1')
    expect(text).not.toMatch(/Helvetica/)
    expect(text).toMatch(/\/BaseFont \/Times-Bold/)
    expect(text).toMatch(/\/BaseFont \/Times-Roman/)
  })
})

describe('gates — mutantes que ainda sobreviviam (frete × seguro, fatura líquida × original, IM do ISSQN)', () => {
  it('frete, seguro, desconto e outras despesas com valores DISTINTOS saem cada um no seu campo', async () => {
    const xml = authorizedProc().xml.replace('<vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc>', '<vFrete>11.11</vFrete><vSeg>22.22</vSeg><vDesc>33.33</vDesc>')
      .replace('<vOutro>0.00</vOutro>', '<vOutro>44.44</vOutro>')
    const r = await render(xml)
    // o valor sai logo abaixo do descritivo dele: ordem do modelo da NT (produtos, frete, seguro, desconto, outras despesas, total)
    // a linha do modelo da NT: produtos, frete, seguro, desconto, outras despesas, total da nota — cada valor no seu campo
    expect(rowOf(r.pages[0], '11,11')).toEqual(['4.000,00', '11,11', '22,22', '33,33', '44,44', '4.000,00'])
  })

  it('fatura com desconto: valor original, desconto e valor líquido distintos, cada um no seu campo', async () => {
    const xml = authorizedProc().xml.replace('<vOrig>4000.00</vOrig><vLiq>4000.00</vLiq>', '<vOrig>4100.00</vOrig><vDesc>100.00</vDesc><vLiq>4000.00</vLiq>')
    const r = await render(xml)
    expect(rowOf(r.pages[0], '4.100,00')).toEqual(['15', '4.100,00', '100,00', '4.000,00'])
  })

  it('ISSQN com inscrição municipal: a IM sai no campo dela', async () => {
    let xml = insertBefore(authorizedProc().xml, '</total>', '<ISSQNtot><vServ>50.00</vServ><vBC>50.00</vBC><vISS>2.50</vISS></ISSQNtot>')
    xml = insertBefore(xml, '<CRT>', '<IM>987654</IM>')
    expect(rowOf((await render(xml)).pages[0], '987654')).toEqual(['987654', '50,00', '50,00', '2,50'])
  })
})

describe('gates — HIGH-N1 (espaços), quadros longos dentro da folha e o grupo IBS/CBS', () => {
  it('infCpl com 4.998 espaços entre duas letras (válido no XSD) desenha rápido e preserva as letras', async () => {
    const xml = authorizedProc().xml.replace(/<infCpl>[\s\S]*?<\/infCpl>/, `<infCpl>a${' '.repeat(4998)}b</infCpl>`)
    const started = Date.now()
    const r = await render(xml)
    expect(Date.now() - started).toBeLessThan(15_000)
    const stream = r.texts[0].join(' ')
    expect(stream).toMatch(/\ba {1,3}b\b/)
  })

  it('muitas duplicatas e transportador com textos longos: NENHUM trecho cai abaixo do pé nem fora da folha, e FOLHA k/N segue certa', async () => {
    const dups = Array.from({ length: 75 }, (_, i) => `<dup><nDup>${String(i + 1).padStart(3, '0')}</nDup><dVenc>2026-12-22</dVenc><vDup>1.00</vDup></dup>`).join('')
    let xml = authorizedProc().xml.replace('</cobr>', `${dups}</cobr>`)
    xml = insertBefore(xml, '</transp>', `<transporta><xNome>${'T'.repeat(60)}</xNome><xEnder>${'E'.repeat(60)}</xEnder><xMun>${'M'.repeat(60)}</xMun><UF>PR</UF></transporta>`)
    const r = await render(xml)
    const total = pdfPageCount(r.pdf)
    r.pages.forEach((runs, i) => {
      expect(runs.filter(x => x.text !== 'SEM VALOR FISCAL' && x.yPdf <= 0.25 * 28.3465)).toEqual([])
      expect(r.texts[i]).toContain(`FOLHA ${i + 1}/${total}`)
    })
    for (let n = 1; n <= 75; n += 37) expect(r.texts.flat().join(' ')).toContain(`${String(n).padStart(3, '0')}  22/12/2026  1,00`)
  })

  it('XML com o grupo IBS/CBS (IBSCBSTot no total ou IBSCBS no item) é 422 no campo procNfeXml: o bloco ainda não é impresso e não pode sumir em silêncio', async () => {
    const withTotal = insertBefore(authorizedProc().xml, '</total>', '<IBSCBSTot><vBCIBSCBS>3000.00</vBCIBSCBS></IBSCBSTot>')
    const withItem = insertBefore(authorizedProc().xml, '</imposto>', '<IBSCBS><CST>000</CST></IBSCBS>')
    for (const xml of [withTotal, withItem]) {
      let e: HttpError | null = null
      try { await render(xml) } catch (x) { e = x as HttpError }
      expect(e?.statusCode).toBe(422)
      expect(e?.fields?.[0]?.field).toBe('procNfeXml')
      expect(e?.fields?.[0]?.message).toMatch(/IBS\/CBS/)
    }
  })

  it('ICMS monofásico: BC e valor, próprios e por retenção, com os rótulos da NT', async () => {
    const xml = authorizedProc().xml.replace('</ICMSTot>', '<qBCMono>10.00</qBCMono><vICMSMono>1.11</vICMSMono><qBCMonoReten>20.00</qBCMonoReten><vICMSMonoReten>2.22</vICMSMonoReten></ICMSTot>')
    const t = (await render(xml)).texts[0]
    expect(t).toEqual(expect.arrayContaining(['BC DO ICMS MONOFÁSICO', '10,00', 'VALOR DO ICMS MONOFÁSICO', '1,11', 'BC DO ICMS MONOFÁSICO POR RETENÇÃO', '20,00', 'VALOR DO ICMS MONOFÁSICO POR RETENÇÃO', '2,22']))
  })
})

describe('gates — desempenho no teto de itens e bloco maior que a folha', () => {
  it('990 itens (o teto do leiaute) desenham em tempo razoável, em 17 folhas ou mais, com todos os itens e nada abaixo do pé', async () => {
    const started = Date.now()
    const r = await render(authorizedProc(longInput(990)).xml)
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(20_000)
    expect(pdfPageCount(r.pdf)).toBeGreaterThanOrEqual(15)
    expect(r.texts.flat().filter(x => /^Item de teste número \d+$/.test(x))).toHaveLength(990)
    for (const runs of r.pages) expect(runs.filter(x => x.text !== 'SEM VALOR FISCAL' && x.yPdf <= 0.25 * 28.3465)).toEqual([])
  })

  it('um item com infAdProd de milhares de linhas (fora do XSD) é 422: nunca PDF com texto fora da folha', async () => {
    const xml = authorizedProc().xml.replace('</xProd>', `</xProd>`).replace(/(<det nItem="1">[\s\S]*?<\/imposto>)/, `$1<infAdProd>${'palavra '.repeat(6000)}</infAdProd>`)
    let e: HttpError | null = null
    try { await render(xml) } catch (x) { e = x as HttpError }
    expect(e?.statusCode).toBe(422)
    expect(e?.fields?.[0]?.field).toBe('procNfeXml')
  })
})
