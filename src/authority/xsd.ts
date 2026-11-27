import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { validateXML, type XMLFileInfo } from 'xmllint-wasm'
import { ELEMENT, elementsOf, parseXml, type XmlNode } from 'fiscal-api'

/**
 * VALIDAÇÃO XSD LOCAL das mensagens da NF-e (NE-3, nfe-api:NFE.E4.P3.T1 — D-NE181, D-NE115, D-NE211, D-NE43; regra RF-NFE-19).
 *
 * - Validador `xmllint-wasm` 5.3.0 (libxml2 em WASM; versão exata no package.json — D-NE181): sem binário nativo, sem rede.
 * - Os XSD são DADO: `acervo/xsd/` é a cópia byte a byte do acervo do Vault, conferida arquivo a arquivo contra `acervo/xsd/MANIFESTO.json`
 *   (SHA-256) no carregamento. Cada mensagem tem a SUA lista FECHADA de arquivos (nome pedido no `include`/`import` → arquivo da camada
 *   certa): no acervo há CINCO `tiposBasico_v1.03.xsd` diferentes, então "o mais novo vence pelo nome" não serve entre famílias (RF-NFE-19).
 *   Na família NF-e (base PL_009_V4 → PL_010d_v1.03/NFe → PL_010f_v1.04) o 010f vence e é igual ao do 010d/NFe onde coincidem.
 * - `include`/`import` respondidos pela PRÉ-CARGA do conjunto; um `schemaLocation` fora do conjunto é recusado ANTES do libxml (nunca rede).
 * - A `NFe` (o documento que o builder da NE-4 monta — NFE.E5.P3) é validada pela raiz `nfe_v4.00.xsd` do PL_010f; o `TNFe` exige a
 *   `Signature`, então só a NF-e ASSINADA passa. O `enviNFe` (o lote da autorização) e os retornos `retEnviNFe` e `retConsReciNFe` entram com a
 *   transmissão (NFE.E6.P1 — ajuste da D-NE211): o `enviNFe` aceita uma NFe ASSINADA.
 * - O `detEvento` do cancelamento é `xs:any skip` no envelope do evento: é recortado como documento próprio e validado contra o
 *   `e110111_v1.00.xsd`, compilado com o `tiposBasico_v1.03` do `PL_010d_v1.03/Evento` (o de 2018 recusa nProt de 17 dígitos e CNPJ
 *   alfanumérico).
 */

export type MessageKind = 'consStatServ' | 'consSitNFe' | 'consReciNFe' | 'consCad' | 'inutNFe' | 'envEvento110111' | 'NFe' | 'enviNFe' | 'retEnviNFe' | 'retConsReciNFe'
  | 'retEnvEvento' | 'procEventoNFe' | 'retInutNFe' | 'procInutNFe'

export type XsdResult = { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] }

const B = 'PL_009_V4_00_NT_2020_006_v1.20/'
const D = 'PL_010d_v1.03/'
const F = 'PL_010f_v1.04/'
/** PL_010h (NT 2026.005/2026.006/2026.008, 13/11/2026): só `leiauteNFe` e `DFeTiposBasicos` mudam; `nfe`, `tiposBasico` e `xmldsig` são byte a byte os do 010f (NFE.E5.P6, D-NE285). */
const H = 'PL_010h_v1.03/NFe/'

interface SchemaSet {
  /** Arquivo raiz (validado como `schema`). */
  readonly root: string
  /** Nome pedido no `include`/`import` → caminho no acervo. */
  readonly files: Readonly<Record<string, string>>
}

