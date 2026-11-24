import { cmToPt, code128Bars, code128Symbols, createPdf, drawBars, drawWatermark, measureText, writeText } from 'fiscal-api/pdf'
import { documentInvalid } from '../errors'
import { accessKeyBlocks, brDate, brDateTime, brDecimal, brZip, clockTime, federalId, invoiceNumber, joinParts } from './danfe-format'
import {
  CM, CRT_LABELS, DANFE_FONT_ROLES, DANFE_TEXTS, DANFE_TEXT_PARTS, FIT_MIN_PT, ITEM_COLUMNS, MOD_FRETE_LABELS,
  type DanfePartName,
} from './danfe-layout'
import type { DanfeMarks } from './danfe-marks'
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
  readonly marks: DanfeMarks
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
  writeText(doc, p.role, e.text, { x: e.x, y: e.y, width: e.widthPt, sizePt: e.sizePt, align: p.align, lineBreak: !e.singleLine })
}

/** Largura (pt) de um texto numa linha, no corpo pedido. */
function widthOf(doc: Doc, part: DanfePartName, text: string, sizePt: number): number {
  return measureText(doc, DANFE_TEXT_PARTS[part].role, text, { sizePt, x: left() }).width
}

const lineCache = new WeakMap<Doc, Map<string, number>>()
/** Altura (pt) de uma linha do trecho no corpo pedido. */
function lineHeight(doc: Doc, part: DanfePartName, sizePt: number): number {
  let cache = lineCache.get(doc)
  if (!cache) { cache = new Map(); lineCache.set(doc, cache) }
  const key = `${part}|${sizePt}`
  let h = cache.get(key)
  if (h === undefined) {
    h = measureText(doc, DANFE_TEXT_PARTS[part].role, 'Mg', { sizePt, width: c(10), x: left() }).height
    cache.set(key, h)
  }
  return h
}

