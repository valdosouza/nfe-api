/// <reference types="jest" />
// nfe-api:NFE.E6.P3.T1 — o DANFE A4 retrato no leiaute da NT 2026.010 (`src/nfe/danfe/danfe.ts`; D-NE52, D-NE100): quadros, CRT, CSOSN, chave em
// blocos, protocolo, "FOLHA n/N", cabeçalho repetido, marca de homologação e carimbo CANCELADA pela voz. Ficha
// `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e6-p3-danfe.md`, mudança 4. O PDF é lido de volta pelo `pdf-text.ts` (só de teste).
import { HttpError } from 'fiscal-api'
import { renderDanfe } from '../nfe/danfe/danfe'
import { danfeMarksOf, type DanfeVoice } from '../nfe/danfe/danfe-marks'
import { NfeErrors } from '../nfe/errors'
import { authorizedProc, insertBefore, longInput } from './danfe-fixtures'
import { saleInput, saleKey } from './nfe-fixtures'
import { pdfContentOps, pdfPageCount, pdfTextRuns, type TextRun } from './pdf-text'

/** Os trechos da MESMA linha de base do trecho âncora, da esquerda para a direita. */
const rowOf = (runs: TextRun[], anchor: string): string[] => {
  const a = runs.find(r => r.text === anchor)!
  return runs.filter(r => Math.abs(r.yPdf - a.yPdf) < 0.6).sort((x, y) => x.x - y.x).map(r => r.text)
}

jest.setTimeout(120_000)

const FIXED = new Date('2026-11-24T15:00:00Z')
const PAGE = { width: 595.28, height: 841.89 }
const KEY_BLOCKS = saleKey().match(/.{4}/g)!.join(' ')

interface Rendered { pdf: Buffer; pages: TextRun[][]; texts: string[][] }
async function render(xml: string, voice: DanfeVoice, tpAmb: '1' | '2' = '2'): Promise<Rendered> {
  const pdf = await renderDanfe({ procNfeXml: xml, marks: danfeMarksOf(voice, tpAmb), creationDate: FIXED })
  const pages = pdfContentOps(pdf).map(ops => pdfTextRuns(ops))
  return { pdf, pages, texts: pages.map(p => p.map(r => r.text)) }
}
const withExtras = (xml: string): string => {
  let out = insertBefore(xml, '</transp>', '<vol><qVol>2</qVol><esp>CAIXA</esp><marca>SETES</marca><nVol>1-2</nVol><pesoL>10.500</pesoL><pesoB>11.000</pesoB></vol>')
  out = insertBefore(out, '</det>', '<infAdProd>Lote 7 conforme o pedido</infAdProd>')
  return insertBefore(out, '</total>', '<ISSQNtot><vServ>50.00</vServ><vBC>50.00</vBC><vISS>2.50</vISS></ISSQNtot>')
}
const refusal = async (p: Promise<unknown>): Promise<HttpError> => {
  try { await p } catch (e) { return e as HttpError }
  throw new Error('não recusou')
}

