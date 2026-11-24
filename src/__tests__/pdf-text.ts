// NFE.E6.P3 — leitor de texto do PDF, SÓ DE TESTE (ficha `ficha-nfe-e6-p3-danfe.md`, mudança 4). Cópia ENXUTA do oráculo do núcleo
// (`fiscal-api/src/__tests__/pdf-oracle.ts`, commit 936f88b: `pdfTextByStream`, `pdfContentOps`, `pdfTextRuns`, `pdfPageCount`, `pdfRects`),
// sem a leitura de QR/Code-128 e sem a anotação de opacidade. O `createPdf` da base não expõe `compress`: o conteúdo de cada folha sai em fluxo
// Flate com fontes-padrão em WinAnsi (hex); aqui o fluxo é inflado e os operadores `Tj`/`TJ` viram texto (cp1252). Regra de extração: um
// trecho por operador de texto, na ordem de escrita; folha = fluxo com `BT` ou `re`; fluxo de imagem/XObject é ignorado.
import zlib from 'zlib'

const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ'
const cp1252 = (bytes: Buffer): string => [...bytes].map(b => (b >= 0x80 && b <= 0x9F ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b))).join('')

function isImageStream(s: string, i: number): boolean {
  const dict = s.slice(Math.max(s.lastIndexOf(' obj', i), 0), i)
  return /\/Subtype\s*\/Image\b|\/Type\s*\/XObject\b/.test(dict)
}

/** Os operadores crus de cada stream de conteúdo que desenha algo (uma por folha no pdfkit), na ordem. */
export function pdfContentOps(pdf: Buffer): string[] {
  const s = pdf.toString('latin1')
  const out: string[] = []
  let i = 0
  while ((i = s.indexOf('stream', i)) !== -1) {
    if (s.slice(i - 3, i) === 'end') { i += 6; continue }
    if (isImageStream(s, i)) { i += 6; continue }
    let start = i + 6
    if (s[start] === '\r') start++
    if (s[start] === '\n') start++
    const end = s.indexOf('endstream', start)
    if (end < 0) break
    const raw = pdf.subarray(start, end)
    let txt: string
    try { txt = zlib.inflateSync(raw).toString('latin1') } catch { txt = raw.toString('latin1') }
    if (/\bBT\b|\bre\b/.test(txt)) out.push(txt)
    i = end + 9
  }
  return out
}

const hexText = (line: string): string => {
  const parts = /TJ$/.test(line) ? [...line.matchAll(/<([0-9a-fA-F]+)>/g)].map(h => h[1]) : [(/<([0-9a-fA-F]+)>/.exec(line) ?? [])[1] ?? '']
  return parts.map(h => cp1252(Buffer.from(h, 'hex'))).join('')
}

export interface TextRun {
  readonly text: string
  /** Recurso da fonte (ex.: "F3") e corpo em pontos. */
  readonly font: string
  readonly size: number
  /** Posição do texto no espaço do PDF (`Tm`; y de baixo para cima). */
  readonly x: number
  readonly yPdf: number
}

/** Cada trecho de texto da folha com fonte, corpo e posição vigentes. */
export function pdfTextRuns(ops: string): TextRun[] {
  const runs: TextRun[] = []
  let font = '', size = 0, x = 0, y = 0
  for (const raw of ops.split('\n')) {
    const line = raw.trim()
    if (/ Tf$/.test(line)) { const m = /^\/(\S+) ([\d.]+) Tf$/.exec(line); if (m) { font = m[1]; size = Number(m[2]) } }
    else if (/ Tm$/.test(line)) { const p = line.split(/\s+/); x = Number(p[4]); y = Number(p[5]) }
    else if (/T[Jj]$/.test(line)) runs.push({ text: hexText(line), font, size, x, yPdf: y })
  }
  return runs
}

/** O texto de cada folha, trecho a trecho, na ordem de escrita. */
export const pdfTextByPage = (pdf: Buffer): string[][] => pdfContentOps(pdf).map(ops => pdfTextRuns(ops).map(r => r.text))

/** Retângulos `x y w h re` (espaço do pdfkit: origem no canto de cima). */
export const pdfRects = (ops: string): [number, number, number, number][] =>
  [...ops.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g)].map(m => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])

/** Quantas folhas o PDF declara (`/Type /Page`, sem `/Pages`). */
export const pdfPageCount = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/Type \/Page(?!s)\b/g) ?? []).length
