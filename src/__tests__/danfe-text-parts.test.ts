/// <reference types="jest" />
// nfe-api:NFE.E6.P3.T2 — a bateria do DANFE inclui o documento com TODOS os opcionais vazios, e cada trecho com texto traz o seu corpo e as suas
// opções de leiaute (D-NE157: nunca herdados de um trecho do meio que pode vir vazio). Ficha
// `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e6-p3-danfe.md`, mudança 5.
import fs from 'fs'
import path from 'path'

// Captura TODA chamada de `writeText` que o DANFE faz (a única porta de texto da família): o teste confere as opções de cada uma.
const calls: { role: string; text: string; opts: Record<string, unknown> }[] = []
jest.mock('fiscal-api/pdf', () => {
  const actual = jest.requireActual('fiscal-api/pdf')
  return {
    ...actual,
    writeText: (doc: unknown, role: string, text: string, opts: Record<string, unknown>) => {
      calls.push({ role, text, opts: { ...opts } })
      return actual.writeText(doc, role, text, opts)
    },
  }
})

import { renderDanfe } from '../nfe/danfe/danfe'
import { DANFE_FONT_ROLES, DANFE_TEXT_PARTS, FIT_MIN_PT } from '../nfe/danfe/danfe-layout'
import { danfeMarksOf } from '../nfe/danfe/danfe-marks'
import { authorizedProc, emptyOptionalsInput, insertBefore } from './danfe-fixtures'
import { pdfContentOps, pdfTextRuns, type TextRun } from './pdf-text'

jest.setTimeout(120_000)
const FIXED = new Date('2026-11-24T15:00:00Z')
const ALIGNS = ['left', 'center', 'right']

async function runsOf(xml: string): Promise<{ runs: TextRun[][]; calls: typeof calls }> {
  calls.length = 0
  const pdf = await renderDanfe({ procNfeXml: xml, marks: danfeMarksOf('A', '2'), creationDate: FIXED })
  return { runs: pdfContentOps(pdf).map(ops => pdfTextRuns(ops)), calls: [...calls] }
}