/** Quebra o texto em linhas que cabem em `widthPt` (palavras; palavra maior que a linha é partida por caractere). Respeita `\n`. */
function wrapLines(doc: Doc, part: DanfePartName, text: string, widthPt: number, sizePt: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`
      if (widthOf(doc, part, candidate, sizePt) <= widthPt) { line = candidate; continue }
      if (line !== '') { out.push(line); line = '' }
      let rest = word
      while (rest !== '' && widthOf(doc, part, rest, sizePt) > widthPt) {
        let n = rest.length - 1
        while (n > 1 && widthOf(doc, part, rest.slice(0, n), sizePt) > widthPt) n--
        out.push(rest.slice(0, n))
        rest = rest.slice(n)
      }
      line = rest
    }
    out.push(line)
  }
  return out
}

/** Escreve uma linha que CABE: encolhe o corpo até `FIT_MIN_PT` e, no limite, abrevia com reticências (campo de largura fixa do leiaute). */
function putFit(doc: Doc, part: DanfePartName, text: string, x: number, y: number, widthPt: number, maxSizePt?: number): void {
  if (text === '') return
  let size = maxSizePt ?? DANFE_TEXT_PARTS[part].sizePt
  while (size > FIT_MIN_PT && widthOf(doc, part, text, size) > widthPt) size -= 0.5
  let shown = text
  if (widthOf(doc, part, shown, size) > widthPt) {
    let n = shown.length
    while (n > 1 && widthOf(doc, part, `${shown.slice(0, n)}...`, size) > widthPt) n--
    shown = `${shown.slice(0, n)}...`
  }
  emit(doc, { part, text: shown, x, y, widthPt, sizePt: size, singleLine: true })
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

/** Uma linha de campos lado a lado: caixa + descritivo (6 pt) + valor (encolhe até 6 pt). Devolve o `y` de baixo. */
function fieldRow(doc: Doc, y: number, heightCm: number, specs: readonly FieldSpec[]): number {
  const widths = scaled(specs.map(s => s.weight))
  const h = c(heightCm)
  let x = left()
  specs.forEach((s, i) => {
    box(doc, x, y, widths[i], h)
    const labelH = lineHeight(doc, 'fieldLabel', DANFE_TEXT_PARTS.fieldLabel.sizePt)
    putFit(doc, 'fieldLabel', s.label, x + PAD, y + PAD / 2, widths[i] - 2 * PAD)
    putFit(doc, s.part, s.value, x + PAD, y + PAD / 2 + labelH, widths[i] - 2 * PAD)
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
    p.CRT ? `CRT: ${CRT_LABELS[p.CRT] ?? p.CRT}` : '',
  ].filter(l => l !== '')
}

function drawIssuerBox(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  const { doc, data } = ctx
  box(doc, x, y, w, h)
  const inner = w - 2 * PAD
  const name = data.emit.xFant && data.emit.xNome ? data.emit.xNome : (data.emit.xNome ?? data.emit.xFant ?? '')
  // razão social: 12 pt negrito, no máximo 3 linhas (encolhe o corpo se preciso, até o piso)
  let size: number = DANFE_TEXT_PARTS.issuerName.sizePt
  let lines = wrapLines(doc, 'issuerName', name, inner, size)
  while (lines.length > 3 && size > FIT_MIN_PT) { size -= 0.5; lines = wrapLines(doc, 'issuerName', name, inner, size) }
  let cursor = y + PAD * 2
  for (const line of lines) {
    emit(doc, { part: 'issuerName', text: line, x: x + PAD, y: cursor, widthPt: inner, sizePt: size, singleLine: true })
    cursor += lineHeight(doc, 'issuerName', size)
  }
  cursor += PAD
  const dataSize = DANFE_TEXT_PARTS.issuerData.sizePt
  for (const raw of issuerLines(data.emit)) {
    for (const line of wrapLines(doc, 'issuerData', raw, inner, dataSize)) {
      emit(doc, { part: 'issuerData', text: line, x: x + PAD, y: cursor, widthPt: inner, sizePt: dataSize, singleLine: true })
      cursor += lineHeight(doc, 'issuerData', dataSize)
    }
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
  line('documentSubtitle', DANFE_TEXTS.subtitle, 6)
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
    drawWatermark(doc, DANFE_TEXTS.watermarkHomologation, { font: 'Helvetica-Bold', sizePt: 46, angleDeg: -45, color: [0, 0, 0, 35], opacity: 0.35 })
  }
  if (marks.cancelled) {
    drawWatermark(doc, DANFE_TEXTS.stampCancelled, { font: 'Helvetica-Bold', sizePt: 90, angleDeg: 45, color: [0, 100, 100, 0], opacity: 0.35 })
  }
  const H = CM.header
  const top = c(CM.margin)
  const x0 = left()
  const topH = c(H.top)
  drawIssuerBox(ctx, x0, top, c(H.emitW), topH)
  drawIdentBox(ctx, x0 + c(H.emitW), top, c(H.identW), topH)
  drawKeyBox(ctx, x0 + c(H.emitW) + c(H.identW), top, c(H.keyW), topH)
  const protocol = joinParts([data.authorization.nProt, brDateTime(data.authorization.dhRecbto)], ' ')
  let y = fieldRow(doc, top + topH, H.rowB, [
    { weight: H.natW, label: DANFE_TEXTS.natOp, value: data.ide.natOp ?? '', part: 'fieldValue' },
    { weight: H.protW, label: DANFE_TEXTS.protocol, value: protocol, part: 'fieldCentered' },
  ])
  y = fieldRow(doc, y, H.rowC, [
    { weight: 6.86, label: DANFE_TEXTS.ie, value: data.emit.IE ?? '', part: 'fieldValue' },
    { weight: 6.86, label: DANFE_TEXTS.iest, value: data.emit.IEST ?? '', part: 'fieldValue' },
    { weight: 6.78, label: DANFE_TEXTS.cnpj, value: federalId(data.emit.id), part: 'fieldValue' },
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
  if (ctx.y + needed <= bottomLimit(ctx.doc)) return false
  const before = ctx.sheet
  newSheet(ctx)
  if (ctx.sheet === before) throw new Error('DANFE: a folha nova não abriu')
  return true
}

const money = (v: string | null | undefined): string => brDecimal(v)

function drawRecipient(ctx: Ctx): void {
  const { doc, data } = ctx
  const r = data.dest
  const a = r.address
  const rows = (): void => {
    let y = ctx.y
    y = blockTitle(doc, y, DANFE_TEXTS.recipient)
    y = fieldRow(doc, y, CM.cell, [
      { weight: 12.0, label: 'NOME / RAZÃO SOCIAL', value: r.xNome ?? '', part: 'fieldValue' },
      { weight: 4.5, label: 'CNPJ / CPF', value: federalId(r.id), part: 'fieldValue' },
      { weight: 4.0, label: 'DATA DA EMISSÃO', value: brDate(data.ide.dhEmi), part: 'fieldCentered' },
    ])
    y = fieldRow(doc, y, CM.cell, [
      { weight: 9.0, label: 'ENDEREÇO', value: joinParts([joinParts([a.xLgr, a.nro], ', '), a.xCpl], ' - '), part: 'fieldValue' },
      { weight: 4.5, label: 'BAIRRO / DISTRITO', value: a.xBairro ?? '', part: 'fieldValue' },
      { weight: 3.0, label: 'CEP', value: brZip(a.CEP), part: 'fieldCentered' },
      { weight: 4.0, label: 'DATA DA SAÍDA / ENTRADA', value: brDate(data.ide.dhSaiEnt), part: 'fieldCentered' },
    ])
    y = fieldRow(doc, y, CM.cell, [
      { weight: 9.0, label: 'MUNICÍPIO', value: a.xMun ?? '', part: 'fieldValue' },
      { weight: 3.5, label: 'FONE / FAX', value: a.fone ?? '', part: 'fieldValue' },
      { weight: 1.0, label: 'UF', value: a.UF ?? '', part: 'fieldCentered' },
      { weight: 3.5, label: 'INSCRIÇÃO ESTADUAL', value: r.IE ?? '', part: 'fieldValue' },
      { weight: 3.5, label: 'HORA DA SAÍDA / ENTRADA', value: clockTime(data.ide.dhSaiEnt), part: 'fieldCentered' },
    ])
    ctx.y = y + c(CM.gap)
  }
  ensureRoom(ctx, c(CM.cell) * 3 + c(0.5))
  rows()
}

function drawInvoice(ctx: Ctx): void {
  const { doc, data } = ctx
  const { fat, dups } = data.billing
  if (!fat && dups.length === 0) return                                    // quadro facultativo: só se o XML traz cobrança (NT L194-196)
  const perRow = 5
  ensureRoom(ctx, c(CM.cell) + c(0.5))
  let y = blockTitle(doc, ctx.y, DANFE_TEXTS.invoice)
  ctx.y = y
  if (fat) {
    y = fieldRow(doc, y, CM.cell, [
      { weight: 1, label: 'FATURA', value: fat.nFat ?? '', part: 'fieldValue' },
      { weight: 1, label: 'VALOR ORIGINAL', value: money(fat.vOrig), part: 'fieldNumber' },
      { weight: 1, label: 'DESCONTO', value: money(fat.vDesc), part: 'fieldNumber' },
      { weight: 1, label: 'VALOR LÍQUIDO', value: money(fat.vLiq), part: 'fieldNumber' },
    ])
  }
  for (let i = 0; i < dups.length; i += perRow) {
    ctx.y = y
    ensureRoom(ctx, c(CM.cell))
    y = ctx.y
    const chunk = dups.slice(i, i + perRow)
    const specs: FieldSpec[] = chunk.map(d => ({
      weight: 1, label: `DUPLICATA ${d.nDup ?? ''}`.trim(), value: joinParts([brDate(d.dVenc), money(d.vDup)], '  '), part: 'fieldCentered' as const,
    }))
    while (specs.length < perRow) specs.push({ weight: 1, label: '', value: '', part: 'fieldCentered' })
    y = fieldRow(doc, y, CM.cell, specs)
  }
  ctx.y = y + c(CM.gap)
}

function drawTax(ctx: Ctx): void {
  const { doc, data } = ctx
  const t = data.totals
  ensureRoom(ctx, c(CM.cell) * 2 + c(0.5))
  let y = blockTitle(doc, ctx.y, DANFE_TEXTS.tax)
  y = fieldRow(doc, y, CM.cell, [
    { weight: 1, label: 'BASE DE CÁLC. DO ICMS', value: money(t.vBC), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR DO ICMS', value: money(t.vICMS), part: 'fieldNumber' },
    { weight: 1, label: 'BASE DE CÁLC. ICMS S.T.', value: money(t.vBCST), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR DO ICMS SUBST.', value: money(t.vST), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR TOTAL DOS PRODUTOS', value: money(t.vProd), part: 'fieldNumber' },
  ])
  y = fieldRow(doc, y, CM.cell, [
    { weight: 1, label: 'VALOR DO FRETE', value: money(t.vFrete), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR DO SEGURO', value: money(t.vSeg), part: 'fieldNumber' },
    { weight: 1, label: 'DESCONTO', value: money(t.vDesc), part: 'fieldNumber' },
    { weight: 1, label: 'OUTRAS DESPESAS ACESSÓRIAS', value: money(t.vOutro), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR DO IPI', value: money(t.vIPI), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR TOTAL DA NOTA', value: money(t.vNF), part: 'fieldNumber' },
  ])
  ctx.y = y + c(CM.gap)
}

function drawCarrier(ctx: Ctx): void {
  const { doc, data } = ctx
  const tr = data.transp
  const carrier: DanfeFields = tr.carrier ?? {}
  const vehicle: DanfeFields = tr.vehicle ?? {}
  const rowsNeeded = 1 + (tr.carrier ? 1 : 0) + Math.max(tr.volumes.length > 0 ? 1 : 0, 0)
  ensureRoom(ctx, c(CM.cell) * rowsNeeded + c(0.5))
  let y = blockTitle(doc, ctx.y, DANFE_TEXTS.carrier)
  y = fieldRow(doc, y, CM.cell, [
    { weight: 5.0, label: 'NOME / RAZÃO SOCIAL', value: carrier.xNome ?? '', part: 'fieldValue' },
    { weight: 6.5, label: 'FRETE POR CONTA', value: tr.modFrete ? (MOD_FRETE_LABELS[tr.modFrete] ?? tr.modFrete) : '', part: 'fieldValue' },
    { weight: 2.2, label: 'CÓDIGO ANTT', value: vehicle.RNTC ?? '', part: 'fieldCentered' },
    { weight: 2.2, label: 'PLACA DO VEÍCULO', value: vehicle.placa ?? '', part: 'fieldCentered' },
    { weight: 1.0, label: 'UF', value: vehicle.UF ?? '', part: 'fieldCentered' },
    { weight: 3.6, label: 'CNPJ / CPF', value: federalId(carrier.CNPJ ?? carrier.CPF ?? null), part: 'fieldValue' },
  ])
  if (tr.carrier) {
    y = fieldRow(doc, y, CM.cell, [
      { weight: 9.0, label: 'ENDEREÇO', value: carrier.xEnder ?? '', part: 'fieldValue' },
      { weight: 6.5, label: 'MUNICÍPIO', value: carrier.xMun ?? '', part: 'fieldValue' },
      { weight: 1.0, label: 'UF', value: carrier.UF ?? '', part: 'fieldCentered' },
      { weight: 3.5, label: 'INSCRIÇÃO ESTADUAL', value: carrier.IE ?? '', part: 'fieldValue' },
    ])
  }
  for (const v of tr.volumes) {
    ctx.y = y
    ensureRoom(ctx, c(CM.cell))
    y = ctx.y
    const f = v.fields
    y = fieldRow(doc, y, CM.cell, [
      { weight: 2.5, label: 'QUANTIDADE', value: f.qVol ?? '', part: 'fieldCentered' },
      { weight: 4.0, label: 'ESPÉCIE', value: f.esp ?? '', part: 'fieldValue' },
      { weight: 4.0, label: 'MARCA', value: f.marca ?? '', part: 'fieldValue' },
      { weight: 3.5, label: 'NUMERAÇÃO', value: f.nVol ?? '', part: 'fieldValue' },
      { weight: 3.25, label: 'PESO BRUTO', value: brDecimal(f.pesoB), part: 'fieldNumber' },
      { weight: 3.25, label: 'PESO LÍQUIDO', value: brDecimal(f.pesoL), part: 'fieldNumber' },
    ])
  }
  ctx.y = y + c(CM.gap)
}

function drawIssqn(ctx: Ctx): void {
  const { doc, data } = ctx
  const s = data.issqnTotals
  if (!s) return                                                            // suprimível quando não se aplica (NT L239-242)
  ensureRoom(ctx, c(CM.cell) + c(0.5))
  let y = blockTitle(doc, ctx.y, DANFE_TEXTS.issqn)
  y = fieldRow(doc, y, CM.cell, [
    { weight: 1, label: 'INSCRIÇÃO MUNICIPAL', value: data.emit.IM ?? '', part: 'fieldValue' },
    { weight: 1, label: 'VALOR TOTAL DOS SERVIÇOS', value: money(s.vServ), part: 'fieldNumber' },
    { weight: 1, label: 'BASE DE CÁLCULO DO ISSQN', value: money(s.vBC), part: 'fieldNumber' },
    { weight: 1, label: 'VALOR DO ISSQN', value: money(s.vISS), part: 'fieldNumber' },
  ])
  ctx.y = y + c(CM.gap)
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
    // a descrição leva as linhas do `infAdProd` logo abaixo (Anexo II: "logo abaixo do item")
    const descWidth = widths[1] - 2 * PAD
    const descLines = [...wrapLines(doc, 'itemText', cells.description, descWidth, textSize),
      ...(item.infAdProd ? wrapLines(doc, 'itemText', item.infAdProd, descWidth, textSize) : [])]
    const h = Math.max(descLines.length, 1) * textH + 2 * PAD
    if (ensureRoom(ctx, h)) drawItemsHeader(ctx, simples)
    let x = left()
    const y = ctx.y
    ITEM_COLUMNS.forEach((col, k) => {
      if (k > 0) vline(doc, x, y, y + h)
      const w = widths[k] - 2 * PAD
      if (col.key === 'description') {
        descLines.forEach((line, n) => emit(doc, { part: col.part, text: line, x: x + PAD, y: y + PAD + n * textH, widthPt: w, sizePt: textSize, singleLine: true }))
      } else {
        putFit(doc, col.part, cells[col.key] ?? '', x + PAD, y + PAD, w, textSize)
      }
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
  ensureRoom(ctx, titleH + Math.min(c(2.0), Math.max(lines.length, 1) * textH + 2 * PAD))
  let y = blockTitle(doc, ctx.y, DANFE_TEXTS.additional)
  let index = 0
  let first = true
  do {
    const room = bottomLimit(doc) - y
    const fit = Math.max(Math.floor((room - 2 * PAD) / textH), 1)
    const take = lines.slice(index, index + fit)
    const h = first && lines.length === 0 ? c(2.0) : Math.max(take.length, 1) * textH + 2 * PAD
    const boxH = first ? Math.max(h, Math.min(c(2.0), room)) : h
    box(doc, left(), y, widths[0], boxH)
    box(doc, left() + widths[0], y, widths[1], boxH)
    if (first) {
      putFit(doc, 'blockTitle', DANFE_TEXTS.complementary, left() + PAD, y + 1, widths[0] - 2 * PAD)
      putFit(doc, 'blockTitle', DANFE_TEXTS.reserved, left() + widths[0] + PAD, y + 1, widths[1] - 2 * PAD)
    }
    const labelH = first ? lineHeight(doc, 'blockTitle', DANFE_TEXT_PARTS.blockTitle.sizePt) : 0
    take.forEach((line, n) => emit(doc, { part: 'itemText', text: line, x: left() + PAD, y: y + PAD + labelH + n * textH, widthPt: widths[0] - 2 * PAD, sizePt: size, singleLine: true }))
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
  const marks = input?.marks
  if (!marks || typeof marks.homologation !== 'boolean' || typeof marks.cancelled !== 'boolean') {
    throw documentInvalid('As marcas do DANFE não foram informadas', [{ field: 'marks', message: 'Informe as marcas de danfeMarksOf(voz, tpAmb)' }])
  }
  if (marks.homologation !== (data.ide.tpAmb === '2')) {
    throw documentInvalid('A marca de homologação não confere com o ambiente da nota', [{ field: 'marks', message: 'A marca de homologação tem de ser igual ao tpAmb 2 do XML' }])
  }
  const ctx = { data, marks, contentTop: 0, y: 0, sheet: 0 } as Ctx
  const w = createPdf({
    paper: 'A4', layout: 'portrait', marginCm: CM.margin, title: `DANFE NF-e ${invoiceNumber(data.ide.nNF)}`, creationDate: input.creationDate,
    fontRoles: DANFE_FONT_ROLES,
    sheetStart: (doc, sheet) => { ctx.doc = doc; drawSheetStart(ctx, sheet) },
  })
  ctx.doc = w.doc
  drawRecipient(ctx)
  drawInvoice(ctx)
  drawTax(ctx)
  drawCarrier(ctx)
  drawIssqn(ctx)
  drawItems(ctx)
  drawAdditional(ctx)
  return w.end((doc, info) => drawSheetNumber(doc, info.sheet, info.total))
}
