import { ELEMENT, elementsOf, parseXml, type XmlNode } from 'fiscal-api'
import { writeNfeElement } from '../authority/xsd'

/**
 * O `nfeProc` (NFE.E6.P1 — D-NE35, D-NE50; ficha §6-7): a NFe ASSINADA (entra byte a byte — a assinatura é sobre a forma canônica) + o `protNFe` da NOSSA
 * chave, ESCRITO a partir do nó que o leitor estrito do núcleo devolveu (nada de recorte de texto — D-NE72, cerca N17). Devolve `null` se a resposta não
 * tem exatamente um `protNFe` da chave pedida, ou se ele tem nó que o escritor não escreve (outro namespace, CDATA, comentário, `Signature`…).
 */

const NS = 'http://www.portalfiscal.inf.br/nfe'
const local = (e: XmlNode): string => e.localName ?? e.nodeName
const child = (el: XmlNode, name: string): XmlNode | null => {
  for (let i = 0; i < el.childNodes.length; i++) { const c = el.childNodes[i]; if (c.nodeType === ELEMENT && c.namespaceURI === NS && local(c) === name) return c }
  return null
}
const textOf = (el: XmlNode | null): string | null => (el && el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 ? (el.childNodes[0].nodeValue ?? '') : null)

export function procNfeXml(signedNfe: string, responseXml: string, chNFe: string): string | null {
  let doc: XmlNode
  try { doc = parseXml(responseXml) } catch { return null }
  const found = elementsOf(doc, false).filter(e => e.nodeType === ELEMENT && e.namespaceURI === NS && local(e) === 'protNFe' && textOf(child(child(e, 'infProt') ?? e, 'chNFe')) === chNFe)
  if (found.length !== 1) return null
  const prot = writeNfeElement(found[0], false, true)
  if (prot === null) return null
  const nfe = String(signedNfe).replace(/^\s*<\?xml[^?]*\?>\s*/, '').trim()
  return `<nfeProc xmlns="${NS}" versao="4.00">${nfe}${prot}</nfeProc>`
}

/** O `DigestValue` do `infNFe` da NFe ASSINADA (a 1ª `Reference` do `SignedInfo`), lido pelo leitor estrito; `null` se não achar um só, no formato de 28 caracteres. */
export function digestValueOf(signedNfe: string): string | null {
  let doc: XmlNode
  try { doc = parseXml(signedNfe) } catch { return null }
  const all = elementsOf(doc, true).filter(e => e.nodeType === ELEMENT && local(e) === 'DigestValue')
  if (all.length !== 1) return null
  const v = textOf(all[0])
  return v !== null && /^[A-Za-z0-9+/]{27}=$/.test(v) ? v : null
}
