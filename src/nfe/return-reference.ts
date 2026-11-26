import { ELEMENT, attrOf, elementsOf, parseXml, textOf, type XmlNode } from 'fiscal-api'
import { assertAccessKey } from '../authority/messages'
import { returnMismatch } from './errors'
import { FormatError, parseDecimal, subtract, toCents, type Decimal } from './formats'
import type { NumberedItem } from './item-numbering'
import type { NfeItemSimples } from './nfe-builder'

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
const wholeMismatch = (message: string) => returnMismatch('A nota de origem da devolução não pode ser conferida', [{ field: 'origin', message }])

/**
 * A FORMA do procNFe da origem e a chave dele (NFE.E5.P7, junção): lido UMA vez pelo leitor estrito, `nfeProc > NFe > infNFe` (um de cada) e a chave do
 * `infNFe/@Id`. As recusas, a ordem e os textos são os de sempre de `assertReturnMatchesOrigin`, que usa este ajudante.
 */
function readOriginProc(originProcNfeXml: string): { doc: XmlNode; root: XmlNode; inf: XmlNode; key: string } {
  let doc: XmlNode
  try { doc = parseXml(originProcNfeXml) } catch { throw wholeMismatch('XML da nota de origem ilegível') }
  // A FORMA do procNFe é fixa: nfeProc > NFe > infNFe e nfeProc > protNFe > infProt — um de cada; nada "achado em qualquer lugar".
  const roots = named(doc, 'nfeProc')
  const root = roots.length === 1 ? roots[0] : null
  const nfe = root ? child(root, 'NFe') : null
  const inf = nfe ? child(nfe, 'infNFe') : null
  if (!root || !inf || named(doc, 'infNFe').length !== 1) throw wholeMismatch('O XML da origem deve ser um procNFe com exatamente uma NF-e')
  const id = attrOf(inf, 'Id') ?? ''
  const key = id.startsWith('NFe') ? id.slice(3) : ''
  try { assertAccessKey(key) } catch { throw wholeMismatch('A chave da nota de origem está fora da forma') }
  return { doc, root, inf, key }
}

/**
 * A chave da nota de origem, tirada do procNFe arquivado (NFE.E5.P7, junção; a lista da junção, item 2): quem compõe a devolução de 2027 usa ESTA chave em
 * `origins[].accessKey` e confere que é a da tentativa autorizada. Recusa como `assertReturnMatchesOrigin` (422 `FISCAL_RETURN_REFERENCE_MISMATCH`).
 */
export function originKeyOf(originProcNfeXml: string): string {
  return readOriginProc(originProcNfeXml).key
}

