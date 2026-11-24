import { ELEMENT, attrOf, elementsOf, isValidCnpj, merchandiseInvoiceTotal, mod11Ascii48, parseXml, type MerchandiseTotalsCents, type XmlNode } from 'fiscal-api'
import type { Environment, Uf } from '../authority/authorizers'
import { CUF } from '../authority/messages'
import { validateMessage } from '../authority/xsd'
import { documentInvalid, MAX_FIELDS, totalsMotorDefect } from './errors'
import { toCents } from './formats'
import { HOMOLOGATION_TEXT } from './homologation'

/**
 * CAMADA 1 DA PRÉ-VALIDAÇÃO (NFE.E5.P5 — D-NE43, D-NE253; ficha-nfe-e5-p5-camada1.md). Um SEGUNDO olhar, independente do builder, sobre o XML
 * CANDIDATO (pré-assinatura): as 14 regras do 1º release (emitente do PR, CRT 1, modelo 55, `tpEmis` 1) que a nfe-api DERIVA, mais o XSD. Violação =
 * 422 com a lista INTEIRA, sem abrir tentativa. PURA: não toca banco, rede, relógio nem segredo — o relógio e os dados de fora entram pelo
 * `Layer1Context`; o XML é lido SÓ pelo leitor estrito do núcleo (nunca por recorte) e nada do builder é importado.
 */

export interface Layer1Context {
  environment: Environment
  /** UF do emitente (a do estabelecimento). */
  emitterUf: Uf
  /** UF servida pelo autorizador da tentativa. */
  authorizerUf: Uf
  /** O relógio, injetado: a função é pura. */
  now: Date
  /** O vNF do ERP (`tb_invoice_merchandise.total_value`) em centavos. */
  erpTotalCents: number
  /** A UF × modelo × ambiente exige o CSRT (dado do núcleo, resolvido por quem compõe a transmissão). */
  csrtRequired: boolean
}

export interface Layer1Violation {
  /** R1 a R14. */
  rule: string
  /** IDs do catálogo fiscal (a R3 serve a RF-NFE-13 e a 55). */
  rf: readonly string[]
  /** Número da rejeição da SEFAZ; nulo quando é escolha nossa ou a norma não numera. */
  rejection: number | null
  field: string
  message: string
  /** R9 quando o XML bate com a fórmula e o ERP não: defeito do motor (D-NE27). */
  motorDefect?: true
}

export interface Layer1Rule {
  id: string
  rf: readonly string[]
  rejections: readonly number[]
  source: string
  mocVersion: string
  owner: string
  ntReview: string
}

const OWNER = 'nfe-api · camada 1'
const MOC = 'MOC 7.00 (PDF; o MOC Online não está no acervo — D-NE98)'
const NO_NT = 'nenhuma NT conhecida em 2026-11-24'