describe('NFE.E6.P3.T1 — o DANFE da nota autorizada em homologação (venda do Simples, CRT 1)', () => {
  let r: Rendered
  beforeAll(async () => { r = await render(withExtras(authorizedProc().xml), 'A') })

  it('uma folha, A4 retrato, com o cabeçalho do leiaute: DANFE, subtítulo, tpNF, número, série e FOLHA 1/1', () => {
    expect(pdfPageCount(r.pdf)).toBe(1)
    expect(r.pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.28 841\.89\]/)
    const t = r.texts[0]
    expect(t).toEqual(expect.arrayContaining(['DANFE', '0 - ENTRADA', '1 - SAÍDA', 'Nº 000.000.015', 'SÉRIE 1', 'FOLHA 1/1']))
    expect(t.join(' ')).toContain('DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRÔNICA')
  })

  it('a chave de acesso em 11 blocos de 4, o protocolo com a data e a hora, e a mensagem de consulta', () => {
    const t = r.texts[0]
    expect(t).toContain(KEY_BLOCKS)
    expect(KEY_BLOCKS.split(' ')).toHaveLength(11)
    expect(t).toContain('141260000012345 24/11/2026 10:16:02')
    expect(t).toEqual(expect.arrayContaining(['CHAVE DE ACESSO', 'PROTOCOLO DE AUTORIZAÇÃO DE USO']))
    expect(t.join(' ')).toContain('www.nfe.fazenda.gov.br/portal')
  })

  it('o código de barras (Code-128 da chave) está na folha: retângulos de barra ≥ 0,02 cm de módulo e ≥ 0,8 cm de altura', () => {
    const ops = pdfContentOps(r.pdf)[0]
    const rects = [...ops.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g)].map(m => [Number(m[3]), Number(m[4])])
    const bars = rects.filter(([, h]) => Math.abs(h - 28.346) < 0.01)               // 1,0 cm de altura
    expect(bars.length).toBeGreaterThan(20)
    expect(Math.min(...bars.map(([w]) => w)) / 28.3465).toBeGreaterThanOrEqual(0.02)
  })

  it('o emitente com o CRT 1, a identificação fiscal e a natureza da operação', () => {
    const t = r.texts[0]
    expect(t).toEqual(expect.arrayContaining(['SETES USINAGEM DE TESTE LTDA', 'Rua Clemente Mendes, 1081', 'Curitiba - PR', '07.742.094/0001-13', '9053273308', 'Venda de produção do estabelecimento']))
    // o CRT é campo próprio na linha da IE (modelo vertical da NT 2026.010): rótulo CÓDIGO DO REGIME TRIBUTÁRIO e o código com o nome
    expect(t).toContain('CÓDIGO DO REGIME TRIBUTÁRIO')
    expect(rowOf(r.pages[0], '9053273308')).toEqual(['9053273308', '1 - SIMPLES NACIONAL', '07.742.094/0001-13'])
    expect(t.join(' ')).not.toContain('CRT:')
  })

  it('o destinatário, o cálculo do imposto, a fatura em duas parcelas e o transportador com volume', () => {
    const t = r.texts[0]
    expect(t).toEqual(expect.arrayContaining(['11.222.333/0001-81', 'Distrito Industrial', '83005-000', '24/11/2026', '1234567890']))
    expect(t).toEqual(expect.arrayContaining(['TOTAL DOS PRODUTOS E TOTAL DA NOTA', 'TOTAL DO ICMS / IPI', 'VALOR TOTAL DA NOTA', 'VALOR TOTAL DOS PRODUTOS', 'FATURA / DUPLICATA  VENCIMENTO  VALOR', '001  22/12/2026  2.000,00', '002  19/01/2027  2.000,00']))
    expect(t.filter(x => x === '4.000,00').length).toBeGreaterThanOrEqual(3)                // produtos, nota, fatura
    expect(t).toEqual(expect.arrayContaining(['CAIXA', 'SETES', '1-2', '11,000', '10,500', 'CÁLCULO DO ISSQN', '50,00', '2,50']))
  })

  it('itens: o CSOSN no lugar do CST (rótulo e valor), o infAdProd logo abaixo da descrição, e as informações complementares inteiras', () => {
    const t = r.texts[0]
    expect(t).toContain('CSOSN')
    expect(t).not.toContain('CST')
    expect(t.filter(x => x === '101')).toHaveLength(2)
    expect(t).toEqual(expect.arrayContaining(['Flange usinada em aço Ø 50 mm', 'Lote 7 conforme o pedido', 'Bucha de bronze', '5101', '73259990']))
    const run = (text: string) => r.pages[0].find(x => x.text === text)!
    expect(run('Lote 7 conforme o pedido').yPdf).toBeLessThan(run('Flange usinada em aço Ø 50 mm').yPdf)          // y de baixo para cima: abaixo da descrição
    expect(t.join(' ')).toContain('Pedido 5001')
    expect(t).toEqual(expect.arrayContaining(['INFORMAÇÕES COMPLEMENTARES', 'RESERVADO AO FISCO']))
  })

  it('o que o XML não traz não é impresso: sem bloco IBS/CBS, sem canhoto, sem QR, sem "null"/"undefined"', () => {
    const all = r.texts[0].join(' ')
    expect(all).not.toMatch(/IBS|CBS|RECEBEMOS|undefined|null|NaN|\[object/)
    expect(all).not.toContain('CANCELADA')
  })

  it('a marca de homologação: "SEM VALOR FISCAL" em marca d\'água, UMA vez, em corpo grande e POR BAIXO do resto', () => {
    const marks = r.pages[0].filter(x => x.text === 'SEM VALOR FISCAL')
    expect(marks).toHaveLength(1)
    expect(marks[0].size).toBe(46)
    expect(r.pages[0][0].text).toBe('SEM VALOR FISCAL')                                   // 1º trecho escrito na folha = por baixo
  })

  it('todo trecho cai dentro da folha e nenhum corpo é menor que 5 pt (descritivo de coluna)', () => {
    for (const run of r.pages[0]) {
      expect(run.size).toBeGreaterThanOrEqual(5)
      if (run.text === 'SEM VALOR FISCAL') continue                                      // a marca diagonal passa da folha por desenho
      expect(run.x).toBeGreaterThanOrEqual(0)
      expect(run.x).toBeLessThanOrEqual(PAGE.width)
      expect(run.yPdf).toBeGreaterThan(0)
      expect(run.yPdf).toBeLessThan(PAGE.height)
    }
  })
})