/** Conjuntos FECHADOS por mensagem (ficha da NFE.E4.P3, §6 mudança 1). */
export const SCHEMA_SETS: Readonly<Record<MessageKind | 'detEvento110111', SchemaSet>> = {
  consStatServ: {
    root: B + 'consStatServ_v4.00.xsd',
    files: { 'leiauteConsStatServ_v4.00.xsd': B + 'leiauteConsStatServ_v4.00.xsd', 'tiposBasico_v4.00.xsd': F + 'tiposBasico_v4.00.xsd' },
  },
  consSitNFe: {
    root: D + 'NFe/consSitNFe_v4.00.xsd',
    files: {
      'leiauteConsSitNFe_v4.00.xsd': D + 'NFe/leiauteConsSitNFe_v4.00.xsd',
      'tiposBasico_v4.00.xsd': F + 'tiposBasico_v4.00.xsd',
      'xmldsig-core-schema_v1.01.xsd': F + 'xmldsig-core-schema_v1.01.xsd',
    },
  },
  consReciNFe: {
    root: B + 'consReciNFe_v4.00.xsd',
    files: {
      'leiauteNFe_v4.00.xsd': H + 'leiauteNFe_v4.00.xsd',
      'tiposBasico_v4.00.xsd': F + 'tiposBasico_v4.00.xsd',
      'xmldsig-core-schema_v1.01.xsd': F + 'xmldsig-core-schema_v1.01.xsd',
      'DFeTiposBasicos_v1.00.xsd': H + 'DFeTiposBasicos_v1.00.xsd',
    },
  },
  // NFE.E6.P1 (ficha §6-2): o lote da autorização e os dois retornos da NF-e (base PL_009_V4); o leiaute da NF-e é o do PL_010h desde a NFE.E5.P7 (o mesmo do conjunto NFe)
  enviNFe: {
    root: B + 'enviNFe_v4.00.xsd',
    files: {
      'leiauteNFe_v4.00.xsd': H + 'leiauteNFe_v4.00.xsd',
      'tiposBasico_v4.00.xsd': F + 'tiposBasico_v4.00.xsd',
      'xmldsig-core-schema_v1.01.xsd': F + 'xmldsig-core-schema_v1.01.xsd',
      'DFeTiposBasicos_v1.00.xsd': H + 'DFeTiposBasicos_v1.00.xsd',
    },
  },
  retEnviNFe: {
    root: B + 'retEnviNFe_v4.00.xsd',
    files: {
      'leiauteNFe_v4.00.xsd': H + 'leiauteNFe_v4.00.xsd',
      'tiposBasico_v4.00.xsd': F + 'tiposBasico_v4.00.xsd',
      'xmldsig-core-schema_v1.01.xsd': F + 'xmldsig-core-schema_v1.01.xsd',
      'DFeTiposBasicos_v1.00.xsd': H + 'DFeTiposBasicos_v1.00.xsd',
    },
  },
  retConsReciNFe: {
    root: B + 'retConsReciNFe_v4.00.xsd',
    files: {
      'leiauteNFe_v4.00.xsd': H + 'leiauteNFe_v4.00.xsd',
      'tiposBasico_v4.00.xsd': F + 'tiposBasico_v4.00.xsd',
      'xmldsig-core-schema_v1.01.xsd': F + 'xmldsig-core-schema_v1.01.xsd',
      'DFeTiposBasicos_v1.00.xsd': H + 'DFeTiposBasicos_v1.00.xsd',
    },
  },
  NFe: {
    root: F + 'nfe_v4.00.xsd',
    files: {
      'leiauteNFe_v4.00.xsd': H + 'leiauteNFe_v4.00.xsd',
      'tiposBasico_v4.00.xsd': F + 'tiposBasico_v4.00.xsd',
      'xmldsig-core-schema_v1.01.xsd': F + 'xmldsig-core-schema_v1.01.xsd',
      'DFeTiposBasicos_v1.00.xsd': H + 'DFeTiposBasicos_v1.00.xsd',
    },
  },
  consCad: {
    root: D + 'CadConsultaCadastro/consCad_v2.00.xsd',
    files: {
      'leiauteConsultaCadastro_v2.00.xsd': D + 'CadConsultaCadastro/leiauteConsultaCadastro_v2.00.xsd',
      'tiposBasico_v1.03.xsd': D + 'CadConsultaCadastro/tiposBasico_v1.03.xsd',
    },
  },
  inutNFe: {
    root: B + 'inutNFe_v4.00.xsd',
    files: {
      'leiauteInutNFe_v4.00.xsd': D + 'NFe/leiauteInutNFe_v4.00.xsd',
      'tiposBasico_v4.00.xsd': F + 'tiposBasico_v4.00.xsd',
      'xmldsig-core-schema_v1.01.xsd': F + 'xmldsig-core-schema_v1.01.xsd',
    },
  },
  envEvento110111: {
    root: D + 'Evento/envEvento_v1.00.xsd',
    files: {
      'leiauteEvento_v1.00.xsd': D + 'Evento/leiauteEvento_v1.00.xsd',
      'tiposBasico_v1.03.xsd': D + 'Evento/tiposBasico_v1.03.xsd',
      'xmldsig-core-schema_v1.01.xsd': D + 'Evento/xmldsig-core-schema_v1.01.xsd',
    },
  },
  // NFE.E6.P2 (D-NE50): o retorno do evento e o procEventoNFe (o evento + o retEvento, o que se guarda), o retorno da inutilização e o procInutNFe
  retEnvEvento: {
    root: D + 'Evento/retEnvEvento_v1.00.xsd',
    files: {
      'leiauteEvento_v1.00.xsd': D + 'Evento/leiauteEvento_v1.00.xsd',
      'tiposBasico_v1.03.xsd': D + 'Evento/tiposBasico_v1.03.xsd',
      'xmldsig-core-schema_v1.01.xsd': D + 'Evento/xmldsig-core-schema_v1.01.xsd',
    },
  },
  procEventoNFe: {
    root: D + 'Evento/procEventoNFe_v1.00.xsd',
    files: {
      'leiauteEvento_v1.00.xsd': D + 'Evento/leiauteEvento_v1.00.xsd',
      'tiposBasico_v1.03.xsd': D + 'Evento/tiposBasico_v1.03.xsd',
      'xmldsig-core-schema_v1.01.xsd': D + 'Evento/xmldsig-core-schema_v1.01.xsd',
    },
  },
  retInutNFe: {
    root: B + 'retInutNFe_v4.00.xsd',
    files: {
      'leiauteInutNFe_v4.00.xsd': D + 'NFe/leiauteInutNFe_v4.00.xsd',
      'tiposBasico_v4.00.xsd': F + 'tiposBasico_v4.00.xsd',
      'xmldsig-core-schema_v1.01.xsd': F + 'xmldsig-core-schema_v1.01.xsd',
    },
  },
  procInutNFe: {
    root: B + 'procInutNFe_v4.00.xsd',
    files: {
      'leiauteInutNFe_v4.00.xsd': D + 'NFe/leiauteInutNFe_v4.00.xsd',
      'tiposBasico_v4.00.xsd': F + 'tiposBasico_v4.00.xsd',
      'xmldsig-core-schema_v1.01.xsd': F + 'xmldsig-core-schema_v1.01.xsd',
    },
  },
  detEvento110111: {
    root: 'Evento_Canc_PL_v1.01/e110111_v1.00.xsd',
    files: { 'tiposBasico_v1.03.xsd': D + 'Evento/tiposBasico_v1.03.xsd' },
  },
}