export function assertReturnMatchesOrigin(items: readonly ReturnItemCheck[], originProcNfeXml: string, emitterCnpj: string): void {
  const whole = wholeMismatch
  if (items.length === 0) throw whole('Devolução sem item para conferir')
  const { doc, root, inf, key: originKey } = readOriginProc(originProcNfeXml)
  const prot = child(root, 'protNFe')
  const infProt = prot ? child(prot, 'infProt') : null
  if (!infProt || named(doc, 'infProt').length !== 1 || text(infProt, 'chNFe') !== originKey || !AUTHORIZED.includes(text(infProt, 'cStat') ?? '')) {
    throw whole('A nota de origem não tem o protocolo de autorização dela (procNFe)')
  }
  // Devolução do 1º release: a origem é uma VENDA (nota de saída, finalidade normal) — nunca outra devolução.
  const ide = child(inf, 'ide')
  if (text(ide, 'tpNF') !== '1' || text(ide, 'finNFe') !== '1') throw whole('A nota de origem não é uma venda (saída, finalidade normal)')
  if (text(child(inf, 'emit'), 'CNPJ') !== emitterCnpj) {
    throw whole('A nota de origem foi emitida por outro estabelecimento — devolução de venda própria apenas (rej. 1193)')
  }
  const dets = new Map<string, XmlNode>()
  for (let i = 0; i < inf.childNodes.length; i++) {
    const c = inf.childNodes[i]
    if (c.nodeType === ELEMENT && c.namespaceURI === NFE_NS && (c.localName ?? c.nodeName) === 'det') {
      const n = attrOf(c, 'nItem') ?? ''
      if (dets.has(n)) throw whole('A nota de origem tem item repetido')
      dets.set(n, c)
    }
  }
  const fields: { field: string; message: string }[] = []
  const returned = new Map<string, Decimal>()                              // quantidade devolvida NESTA nota, somada por item de origem
  for (const it of items) {
    const f = `det[${it.itemId}]`
    if (it.origin.accessKey !== originKey) { fields.push({ field: f, message: 'O item referencia outra nota de origem' }); continue }
    const det = dets.get(String(it.origin.numbered.nItem))
    const prod = det ? child(det, 'prod') : null
    if (!prod) { fields.push({ field: f, message: `A nota de origem não tem o item ${it.origin.numbered.nItem}` }); continue }
    const diffs: string[] = []
    if (it.cProd === null || text(prod, 'cProd') !== it.cProd) diffs.push('código do produto')
    if (compare(it.vUnCom, text(prod, 'vUnCom')) !== 0) diffs.push('valor unitário')
    // Dois itens da devolução no MESMO item da origem somam: a soma não pode passar da quantidade vendida (o saldo entre notas é do ERP).
    const nKey = String(it.origin.numbered.nItem)
    let q: number | null = null
    try {
      const mine = parseDecimal(it.qCom)
      if (mine.units <= 0n) throw new FormatError('zero', 'quantidade devolvida')
      const sum = returned.has(nKey) ? subtract(returned.get(nKey) as Decimal, { units: -mine.units, scale: mine.scale }) : mine
      returned.set(nKey, sum)
      const d = subtract(sum, parseDecimal(text(prod, 'qCom'))).units
      q = d > 0n ? 1 : 0
    } catch (e) { if (!(e instanceof FormatError)) throw e }
    if (q === null || q > 0) diffs.push(q === null ? 'quantidade' : 'quantidade maior que a da origem')
    if (diffs.length) fields.push({ field: f, message: `Não confere com o item ${it.origin.numbered.nItem} da nota de origem: ${diffs.join(', ')}` })
  }
  if (fields.length) throw returnMismatch(`A devolução não confere com a nota de origem em ${fields.length} item(ns)`, fields)
}

/**
 * O GRUPO DO SIMPLES DA ORIGEM (NFE.E5.P6, D-NE288, D-NE289; NT 2026.005 L183-197): a devolução de 2027 copia o `cAtivSN` e o `IBSCBS` do item da nota de origem a
 * partir do XML AUTORIZADO da origem (procNFe arquivado) — nunca do que o faturamento guardou (a devolução não tem linha no setes-api — D-IB142). Origem sem
 * `gTribSN` (nota de 2026, ou do ERP Desktop) → `simples: null`: a devolução sai sem o grupo (D-NE289; RF-DEV-02). A base do item é `vProd + vFrete + vOutro − vDesc`
 * lidos do `det/prod` da origem — a mesma fórmula da D-NE287, com o seguro fora (S9/S10, grau L). Lido pelo leitor ESTRITO do núcleo, como o resto desta peça.
 * Esta leitura NÃO confere a identidade nem a autorização da origem (chave, `protNFe`, venda): quem compõe (`compose.ts`, junção da NFE.E5.P7) chama
 * `assertReturnMatchesOrigin` com O MESMO XML e tira `origins[].accessKey` dele (`originKeyOf`), conferida contra a tentativa autorizada.
 */
export interface OriginItemSimples {
  /** `qCom` do item da origem (texto), para conferir a devolução de quantidade inteira (S6). */
  qCom: string | null
  simples: NfeItemSimples | null
}