/** O catálogo (D-NE43: cada regra com versão do MOC, dono e revisão por NT; as fontes são as da D-NE253). */
export const LAYER1_RULES: readonly Layer1Rule[] = Object.freeze([
  { id: 'R1', rf: ['RF-NFE-53'], rejections: [502, 253, 897, 207], source: 'AI:4536, 4735, 4563-4573; MOC Anexo I rej. 207', mocVersion: MOC, owner: OWNER, ntReview: 'NT 2019.001' },
  { id: 'R2', rf: ['RF-NFE-54'], rejections: [703, 228], source: 'AI:4587, 4593; nt-2025-001-v1-03.txt:368-392', mocVersion: MOC, owner: OWNER, ntReview: 'NT 2025.001 v1.03' },
  { id: 'R3', rf: ['RF-NFE-13', 'RF-NFE-55'], rejections: [226, 247, 252, 271, 273], source: 'AI:4555, 4739, 4686-4690, 5137-5143', mocVersion: MOC, owner: OWNER, ntReview: NO_NT },
  { id: 'R4', rf: ['RF-NFE-55'], rejections: [556, 244, 503], source: 'AI:4829, 4811, 5101', mocVersion: MOC, owner: OWNER, ntReview: NO_NT },
  { id: 'R5', rf: ['RF-NFE-29'], rejections: [598, 208], source: 'AI:5239-5243; D-NE216; MOC Anexo I rej. 208', mocVersion: MOC, owner: OWNER, ntReview: 'NT 2026.002 v1.11' },
  { id: 'R6', rf: ['RF-NFE-30'], rejections: [972, 973, 975], source: 'AI:8048-8070', mocVersion: MOC, owner: OWNER, ntReview: 'NT 2018.005' },
  { id: 'R7', rf: ['RF-NFE-31'], rejections: [927], source: 'AI:5616-5620', mocVersion: MOC, owner: OWNER, ntReview: 'NT 2019.001' },
  { id: 'R8', rf: ['RF-NFE-28'], rejections: [531, 532, 533, 534, 535, 536, 537, 538, 564, 601, 602, 603, 604, 685, 795, 859, 861, 862, 863], source: 'AI:7503-7602 (W03-20 a W15); CONFERENCIAS.md:86', mocVersion: MOC, owner: OWNER, ntReview: 'NT 2025.002 v1.53' },
  { id: 'R9', rf: ['RF-NFE-28'], rejections: [610], source: 'nt-2023-004-v1-20.txt:700-745; AI:7613', mocVersion: MOC, owner: OWNER, ntReview: 'NT 2023.004 v1.20' },
  { id: 'R10', rf: ['RF-NFE-19'], rejections: [215], source: 'AI:4391-4393; D-NE181', mocVersion: MOC, owner: OWNER, ntReview: NO_NT },
  { id: 'R11', rf: ['RF-NFE-35'], rejections: [402, 404, 587, 588], source: 'AI:4409-4419', mocVersion: MOC, owner: OWNER, ntReview: NO_NT },
  { id: 'R12', rf: ['RF-NFE-16'], rejections: [214], source: 'AI:4358', mocVersion: MOC, owner: OWNER, ntReview: NO_NT },
  { id: 'R13', rf: ['RF-NFE-56'], rejections: [871, 904, 865], source: 'AI:7884, 10283, 10355; D-NE48', mocVersion: MOC, owner: OWNER, ntReview: 'NT 2023.004 v1.20' },
  { id: 'R14', rf: ['RF-DEV-03'], rejections: [1010, 321, 236, 316], source: 'nt-2025-002-v1-53.txt:5232-5262; D-NE219; MOC Anexo I rej. 236, 316', mocVersion: MOC, owner: OWNER, ntReview: 'NT 2025.002 v1.53' },
])

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe'
/** Nome de elemento que vem do XML e entra em `field`: truncado, para o corpo da recusa não inchar. */
const short = (name: string): string => (name.length > 64 ? `${name.slice(0, 64)}…` : name)
/** Limite da mensagem (500 KB lidos como 1.000 — o mais estrito) e a margem para a assinatura e o envelope (S5). */
const MAX_BYTES = 500_000
const SIGNATURE_MARGIN = 10_240
/** Janela do `dhEmi` (703: 5 min à frente; 228: 30 dias atrás). */
const AHEAD_MS = 5 * 60_000
const BEHIND_MS = 30 * 86_400_000
const DH_EMI = /^(20[0-9]{2})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([-+](0[0-9]|1[01]):00|\+12:00)$/
/** As 20 sequências que o cNF não pode ter (B03-10 — rej. 897): CÓPIA própria da camada (paridade provada no teste). */
export const LAYER1_FORBIDDEN_CNF: readonly string[] = Object.freeze([
  '00000000', '11111111', '22222222', '33333333', '44444444', '55555555', '66666666', '77777777', '88888888', '99999999',
  '12345678', '23456789', '34567890', '45678901', '56789012', '67890123', '78901234', '89012345', '90123456', '01234567',
])
/** `ds:Signature` só de FORMA (estrutura mínima do xmldsig com valores de preenchimento): prova a estrutura que o `TNFe` exige, não a assinatura. */
const FORM_SIGNATURE = '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo>'
  + '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>'
  + '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>'
  + '<Reference URI="#form"><Transforms>'
  + '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>'
  + '<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></Transforms>'
  + '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>'
  + '<DigestValue>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</DigestValue></Reference></SignedInfo>'
  + '<SignatureValue>AAAA</SignatureValue><KeyInfo><X509Data><X509Certificate>AAAA</X509Certificate></X509Data></KeyInfo></Signature>'

// ---------------------------------------------------------------------------------------------------------------------------------------
// Leitura do documento (só pelo leitor estrito do núcleo)
// ---------------------------------------------------------------------------------------------------------------------------------------

const isEl = (n: XmlNode, name?: string): boolean => n.nodeType === ELEMENT && n.namespaceURI === NFE_NS && (name === undefined || (n.localName ?? n.nodeName) === name)
const child = (parent: XmlNode | null, name: string): XmlNode | null => {
  if (!parent) return null
  for (let i = 0; i < parent.childNodes.length; i++) if (isEl(parent.childNodes[i], name)) return parent.childNodes[i]
  return null
}
const children = (parent: XmlNode | null, name: string): XmlNode[] => {
  const out: XmlNode[] = []
  if (parent) for (let i = 0; i < parent.childNodes.length; i++) if (isEl(parent.childNodes[i], name)) out.push(parent.childNodes[i])
  return out
}
/** O texto CRU (sem aparar) de um elemento só de texto; `null` se ausente ou se tem elemento filho. */
const raw = (el: XmlNode | null): string | null => {
  if (!el) return null
  let out = ''
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i]
    if (c.nodeType === 3) out += c.nodeValue ?? ''
    else return null
  }
  return out
}
const val = (parent: XmlNode | null, name: string): string | null => raw(child(parent, name))