describe('NFE.E6.P3.T2 — a tabela de trechos: cada trecho diz o papel, o corpo e o alinhamento', () => {
  const entries = Object.entries(DANFE_TEXT_PARTS)

  it('todo trecho tem papel registrado, corpo finito positivo e alinhamento do domínio', () => {
    expect(entries.length).toBeGreaterThanOrEqual(15)
    for (const [name, p] of entries) {
      expect([name, Object.keys(DANFE_FONT_ROLES)]).toEqual([name, expect.arrayContaining([p.role])])
      expect(Number.isFinite(p.sizePt) && p.sizePt > 0).toBe(true)
      expect(ALIGNS).toContain(p.align)
      expect(Object.keys(p).sort()).toEqual(['align', 'role', 'sizePt'])             // nenhum trecho carrega opção a mais herdável
    }
  })

  it('os corpos seguem o Anexo II: 5 pt nos descritivos de bloco e coluna, 6 pt no resto dos descritivos e nos itens, 12 pt em DANFE e emitente, 10 pt na identificação', () => {
    expect(DANFE_TEXT_PARTS.blockTitle.sizePt).toBe(5)
    expect(DANFE_TEXT_PARTS.columnTitle.sizePt).toBe(5)
    expect(DANFE_TEXT_PARTS.fieldLabel.sizePt).toBe(6)
    expect(DANFE_TEXT_PARTS.itemText.sizePt).toBe(6)
    expect(DANFE_TEXT_PARTS.documentName.sizePt).toBe(12)
    expect(DANFE_TEXT_PARTS.issuerName.sizePt).toBe(12)
    expect(DANFE_TEXT_PARTS.identification.sizePt).toBe(10)
    expect(FIT_MIN_PT).toBe(6)
  })

  it('o desenho só escreve texto por UMA função: há uma única chamada de `writeText` em `danfe.ts`', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'nfe', 'danfe', 'danfe.ts'), 'utf8')
    const code = source.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')
    expect(code.match(/writeText\(/g)).toHaveLength(1)
    expect(code).not.toMatch(/\.text\(|\.font\(|\.addPage\(|heightOfString|widthOfString/)
  })
})

describe('NFE.E6.P3.T2 — cada chamada de texto traz o corpo e as opções de leiaute COMPLETOS (D-NE157)', () => {
  let full: Awaited<ReturnType<typeof runsOf>>
  beforeAll(async () => { full = await runsOf(insertBefore(authorizedProc().xml, '</det>', '<infAdProd>Lote 7 conforme o pedido</infAdProd>')) })

  it('nenhuma chamada deixa de dizer x, y, width, sizePt, align e lineBreak (nada herdado do que veio antes)', () => {
    expect(full.calls.length).toBeGreaterThan(100)
    for (const call of full.calls) {
      for (const key of ['x', 'y', 'width', 'sizePt', 'align', 'lineBreak']) {
        expect([call.text, key, call.opts[key] !== undefined]).toEqual([call.text, key, true])
      }
      expect(Object.keys(DANFE_FONT_ROLES)).toContain(call.role)
      expect(ALIGNS).toContain(call.opts.align)
      expect(call.text).not.toBe('')                                                  // texto vazio nunca chega ao desenho
      expect(typeof call.opts.sizePt === 'number' && call.opts.sizePt >= 5 && call.opts.sizePt <= 12).toBe(true)
    }
  })

  it('só a quebra de folha escreve em modo de quebra; todo o resto é linha única', () => {
    const wrapped = full.calls.filter(call => call.opts.lineBreak === true)
    expect(wrapped).toHaveLength(0)                                                   // uma folha só: nenhuma quebra
    expect(full.calls.every(call => call.opts.lineBreak === false)).toBe(true)
  })
})

describe('NFE.E6.P3.T2 — o documento com TODOS os opcionais vazios', () => {
  let empty: Awaited<ReturnType<typeof runsOf>>
  let full: Awaited<ReturnType<typeof runsOf>>
  beforeAll(async () => {
    empty = await runsOf(authorizedProc(emptyOptionalsInput()).xml)
    full = await runsOf(authorizedProc().xml)
  })

  it('sai sem erro, em uma folha, sem "undefined", "null", "NaN" nem trecho vazio, e sem os quadros facultativos', () => {
    expect(empty.runs).toHaveLength(1)
    const texts = empty.runs[0].map(r => r.text)
    expect(texts.join(' ')).not.toMatch(/undefined|null|NaN|\[object/)
    expect(texts.every(t => t.trim() !== '')).toBe(true)
    expect(texts).not.toContain('FATURA / DUPLICATAS')                                // sem cobrança no XML
    expect(texts).not.toContain('CÁLCULO DO ISSQN')
    expect(texts).toEqual(expect.arrayContaining(['DANFE', 'FOLHA 1/1', 'DESTINATÁRIO / REMETENTE', 'CÁLCULO DO IMPOSTO', 'TRANSPORTADOR / VOLUMES TRANSPORTADOS', 'DADOS DOS PRODUTOS / SERVIÇOS']))
    expect(texts).toContain('9 - Sem Ocorrência de Transporte')
  })

  it('os campos opcionais ausentes ficam em branco: o quadro existe e o valor não aparece (fantasia, complemento, IE do destinatário, EAN)', () => {
    const texts = empty.runs[0].map(r => r.text)
    expect(texts).toContain('INSCRIÇÃO ESTADUAL')                                     // o rótulo do destinatário segue lá
    expect(texts).not.toContain('SETES')                                              // xFant ausente
    expect(texts).not.toContain('1234567890')                                         // IE do destinatário ausente
    expect(texts).not.toContain('Galpão 2')                                           // xCpl ausente
    expect(texts.join(' ')).not.toContain('SEM GTIN')
  })

  it('o trecho de um campo vazio não muda o corpo nem a posição dos rótulos vizinhos (nada herdado — D-NE157)', () => {
    const labelRuns = (runs: TextRun[]): Map<string, string> => {
      const map = new Map<string, string>()
      for (const r of runs) if (r.size === 6 && /^[A-ZÀ-Ý \/.]+$/.test(r.text) && r.text.length > 3) map.set(r.text, `${r.size}|${r.x.toFixed(2)}|${r.yPdf.toFixed(2)}`)
      return map
    }
    const a = labelRuns(full.runs[0])
    const b = labelRuns(empty.runs[0])
    const common = [...a.keys()].filter(k => b.has(k) && !['DESCONTO'].includes(k))
    expect(common.length).toBeGreaterThan(20)
    for (const label of common) {
      // os quadros acima do 1º campo que muda de altura ficam no mesmo lugar; compara corpo e x (a altura do quadro da fatura muda o y de baixo)
      expect([label, a.get(label)!.split('|').slice(0, 2)]).toEqual([label, b.get(label)!.split('|').slice(0, 2)])
    }
  })

  it('cada chamada do documento vazio também traz corpo e opções completos', () => {
    for (const call of empty.calls) {
      for (const key of ['x', 'y', 'width', 'sizePt', 'align', 'lineBreak']) expect([call.text, key, call.opts[key] !== undefined]).toEqual([call.text, key, true])
    }
  })
})
