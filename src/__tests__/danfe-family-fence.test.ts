/// <reference types="jest" />
// nfe-api:NFE.E6.P3.T3 — a cópia da cerca da família do PDF (D-GP88; D-NE228; prompt_onda_nfe_sefaz.md §24.3-1) roda na suíte da nfe-api:
// varre a pasta do DANFE INTEIRA (`src/nfe/danfe/**`) e, no resto de `src/` (fora de `__tests__`), exige que nenhum arquivo seja da família
// (`isPdfFamilyFile`). Ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e6-p3-danfe.md`, mudança 1. A regra e os casos antigos moram no
// núcleo (`fiscal-api/src/__tests__/pdf-family-fence.test.ts`); aqui há um caso por regra (a cópia não derivou) e os itens NOVOS da D-NE228.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isPdfFamilyFile, pdfFamilyViolations, type FenceRule } from './pdf-family-fence'

const SRC = path.resolve(__dirname, '..')
const DANFE_DIR = path.join(SRC, 'nfe', 'danfe')

const rules = (code: string): FenceRule[] => [...new Set(pdfFamilyViolations(code).map(v => v.rule))].sort()

/** Todos os `.ts` de uma pasta, recursivamente (caminhos absolutos, ordem estável). */
function tsFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFilesUnder(full))
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full)           // qualquer fonte: um `.mts` não escapa da varredura
  }
  return out
}