const centsOf = (text: string | null): number | null => { try { return text === null ? null : toCents(text) } catch { return null } }

/** O que a camada lê do candidato, uma vez. */
interface Doc {
  root: XmlNode
  inf: XmlNode
  ide: XmlNode | null
  emit: XmlNode | null
  dest: XmlNode | null
  dets: XmlNode[]
  tot: XmlNode | null
  finNFe: string | null
  isReturn: boolean
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// As regras
// ---------------------------------------------------------------------------------------------------------------------------------------

class Collector {
  readonly list: Layer1Violation[] = []
  add(rule: string, rejection: number | null, field: string, message: string, motorDefect?: true): void {
    const r = LAYER1_RULES.find(x => x.id === rule)
    this.list.push({ rule, rf: r ? r.rf : [], rejection, field, message, ...(motorDefect ? { motorDefect } : {}) })
  }
  /** Campo obrigatório ausente numa regra: violação da regra dona (nunca exceção). */
  missing(rule: string, field: string): void { this.add(rule, null, field, 'Campo obrigatório ausente no candidato') }
}

/** R11 sobre o texto cru, ANTES de ler (declaração, prefixo, espaço entre tags e nas bordas). */
function rawFormat(xml: string, c: Collector): void {
  const decl = /^<\?xml\s[^?]*\?>/.exec(xml)
  if (decl) {
    const enc = /encoding\s*=\s*["']([^"']*)["']/i.exec(decl[0])
    if (enc && enc[1].toUpperCase() !== 'UTF-8') c.add('R11', 402, 'declaração', 'Codificação do XML diferente de UTF-8')
  }
  if (/<\/?[A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*/.test(xml.replace(/^<\?xml[^?]*\?>/, ''))) c.add('R11', 404, 'documento', 'Uso de prefixo de namespace no XML da NF-e')
  if (/>[ \t\r\n]+</.test(xml) || /^[ \t\r\n]/.test(xml) || /[ \t\r\n]$/.test(xml)) c.add('R11', 588, 'documento', 'Caractere de edição (LF, CR, TAB ou espaço) entre as tags ou nas bordas da mensagem')
}

/** R11 nos nós de texto: espaço nas pontas do texto (escolha nossa — D-NE28), espaço entre tags escrito por referência de caractere (588) e comentário, instrução ou CDATA (o leitor da SEFAZ não os aceita). */
function edgeSpaces(doc: Doc, c: Collector): void {
  for (const el of elementsOf(doc.root, true)) {
    if (el.nodeType !== ELEMENT) continue
    const name = short(el.localName ?? el.nodeName)
    const text = raw(el)
    if (text !== null && text !== '' && text !== text.trim()) c.add('R11', null, name, 'Espaço nas pontas do texto do elemento (escolha nossa, D-NE28)')
    let hasElement = false
    for (let i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === ELEMENT) hasElement = true
    for (let i = 0; i < el.childNodes.length; i++) {
      const n = el.childNodes[i]
      if (n.nodeType === 8 || n.nodeType === 7 || n.nodeType === 4) c.add('R11', null, name, 'Comentário, instrução de processamento ou CDATA no XML da NF-e (escolha nossa)')
      else if (hasElement && !c.list.some(v => v.rejection === 588) && n.nodeType === 3 && (n.nodeValue ?? '').trim() === '' && (n.nodeValue ?? '') !== '') c.add('R11', 588, name, 'Caractere de edição entre as tags (escrito por referência de caractere)')
    }
  }
}

function rulesR1(doc: Doc, c: Collector): void {
  const { ide } = doc
  const f = { cUF: val(ide, 'cUF'), cNF: val(ide, 'cNF'), nNF: val(ide, 'nNF'), mod: val(ide, 'mod'), serie: val(ide, 'serie'), tpEmis: val(ide, 'tpEmis'), cDV: val(ide, 'cDV'), dhEmi: val(ide, 'dhEmi') }
  const cnpj = val(doc.emit, 'CNPJ')
  const absent = Object.entries({ ...f, 'emit.CNPJ': cnpj }).filter(([, v]) => v === null).map(([k]) => k)
  if (absent.length) { for (const k of absent) c.missing('R1', k.includes('.') ? k : `ide.${k}`); return }
  const dh = DH_EMI.exec(f.dhEmi as string)
  const id = attrOf(doc.inf, 'Id') ?? ''
  if (!/^[0-9]+$/.test(f.serie as string) || !/^[0-9]+$/.test(f.nNF as string) || !/^[0-9A-Z]{14}$/.test(cnpj as string) || !/^[0-9]{8}$/.test(f.cNF as string)
    || !/^[0-9]{2}$/.test(f.cUF as string) || !dh) {
    c.add('R1', 502, 'ide', 'Campos da chave de acesso fora da forma — a chave não pode ser composta')
    return
  }
  const body = `${f.cUF}${(dh[1] as string).slice(2)}${dh[2]}${cnpj}${f.mod}${(f.serie as string).padStart(3, '0')}${(f.nNF as string).padStart(9, '0')}${f.tpEmis}${f.cNF}`
  if (body.length === 43) {
    if (id !== `NFe${body}${f.cDV}`) c.add('R1', 502, 'infNFe/@Id', 'O Id difere de "NFe" + a chave composta dos campos do próprio XML')
    if (!/^[0-9A-Z]{43}$/.test(body) || mod11Ascii48(body) !== Number(f.cDV)) c.add('R1', 253, 'ide/cDV', 'Dígito verificador da chave de acesso não confere')
  } else c.add('R1', 502, 'ide', 'Campos da chave de acesso com tamanho fora do leiaute')
  if (!isValidCnpj(cnpj as string)) c.add('R1', 207, 'emit/CNPJ', 'CNPJ do emitente inválido')
  if (LAYER1_FORBIDDEN_CNF.includes(f.cNF as string) || Number(f.cNF) === Number(f.nNF)) c.add('R1', 897, 'ide/cNF', 'Código numérico igual ao número da nota ou em sequência proibida')
}

function rulesR2(doc: Doc, ctx: Layer1Context, c: Collector): Date | null {
  const dhText = val(doc.ide, 'dhEmi')
  if (dhText === null) { c.missing('R2', 'ide/dhEmi'); return null }
  if (!DH_EMI.test(dhText)) { c.add('R2', null, 'ide/dhEmi', 'Data e hora fora da forma do leiaute (fuso ±hh:00 obrigatório)'); return null }
  const at = new Date(dhText)
  if (Number.isNaN(at.getTime())) { c.add('R2', null, 'ide/dhEmi', 'Data e hora inexistentes'); return null }
  if (Number.isNaN(ctx.now.getTime())) { c.add('R2', null, 'contexto/now', 'O relógio injetado é inválido — a janela do dhEmi não pode ser conferida'); return at }
  const diff = at.getTime() - ctx.now.getTime()
  if (diff > AHEAD_MS) c.add('R2', 703, 'ide/dhEmi', 'Data de emissão posterior à data do processamento (tolerância de 5 minutos)')
  if (diff < -BEHIND_MS) c.add('R2', 228, 'ide/dhEmi', 'Data de emissão com mais de 30 dias de atraso')
  return at
}

function rulesR3(doc: Doc, ctx: Layer1Context, c: Collector): void {
  const cUF = val(doc.ide, 'cUF'), tpAmb = val(doc.ide, 'tpAmb')
  if (cUF === null) c.missing('R3', 'ide/cUF')
  else if (cUF !== CUF[ctx.emitterUf] || cUF !== CUF[ctx.authorizerUf]) c.add('R3', 226, 'ide/cUF', 'A UF do documento difere da UF do emitente ou da UF do autorizador')
  const ender = child(doc.emit, 'enderEmit')
  const uf = val(ender, 'UF')
  if (uf === null) c.missing('R3', 'emit/enderEmit/UF')
  else if (uf !== ctx.emitterUf) c.add('R3', 247, 'emit/enderEmit/UF', 'A sigla da UF do emitente difere da UF autorizadora')
  if (tpAmb === null) c.missing('R3', 'ide/tpAmb')
  else if (tpAmb !== (ctx.environment === 'H' ? '2' : '1')) c.add('R3', 252, 'ide/tpAmb', 'O ambiente do documento difere do ambiente da tentativa')
  const cMunFG = val(doc.ide, 'cMunFG'), cMun = val(ender, 'cMun')
  if (cMunFG === null) c.missing('R3', 'ide/cMunFG')
  else if (cUF !== null && !cMunFG.startsWith(cUF)) c.add('R3', 271, 'ide/cMunFG', 'O município de ocorrência do fato gerador não pertence à UF')
  if (cMun === null) c.missing('R3', 'emit/enderEmit/cMun')
  else if (cUF !== null && !cMun.startsWith(cUF)) c.add('R3', 273, 'emit/enderEmit/cMun', 'O município do emitente não pertence à UF')
}

function rulesR4(doc: Doc, c: Collector): void {
  const ide = doc.ide
  if (child(ide, 'dhCont') || child(ide, 'xJust')) c.add('R4', 556, 'ide', 'Emissão normal com data/hora ou justificativa de contingência')
  const tpEmis = val(ide, 'tpEmis'), procEmi = val(ide, 'procEmi'), serie = val(ide, 'serie')
  if (tpEmis !== null && tpEmis !== '1') c.add('R4', null, 'ide/tpEmis', 'Tipo de emissão diferente de 1 — fora do 1º release')
  const mod = val(ide, 'mod'), crt = val(doc.emit, 'CRT')
  if (mod !== null && mod !== '55') c.add('R4', null, 'ide/mod', 'Modelo diferente de 55 — fora do 1º release')
  if (crt === null) c.missing('R4', 'emit/CRT')
  else if (crt !== '1') c.add('R4', null, 'emit/CRT', 'Regime tributário diferente de 1 (Simples Nacional) — fora do 1º release')
  if (procEmi === null) c.missing('R4', 'ide/procEmi')
  if (serie === null) c.missing('R4', 'ide/serie')
  else if (/^[0-9]+$/.test(serie)) {
    const n = Number(serie)
    if (n > 909) c.add('R4', 503, 'ide/serie', 'Série fora do intervalo 0 a 909')
    else if (procEmi === '0' && n > 889) c.add('R4', 244, 'ide/serie', 'Série de 890 a 909 com processo de emissão 0 (aplicativo do contribuinte)')
  }
}

function rulesR5(doc: Doc, ctx: Layer1Context, c: Collector): void {
  const destCnpj = val(doc.dest, 'CNPJ')
  if (destCnpj !== null && !isValidCnpj(destCnpj)) c.add('R5', 208, 'dest/CNPJ', 'CNPJ do destinatário inválido')
  const xNome = val(doc.dest, 'xNome')
  if (xNome === null) { c.missing('R5', 'dest/xNome'); return }
  if (ctx.environment === 'H' && xNome !== HOMOLOGATION_TEXT) c.add('R5', 598, 'dest/xNome', 'Em homologação o nome do destinatário é o texto fixo da norma')
  if (ctx.environment === 'P' && xNome.trim().toUpperCase() === HOMOLOGATION_TEXT) c.add('R5', null, 'dest/xNome', 'O texto fixo de homologação não pode aparecer em produção (escolha nossa)')
}

function rulesR6(doc: Doc, ctx: Layer1Context, c: Collector): void {
  const rt = child(doc.inf, 'infRespTec')
  if (!rt) { c.add('R6', 972, 'infRespTec', 'Grupo de informações do responsável técnico ausente'); return }
  const cnpj = val(rt, 'CNPJ')
  if (cnpj === null || !isValidCnpj(cnpj)) c.add('R6', 973, 'infRespTec/CNPJ', 'CNPJ do responsável técnico ausente ou inválido')
  const id = val(rt, 'idCSRT'), hash = val(rt, 'hashCSRT')
  if (ctx.csrtRequired) {
    if (id === null || hash === null) c.add('R6', 975, 'infRespTec', 'O identificador e o hash do CSRT são obrigatórios para esta UF')
    else {
      if (!/^[0-9]{2}$/.test(id)) c.add('R6', 975, 'infRespTec/idCSRT', 'Identificador do CSRT fora da forma (2 dígitos)')
      if (!/^[A-Za-z0-9+/]{27}=$/.test(hash)) c.add('R6', 975, 'infRespTec/hashCSRT', 'Hash do CSRT fora da forma (Base64 de 20 bytes)')
    }
  } else if (id !== null || hash !== null) c.add('R6', null, 'infRespTec', 'O par idCSRT/hashCSRT não é exigido para esta UF (escolha nossa)')
}

function rulesR7(doc: Doc, c: Collector): void {
  if (doc.dets.length === 0) { c.missing('R7', 'det'); return }
  if (doc.dets.length > 990) c.add('R7', 927, 'det', 'Mais de 990 itens')
  doc.dets.forEach((d, i) => {
    if (attrOf(d, 'nItem') !== String(i + 1)) c.add('R7', 927, `det[${i + 1}]/@nItem`, 'O nItem deve ser consecutivo a partir de 1')
  })
}

const elementsOfChildren = (parent: XmlNode): XmlNode[] => {
  const out: XmlNode[] = []
  for (let i = 0; i < parent.childNodes.length; i++) if (isEl(parent.childNodes[i])) out.push(parent.childNodes[i])
  return out
}

/** Soma do texto decimal de `path` (elementos descendentes de cada `det`) em centavos; `null` se algum valor não for centavo exato. */
const sumDets = (dets: XmlNode[], path: readonly string[]): number | null => {
  let total = 0
  for (const d of dets) {
    let nodes: XmlNode[] = [d]
    for (const step of path) nodes = step === '*' ? nodes.flatMap(n => elementsOfChildren(n)) : nodes.flatMap(n => children(n, step))
    for (const n of nodes) { const v = centsOf(raw(n)); if (v === null) return null; total += v }
  }
  return total
}

/** O que o `ICMSTot` soma dos itens: campo → caminho dentro do `det` ('*' = qualquer grupo filho: o CSOSN muda o nome do grupo) e a rejeição da SEFAZ (MOC Anexo I, W03-20 a W15). */
const ICMS = ['imposto', 'ICMS', '*'] as const
const TOT_FIELDS: readonly { f: string; path: readonly string[]; rej: number }[] = [
  { f: 'vBC', path: [...ICMS, 'vBC'], rej: 531 }, { f: 'vICMS', path: [...ICMS, 'vICMS'], rej: 532 }, { f: 'vICMSDeson', path: [...ICMS, 'vICMSDeson'], rej: 795 },
  { f: 'vFCP', path: [...ICMS, 'vFCP'], rej: 861 }, { f: 'vBCST', path: [...ICMS, 'vBCST'], rej: 533 }, { f: 'vST', path: [...ICMS, 'vICMSST'], rej: 534 },
  { f: 'vFCPST', path: [...ICMS, 'vFCPST'], rej: 862 }, { f: 'vFCPSTRet', path: [...ICMS, 'vFCPSTRet'], rej: 859 },
  { f: 'vProd', path: ['prod', 'vProd'], rej: 564 }, { f: 'vFrete', path: ['prod', 'vFrete'], rej: 535 }, { f: 'vSeg', path: ['prod', 'vSeg'], rej: 536 },
  { f: 'vDesc', path: ['prod', 'vDesc'], rej: 537 },
  { f: 'vII', path: ['imposto', 'II', 'vII'], rej: 601 }, { f: 'vIPI', path: ['imposto', 'IPI', 'IPITrib', 'vIPI'], rej: 538 },
  { f: 'vIPIDevol', path: ['impostoDevol', 'IPI', 'vIPIDevol'], rej: 863 },
  { f: 'vPIS', path: ['imposto', 'PIS', '*', 'vPIS'], rej: 602 }, { f: 'vCOFINS', path: ['imposto', 'COFINS', '*', 'vCOFINS'], rej: 603 },
  { f: 'vOutro', path: ['prod', 'vOutro'], rej: 604 },
]

function rulesR8R9(doc: Doc, ctx: Layer1Context, at: Date | null, c: Collector): void {
  const icmsTot = child(doc.tot, 'ICMSTot')
  if (!icmsTot) { c.missing('R8', 'total/ICMSTot'); return }
  const sums = new Map<string, number>()
  for (const { f, path, rej } of TOT_FIELDS) {
    const expected = sumDets(doc.dets, path)
    const written = centsOf(val(icmsTot, f))
    if (written === null) { c.add('R8', rej, `ICMSTot/${f}`, 'Campo do total ausente ou fora do formato monetário'); continue }
    if (expected === null) { c.add('R8', rej, `ICMSTot/${f}`, 'Valor de item fora do formato monetário — a soma não pode ser conferida'); continue }
    sums.set(f, expected)
    if (written !== expected) c.add('R8', rej, `ICMSTot/${f}`, 'O total difere da soma dos itens (regra W do ICMSTot)')
  }
  const tribSum = sumDets(doc.dets, ['imposto', 'vTotTrib'])
  const tribWritten = val(icmsTot, 'vTotTrib')
  if (tribSum !== null) {
    if (tribWritten === null ? tribSum !== 0 : centsOf(tribWritten) !== tribSum) c.add('R8', 685, 'ICMSTot/vTotTrib', 'O total aproximado de tributos difere da soma dos itens')
  }

  // R9 — o vNF escrito = a fórmula do núcleo sobre as parcelas dos ITENS = o vNF do ERP (D-NE27: tolerância zero)
  if (!at) return                                                                    // sem data legível a fórmula não roda (a R2 já acusou)
  const wroteVNF = centsOf(val(icmsTot, 'vNF'))
  const parts = ['vProd', 'vDesc', 'vFrete', 'vSeg', 'vOutro'].map(k => sums.get(k))
  if (wroteVNF === null || parts.some(p => p === undefined)) { c.add('R9', 610, 'ICMSTot/vNF', 'vNF ausente ou parcelas dos itens ilegíveis — a fórmula não pode ser conferida'); return }
  const totals: MerchandiseTotalsCents = {
    vProd: parts[0] as number, vDesc: parts[1] as number, vFrete: parts[2] as number, vSeg: parts[3] as number, vOutro: parts[4] as number,
    vICMSDesonDeducted: 0, vST: sums.get('vST') ?? 0, vFCPST: sums.get('vFCPST') ?? 0, vICMSMonoReten: 0, vII: sums.get('vII') ?? 0, vIPI: sums.get('vIPI') ?? 0, vIPIDevol: sums.get('vIPIDevol') ?? 0, vServ: 0, vPISSTSummed: 0, vCOFINSSTSummed: 0, newVehicleSale: false,
  }
  let formula: number
  try {
    formula = merchandiseInvoiceTotal(totals, (val(doc.ide, 'dhEmi') as string).slice(0, 10)).cents
  } catch { c.add('R9', 610, 'ICMSTot/vNF', 'A fórmula oficial do vNF não se aplica a estes valores ou a esta data'); return }
  if (wroteVNF !== formula) c.add('R9', 610, 'ICMSTot/vNF', 'O vNF escrito difere da fórmula oficial sobre os itens do próprio XML')
  else if (!Number.isSafeInteger(ctx.erpTotalCents) || formula !== ctx.erpTotalCents) {
    c.add('R9', 610, 'ICMSTot/vNF', 'O vNF pela fórmula oficial difere do total gravado pelo faturamento (tolerância zero)', true)
  }
}

/** R10 — o XSD sobre o candidato com a Signature de forma (S4); uma violação por elemento, citando só o nome (a mensagem do validador cita o valor). */
async function rulesR10(xml: string, rootName: string, c: Collector): Promise<void> {
  // o fechamento vem do NOME da raiz que o leitor estrito já leu (não de um literal de tag: a cerca N17 do núcleo proíbe recorte de XML por texto de tag)
  const closeTag = `</${rootName}>`
  const body = xml.trimEnd()
  if (!body.endsWith(closeTag)) { c.add('R10', 215, 'NFe', 'Elemento raiz sem fechamento'); return }
  const at = body.length - closeTag.length
  const result = await validateMessage('NFe', body.slice(0, at) + FORM_SIGNATURE + body.slice(at))
  if (result.ok) return
  const seen = new Set<string>()
  for (const message of result.errors) {
    const m = /Element '(?:\{[^}]*\})?([^']+)'/.exec(message)
    const name = m ? short(m[1]) : 'documento'
    if (seen.has(name)) continue
    seen.add(name)
    c.add('R10', 215, name, 'Estrutura ou tipo inválido segundo o leiaute (XSD)')
  }
}