describe('NFE.E6.P3.T1 — a nota em produção não leva a marca; a cancelada leva o carimbo (D-NE52)', () => {
  it('produção (tpAmb 1), autorizada: sem "SEM VALOR FISCAL" e sem CANCELADA', async () => {
    const input = saleInput({ environment: '1', dest: { ...saleInput().dest, xNome: 'CLIENTE REAL LTDA' } })
    const r = await render(authorizedProc(input).xml, 'A', '1')
    const all = r.texts[0].join(' ')
    expect(all).not.toContain('SEM VALOR FISCAL')
    expect(all).not.toContain('CANCELADA')
    expect(all).toContain('CLIENTE REAL LTDA')
  })

  it('cancelada em homologação: o carimbo CANCELADA (90 pt) E a marca de homologação, as duas por baixo do conteúdo', async () => {
    const r = await render(authorizedProc().xml, 'C')
    const stamp = r.pages[0].filter(x => x.text === 'CANCELADA')
    expect(stamp).toHaveLength(1)
    expect(stamp[0].size).toBe(90)
    expect(r.texts[0].slice(0, 2).sort()).toEqual(['CANCELADA', 'SEM VALOR FISCAL'])
  })

  it('cancelada em produção: só o carimbo', async () => {
    const input = saleInput({ environment: '1', dest: { ...saleInput().dest, xNome: 'CLIENTE REAL LTDA' } })
    const r = await render(authorizedProc(input).xml, 'C', '1')
    expect(r.texts[0]).toContain('CANCELADA')
    expect(r.texts[0].join(' ')).not.toContain('SEM VALOR FISCAL')
  })

  it('as vozes K e N (a nota segue autorizada) saem sem carimbo', async () => {
    for (const voice of ['K', 'N'] as const) {
      const r = await render(authorizedProc().xml, voice)
      expect(r.texts[0]).not.toContain('CANCELADA')
      expect(r.texts[0]).toContain('SEM VALOR FISCAL')
    }
  })

  it('a marca de homologação tem de bater com o tpAmb do XML (422 no campo `marks`); marcas ausentes também', async () => {
    const h = authorizedProc().xml                                                       // XML em H
    const wrong = await refusal(renderDanfe({ procNfeXml: h, marks: danfeMarksOf('A', '1') }))
    expect(wrong.statusCode).toBe(422)
    expect(wrong.code).toBe(NfeErrors.DOCUMENT_INVALID)
    expect(wrong.fields?.[0]?.field).toBe('marks')
    const prod = authorizedProc(saleInput({ environment: '1', dest: { ...saleInput().dest, xNome: 'CLIENTE REAL LTDA' } })).xml
    expect((await refusal(renderDanfe({ procNfeXml: prod, marks: danfeMarksOf('A', '2') }))).fields?.[0]?.field).toBe('marks')
    expect((await refusal(renderDanfe({ procNfeXml: h, marks: undefined as never }))).fields?.[0]?.field).toBe('marks')
  })

  it('XML que não serve para o DANFE é 422 no campo `procNfeXml` (nunca PDF parcial)', async () => {
    const e = await refusal(renderDanfe({ procNfeXml: '<nfeProc/>', marks: danfeMarksOf('A', '2') }))
    expect(e.statusCode).toBe(422)
    expect(e.fields?.[0]?.field).toBe('procNfeXml')
  })
})