export class XsdManifestError extends Error {
  constructor(message: string) { super(message); this.name = 'XsdManifestError' }
}

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe'
export const DEFAULT_XSD_DIR = path.resolve(__dirname, '..', '..', 'acervo', 'xsd')

interface LoadedSet { readonly root: XMLFileInfo; readonly preload: readonly XMLFileInfo[] }

/** Carrega e confere os conjuntos (SHA-256 contra o manifesto; nenhum `schemaLocation` fora do conjunto). Lança `XsdManifestError`. */
export function loadSchemaSets(dir: string = DEFAULT_XSD_DIR, manifest?: Record<string, string>): Readonly<Record<keyof typeof SCHEMA_SETS, LoadedSet>> {
  const hashes = manifest ?? (JSON.parse(fs.readFileSync(path.join(dir, 'MANIFESTO.json'), 'utf8')).files as Record<string, string>)
  const read = (rel: string): string => {
    const expected = hashes[rel]
    if (!expected) throw new XsdManifestError(`XSD fora do manifesto: ${rel}`)
    const bytes = fs.readFileSync(path.join(dir, rel))
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw new XsdManifestError(`XSD diferente do manifesto: ${rel}`)
    return bytes.toString('utf8')
  }
  const out = {} as Record<keyof typeof SCHEMA_SETS, LoadedSet>
  for (const [kind, set] of Object.entries(SCHEMA_SETS) as [keyof typeof SCHEMA_SETS, SchemaSet][]) {
    const rootText = read(set.root)
    const preload = Object.entries(set.files).map(([name, rel]) => ({ fileName: name, contents: read(rel) }))
    const known = new Set(Object.keys(set.files))
    for (const text of [rootText, ...preload.map(p => p.contents as string)]) {
      for (const m of text.matchAll(/schemaLocation="([^"]*)"/g)) {
        if (!known.has(m[1])) throw new XsdManifestError(`include fora do conjunto em ${kind}: ${m[1]}`)
      }
    }
    out[kind] = { root: { fileName: path.posix.basename(set.root), contents: rootText }, preload }
  }
  return out
}

