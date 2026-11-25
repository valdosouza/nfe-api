import { ELEMENT, attrOf, parseXml, textOf, type XmlNode } from 'fiscal-api'
import { assertAccessKey } from '../../authority/messages'
import { documentInvalid } from '../errors'

/**
 * LEITOR DO DANFE (NFE.E6.P3 — ficha `ficha-nfe-e6-p3-danfe.md` §6; D-NE100). Lê o `nfeProc` ARQUIVADO da nota autorizada pelo `parseXml`
 * ESTRITO do núcleo (nunca por recorte de texto) e devolve SÓ o que o XML traz: campo ausente = `null`, nunca valor inventado nem inferido
 * (NT 2026.010 L174-181; Anexo II 3.x). Não confere assinatura nem XSD — quem arquivou o `nfeProc` já o fez (NFE.E6.P1); aqui só a FORMA que o
 * DANFE precisa: um `nfeProc` com UMA `NFe` (modelo 55) e o `protNFe` de autorização (cStat 100 ou 150) da MESMA chave. A forma errada é 422
 * `FISCAL_DOCUMENT_INVALID` com o campo `procNfeXml`; nunca PDF parcial. Os textos ficam como estão no XML (formatar é do desenho).
 */

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe'
/** cStat do protocolo que prova a autorização: 100 (autorizado) e 150 (autorizado fora de prazo). */
const AUTHORIZED = ['100', '150']

export type DanfeFields = Readonly<Record<string, string | null>>

export interface DanfeParty {
  /** `CNPJ`, `CPF` ou `idEstrangeiro` — o que o XML trouxe. */
  readonly idKind: 'CNPJ' | 'CPF' | 'idEstrangeiro' | null
  readonly id: string | null
  readonly xNome: string | null
  readonly xFant: string | null
  /** `xLgr`, `nro`, `xCpl`, `xBairro`, `cMun`, `xMun`, `UF`, `CEP`, `cPais`, `xPais`, `fone`. */
  readonly address: DanfeFields
  readonly IE: string | null
  readonly IEST: string | null
  readonly IM: string | null
  readonly CRT: string | null
  readonly indIEDest: string | null
}

export interface DanfeItem {
  readonly itemNo: string | null
  /** `cProd`, `cEAN`, `xProd`, `NCM`, `CFOP`, `uCom`, `qCom`, `vUnCom`, `vProd`, `cEANTrib`, `uTrib`, `qTrib`, `vUnTrib`, `vFrete`, `vSeg`, `vDesc`, `vOutro`. */
  readonly prod: DanfeFields
  /** O grupo único de `imposto/ICMS/*`: o nome do grupo (`ICMSSN102`…) e os filhos (`orig`, `CST`/`CSOSN`, `vBC`, `pICMS`, `vICMS`…). */
  readonly icmsGroup: string | null
  readonly icms: DanfeFields
  readonly infAdProd: string | null
}

export interface DanfeVolume { readonly fields: DanfeFields }

export interface DanfeData {
  readonly accessKey: string
  /** `cUF`, `natOp`, `mod`, `serie`, `nNF`, `dhEmi`, `dhSaiEnt`, `tpNF`, `idDest`, `tpImp`, `tpAmb`, `finNFe`. */
  readonly ide: DanfeFields
  readonly emit: DanfeParty
  readonly dest: DanfeParty
  readonly items: readonly DanfeItem[]
  /** `ICMSTot` inteiro (`vBC`, `vICMS`, `vBCST`, `vST`, `vProd`, `vFrete`, `vSeg`, `vDesc`, `vII`, `vIPI`, `vPIS`, `vCOFINS`, `vOutro`, `vNF`, …). */
  readonly totals: DanfeFields
  /** `ISSQNtot` quando o XML o traz; `null` senão. */
  readonly issqnTotals: DanfeFields | null
  readonly transp: { readonly modFrete: string | null; readonly carrier: DanfeFields | null; readonly vehicle: DanfeFields | null; readonly volumes: readonly DanfeVolume[] }
  readonly billing: { readonly fat: DanfeFields | null; readonly dups: readonly DanfeFields[] }
  readonly infAdFisco: string | null
  readonly infCpl: string | null
  /** `nProt`, `dhRecbto`, `cStat`, `chNFe`, `xMotivo`. */
  readonly authorization: DanfeFields
}