const centsOf = (parent: XmlNode | null, name: string): number | null => {
  const v = text(parent, name)
  if (v === null) return null
  try { return toCents(v) } catch (e) { if (e instanceof FormatError) return null; throw e }
}

export function readOriginSimples(originProcNfeXml: string): ReadonlyMap<number, OriginItemSimples> {
  const whole = (field: string, message: string) => returnMismatch('A nota de origem da devolução não pode ser lida', [{ field, message }])
  let doc: XmlNode
  try { doc = parseXml(originProcNfeXml) } catch { throw whole('origin', 'XML da nota de origem ilegível') }
  const roots = named(doc, 'nfeProc')
  const root = roots.length === 1 ? roots[0] : null
  const nfe = root ? child(root, 'NFe') : null
  const inf = nfe ? child(nfe, 'infNFe') : null
  if (!root || !inf || named(doc, 'infNFe').length !== 1) throw whole('origin', 'O XML da origem deve ser um procNFe com exatamente uma NF-e')
  const out = new Map<number, OriginItemSimples>()
  for (let i = 0; i < inf.childNodes.length; i++) {
    const det = inf.childNodes[i]
    if (det.nodeType !== ELEMENT || det.namespaceURI !== NFE_NS || (det.localName ?? det.nodeName) !== 'det') continue
    const position = Number(attrOf(det, 'nItem') ?? '')
    if (!Number.isInteger(position) || position < 1 || out.has(position)) throw whole('origin', 'A nota de origem tem item sem número ou repetido')
    const f = `origin.det[${position}]`
    const prod = child(det, 'prod')
    if (!prod) throw whole(f, 'Item da origem sem o grupo prod')
    const group = child(child(det, 'imposto') ?? det, 'IBSCBS')
    const tribSN = group ? child(group, 'gTribSN') : null
    // `IBSCBS` sem `gTribSN` é regime regular (ou grupo estranho): não se espelha nem se finge "sem grupo" (S5, D-NE290).
    if (group && !tribSN) throw whole(f, 'O IBSCBS da origem não é o do Simples (regime regular) — fora-do-primeiro-release')
    if (!tribSN) { out.set(position, { qCom: text(prod, 'qCom'), simples: null }); continue }
    try { parseDecimal(text(prod, 'qCom')) } catch { throw whole(f, 'A quantidade do item da origem está ilegível') }
    const ibs = child(tribSN, 'gIBSSN'), cbs = child(tribSN, 'gCBSSN')
    const activity = text(prod, 'cAtivSN'), classification = text(group, 'cClassTrib')
    const vIBS = ibs ? centsOf(ibs, 'vIBSSN') : 0, vCBS = centsOf(cbs, 'vCBSSN')
    const rIBS = ibs ? text(ibs, 'pIBSSN') : null, rCBS = text(cbs, 'pCBSSN')
    const vProd = centsOf(prod, 'vProd'), vFrete = child(prod, 'vFrete') ? centsOf(prod, 'vFrete') : 0
    const vOutro = child(prod, 'vOutro') ? centsOf(prod, 'vOutro') : 0, vDesc = child(prod, 'vDesc') ? centsOf(prod, 'vDesc') : 0
    if (!activity || !classification || !cbs || vIBS === null || vCBS === null || vProd === null || vFrete === null || vOutro === null || vDesc === null || rCBS === null || (ibs && rIBS === null)) {
      throw whole(f, 'O grupo do Simples da origem está incompleto ou malformado')
    }
    if (vProd + vFrete + vOutro - vDesc < 0) throw whole(f, 'Desconto do item da origem maior que o valor do item')
    out.set(position, {
      qCom: text(prod, 'qCom'),
      simples: {
        activity, classification, ibsRate: rIBS, cbsRate: rCBS, ...(ibs ? {} : { withoutIbs: true }),
        ibsCents: vIBS, cbsCents: vCBS, baseCents: vProd + vFrete + vOutro - vDesc,
      },
    })
  }
  return out
}