let cached: ReturnType<typeof loadSchemaSets> | null = null
const sets = () => (cached ??= loadSchemaSets())

async function validateWith(set: LoadedSet, xml: string): Promise<XsdResult> {
  const r = await validateXML({ xml: { fileName: 'mensagem.xml', contents: xml }, schema: set.root, preload: [...set.preload] })
  return r.valid ? { ok: true } : { ok: false, errors: r.errors.map(e => e.message) }
}

const TEXT = 3
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'
const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\r': '&#13;', '\t': '&#9;', '\n': '&#10;' }
const escText = (s: string) => s.replace(/[&<>\r]/g, c => ESCAPES[c])
const escAttr = (s: string) => s.replace(/[&<>"\r\t\n]/g, c => ESCAPES[c])

/**
 * ESCREVE o elemento como documento próprio a partir do nó que o leitor estrito do núcleo devolveu (N17 — D-NE72, D-NE85…D-NE90: nada
 * de recorte do texto): elementos só no namespace da NF-e (sem prefixo; `xmlns` da NF-e na raiz), atributos sem namespace e texto.
 * Qualquer outro nó (outro namespace ou sem namespace, atributo qualificado, CDATA, comentário, PI) = `null`. Conhecimento negativo: o
 * `e110111` aceitaria comentário, PI e CDATA, mas o nosso montador não os produz e a recusa é fechada (D-NE87); e o leitor do núcleo
 * normaliza U+0085/U+2028 crus para `\n` (regra do XML 1.1 do @xmldom), o que só pode RECUSAR um xJust que o fisco aceitaria, nunca aceitar
 * um inválido (achado do gate adversarial da NFE.E4.P3.T4, para o núcleo).
 */
const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#'

/**
 * A `Signature` (xmldsig) que o fisco põe no `protNFe`/`retEvento`/`retInutNFe` (NFE.E6.P5, gate adversarial da rodada 1): copiada nó a nó, no namespace dsig declarado UMA vez no
 * topo, sem atributo qualificado, CDATA, comentário nem PI — o mesmo fecho do escritor da NF-e. Só entra quando o chamador pede (`allowDsig`): o `detEvento` que NÓS enviamos nunca a leva.
 */
/** Os ÚNICOS pais da `Signature` que o fisco devolve (NFE.E6.P5, rodada 2): `protNFe`, `retEvento`, `retInutNFe` — em qualquer outro elemento a `Signature` é recusada. */
const SIGNATURE_PARENTS: ReadonlySet<string> = new Set(['protNFe', 'retEvento', 'retInutNFe'])

function writeDsigElement(el: XmlNode, top: boolean): string | null {
  if (el.namespaceURI !== DSIG_NS) return null
  const name = el.localName ?? el.nodeName
  let out = `<${name}${top ? ` xmlns="${DSIG_NS}"` : ''}`
  const attrs = el.attributes
  for (let i = 0; attrs && i < attrs.length; i++) {
    const a = attrs[i] as { name: string; value: string; namespaceURI?: string | null }
    if (a.namespaceURI === XMLNS_NS) continue
    if (a.namespaceURI || a.name.includes(':')) return null
    out += ` ${a.name}="${escAttr(a.value)}"`
  }
  out += '>'
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i]
    if (c.nodeType === TEXT) out += escText(c.nodeValue ?? '')
    else if (c.nodeType === ELEMENT) { const w = writeDsigElement(c, false); if (w === null) return null; out += w }
    else return null
  }
  return `${out}</${name}>`
}