const bad = (message: string) => documentInvalid('O XML da nota não serve para o DANFE', [{ field: 'procNfeXml', message }])

const isNamed = (n: XmlNode, name: string): boolean => n.nodeType === ELEMENT && n.namespaceURI === NFE_NS && (n.localName ?? n.nodeName) === name

function kids(parent: XmlNode, name?: string): XmlNode[] {
  const out: XmlNode[] = []
  for (let i = 0; i < parent.childNodes.length; i++) {
    const c = parent.childNodes[i]
    if (c.nodeType === ELEMENT && c.namespaceURI === NFE_NS && (name === undefined || (c.localName ?? c.nodeName) === name)) out.push(c)
  }
  return out
}
const child = (parent: XmlNode | null, name: string): XmlNode | null => (parent ? kids(parent, name)[0] ?? null : null)

/** Campos de VÁRIAS linhas (o DANFE os quebra em `\n`); o resto do XML vai para linha única, sem controle. */
const MULTILINE = new Set(['infCpl', 'infAdFisco', 'infAdProd'])

function text(node: XmlNode | null, multiline = false): string | null {
  if (!node) return null
  let value: string
  try { value = textOf(node) } catch { return null }
  // CR, LF e TAB num campo de linha única derrubariam o desenho (M4 do gate adversarial): viram um espaço; nos de várias linhas só se normaliza a quebra
  value = multiline ? value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ') : value.replace(/[\t\r\n]+/g, ' ')
  return value === '' ? null : value
}
const textOfChild = (parent: XmlNode | null, name: string): string | null => text(child(parent, name), MULTILINE.has(name))

/**
 * Todos os filhos ELEMENTO com texto simples de um grupo, por nome (grupo ausente = `{}`). `unique`: elemento simples REPETIDO no grupo é
 * recusa (o XSD só admite um; `fieldsOf` ficaria com o último e `child` com o primeiro — L1 do gate adversarial).
 */
function fieldsOf(group: XmlNode | null, unique = false): DanfeFields {
  const out: Record<string, string | null> = {}
  if (!group) return out
  for (const c of kids(group)) {
    if (kids(c).length !== 0) continue
    const name = c.localName ?? c.nodeName
    if (unique && name in out) throw bad(`O elemento ${name} aparece mais de uma vez`)
    out[name] = text(c, MULTILINE.has(name))
  }
  return out
}

const PARTY_ID = ['CNPJ', 'CPF', 'idEstrangeiro'] as const
function partyOf(group: XmlNode | null, addressTag: string): DanfeParty {
  const idKind = PARTY_ID.find(k => child(group, k) !== null) ?? null
  return {
    idKind, id: idKind ? textOfChild(group, idKind) : null,
    xNome: textOfChild(group, 'xNome'), xFant: textOfChild(group, 'xFant'),
    address: fieldsOf(child(group, addressTag)),
    IE: textOfChild(group, 'IE'), IEST: textOfChild(group, 'IEST'), IM: textOfChild(group, 'IM'),
    CRT: textOfChild(group, 'CRT'), indIEDest: textOfChild(group, 'indIEDest'),
  }
}