/** A varredura da família: tudo da pasta do DANFE é conferido; o resto de `src/` (sem `__tests__`) não pode ser da família. */
export function scanFamily(srcDir: string, danfeDir: string): { violations: string[]; strays: string[]; scanned: number } {
  const inDanfe = new Set(tsFilesUnder(danfeDir))
  const violations: string[] = []
  for (const file of inDanfe) {
    for (const v of pdfFamilyViolations(fs.readFileSync(file, 'utf8'))) violations.push(`${path.relative(srcDir, file)}:${v.line} (${v.rule}) ${v.snippet}`)
  }
  const strays = tsFilesUnder(srcDir)
    .filter(f => !inDanfe.has(f) && !path.relative(srcDir, f).split(path.sep).includes('__tests__'))
    .filter(f => isPdfFamilyFile(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(srcDir, f))
  return { violations, strays, scanned: inDanfe.size }
}

describe('NFE.E6.P3.T3 — a cópia não derivou da regra do núcleo (um caso por regra)', () => {
  it('(a) `doc.text`/`doc.font`, (b) medida crua e `registerFont`, (c) colchete, (d) `pageAdded`, (e) matriz fora de `save()`', () => {
    const cases: [string, FenceRule[]][] = [
      ["doc.text('x')", ['a']],
      ["doc.font('Courier')", ['a']],
      ["doc.widthOfString('x')", ['b']],
      ["doc.registerFont('t', 'Symbol')", ['b']],
      ["doc['text']('x')", ['c']],
      ["doc.on('pageAdded', f)", ['d']],
      ['doc.rect(0, 0, 1, 1).clip()', ['e']],
      ['doc.save(); doc.rotate(90); doc.restore()', []],
    ]
    expect(cases.map(([c]) => [c, rules(c)])).toEqual(cases)
  })
})

describe('NFE.E6.P3.T3 — o alcance novo da D-NE228 (gate A6 do núcleo)', () => {
  it('`addContent`, `formText`, `note` e `textAnnotation` como chamada — direta, encadeada, opcional, call/apply/bind e embrulhada', () => {
    const cases = [
      "doc.addContent('BT /F1 12 Tf (x) Tj ET')",
      "doc.formText('campo', 10, 10, 100, 20)",
      "doc.note(10, 10, 20, 20, 'texto')",
      "doc.textAnnotation(10, 10, 20, 20, 'texto')",
      "doc.rect(0, 0, 1, 1).note(0, 0, 1, 1, 'x')",
      "doc?.addContent('x')",
      "doc.addContent?.('x')",
      "doc.addContent.call(doc, 'x')",
      "doc.formText.apply(doc, ['c', 1, 1, 1, 1])",
      "const w = doc.textAnnotation.bind(doc); w(1, 1, 1, 1, 'x')",
      "(doc.addContent as (s: string) => void)('x')",
      "(0, doc.note)(1, 1, 1, 1, 'x')",
      "doc.addContent`x`",
      "['a', 'b'].forEach(doc.note, doc)",
    ]
    expect(cases.map(c => [c, rules(c)])).toEqual(cases.map(c => [c, ['a']]))
  })

  it('os mesmos nomes por colchete, chave computada e Reflect (regra c) e a desestruturação do método solto (regra b)', () => {
    const cases: [string, FenceRule[]][] = [
      ["doc['addContent']('x')", ['c']],
      ["doc['formText']('c', 1, 1, 1, 1)", ['c']],
      ["doc[`note`](1, 1, 1, 1, 'x')", ['c']],
      ["doc['textAnnotation'](1, 1, 1, 1, 'x')", ['c']],
      ["Reflect.apply(doc.addContent, doc, ['x'])", ['a', 'c']],
      ["Reflect.get(doc, 'note')", ['c']],
      ['const { addContent } = doc', ['b']],
      ['const { formText: f } = doc', ['b']],
      ["const { ['textAnnotation']: t } = doc", ['c']],
    ]
    expect(cases.map(([c]) => [c, rules(c)])).toEqual(cases)
  })

  it('o resto das APIs do pdfkit que escrevem texto ou conteúdo fora das portas (M1 do gate adversarial): anotações, formulários, `continueOnNewPage` e os internos', () => {
    const cases = [
      "doc.annotate(10, 10, 20, 20, { Subtype: 'FreeText', Contents: 'x' })",
      "doc.formAnnotation('campo', 'text', 10, 10, 20, 20)",
      "doc.formField('campo')",
      "doc.formCombo('campo', 10, 10, 20, 20)",
      "doc.formList('campo', 10, 10, 20, 20)",
      "doc.formPushButton('campo', 10, 10, 20, 20)",
      "doc.formRadioButton('campo', 10, 10, 20, 20)",
      "doc.formCheckbox('campo', 10, 10, 20, 20)",
      'doc.continueOnNewPage()',
      "doc._fragment('x', 1, 2, {})",
      "doc._text('x', 1, 2, {}, () => {})",
      "doc._line('x', {}, () => {})",
      "doc.annotate.call(doc, 1, 2, 3, 4, {})",
      "doc.link(10, 10, 20, 20, 'http://x')",
      "doc.rectAnnotation(10, 10, 20, 20, { Contents: 'x' })",
      "doc.lineAnnotation(1, 2, 3, 4, {})",
      "doc.fileAnnotation(10, 10, 20, 20, { src: 'a' })",
      "doc.highlight(1, 2, 3, 4)",
      "doc.goTo(1, 2, 3, 4, 'dest')",
      "doc.markContent('Span')",
      "doc.file(Buffer.from('x'), { name: 'a.txt' })",
      "doc.addNamedEmbeddedFile('a.txt', {})",
    ]
    expect(cases.map(c => [c, rules(c)])).toEqual(cases.map(c => [c, ['a']]))
  })

  it('`doc.page.write(…)` e `doc.page.content.write(…)` (o que o `addContent` faz por dentro) e `doc[chave]` com chave que não é texto literal', () => {
    const cases: [string, FenceRule[]][] = [
      ["doc.page.write('BT (x) Tj ET')", ['b']],
      ["doc.page.content.write('BT (x) Tj ET')", ['b']],
      ["const p = doc.page; p.write('BT (x) Tj ET')", ['b']],
      ["const k = 'text'; doc[k]('x')", ['c']],
      ['doc[`te${sufixo}`](\'x\')', ['c']],
      ['doc[nome()](1)', ['c']],
    ]
    expect(cases.map(([c]) => [c, rules(c)])).toEqual(cases)
    // o que NÃO é acusado: escrever em outro objeto, ler `doc.page.height`, índice de lista com identificador que não é `doc`
    for (const c of ['stream.write(chunk)', 'const h = doc.page.height', 'const linha = linhas[i]']) expect([c, pdfFamilyViolations(c)]).toEqual([c, []])
  })

  it('o EMBRULHO e a chamada do `addPage`: referência, atribuição, colchete, `Object.defineProperty` e o texto solto', () => {
    const cases: [string, FenceRule[]][] = [
      ['doc.addPage()', ['b']],
      ["doc.addPage({ margin: 10 })", ['b']],
      ['const original = doc.addPage', ['b']],
      ['const { addPage } = doc', ['b']],
      ['doc.addPage = function () { return original.call(this) }', ['b']],
      ['const wrap = doc.addPage.bind(doc); wrap()', ['b']],
      ["doc['addPage']()", ['c', 'd']],
      ["Object.defineProperty(doc, 'addPage', { value: () => doc })", ['d']],
      ["const NOME = 'addPage'", ['d']],
    ]
    expect(cases.map(([c]) => [c, rules(c)])).toEqual(cases)
  })

  it('o que a família escreve de verdade passa: portas da base, dado com nome parecido e matriz dentro de `save()`', () => {
    for (const c of [
      "writeText(doc, 'corpo', 'DANFE', { width: 100, lineBreak: false })",
      "const largura = measureText(doc, 'corpo', 'x').width",
      'doc.save(); doc.rotate(-45); drawWatermark(doc, texto, estilo); doc.restore()',
      "const pagina = { addPageCount: 2, contentNote: 'x' }",
      'const total = folhas.length',
    ]) expect([c, pdfFamilyViolations(c)]).toEqual([c, []])
  })

  it('o isPdfFamilyFile vê o arquivo que importa `fiscal-api/pdf`, `pdfkit` ou cita o tipo `PDFKit`, e não vê o que só tem dado', () => {
    expect(isPdfFamilyFile("import { writeText } from 'fiscal-api/pdf'")).toBe(true)
    expect(isPdfFamilyFile("import PDFDocument from 'pdfkit'")).toBe(true)
    expect(isPdfFamilyFile('function f(doc: PDFKit.PDFDocument) {}')).toBe(true)
    expect(isPdfFamilyFile("import { parseXml } from 'fiscal-api'\nexport const x = 1")).toBe(false)
  })
})

describe('NFE.E6.P3.T3 — o varredor de pasta (código novo desta cópia)', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danfe-fence-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
  const put = (rel: string, code: string): void => {
    const full = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, code)
  }

  it('acusa uma violação em arquivo AUXILIAR da pasta do DANFE que não importa nada de PDF (o escape por barril local ou alias de `doc`)', () => {
    put('nfe/danfe/danfe.ts', "import { writeText } from 'fiscal-api/pdf'\nexport const a = writeText")
    put('nfe/danfe/helpers/barril.ts', "export const t = (doc: any) => doc.text('escapou')")      // sem import de PDF: o isPdfFamilyFile não o vê
    const r = scanFamily(tmp, path.join(tmp, 'nfe', 'danfe'))
    expect(r.scanned).toBe(2)
    expect(r.violations).toEqual([expect.stringContaining('helpers')])
    expect(r.violations[0]).toMatch(/\(a\)/)
    expect(r.strays).toEqual([])
  })

  it('varre também `.mts`, `.cts`, `.tsx` e `.js` da pasta do DANFE (um auxiliar com outra extensão não escapa)', () => {
    for (const ext of ['mts', 'cts', 'tsx', 'js', 'mjs']) {
      put(`nfe/danfe/aux.${ext}`, "export const t = (doc) => doc.text('escapou')")
    }
    const r = scanFamily(tmp, path.join(tmp, 'nfe', 'danfe'))
    expect(r.scanned).toBe(5)
    expect(r.violations).toHaveLength(5)
  })

  it('acusa o arquivo da família FORA da pasta (fora de `__tests__`) e ignora `__tests__`', () => {
    put('nfe/danfe/danfe.ts', 'export const limpo = 1')
    put('nfe/fora.ts', "import PDFDocument from 'pdfkit'\nexport const d = PDFDocument")
    put('__tests__/oraculo.ts', "import PDFDocument from 'pdfkit'\nexport const d = PDFDocument")
    put('outro/__tests__/x.ts', "import { writeText } from 'fiscal-api/pdf'")
    const r = scanFamily(tmp, path.join(tmp, 'nfe', 'danfe'))
    expect(r.violations).toEqual([])
    expect(r.strays).toEqual([path.join('nfe', 'fora.ts')])
  })

  it('a pasta limpa passa, e pasta inexistente varre zero arquivo', () => {
    put('nfe/danfe/danfe.ts', "import { writeText } from 'fiscal-api/pdf'\nexport const a = writeText")
    expect(scanFamily(tmp, path.join(tmp, 'nfe', 'danfe'))).toEqual({ violations: [], strays: [], scanned: 1 })
    expect(scanFamily(tmp, path.join(tmp, 'nao-existe')).scanned).toBe(0)
  })
})

describe('NFE.E6.P3.T3 — a nfe-api real', () => {
  const real = scanFamily(SRC, DANFE_DIR)

  it('a pasta do DANFE inteira não tem violação da cerca (e a varredura de fato leu os arquivos dela)', () => {
    expect(real.scanned).toBeGreaterThanOrEqual(5)                                   // danfe, danfe-format, danfe-layout, danfe-marks, danfe-read
    expect(real.violations).toEqual([])
  })

  it('nenhum arquivo FORA da pasta do DANFE (e fora de `__tests__`) é da família do PDF', () => {
    expect(real.strays).toEqual([])
  })
})