export function writeNfeElement(el: XmlNode, root: boolean, allowDsig = false): string | null {
  if (el.namespaceURI !== NFE_NS) return null
  const name = el.localName ?? el.nodeName
  let out = `<${name}${root ? ` xmlns="${NFE_NS}"` : ''}`
  const attrs = el.attributes
  for (let i = 0; attrs && i < attrs.length; i++) {
    const a = attrs[i] as { name: string; value: string; namespaceURI?: string | null }
    if (a.namespaceURI === XMLNS_NS) continue                              // declaração de namespace: a raiz já declara a da NF-e
    if (a.namespaceURI || a.name.includes(':')) return null
    out += ` ${a.name}="${escAttr(a.value)}"`
  }
  out += '>'
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i]
    if (c.nodeType === TEXT) out += escText(c.nodeValue ?? '')
    else if (c.nodeType === ELEMENT) {
      const w = allowDsig && SIGNATURE_PARENTS.has(name) && c.namespaceURI === DSIG_NS && (c.localName ?? c.nodeName) === 'Signature' ? writeDsigElement(c, true) : writeNfeElement(c, false, allowDsig)
      if (w === null) return null
      out += w
    }
    else return null
  }
  return `${out}</${name}>`
}

/** O ÚNICO `detEvento` do envelope (D-NE39: 1 evento por lote), lido pelo leitor estrito e escrito como documento próprio; ou o erro. */
function detEventoOf(xml: string): { readonly xml: string } | { readonly error: string } {
  let doc: XmlNode
  try { doc = parseXml(xml) } catch { return { error: 'envEvento: ilegível pelo leitor estrito (N17)' } }
  const found = elementsOf(doc, false).filter(e => e.nodeType === ELEMENT
    && (e.localName ?? e.nodeName) === 'detEvento' && e.namespaceURI === NFE_NS)
  if (found.length !== 1) return { error: 'envEvento: deve haver exatamente um detEvento (D-NE39)' }
  const det = writeNfeElement(found[0], true)
  return det === null ? { error: 'envEvento: detEvento com nó fora do e110111 (outro namespace ou sem namespace, atributo qualificado, CDATA, comentário ou PI)' } : { xml: det }
}

/** Valida a mensagem contra o seu conjunto de XSD; a lista INTEIRA de erros volta (D-NE43). */
export async function validateMessage(kind: MessageKind, xml: string): Promise<XsdResult> {
  const s = sets()
  const env = await validateWith(s[kind], xml)
  if (!env.ok || kind !== 'envEvento110111') return env
  const det = detEventoOf(xml)
  return 'error' in det ? { ok: false, errors: [det.error] } : validateWith(s.detEvento110111, det.xml)
}
