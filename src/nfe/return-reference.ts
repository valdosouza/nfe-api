import { ELEMENT, attrOf, elementsOf, parseXml, textOf, type XmlNode } from 'fiscal-api'
import { returnMismatch } from './errors'
import { FormatError, parseDecimal, subtract } from './formats'
import type { NumberedItem } from './item-numbering'

/**
 * DEVOLUÇÃO × NOTA DE ORIGEM (NFE.E5.P3.T3 — D-NE103, D-NE219; RF-DEV-03 e a proposta RF-DEV-05). A devolução referencia a origem POR
 * ITEM (`DFeReferenciado`: chave + nItem). Quando a referência é por item a SEFAZ não confere produto, quantidade nem valor contra a
 * origem — esta conferência é regra NOSSA: antes de referenciar, o `det[nItem]` do procNFe ARQUIVADO da origem tem de bater com o item
 * devolvido; divergência = 422 `FISCAL_RETURN_REFERENCE_MISMATCH` com o item — nunca se chuta o par.
 *
 * Devolução do 1º release (S6 da ficha) = devolução de venda PRÓPRIA: a origem foi emitida pelo MESMO estabelecimento (o que cumpre a
 * rej. 1193 — emitente da origem igual em todos os itens). Confere, por item: `cProd` igual, `vUnCom` igual e `qCom` devolvida menor ou
 * igual à da origem (devolução parcial é legítima; o saldo devolvível é do ERP web).
 *
 * A origem é lida pelo leitor ESTRITO do núcleo (`parseXml` — N17), nunca por recorte de texto.
 */

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe'
/** cStat do protocolo que prova a autorização: 100 (autorizado) e 150 (autorizado fora de prazo). */
const AUTHORIZED = ['100', '150']

export interface ReturnItemCheck {
  /** Id do item da DEVOLUÇÃO (para citar na recusa). */
  itemId: number
  cProd: string | null
  /** Quantidade devolvida e valor unitário, como texto decimal. */
  qCom: string | null
  vUnCom: string | null
  origin: { accessKey: string; numbered: NumberedItem }
}

const named = (scope: XmlNode, name: string): XmlNode[] =>
  elementsOf(scope, false).filter(e => e.nodeType === ELEMENT && e.namespaceURI === NFE_NS && (e.localName ?? e.nodeName) === name)

const child = (parent: XmlNode, name: string): XmlNode | null => {
  for (let i = 0; i < parent.childNodes.length; i++) {
    const c = parent.childNodes[i]
    if (c.nodeType === ELEMENT && c.namespaceURI === NFE_NS && (c.localName ?? c.nodeName) === name) return c
  }
  return null
}

const text = (parent: XmlNode | null, name: string): string | null => {
  const el = parent ? child(parent, name) : null
  if (!el) return null
  try { return textOf(el) } catch { return null }
}

/** -1, 0, 1 ou `null` quando um dos dois não é decimal. */
const compare = (a: string | null, b: string | null): number | null => {
  try {
    const d = subtract(parseDecimal(a), parseDecimal(b)).units
    return d < 0n ? -1 : d > 0n ? 1 : 0
  } catch (e) { if (e instanceof FormatError) return null; throw e }
}

/**
 * Confere os itens da devolução contra o procNFe de UMA nota de origem. `emitterCnpj` = o CNPJ do emitente da devolução.
 * Lança `HttpError` 422 `FISCAL_RETURN_REFERENCE_MISMATCH` com a lista inteira dos itens que não conferem.
 */
export function assertReturnMatchesOrigin(items: readonly ReturnItemCheck[], originProcNfeXml: string, emitterCnpj: string): void {
  const whole = (message: string) => returnMismatch('A nota de origem da devolução não pode ser conferida', [{ field: 'origin', message }])
  if (items.length === 0) throw whole('Devolução sem item para conferir')
  let doc: XmlNode
  try { doc = parseXml(originProcNfeXml) } catch { throw whole('XML da nota de origem ilegível') }
  const infs = named(doc, 'infNFe')
  if (infs.length !== 1) throw whole('O XML da origem deve ter exatamente uma NF-e')
  const inf = infs[0]
  const id = attrOf(inf, 'Id') ?? ''
  const originKey = id.startsWith('NFe') ? id.slice(3) : ''
  const prots = named(doc, 'infProt')
  if (prots.length !== 1 || text(prots[0], 'chNFe') !== originKey || !AUTHORIZED.includes(text(prots[0], 'cStat') ?? '')) {
    throw whole('A nota de origem não tem o protocolo de autorização dela (procNFe)')
  }
  if (text(child(inf, 'emit'), 'CNPJ') !== emitterCnpj) {
    throw whole('A nota de origem foi emitida por outro estabelecimento — devolução de venda própria apenas (rej. 1193)')
  }
  const dets = new Map<string, XmlNode>()
  for (let i = 0; i < inf.childNodes.length; i++) {
    const c = inf.childNodes[i]
    if (c.nodeType === ELEMENT && c.namespaceURI === NFE_NS && (c.localName ?? c.nodeName) === 'det') dets.set(attrOf(c, 'nItem') ?? '', c)
  }
  const fields: { field: string; message: string }[] = []
  for (const it of items) {
    const f = `det[${it.itemId}]`
    if (it.origin.accessKey !== originKey) { fields.push({ field: f, message: 'O item referencia outra nota de origem' }); continue }
    const det = dets.get(String(it.origin.numbered.nItem))
    const prod = det ? child(det, 'prod') : null
    if (!prod) { fields.push({ field: f, message: `A nota de origem não tem o item ${it.origin.numbered.nItem}` }); continue }
    const diffs: string[] = []
    if (it.cProd === null || text(prod, 'cProd') !== it.cProd) diffs.push('código do produto')
    if (compare(it.vUnCom, text(prod, 'vUnCom')) !== 0) diffs.push('valor unitário')
    const q = compare(it.qCom, text(prod, 'qCom'))
    if (q === null || q > 0) diffs.push(q === null ? 'quantidade' : 'quantidade maior que a da origem')
    if (diffs.length) fields.push({ field: f, message: `Não confere com o item ${it.origin.numbered.nItem} da nota de origem: ${diffs.join(', ')}` })
  }
  if (fields.length) throw returnMismatch(`A devolução não confere com a nota de origem em ${fields.length} item(ns)`, fields)
}