export function readNfeProc(procNfeXml: string): DanfeData {
  if (typeof procNfeXml !== 'string' || procNfeXml.trim() === '') throw bad('XML ausente')
  let doc: XmlNode
  try { doc = parseXml(procNfeXml) } catch { throw bad('XML ilegível') }
  const rootEl = (doc as unknown as { documentElement?: XmlNode | null }).documentElement ?? null
  if (!rootEl || !isNamed(rootEl, 'nfeProc')) throw bad('A raiz deve ser o nfeProc da nota autorizada')
  const nfes = kids(rootEl, 'NFe')
  const prots = kids(rootEl, 'protNFe')
  if (nfes.length !== 1 || prots.length !== 1) throw bad('O nfeProc deve ter exatamente uma NFe e um protNFe')
  if (kids(nfes[0], 'infNFe').length !== 1 || kids(prots[0], 'infProt').length !== 1) throw bad('A NFe e o protNFe devem ter exatamente um infNFe e um infProt')
  const inf = child(nfes[0], 'infNFe')
  const infProt = child(prots[0], 'infProt')
  if (!inf || !infProt) throw bad('Falta o infNFe ou o infProt')
  const id = attrOf(inf, 'Id') ?? ''
  const accessKey = id.startsWith('NFe') ? id.slice(3) : ''
  try { assertAccessKey(accessKey) } catch { throw bad('A chave de acesso do infNFe está fora da forma') }
  const authorization = fieldsOf(infProt, true)
  if (authorization.chNFe !== accessKey) throw bad('O protocolo é de outra chave de acesso')
  if (!AUTHORIZED.includes(authorization.cStat ?? '')) throw bad('O protocolo não é de autorização de uso (cStat 100 ou 150)')
  if (!authorization.nProt) throw bad('O protocolo não traz o número (nProt)')

  const ideFields = fieldsOf(child(inf, 'ide'), true)
  if (ideFields.mod !== '55') throw bad('O DANFE desta peça é do modelo 55')
  if (ideFields.tpAmb !== '1' && ideFields.tpAmb !== '2') throw bad('O ambiente (tpAmb) do XML está fora do domínio')
  if (authorization.tpAmb !== undefined && authorization.tpAmb !== ideFields.tpAmb) throw bad('O ambiente do protocolo não é o da nota')
  if (ideFields.tpNF !== '0' && ideFields.tpNF !== '1') throw bad('O tipo de operação (tpNF) do XML está fora do domínio')
  // a chave carrega modelo (posições 21-22), série (23-25) e número (26-34): o `ide` tem de dizer o mesmo
  const sameNumber = (a: string | null | undefined, b: string): boolean => a !== null && a !== undefined && /^\d+$/.test(a) && Number(a) === Number(b)
  if (!sameNumber(ideFields.serie, accessKey.slice(22, 25)) || !sameNumber(ideFields.nNF, accessKey.slice(25, 34)) || ideFields.mod !== accessKey.slice(20, 22)) {
    throw bad('O modelo, a série ou o número do ide não conferem com a chave de acesso')
  }

  const items: DanfeItem[] = kids(inf, 'det').map(det => {
    const icmsWrap = child(child(det, 'imposto'), 'ICMS')
    const group = icmsWrap ? kids(icmsWrap)[0] ?? null : null
    return {
      itemNo: attrOf(det, 'nItem'), prod: fieldsOf(child(det, 'prod')),
      icmsGroup: group ? (group.localName ?? group.nodeName) : null, icms: fieldsOf(group), infAdProd: textOfChild(det, 'infAdProd'),
    }
  })
  if (items.length === 0) throw bad('A nota não tem item (det)')

  const total = child(inf, 'total')
  // o bloco "Total do IBS/CBS/IS" e as colunas UB dos itens (NT 2026.010 4.1) ainda NÃO são impressos: nota com o grupo é recusada, nunca sai um DANFE que o omite
  // em silêncio. O builder do 1º release não escreve o grupo para o Simples em 2026 (NFE.E5.P4); o passo que o imprime tira esta recusa.
  if (child(total, 'IBSCBSTot') !== null || kids(inf, 'det').some(det => child(child(det, 'imposto'), 'IBSCBS') !== null)) {
    throw bad('O XML traz o grupo IBS/CBS, que este DANFE ainda não imprime (NT 2026.010 4.1)')
  }
  const transp = child(inf, 'transp')
  const cobr = child(inf, 'cobr')
  const infAdic = child(inf, 'infAdic')
  const issqn = child(total, 'ISSQNtot')
  return {
    accessKey, ide: ideFields, emit: partyOf(child(inf, 'emit'), 'enderEmit'), dest: partyOf(child(inf, 'dest'), 'enderDest'), items,
    totals: fieldsOf(child(total, 'ICMSTot')), issqnTotals: issqn ? fieldsOf(issqn) : null,
    transp: {
      modFrete: textOfChild(transp, 'modFrete'),
      carrier: child(transp, 'transporta') ? fieldsOf(child(transp, 'transporta')) : null,
      vehicle: child(transp, 'veicTransp') ? fieldsOf(child(transp, 'veicTransp')) : null,
      volumes: transp ? kids(transp, 'vol').map(v => ({ fields: fieldsOf(v) })) : [],
    },
    billing: { fat: child(cobr, 'fat') ? fieldsOf(child(cobr, 'fat')) : null, dups: cobr ? kids(cobr, 'dup').map(d => fieldsOf(d)) : [] },
    infAdFisco: textOfChild(infAdic, 'infAdFisco'), infCpl: textOfChild(infAdic, 'infCpl'), authorization,
  }
}