describe('NFE.E6.P3.T1 — a nota longa: várias folhas, FOLHA n/N em todas, cabeçalho e títulos das colunas repetidos', () => {
  let r: Rendered
  let xml: string
  beforeAll(async () => { xml = authorizedProc(longInput(90)).xml; r = await render(xml, 'A') })

  it('mais de uma folha, e FOLHA k/N de cada uma com o total N igual ao de folhas do PDF', () => {
    const total = pdfPageCount(r.pdf)
    expect(total).toBeGreaterThanOrEqual(2)
    expect(r.texts).toHaveLength(total)
    r.texts.forEach((t, i) => expect(t).toContain(`FOLHA ${i + 1}/${total}`))
  })

  it('o cabeçalho (DANFE, número, chave em blocos, protocolo, natureza, IE e CNPJ) se repete em TODA folha, com a marca por baixo', () => {
    for (const t of r.texts) {
      expect(t).toEqual(expect.arrayContaining(['DANFE', 'Nº 000.000.015', KEY_BLOCKS, '141260000012345 24/11/2026 10:16:02', 'Venda de produção do estabelecimento', '07.742.094/0001-13']))
    }
    r.pages.forEach(p => expect(p[0].text).toBe('SEM VALOR FISCAL'))
  })

  it('os quadros da 1ª folha só saem nela; a folha de itens repete as colunas (CÓDIGO, CSOSN)', () => {
    expect(r.texts[0]).toContain('DESTINATÁRIO / REMETENTE')
    for (const t of r.texts.slice(1)) expect(t).not.toContain('DESTINATÁRIO / REMETENTE')
    for (const t of r.texts) { expect(t).toContain('CÓDIGO'); expect(t).toContain('CSOSN') }
  })

  it('os 90 itens saem uma vez cada, em ordem, e as informações complementares só no fim', () => {
    const flat = r.texts.flat()
    const itemTexts = flat.filter(x => /^Item de teste número \d+$/.test(x))
    expect(itemTexts).toEqual(Array.from({ length: 90 }, (_, i) => `Item de teste número ${i + 1}`))
    expect(flat.filter(x => x === 'INFORMAÇÕES COMPLEMENTARES')).toHaveLength(1)
    expect(r.texts[r.texts.length - 1]).toContain('INFORMAÇÕES COMPLEMENTARES')
  })

  it('nenhum trecho passa do pé da folha (margem inferior de 0,25 cm)', () => {
    for (const p of r.pages) {
      for (const run of p) {
        if (run.text === 'SEM VALOR FISCAL') continue
        expect(run.yPdf).toBeGreaterThan(0.25 * 28.3465)
      }
    }
  })

  it('o mesmo XML e a mesma data de criação dão o MESMO PDF (arquivo reproduzível)', async () => {
    const again = await render(xml, 'A')
    expect(again.pdf.equals(r.pdf)).toBe(true)
  })
})

describe('NFE.E6.P3.T1 — as informações complementares continuam na folha seguinte, no mesmo quadro', () => {
  it('um infCpl enorme (centenas de linhas) atravessa folhas sem perder linha', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `linha ${i + 1} de observação`)
    const xml = authorizedProc().xml.replace(/<infCpl>[\s\S]*?<\/infCpl>/, `<infCpl>${lines.join(' ')}</infCpl>`)
    const r = await render(xml, 'A')
    expect(pdfPageCount(r.pdf)).toBeGreaterThanOrEqual(2)
    const text = r.texts.flat().filter(x => !x.startsWith('FOLHA')).join(' ')
    for (const n of [1, 150, 400]) expect(text).toContain(`linha ${n} de observação`)
    expect(r.texts.flat().filter(x => x === 'INFORMAÇÕES COMPLEMENTARES')).toHaveLength(1)
    r.texts.forEach((t, i) => expect(t).toContain(`FOLHA ${i + 1}/${r.texts.length}`))
  })
})
