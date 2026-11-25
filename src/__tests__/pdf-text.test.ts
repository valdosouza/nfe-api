/// <reference types="jest" />
// NFE.E6.P3 — o leitor de texto do PDF só de teste (`pdf-text.ts`) lê de volta o que a base escreve: texto com acento, posição e folha.
import { createPdf, writeText, cmToPt } from 'fiscal-api/pdf'
import { pdfPageCount, pdfRects, pdfContentOps, pdfTextByPage, pdfTextRuns } from './pdf-text'

const FIXED = new Date('2026-11-24T12:00:00Z')

describe('pdf-text — lê de volta um PDF mínimo da base', () => {
  it('texto com acento (WinAnsi), corpo e posição por trecho, e a contagem de folhas', async () => {
    const w = createPdf({ marginCm: 0.5, title: 'leitor', creationDate: FIXED, fontRoles: { corpo: 'Times-Roman' } })
    writeText(w.doc, 'corpo', 'Natureza da operação — ação', { x: cmToPt(1), y: cmToPt(2), sizePt: 10, lineBreak: false, width: cmToPt(10) })
    w.doc.rect(10, 20, 30, 40).stroke()
    const pdf = await w.end()
    expect(pdfPageCount(pdf)).toBe(1)
    expect(pdfTextByPage(pdf)).toEqual([['Natureza da operação — ação']])
    const [run] = pdfTextRuns(pdfContentOps(pdf)[0])
    expect(run.size).toBe(10)
    expect(run.x).toBeCloseTo(cmToPt(1), 3)
    expect(pdfRects(pdfContentOps(pdf)[0])).toEqual([[10, 20, 30, 40]])
  })

  it('uma folha por fluxo: o conteúdo que transborda abre a 2ª folha e cada uma tem o seu texto', async () => {
    const w = createPdf({ marginCm: 0.5, title: 'leitor', creationDate: FIXED, fontRoles: { corpo: 'Times-Roman' } })
    writeText(w.doc, 'corpo', Array.from({ length: 120 }, (_, i) => `linha ${i + 1}`).join('\n'), { sizePt: 9, x: cmToPt(0.5), y: cmToPt(0.5), width: cmToPt(8) })
    const pdf = await w.end()
    expect(pdfPageCount(pdf)).toBe(2)
    const pages = pdfTextByPage(pdf)
    expect(pages).toHaveLength(2)
    expect(pages.flat().filter(t => t.startsWith('linha ')).length).toBeGreaterThanOrEqual(120)
  })
})
