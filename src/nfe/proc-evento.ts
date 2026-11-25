import { ELEMENT, elementsOf, parseXml, type XmlNode } from 'fiscal-api'
import { writeNfeElement } from '../authority/xsd'

/**
 * Os arquivos que guardam o evento e a inutilização (NFE.E6.P2 — D-NE50; ficha-nfe-e6-p2-cancelar-inutilizar-rodizio.md §7-2): o `procEventoNFe` (o `evento`
 * assinado + o `retEvento` da NOSSA chave) e o `ProcInutNFe` (o `inutNFe` assinado + o `retInutNFe` do NOSSO Id). O documento assinado entra byte a byte (a assinatura
 * é sobre a forma canônica); o retorno é ESCRITO a partir do nó que o leitor estrito do núcleo devolveu — nada de recorte de texto (cerca N17, D-NE72). Devolvem
 * `null` se a resposta não tem exatamente UM retorno do nosso pedido, ou se ele tem nó que o escritor não escreve (outro namespace, `Signature`, CDATA, comentário, PI).
 */

const NS = 'http://www.portalfiscal.inf.br/nfe'
const local = (e: XmlNode): string => e.localName ?? e.nodeName
const child = (el: XmlNode | null, name: string): XmlNode | null => {
  if (!el) return null
  for (let i = 0; i < el.childNodes.length; i++) { const c = el.childNodes[i]; if (c.nodeType === ELEMENT && c.namespaceURI === NS && local(c) === name) return c }
  return null
}
const textOf = (el: XmlNode | null): string | null => (el && el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 ? (el.childNodes[0].nodeValue ?? '') : null)
const bare = (xml: string): string => String(xml).replace(/^\s*<\?xml[^?]*\?>\s*/, '').trim()

/** O nome do arquivo do evento ENVIADO, assinado e guardado ANTES do envio (D-NE50): `<chave>-evt<tpEvento>-<nSeq>.xml` — o par do `-nfe.xml`. */
export const eventFileName = (chNFe: string, tpEvento = '110111', nSeq = 1): string => `${chNFe}-evt${tpEvento}-${nSeq}.xml`
/** O nome do `procEventoNFe` (o evento + o `retEvento` com o protocolo do evento): o par do `-procNFe.xml`. */
export const eventProcFileName = (chNFe: string, tpEvento = '110111', nSeq = 1): string => `${chNFe}-evt${tpEvento}-${nSeq}-proc.xml`
/** O nome do arquivo da inutilização (D-NE50): `<Id43>-inut.xml`. */
export const voidFileName = (voidId: string): string => `${voidId}-inut.xml`

/** `retEvento` do pedido: o único cuja `chNFe`, `tpEvento` e `nSeqEvento` são os nossos (o lote 128 traz um por evento enviado — D-NE39: um). */
export function procEventoXml(signedEvento: string, responseXml: string, chNFe: string, tpEvento = '110111', nSeq = 1): string | null {
  let doc: XmlNode
  try { doc = parseXml(responseXml) } catch { return null }
  const found = elementsOf(doc, false).filter(e => {
    if (e.nodeType !== ELEMENT || e.namespaceURI !== NS || local(e) !== 'retEvento') return false
    const inf = child(e, 'infEvento')
    return textOf(child(inf, 'chNFe')) === chNFe && textOf(child(inf, 'tpEvento')) === tpEvento && textOf(child(inf, 'nSeqEvento')) === String(nSeq)
  })
  if (found.length !== 1) return null
  const ret = writeNfeElement(found[0], false)
  if (ret === null) return null
  return `<procEventoNFe xmlns="${NS}" versao="1.00">${bare(signedEvento)}${ret}</procEventoNFe>`
}

/** `retInutNFe` do pedido: o único cujo `infInut` traz a nossa faixa (UF, ano, CNPJ, modelo, série, início e fim) — o eco que a D-NE210 exige. */
export function procInutXml(signedInut: string, responseXml: string, parts: { cUF: string; ano: string; cnpj: string; serie: number; from: number; to: number }): string | null {
  let doc: XmlNode
  try { doc = parseXml(responseXml) } catch { return null }
  const found = elementsOf(doc, false).filter(e => {
    if (e.nodeType !== ELEMENT || e.namespaceURI !== NS || local(e) !== 'retInutNFe') return false
    const inf = child(e, 'infInut')
    return textOf(child(inf, 'cUF')) === parts.cUF && textOf(child(inf, 'ano')) === parts.ano && textOf(child(inf, 'CNPJ')) === parts.cnpj && textOf(child(inf, 'mod')) === '55'
      && textOf(child(inf, 'serie')) === String(parts.serie) && textOf(child(inf, 'nNFIni')) === String(parts.from) && textOf(child(inf, 'nNFFin')) === String(parts.to)
  })
  if (found.length !== 1) return null
  const ret = writeNfeElement(found[0], false)
  if (ret === null) return null
  return `<ProcInutNFe xmlns="${NS}" versao="4.00">${bare(signedInut)}${ret}</ProcInutNFe>`
}
