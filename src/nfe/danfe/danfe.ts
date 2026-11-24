import { cmToPt, code128Bars, code128Symbols, createPdf, drawBars, drawWatermark, measureText, writeText } from 'fiscal-api/pdf'
import { documentInvalid } from '../errors'
import { accessKeyBlocks, brDate, brDateTime, brDecimal, brZip, clockTime, federalId, invoiceNumber, joinParts } from './danfe-format'
import {
  CM, CRT_LABELS, DANFE_FONT_ROLES, DANFE_TEXTS, DANFE_TEXT_PARTS, ITEM_COLUMNS, MOD_FRETE_LABELS, WATERMARKS,
  type DanfePartName,
} from './danfe-layout'
import { danfeMarksOf, type DanfeMarks, type DanfeVoice } from './danfe-marks'
import type { TpAmbCode } from '../homologation'
import { readNfeProc, type DanfeData, type DanfeFields, type DanfeItem, type DanfeParty } from './danfe-read'

/**
 * O DANFE A4 RETRATO do modelo 55 (NFE.E6.P3 — NT 2026.010 sobre o Anexo II do MOC 7.00; D-NE51, D-NE52, D-NE100, D-NE157, D-NE228; ficha
 * `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e6-p3-danfe.md`).
 *
 * CONTRATO (o que a rota da NFE.E6.P4 chama):
 *   `renderDanfe({ procNfeXml, marks, creationDate? }) → Promise<Buffer>` — o PDF.
 *   - `procNfeXml`: o `nfeProc` ARQUIVADO da nota AUTORIZADA (NFe assinada + `protNFe` de cStat 100/150); lido pelo `parseXml` estrito do núcleo
 *     (`danfe-read.ts`). O DANFE reproduz só o que o XML traz (NT L174-181): nada é inferido nem calculado.
 *   - `marks`: de `danfeMarksOf(voz, tpAmb)` — `homologation` (marca d'água "SEM VALOR FISCAL", AII 3.x) e `cancelled` (carimbo CANCELADA, D-NE52).
 *     A marca de homologação tem de bater com o `tpAmb` do XML (senão 422 no campo `marks`): quem pede o DANFE de H com marca de P, ou o inverso, erra.
 *   - Recusa = HttpError 422 `FISCAL_DOCUMENT_INVALID` (campo `procNfeXml` ou `marks`); nunca PDF parcial. Sem banco, sem `.env`, sem rede, sem relógio:
 *     `creationDate` (padrão: agora) é a única fonte de tempo, e fixá-la dá PDF reprodutível.
 *
 * COMO É FEITO: só as portas da base de PDF (`fiscal-api/pdf`: `createPdf`, `writeText`/`measureText`, `drawBars`, `drawWatermark`) — a cerca
 * `danfe-family-fence.test.ts` varre esta pasta (D-NE228). TODO texto passa pela função `emit` (a ÚNICA chamada de `writeText` deste arquivo; o
 * teste `danfe-text-parts.test.ts` confere), que recebe corpo e opções COMPLETOS de cada trecho (D-NE157). Quadros e medidas em `danfe-layout.ts`.
 * O cabeçalho (emitente, identificação, chave com Code-128, natureza, protocolo, IE/IE ST/CNPJ) é desenhado pelo `sheetStart` da base em TODA folha
 * (AII L645-668) e "FOLHA n/N" pela passada por folha (AII 3.10.2). Itens e informações complementares seguem para novas folhas com o cabeçalho
 * repetido; a folha nova de itens repete a linha de títulos das colunas.
 * Sem canhoto, sem logo (a porta de imagem do núcleo é o passo da D-NE241), sem QR Code, sem bloco IBS/CBS (o XML do Simples em 2026 não traz o
 * grupo), sem DANFE de contingência (D-E12): ficha §10.
 */
export interface RenderDanfeInput {
  readonly procNfeXml: string
  /** A última voz da tentativa (o `kind` lido pela view da família): decide se há DANFE e se leva o carimbo (`danfeMarksOf`). */
  readonly voice: DanfeVoice
  /** Data gravada no PDF (padrão: agora). */
  readonly creationDate?: Date
}

const c = cmToPt
const PAD = CM.padPt
const LINE_W = 0.5

type Doc = PDFKit.PDFDocument
interface Ctx {
  doc: Doc
  data: DanfeData
  marks: DanfeMarks
  /** O `y` onde o conteúdo de cada folha começa (logo abaixo do cabeçalho). */
  contentTop: number
  /** O `y` corrente do desenho (próprio: o `doc.y` do pdfkit só vale para o fluxo de texto). */
  y: number
  sheet: number
}

const left = (): number => c(CM.margin)
const bottomLimit = (doc: Doc): number => doc.page.height - doc.page.margins.bottom