/** Chave referenciada: 44 dígitos, DV, modelo 55 e diferente da chave da própria nota. */
function checkRefKey(key: string | null, own: string, where: string, c: Collector): void {
  if (key === null) { c.missing('R14', where); return }
  if (!/^[0-9]{44}$/.test(key)) { c.add('R14', 236, where, 'Chave de acesso referenciada fora da forma (44 dígitos)'); return }
  if (mod11Ascii48(key.slice(0, 43)) !== Number(key[43])) c.add('R14', 236, where, 'Chave de acesso referenciada com dígito verificador inválido')
  if (key.slice(20, 22) !== '55') c.add('R14', null, where, 'Chave referenciada de modelo diferente de 55 — fora do 1º release (escolha nossa)')
  if (key === own) c.add('R14', 316, where, 'Chave de acesso referenciada igual à da própria nota')
}

function rulesR13R14(doc: Doc, c: Collector): void {
  const ide = doc.ide
  const nfref = children(ide, 'NFref')
  const refs = doc.dets.map(d => child(d, 'DFeReferenciado'))
  const anyRef = refs.some(r => r !== null)
  const own = (attrOf(doc.inf, 'Id') ?? '').replace(/^NFe/, '')
  if (doc.finNFe !== '1' && doc.finNFe !== '4') c.add('R13', null, 'ide/finNFe', 'Finalidade fora do perfil do 1º release (1 venda; 4 devolução)')
  const pag = child(doc.inf, 'pag')
  const pags = children(pag, 'detPag')
  if (doc.isReturn) {
    if (pags.length !== 1 || val(pags[0], 'tPag') !== '90') c.add('R13', 871, 'pag/detPag/tPag', 'Devolução: a forma de pagamento deve ser 90 (sem pagamento)')
    else if (centsOf(val(pags[0], 'vPag')) !== 0) c.add('R13', 904, 'pag/detPag/vPag', 'Devolução: o valor do pagamento deve ser 0.00')
    if (nfref.length && anyRef) c.add('R14', 1010, 'ide/NFref', 'Chave referenciada no cabeçalho e também no item')
    else if (nfref.length) c.add('R14', null, 'ide/NFref', 'Referência só no cabeçalho — a devolução referencia por item (escolha nossa, D-NE219)')
    else if (!anyRef) c.add('R14', 321, 'det/DFeReferenciado', 'Devolução sem nenhuma nota referenciada')
    else refs.forEach((r, i) => { if (r === null) c.add('R14', 321, `det[${i + 1}]/DFeReferenciado`, 'Item da devolução sem a nota referenciada') })
    refs.forEach((r, i) => { if (r !== null) checkRefKey(val(r, 'chaveAcesso'), own, `det[${i + 1}]/DFeReferenciado/chaveAcesso`, c) })
  } else {
    if (anyRef) c.add('R14', null, 'det/DFeReferenciado', 'Nota que não é devolução com item referenciado (escolha nossa)')
    // venda: a soma dos pagamentos (menos o troco) cobre o vNF (865); o excesso não é rejeição numerada (escolha nossa)
    const vnf = centsOf(val(child(doc.tot, 'ICMSTot'), 'vNF'))
    const paid = pags.map(d => centsOf(val(d, 'vPag')))
    if (vnf !== null && paid.length && paid.every(v => v !== null)) {
      const net = (paid as number[]).reduce((a, b) => a + b, 0) - (centsOf(val(pag, 'vTroco')) ?? 0)
      if (net < vnf) c.add('R13', 865, 'pag/detPag/vPag', 'Total dos pagamentos menor que o total da nota')
      else if (net > vnf) c.add('R13', null, 'pag/detPag/vPag', 'Total dos pagamentos maior que o total da nota (escolha nossa)')
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// A camada
// ---------------------------------------------------------------------------------------------------------------------------------------

/** Confere o XML candidato e devolve TODAS as violações (lista vazia = candidato limpo). Nunca lança por dado do candidato. */
export async function validateCandidate(xml: string, ctx: Layer1Context): Promise<Layer1Violation[]> {
  const c = new Collector()
  // R12 — o tamanho ANTES de ler (o leitor recusa acima de 1 MiB e essa nota tem de cair aqui)
  if (typeof xml !== 'string') { c.add('R10', 215, 'documento', 'O candidato não é texto'); return c.list }
  if (Buffer.byteLength(xml, 'utf8') + SIGNATURE_MARGIN > MAX_BYTES) {
    c.add('R12', 214, 'documento', 'Mensagem acima do limite de 500 KB (contada com a margem da assinatura)')
    return c.list
  }
  rawFormat(xml, c)
  let root: ReturnType<typeof parseXml>
  try { root = parseXml(xml) } catch {
    c.add('R10', 215, 'documento', 'XML ilegível pelo leitor estrito (estrutura, entidade, DOCTYPE ou profundidade)')
    return c.list
  }
  const top = elementsOf(root, false).find(e => e.nodeType === ELEMENT) as XmlNode
  if ((top.localName ?? top.nodeName) !== 'NFe' || top.namespaceURI !== NFE_NS) {
    c.add('R11', 587, 'NFe', 'A raiz não é a NFe no namespace da NF-e')
    return c.list                                                                    // as outras regras precisam do documento
  }
  const inf = child(top, 'infNFe')
  if (!inf) { c.add('R10', 215, 'infNFe', 'Elemento infNFe ausente'); return c.list }
  const ide = child(inf, 'ide')
  const finNFe = val(ide, 'finNFe')
  const doc: Doc = { root: top, inf, ide, emit: child(inf, 'emit'), dest: child(inf, 'dest'), dets: children(inf, 'det'), tot: child(inf, 'total'), finNFe, isReturn: finNFe === '4' }
  edgeSpaces(doc, c)
  rulesR1(doc, c)
  const at = rulesR2(doc, ctx, c)
  rulesR3(doc, ctx, c)
  rulesR4(doc, c)
  rulesR5(doc, ctx, c)
  rulesR6(doc, ctx, c)
  rulesR7(doc, c)
  rulesR8R9(doc, ctx, at, c)
  rulesR13R14(doc, c)
  await rulesR10(xml, top.localName ?? top.nodeName, c)
  return c.list
}

const label = (v: Layer1Violation): string => `[${v.rule}${v.rejection === null ? '' : ` · rej. ${v.rejection}`}] ${v.message}`

/**
 * Lança a recusa 422 com a lista inteira. A R9 SOZINHA (o XML bate com a fórmula e o ERP não) é o defeito do motor — `FISCAL_TOTALS_MOTOR_DEFECT`
 * (D-NE27); com qualquer outra violação o documento vem primeiro e o código é `FISCAL_DOCUMENT_INVALID`, com a R9 na lista.
 */
export async function assertLayer1(xml: string, ctx: Layer1Context): Promise<void> {
  const list = await validateCandidate(xml, ctx)
  if (list.length === 0) return
  const fields = list.map(v => ({ field: v.field, message: label(v) }))
  if (list.every(v => v.motorDefect)) throw totalsMotorDefect('O total da nota (vNF) gravado pelo faturamento não confere com a fórmula oficial', fields)
  const more = list.length > MAX_FIELDS ? ` (e mais ${list.length - MAX_FIELDS} violação(ões) além das ${MAX_FIELDS} listadas)` : ''
  throw documentInvalid(`O candidato da NF-e tem ${list.length} violação(ões) da camada 1${more}`, fields)
}