/** Normaliza larguras em cm para somarem a largura útil (a tabela do leiaute é sugestão: a soma pode variar em centésimos). */
function scaled(widthsCm: readonly number[]): number[] {
  const sum = widthsCm.reduce((a, b) => a + b, 0)
  return widthsCm.map(w => c((w * CM.width) / sum))
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// A PORTA DE TEXTO DO DANFE: `emit` é a ÚNICA chamada de `writeText` (D-NE157 — corpo e opções completos em cada trecho, nada herdado).
// ---------------------------------------------------------------------------------------------------------------------------------------
interface Emission {
  readonly part: DanfePartName
  readonly text: string
  readonly x: number
  readonly y: number
  readonly widthPt: number
  readonly sizePt: number
  /** Linha única (padrão do DANFE: o texto já vem medido para caber). `false` só para a quebra de folha. */
  readonly singleLine: boolean
}

function emit(doc: Doc, e: Emission): void {
  if (e.text === '') return                                                 // texto vazio não chama o desenho (D-NE157)
  const p = DANFE_TEXT_PARTS[e.part]
  // a tabela de trechos MANDA no corpo: fora de [minSizePt, sizePt] é defeito do desenho (nunca vira PDF com corpo menor que o do Anexo II)
  if (!(e.sizePt >= p.minSizePt && e.sizePt <= p.sizePt)) throw new Error(`DANFE: corpo ${e.sizePt} pt fora da faixa do trecho ${e.part}`)
  writeText(doc, p.fontRole, e.text, { x: e.x, y: e.y, width: e.widthPt, sizePt: e.sizePt, align: p.align, lineBreak: !e.singleLine })
}

/** Largura (pt) de um texto numa linha, no corpo pedido. */
const widthCache = new WeakMap<Doc, Map<string, number>>()
function widthOf(doc: Doc, part: DanfePartName, text: string, sizePt: number): number {
  let cache = widthCache.get(doc)
  if (!cache) { cache = new Map(); widthCache.set(doc, cache) }
  const key = `${part}|${sizePt}|${text}`
  let w = cache.get(key)
  if (w === undefined) {
    w = measureText(doc, DANFE_TEXT_PARTS[part].fontRole, text, { sizePt, x: left() }).width
    if (cache.size < 50_000) cache.set(key, w)                              // teto de memória por documento
  }
  return w
}

const lineCache = new WeakMap<Doc, Map<string, number>>()
/** Altura (pt) de uma linha do trecho no corpo pedido. */
function lineHeight(doc: Doc, part: DanfePartName, sizePt: number): number {
  let cache = lineCache.get(doc)
  if (!cache) { cache = new Map(); lineCache.set(doc, cache) }
  const key = `${part}|${sizePt}`
  let h = cache.get(key)
  if (h === undefined) {
    h = measureText(doc, DANFE_TEXT_PARTS[part].fontRole, 'Mg', { sizePt, width: c(10), x: left() }).height
    cache.set(key, h)
  }
  return h
}

/** O maior `n >= 1` tal que `text.slice(0, n)` cabe em `widthPt` (busca binária: custo O(log n) medidas, não O(n) — H1 do gate adversarial). */
function fitChars(doc: Doc, part: DanfePartName, text: string, widthPt: number, sizePt: number): number {
  let lo = 1
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (widthOf(doc, part, text.slice(0, mid), sizePt) <= widthPt) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Quebra o texto em linhas que cabem em `widthPt` (palavras; palavra maior que a linha é partida por caractere). Respeita `\n`. */
function wrapLines(doc: Doc, part: DanfePartName, text: string, widthPt: number, sizePt: number): string[] {
  const out: string[] = []
  for (const rawParagraph of text.split('\n')) {
    // 3 ou mais espaços seguidos valem 2: o XSD aceita centenas de espaços no meio do texto, e cada espaço extra seria uma "palavra" vazia medida de novo
    // (custo quadrático: 5.000 espaços levavam 89 s de CPU síncrona — HIGH-N1 do gate adversarial); só espaço em branco muda, nenhum caractere visível
    const paragraph = rawParagraph.replace(/ {3,}/g, '  ')
    let line = ''
    for (const word of paragraph.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`
      if (widthOf(doc, part, candidate, sizePt) <= widthPt) { line = candidate; continue }
      if (line !== '') { out.push(line); line = '' }
      let rest = word
      while (rest !== '' && widthOf(doc, part, rest, sizePt) > widthPt) {
        const n = fitChars(doc, part, rest, widthPt, sizePt)           // sempre >= 1: um caractere mais largo que a linha sai sozinho, sem laço
        out.push(rest.slice(0, n))
        rest = rest.slice(n)
      }
      line = rest
    }
    out.push(line)
  }
  return out
}

/**
 * Descritivo ou chave numa linha que CABE: encolhe o corpo até o `minSizePt` do trecho e, no limite, abrevia com reticências. SÓ para textos FIXOS
 * do leiaute e a chave (44 caracteres): o VALOR de campo do XML nunca passa por aqui — usa `putWrapped` (quebra, não abrevia: M2 do gate adversarial).
 */
function putFit(doc: Doc, part: DanfePartName, text: string, x: number, y: number, widthPt: number): void {
  if (text === '') return
  const p = DANFE_TEXT_PARTS[part]
  let size: number = p.sizePt
  while (size > p.minSizePt && widthOf(doc, part, text, size) > widthPt) size = Math.max(size - 0.5, p.minSizePt)
  let shown = text
  if (widthOf(doc, part, shown, size) > widthPt) {
    let lo = 0
    let hi = shown.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (widthOf(doc, part, `${shown.slice(0, mid)}...`, size) <= widthPt) lo = mid
      else hi = mid - 1
    }
    shown = `${shown.slice(0, lo)}...`
  }
  emit(doc, { part, text: shown, x, y, widthPt, sizePt: size, singleLine: true })
}

/** Escreve o texto QUEBRADO em linhas no corpo do trecho (sem encolher, sem abreviar) e devolve a altura usada. */
function putWrapped(doc: Doc, part: DanfePartName, text: string, x: number, y: number, widthPt: number): number {
  const size = DANFE_TEXT_PARTS[part].sizePt
  const lh = lineHeight(doc, part, size)
  const lines = text === '' ? [] : wrapLines(doc, part, text, widthPt, size)
  lines.forEach((line, n) => emit(doc, { part, text: line, x, y: y + n * lh, widthPt, sizePt: size, singleLine: true }))
  return lines.length * lh
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Caixas e campos
// ---------------------------------------------------------------------------------------------------------------------------------------
function box(doc: Doc, x: number, y: number, w: number, h: number): void {
  doc.save()
  doc.lineWidth(LINE_W)
  doc.rect(x, y, w, h).stroke()
  doc.restore()
}

function vline(doc: Doc, x: number, y1: number, y2: number): void {
  doc.save()
  doc.lineWidth(LINE_W)
  doc.moveTo(x, y1).lineTo(x, y2).stroke()
  doc.restore()
}

interface FieldSpec { readonly weight: number; readonly label: string; readonly value: string; readonly part: DanfePartName }

/**
 * Uma linha de campos lado a lado: caixa + descritivo (6 pt) + valor QUEBRADO no corpo do trecho (10 pt). A altura é a maior entre a mínima do
 * leiaute e a que o valor mais longo pede. Devolve o `y` de baixo.
 */
function rowHeight(doc: Doc, heightCm: number, specs: readonly FieldSpec[]): number {
  const widths = scaled(specs.map(sp => sp.weight))
  const labelH = lineHeight(doc, 'fieldLabel', DANFE_TEXT_PARTS.fieldLabel.sizePt)
  const lines = specs.map((sp, i) => (sp.value === '' ? 0 : wrapLines(doc, sp.part, sp.value, widths[i] - 2 * PAD, DANFE_TEXT_PARTS[sp.part].sizePt).length))
  const tallest = specs.reduce((m, sp, i) => Math.max(m, lines[i] * lineHeight(doc, sp.part, DANFE_TEXT_PARTS[sp.part].sizePt)), 0)
  return Math.max(c(heightCm), PAD / 2 + labelH + tallest + PAD)
}

function fieldRow(doc: Doc, y: number, heightCm: number, specs: readonly FieldSpec[]): number {
  const widths = scaled(specs.map(sp => sp.weight))
  const labelH = lineHeight(doc, 'fieldLabel', DANFE_TEXT_PARTS.fieldLabel.sizePt)
  const h = rowHeight(doc, heightCm, specs)
  let x = left()
  specs.forEach((sp, i) => {
    box(doc, x, y, widths[i], h)
    putFit(doc, 'fieldLabel', sp.label, x + PAD, y + PAD / 2, widths[i] - 2 * PAD)
    putWrapped(doc, sp.part, sp.value, x + PAD, y + PAD / 2 + labelH, widths[i] - 2 * PAD)
    x += widths[i]
  })
  return y + h
}

/** Título de bloco (5 pt negrito caixa alta) acima dos campos. */
function blockTitle(doc: Doc, y: number, text: string): number {
  const h = lineHeight(doc, 'blockTitle', DANFE_TEXT_PARTS.blockTitle.sizePt)
  putFit(doc, 'blockTitle', text, left(), y, c(CM.width))
  return y + h + 1
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Cabeçalho repetido em toda folha (`sheetStart`) e "FOLHA n/N" (passada)
// ---------------------------------------------------------------------------------------------------------------------------------------
function issuerLines(p: DanfeParty): string[] {
  const a = p.address
  return [
    joinParts([joinParts([a.xLgr, a.nro], ', '), a.xCpl], ' - '),
    joinParts([a.xBairro, a.CEP ? `CEP ${brZip(a.CEP)}` : null], ' - '),
    joinParts([joinParts([a.xMun, a.UF], ' - '), a.fone ? `Fone: ${a.fone}` : null], ' - '),
  ].filter(l => l !== '')
}

/** As linhas do quadro do emitente (razão social em 12 pt, dados em 8 pt) e a altura que elas pedem — o quadro CRESCE com o dado (L2 do gate socrático). */
function issuerContent(doc: Doc, p: DanfeParty, inner: number): { name: string[]; data: string[]; height: number } {
  const name = p.xFant && p.xNome ? p.xNome : (p.xNome ?? p.xFant ?? '')
  const nameLines = name === '' ? [] : wrapLines(doc, 'issuerName', name, inner, DANFE_TEXT_PARTS.issuerName.sizePt)
  const dataLines = issuerLines(p).flatMap(raw => wrapLines(doc, 'issuerData', raw, inner, DANFE_TEXT_PARTS.issuerData.sizePt))
  const height = PAD * 2 + nameLines.length * lineHeight(doc, 'issuerName', DANFE_TEXT_PARTS.issuerName.sizePt) + PAD
    + dataLines.length * lineHeight(doc, 'issuerData', DANFE_TEXT_PARTS.issuerData.sizePt) + PAD
  return { name: nameLines, data: dataLines, height }
}

function drawIssuerBox(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  const { doc, data } = ctx
  box(doc, x, y, w, h)
  const inner = w - 2 * PAD
  const content = issuerContent(doc, data.emit, inner)
  const size: number = DANFE_TEXT_PARTS.issuerName.sizePt
  let cursor = y + PAD * 2
  for (const line of content.name) {
    emit(doc, { part: 'issuerName', text: line, x: x + PAD, y: cursor, widthPt: inner, sizePt: size, singleLine: true })
    cursor += lineHeight(doc, 'issuerName', size)
  }
  cursor += PAD
  const dataSize = DANFE_TEXT_PARTS.issuerData.sizePt
  for (const line of content.data) {
    emit(doc, { part: 'issuerData', text: line, x: x + PAD, y: cursor, widthPt: inner, sizePt: dataSize, singleLine: true })
    cursor += lineHeight(doc, 'issuerData', dataSize)
  }
}

function drawIdentBox(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  const { doc, data } = ctx
  box(doc, x, y, w, h)
  const inner = w - 2 * PAD
  let cursor = y + PAD * 2
  const line = (part: DanfePartName, text: string, sizePt: number = DANFE_TEXT_PARTS[part].sizePt): void => {
    for (const piece of wrapLines(doc, part, text, inner, sizePt)) {
      emit(doc, { part, text: piece, x: x + PAD, y: cursor, widthPt: inner, sizePt, singleLine: true })
      cursor += lineHeight(doc, part, sizePt)
    }
  }
  line('documentName', DANFE_TEXTS.title)
  line('documentSubtitle', DANFE_TEXTS.subtitle)
  cursor += PAD
  line('documentSubtitle', DANFE_TEXTS.entry)
  line('documentSubtitle', DANFE_TEXTS.exit)
  // o tipo de operação (tpNF) em quadro de 10 pt negrito ao lado
  const tpBox = c(0.55)
  box(doc, x + w - tpBox - PAD, cursor - 2 * lineHeight(doc, 'documentSubtitle', 8), tpBox, tpBox)
  emit(doc, { part: 'identification', text: data.ide.tpNF ?? '', x: x + w - tpBox - PAD, y: cursor - 2 * lineHeight(doc, 'documentSubtitle', 8) + PAD * 2, widthPt: tpBox, sizePt: DANFE_TEXT_PARTS.identification.sizePt, singleLine: true })
  cursor += PAD
  line('identification', data.ide.nNF ? `Nº ${invoiceNumber(data.ide.nNF)}` : '')
  line('identification', data.ide.serie ? `SÉRIE ${data.ide.serie}` : '')
}

function drawKeyBox(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  const { doc, data } = ctx
  box(doc, x, y, w, h)
  const inner = w - 2 * PAD
  const barsH = c(CM.header.barsHeight)
  drawBars(doc, code128Bars(code128Symbols(data.accessKey)), { x: x + PAD, y: y + PAD * 2, width: inner, height: barsH })
  let cursor = y + PAD * 2 + barsH + PAD * 2
  const labelH = lineHeight(doc, 'fieldLabel', DANFE_TEXT_PARTS.fieldLabel.sizePt)
  putFit(doc, 'fieldLabel', DANFE_TEXTS.accessKey, x + PAD, cursor, inner)
  cursor += labelH
  putFit(doc, 'accessKey', accessKeyBlocks(data.accessKey), x + PAD, cursor, inner)
  cursor += lineHeight(doc, 'accessKey', DANFE_TEXT_PARTS.accessKey.sizePt) + PAD
  const consultSize = DANFE_TEXT_PARTS.consultMessage.sizePt
  for (const piece of wrapLines(doc, 'consultMessage', DANFE_TEXTS.consult, inner, consultSize)) {
    emit(doc, { part: 'consultMessage', text: piece, x: x + PAD, y: cursor, widthPt: inner, sizePt: consultSize, singleLine: true })
    cursor += lineHeight(doc, 'consultMessage', consultSize)
  }
}

/** O cabeçalho da folha (AII L645-668) e a marca por baixo; deixa `doc.y` logo abaixo, onde o conteúdo começa. */
function drawSheetStart(ctx: Ctx, sheet: number): void {
  const { doc, data, marks } = ctx
  ctx.sheet = sheet
  if (marks.homologation) {
    drawWatermark(doc, DANFE_TEXTS.watermarkHomologation, WATERMARKS.homologation)
  }
  if (marks.cancelled) {
    drawWatermark(doc, DANFE_TEXTS.stampCancelled, WATERMARKS.cancelled)
  }
  const H = CM.header
  const top = c(CM.margin)
  const x0 = left()
  // a altura do 1º andar é a do leiaute ou a que o emitente pedir (os três quadros dividem a mesma altura)
  const issuer = issuerContent(doc, data.emit, c(H.emitW) - 2 * PAD)
  // um emitente que pede mais de 10 cm de cabeçalho (o XSD limita o nome a 60 e o endereço a 60 por linha) não cabe em folha: recusa, nunca cabeçalho que come a folha
  if (issuer.height > c(10)) throw documentInvalid('O XML da nota traz um emitente grande demais para o cabeçalho do DANFE', [{ field: 'procNfeXml', message: 'Nome ou endereço do emitente fora do tamanho do leiaute' }])
  const topH = Math.max(c(H.top), issuer.height)
  drawIssuerBox(ctx, x0, top, c(H.emitW), topH)
  drawIdentBox(ctx, x0 + c(H.emitW), top, c(H.identW), topH)
  drawKeyBox(ctx, x0 + c(H.emitW) + c(H.identW), top, c(H.keyW), topH)
  const protocol = joinParts([data.authorization.nProt, brDateTime(data.authorization.dhRecbto)], ' ')
  let y = fieldRow(doc, top + topH, H.rowB, [
    { weight: H.natW, label: DANFE_TEXTS.natOp, value: data.ide.natOp ?? '', part: 'fieldValue' },
    { weight: H.protW, label: DANFE_TEXTS.protocol, value: protocol, part: 'fieldCentered' },
  ])
  // modelo da NT 2026.010: a IE, o CÓDIGO DO REGIME TRIBUTÁRIO (CRT), a IE do substituto e o CNPJ na mesma linha
  y = fieldRow(doc, y, H.rowC, [
    { weight: 4.3, label: DANFE_TEXTS.ie, value: data.emit.IE ?? '', part: 'fieldValue' },
    { weight: 4.8, label: DANFE_TEXTS.crt, value: data.emit.CRT ? (CRT_LABELS[data.emit.CRT] ?? data.emit.CRT) : '', part: 'fieldValue' },
    { weight: 5.4, label: DANFE_TEXTS.iest, value: data.emit.IEST ?? '', part: 'fieldValue' },
    { weight: 6.0, label: DANFE_TEXTS.cnpj, value: federalId(data.emit.id), part: 'fieldValue' },
  ])
  ctx.contentTop = y + c(CM.gap)
  ctx.y = ctx.contentTop
  doc.x = x0
  doc.y = ctx.contentTop
}

/** "FOLHA n/N" no quadro de identificação (AII 3.10.2: na parte superior de CADA folha, inclusive a única). */
function drawSheetNumber(doc: Doc, sheet: number, total: number): void {
  const H = CM.header
  const w = c(H.identW)
  emit(doc, {
    part: 'identification', text: `FOLHA ${sheet}/${total}`, x: left() + c(H.emitW), y: c(CM.margin) + c(H.top) - c(0.55),
    widthPt: w, sizePt: DANFE_TEXT_PARTS.identification.sizePt, singleLine: true,
  })
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Corpo
// ---------------------------------------------------------------------------------------------------------------------------------------
/** Abre uma folha nova: escreve um espaço no pé da folha, o que faz o pdfkit abrir a folha (e a base rodar o `sheetStart`). */
function newSheet(ctx: Ctx): void {
  const { doc } = ctx
  emit(doc, { part: 'itemText', text: ' ', x: left(), y: bottomLimit(doc), widthPt: c(1), sizePt: DANFE_TEXT_PARTS.itemText.sizePt, singleLine: false })
  ctx.y = ctx.contentTop
}

/** Garante `needed` pt livres; abre folha se não couber. Devolve `true` quando abriu. */
function ensureRoom(ctx: Ctx, needed: number): boolean {
  // um bloco (linha de campos ou item) mais alto que a folha útil não cabe nem numa folha nova: recusa, nunca texto fora da folha
  if (needed > bottomLimit(ctx.doc) - ctx.contentTop) {
    throw documentInvalid('O XML da nota traz um bloco maior que a folha do DANFE', [{ field: 'procNfeXml', message: 'Texto de um item ou campo grande demais para uma folha' }])
  }
  if (ctx.y + needed <= bottomLimit(ctx.doc)) return false
  const before = ctx.sheet
  newSheet(ctx)
  if (ctx.sheet === before) throw new Error('DANFE: a folha nova não abriu')
  return true
}

const money = (v: string | null | undefined): string => brDecimal(v)

/**
 * Uma linha de campos do CORPO: mede a altura que o valor mais longo pede, reserva ESSA altura (com o título do bloco, quando é a 1ª linha) e abre
 * folha nova se não couber — o quadro nunca passa do pé da folha (MEDIUM-N2 do gate adversarial).
 */
function ctxRow(ctx: Ctx, heightCm: number, specs: readonly FieldSpec[], title?: string): void {
  const { doc } = ctx
  const titleH = title ? lineHeight(doc, 'blockTitle', DANFE_TEXT_PARTS.blockTitle.sizePt) + 1 : 0
  ensureRoom(ctx, titleH + rowHeight(doc, heightCm, specs))
  let y = ctx.y
  if (title) y = blockTitle(doc, y, title)
  ctx.y = fieldRow(doc, y, heightCm, specs)
}

const gap = (ctx: Ctx): void => { ctx.y += c(CM.gap) }

function drawRecipient(ctx: Ctx): void {
  const { data } = ctx
  const r = data.dest
  const a = r.address
  ctxRow(ctx, CM.cell, [
    { weight: 12.0, label: 'NOME / RAZÃO SOCIAL', value: r.xNome ?? '', part: 'fieldValue' },
    { weight: 4.5, label: 'CNPJ / CPF', value: federalId(r.id), part: 'fieldValue' },
    { weight: 4.0, label: 'DATA DA EMISSÃO', value: brDate(data.ide.dhEmi), part: 'fieldCentered' },
  ], DANFE_TEXTS.recipient)
  ctxRow(ctx, CM.cell, [
    { weight: 9.0, label: 'ENDEREÇO', value: joinParts([joinParts([a.xLgr, a.nro], ', '), a.xCpl], ' - '), part: 'fieldValue' },
    { weight: 4.5, label: 'BAIRRO / DISTRITO', value: a.xBairro ?? '', part: 'fieldValue' },
    { weight: 3.0, label: 'CEP', value: brZip(a.CEP), part: 'fieldCentered' },
    { weight: 4.0, label: 'DATA DA SAÍDA / ENTRADA', value: brDate(data.ide.dhSaiEnt), part: 'fieldCentered' },
  ])
  ctxRow(ctx, CM.cell, [
    { weight: 9.0, label: 'MUNICÍPIO', value: a.xMun ?? '', part: 'fieldValue' },
    { weight: 3.5, label: 'FONE / FAX', value: a.fone ?? '', part: 'fieldValue' },
    { weight: 1.0, label: 'UF', value: a.UF ?? '', part: 'fieldCentered' },
    { weight: 3.5, label: 'INSCRIÇÃO ESTADUAL', value: r.IE ?? '', part: 'fieldValue' },
    { weight: 3.5, label: 'HORA DA SAÍDA / ENTRADA', value: clockTime(data.ide.dhSaiEnt), part: 'fieldCentered' },
  ])
  gap(ctx)
}

function drawInvoice(ctx: Ctx): void {
  const { data } = ctx
  const { fat, dups } = data.billing
  if (!fat && dups.length === 0) return                                    // quadro facultativo: só se o XML traz cobrança (NT L194-196)
  let title: string | undefined = DANFE_TEXTS.invoice
  if (fat) {
    ctxRow(ctx, CM.cell, [
      { weight: 1, label: 'FATURA', value: fat.nFat ?? '', part: 'fieldValue' },
      { weight: 1, label: 'VALOR ORIGINAL', value: money(fat.vOrig), part: 'fieldNumber' },
      { weight: 1, label: 'DESCONTO', value: money(fat.vDesc), part: 'fieldNumber' },
      { weight: 1, label: 'VALOR LÍQUIDO', value: money(fat.vLiq), part: 'fieldNumber' },
    ], title)
    title = undefined
  }
  const perRow = 4
  for (let i = 0; i < dups.length; i += perRow) {
    const specs: FieldSpec[] = dups.slice(i, i + perRow).map(d => ({
      weight: 1, label: DANFE_TEXTS.duplicate, value: joinParts([d.nDup, brDate(d.dVenc), money(d.vDup)], '  '), part: 'fieldCentered' as const,
    }))
    while (specs.length < perRow) specs.push({ weight: 1, label: '', value: '', part: 'fieldCentered' })
    ctxRow(ctx, CM.cell, specs, title)
    title = undefined
  }
  gap(ctx)
}

/** Valor decimal diferente de zero (os totais condicionais da NT 4.4 só saem quando o XML os traz com valor — suposição S-8 da ficha). */
const nonZero = (v: string | null | undefined): boolean => v !== null && v !== undefined && v !== '' && !/^-?0+(\.0+)?$/.test(v)

/** "TOTAL DOS PRODUTOS E TOTAL DA NOTA" (modelo vertical da NT 2026.010). */
function drawTotals(ctx: Ctx): void {
  const t = ctx.data.totals
  ctxRow(ctx, CM.cell, [
    { weight: 1, label: 'VALOR TOTAL DOS PRODUTOS', value: money(t.vProd), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR DO FRETE', value: money(t.vFrete), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR DO SEGURO', value: money(t.vSeg), part: 'fieldNumber' },
    { weight: 1, label: 'DESCONTO', value: money(t.vDesc), part: 'fieldNumber' },
    { weight: 1, label: 'OUTRAS DESPESAS ACESSÓRIAS', value: money(t.vOutro), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR TOTAL DA NOTA', value: money(t.vNF), part: 'fieldNumber' },
  ], DANFE_TEXTS.totals)
  gap(ctx)
}

/**
 * "TOTAL DO ICMS / IPI" (modelo vertical da NT 2026.010): BC e valor do ICMS, BC e valor do ICMS ST, IPI; e, só quando o XML traz com valor
 * (NT 4.4; S-8 da ficha: valor diferente de zero), FCP, FCP retido por ST, DIFAL na UF de destino, FCP da UF de destino e o ICMS monofásico
 * (valor e base quantitativa, próprio e por retenção).
 */
function drawIcmsIpi(ctx: Ctx): void {
  const t = ctx.data.totals
  ctxRow(ctx, CM.cell, [
    { weight: 1, label: 'BASE DE CÁLCULO DO ICMS', value: money(t.vBC), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR DO ICMS', value: money(t.vICMS), part: 'fieldNumber' },
    { weight: 1, label: 'BASE DE CÁLCULO DO ICMS ST', value: money(t.vBCST), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR DO ICMS ST', value: money(t.vST), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR DO IPI', value: money(t.vIPI), part: 'fieldNumber' },
  ], DANFE_TEXTS.icmsIpi)
  const extras: { label: string; value: string }[] = ([
    ['VALOR DO FCP', t.vFCP], ['VALOR DO FCP RETIDO POR ST', t.vFCPST], ['VALOR DO DIFAL NA UF DE DESTINO', t.vICMSUFDest],
    ['VALOR DO FCP NA UF DE DESTINO', t.vFCPUFDest], ['BC DO ICMS MONOFÁSICO', t.qBCMono], ['VALOR DO ICMS MONOFÁSICO', t.vICMSMono],
    ['BC DO ICMS MONOFÁSICO POR RETENÇÃO', t.qBCMonoReten], ['VALOR DO ICMS MONOFÁSICO POR RETENÇÃO', t.vICMSMonoReten],
  ] as const).filter(([, v]) => nonZero(v)).map(([label, v]) => ({ label, value: money(v) }))
  for (let i = 0; i < extras.length; i += 4) {
    const specs: FieldSpec[] = extras.slice(i, i + 4).map(e => ({ weight: 1, label: e.label, value: e.value, part: 'fieldNumber' as const }))
    while (specs.length < 4) specs.push({ weight: 1, label: '', value: '', part: 'fieldNumber' })
    ctxRow(ctx, CM.cell, specs)
  }
  gap(ctx)
}

function drawIssqn(ctx: Ctx): void {
  const { data } = ctx
  const s = data.issqnTotals
  if (!s) return                                                            // suprimível quando não se aplica (NT L239-242)
  ctxRow(ctx, CM.cell, [
    { weight: 1, label: 'INSCRIÇÃO MUNICIPAL', value: data.emit.IM ?? '', part: 'fieldValue' },
    { weight: 1, label: 'VALOR TOTAL DOS SERVIÇOS', value: money(s.vServ), part: 'fieldNumber' },
    { weight: 1, label: 'BASE DE CÁLCULO DO ISSQN', value: money(s.vBC), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR DO ISSQN', value: money(s.vISS), part: 'fieldNumber' },
  ], DANFE_TEXTS.issqn)
  gap(ctx)
}

function drawCarrier(ctx: Ctx): void {
  const { data } = ctx
  const tr = data.transp
  const carrier: DanfeFields = tr.carrier ?? {}
  const vehicle: DanfeFields = tr.vehicle ?? {}
  // exibição detalhada CONDICIONADA à existência de dados (NT 2026.010 4.4): sem transportador, veículo, volume nem modalidade de frete
  // com transporte (0 a 4), o quadro não sai; "9 - Sem Ocorrência de Transporte" sozinho é ausência de dado
  const hasData = tr.carrier !== null || tr.vehicle !== null || tr.volumes.length > 0 || (tr.modFrete !== null && tr.modFrete !== '9')
  if (!hasData) return
  ctxRow(ctx, CM.cell, [
    { weight: 5.0, label: 'NOME / RAZÃO SOCIAL', value: carrier.xNome ?? '', part: 'fieldValue' },
    { weight: 6.5, label: 'FRETE POR CONTA', value: tr.modFrete ? (MOD_FRETE_LABELS[tr.modFrete] ?? tr.modFrete) : '', part: 'fieldValue' },
    { weight: 2.2, label: 'CÓDIGO ANTT', value: vehicle.RNTC ?? '', part: 'fieldCentered' },
    { weight: 2.2, label: 'PLACA DO VEÍCULO', value: vehicle.placa ?? '', part: 'fieldCentered' },
    { weight: 1.0, label: 'UF', value: vehicle.UF ?? '', part: 'fieldCentered' },
    { weight: 3.6, label: 'CNPJ / CPF', value: federalId(carrier.CNPJ ?? carrier.CPF ?? null), part: 'fieldValue' },
  ], DANFE_TEXTS.carrier)
  if (tr.carrier) {
    ctxRow(ctx, CM.cell, [
      { weight: 9.0, label: 'ENDEREÇO', value: carrier.xEnder ?? '', part: 'fieldValue' },
      { weight: 6.5, label: 'MUNICÍPIO', value: carrier.xMun ?? '', part: 'fieldValue' },
      { weight: 1.0, label: 'UF', value: carrier.UF ?? '', part: 'fieldCentered' },
      { weight: 3.5, label: 'INSCRIÇÃO ESTADUAL', value: carrier.IE ?? '', part: 'fieldValue' },
    ])
  }
  for (const v of tr.volumes) {
    const f = v.fields
    ctxRow(ctx, CM.cell, [
      { weight: 2.5, label: 'QUANTIDADE', value: f.qVol ?? '', part: 'fieldCentered' },
      { weight: 4.0, label: 'ESPÉCIE', value: f.esp ?? '', part: 'fieldValue' },
      { weight: 4.0, label: 'MARCA', value: f.marca ?? '', part: 'fieldValue' },
      { weight: 3.5, label: 'NUMERAÇÃO', value: f.nVol ?? '', part: 'fieldValue' },
      { weight: 3.25, label: 'PESO BRUTO', value: brDecimal(f.pesoB), part: 'fieldNumber' },
      { weight: 3.25, label: 'PESO LÍQUIDO', value: brDecimal(f.pesoL), part: 'fieldNumber' },
    ])
  }
  gap(ctx)
}

// ---- itens -----------------------------------------------------------------------------------------------------------------------------
function itemCells(item: DanfeItem): Record<string, string> {
  const p = item.prod
  const i = item.icms
  return {
    code: p.cProd ?? '', description: p.xProd ?? '', ncm: p.NCM ?? '',
    tax: i.CSOSN ?? i.CST ?? '', cfop: p.CFOP ?? '', unit: p.uCom ?? '',
    qty: brDecimal(p.qCom), unitValue: brDecimal(p.vUnCom), total: brDecimal(p.vProd),
    bc: brDecimal(i.vBC), icms: brDecimal(i.vICMS), rate: brDecimal(i.pICMS),
  }
}

/** Unidade, quantidade ou valor unitário tributável diferentes dos comerciais: os DOIS aparecem (AII 3.1.7). Texto só com campos do XML. */
function taxableLine(item: DanfeItem): string {
  const p = item.prod
  const differs = (a: string | null | undefined, b: string | null | undefined): boolean => {
    if (b === null || b === undefined) return false
    const na = Number(a)
    const nb = Number(b)
    return a !== null && a !== undefined && Number.isFinite(na) && Number.isFinite(nb) && b !== '' && a !== '' ? na !== nb : b !== a   // `2` e `2.0000` são o mesmo número
  }
  if (!(differs(p.uCom, p.uTrib) || differs(p.qCom, p.qTrib) || differs(p.vUnCom, p.vUnTrib))) return ''
  return `Trib.: ${joinParts([brDecimal(p.qTrib), p.uTrib], ' ')} x ${brDecimal(p.vUnTrib)}`
}

/** A linha de títulos das colunas (5 pt caixa alta); a coluna do imposto diz CSOSN quando o grupo do ICMS é do Simples. */
function drawItemsHeader(ctx: Ctx, simples: boolean): void {
  const { doc } = ctx
  let y = ctx.y
  y = blockTitle(doc, y, DANFE_TEXTS.items)
  const widths = scaled(ITEM_COLUMNS.map(col => col.widthCm))
  const h = lineHeight(doc, 'columnTitle', DANFE_TEXT_PARTS.columnTitle.sizePt) * 2 + 2 * PAD
  let x = left()
  ITEM_COLUMNS.forEach((col, k) => {
    box(doc, x, y, widths[k], h)
    const title = col.key === 'tax' ? (simples ? 'CSOSN' : 'CST') : col.title
    const size = DANFE_TEXT_PARTS.columnTitle.sizePt
    const lines = wrapLines(doc, 'columnTitle', title, widths[k] - 2 * PAD, size)
    lines.slice(0, 2).forEach((line, n) => {
      emit(doc, { part: 'columnTitle', text: line, x: x + PAD, y: y + PAD + n * lineHeight(doc, 'columnTitle', size), widthPt: widths[k] - 2 * PAD, sizePt: size, singleLine: true })
    })
    x += widths[k]
  })
  ctx.y = y + h
}

function drawItems(ctx: Ctx): void {
  const { doc, data } = ctx
  const simples = data.items.some(it => (it.icmsGroup ?? '').startsWith('ICMSSN'))
  const widths = scaled(ITEM_COLUMNS.map(col => col.widthCm))
  const headerH = lineHeight(doc, 'columnTitle', DANFE_TEXT_PARTS.columnTitle.sizePt) * 2 + 2 * PAD + lineHeight(doc, 'blockTitle', DANFE_TEXT_PARTS.blockTitle.sizePt) + 1
  const textSize = DANFE_TEXT_PARTS.itemText.sizePt
  const textH = lineHeight(doc, 'itemText', textSize)
  ensureRoom(ctx, headerH + textH * 2 + 2 * PAD)
  drawItemsHeader(ctx, simples)
  for (const item of data.items) {
    const cells = itemCells(item)
    // cada coluna QUEBRA em linhas (nunca abrevia: o valor do XML é reproduzido inteiro); a descrição leva o tributável e o `infAdProd` logo abaixo
    const columnLines = ITEM_COLUMNS.map((col, k) => {
      const w = widths[k] - 2 * PAD
      if (col.key !== 'description') return cells[col.key] === '' ? [] : wrapLines(doc, col.part, cells[col.key], w, textSize)
      const extra = [taxableLine(item), item.infAdProd ?? ''].filter(t => t !== '')
      return [...(cells.description === '' ? [] : wrapLines(doc, col.part, cells.description, w, textSize)), ...extra.flatMap(t => wrapLines(doc, col.part, t, w, textSize))]
    })
    const h = Math.max(...columnLines.map(l => l.length), 1) * textH + 2 * PAD
    if (ensureRoom(ctx, h)) drawItemsHeader(ctx, simples)
    let x = left()
    const y = ctx.y
    ITEM_COLUMNS.forEach((col, k) => {
      if (k > 0) vline(doc, x, y, y + h)
      const w = widths[k] - 2 * PAD
      columnLines[k].forEach((line, n) => emit(doc, { part: col.part, text: line, x: x + PAD, y: y + PAD + n * textH, widthPt: w, sizePt: textSize, singleLine: true }))
      x += widths[k]
    })
    doc.save()
    doc.lineWidth(LINE_W)
    doc.moveTo(left(), y + h).lineTo(left() + c(CM.width), y + h).stroke()
    doc.moveTo(left(), y).lineTo(left(), y + h).stroke()
    doc.moveTo(left() + c(CM.width), y).lineTo(left() + c(CM.width), y + h).stroke()
    doc.restore()
    ctx.y = y + h
  }
  ctx.y += c(CM.gap)
}

// ---- dados adicionais --------------------------------------------------------------------------------------------------------------------
/** Informações complementares: TODO `infAdFisco` e `infCpl` (AII L498-510); a continuação vai para a folha seguinte, no mesmo quadro. */
function drawAdditional(ctx: Ctx): void {
  const { doc, data } = ctx
  const text = joinParts([data.infAdFisco, data.infCpl], '\n')
  const widths = scaled([14.0, 6.5])
  const size = DANFE_TEXT_PARTS.itemText.sizePt
  const textH = lineHeight(doc, 'itemText', size)
  const lines = text === '' ? [] : wrapLines(doc, 'itemText', text, widths[0] - 2 * PAD, size)
  const titleH = lineHeight(doc, 'blockTitle', DANFE_TEXT_PARTS.blockTitle.sizePt) + 1
  const labelH = lineHeight(doc, 'fieldLabel', DANFE_TEXT_PARTS.fieldLabel.sizePt) + 1
  const minBox = c(2.0)
  ensureRoom(ctx, titleH + Math.min(minBox, labelH + Math.max(lines.length, 1) * textH + 2 * PAD))
  let y = blockTitle(doc, ctx.y, DANFE_TEXTS.additional)
  let index = 0
  let first = true
  do {
    const room = bottomLimit(doc) - y
    const head = first ? labelH : 0                                          // só o 1º trecho do quadro leva o descritivo
    const fit = Math.max(Math.floor((room - 2 * PAD - head) / textH), 1)
    const take = lines.slice(index, index + fit)
    const needed = head + Math.max(take.length, 1) * textH + 2 * PAD
    const boxH = first ? Math.max(needed, Math.min(minBox, room)) : needed
    box(doc, left(), y, widths[0], boxH)
    box(doc, left() + widths[0], y, widths[1], boxH)
    if (first) {
      putFit(doc, 'fieldLabel', DANFE_TEXTS.complementary, left() + PAD, y + 1, widths[0] - 2 * PAD)
      putFit(doc, 'fieldLabel', DANFE_TEXTS.reserved, left() + widths[0] + PAD, y + 1, widths[1] - 2 * PAD)
    }
    take.forEach((line, n) => emit(doc, { part: 'itemText', text: line, x: left() + PAD, y: y + PAD + head + n * textH, widthPt: widths[0] - 2 * PAD, sizePt: size, singleLine: true }))
    index += take.length
    ctx.y = y + boxH
    first = false
    if (index < lines.length) {
      newSheet(ctx)
      y = ctx.y
    }
  } while (index < lines.length)
}

// ---------------------------------------------------------------------------------------------------------------------------------------
export async function renderDanfe(input: RenderDanfeInput): Promise<Buffer> {
  const data = readNfeProc(input?.procNfeXml)
  // as marcas saem da VOZ e do ambiente do PRÓPRIO XML: ninguém monta marca por fora (nem pede marca de H para nota de P); voz sem autorização = 422 no campo `voice`
  const marks = danfeMarksOf(input?.voice ?? null, data.ide.tpAmb as TpAmbCode)
  const ctx = { data, marks, contentTop: 0, y: 0, sheet: 0 } as Ctx
  try {
    const w = createPdf({
      paper: 'A4', layout: 'portrait', marginCm: CM.margin, title: `DANFE NF-e ${invoiceNumber(data.ide.nNF)}`, creationDate: input.creationDate,
      fontRoles: DANFE_FONT_ROLES,
      sheetStart: (doc, sheet) => { ctx.doc = doc; drawSheetStart(ctx, sheet) },
    })
    ctx.doc = w.doc
    // ordem do modelo vertical da NT 2026.010 (D-NE100; o Anexo II vale no que a NT não muda): destinatário, fatura, totais dos produtos e da nota,
    // total do ICMS/IPI, (total do IBS/CBS/IS: só se o XML trouxer o grupo — não no Simples de 2026), ISSQN, transportador, itens, dados adicionais
    drawRecipient(ctx)
    drawInvoice(ctx)
    drawTotals(ctx)
    drawIcmsIpi(ctx)
    drawIssqn(ctx)
    drawCarrier(ctx)
    drawItems(ctx)
    drawAdditional(ctx)
    return await w.end((doc, info) => drawSheetNumber(doc, info.sheet, info.total))
  } catch (e) {
    // a base recusa texto que não cabe ou com controle por `RangeError`: entrada fora da forma é 422, nunca 500 (M4 do gate adversarial)
    if (e instanceof RangeError) throw documentInvalid('O XML da nota traz um valor que o DANFE não consegue desenhar', [{ field: 'procNfeXml', message: 'Valor fora da forma do leiaute' }])
    throw e
  }
}
