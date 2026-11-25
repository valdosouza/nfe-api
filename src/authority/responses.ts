import {
  ELEMENT, XmlUnreadableError, toUtcDb, elementsOf, nameIs, parseXml, textOf, type AmbiguousCause, type XmlNode, type XmlReadOptions,
} from 'fiscal-api'
import { NFE_NS } from './soap'

/**
 * LEITORES das respostas da SEFAZ, conferidas contra a PERGUNTA (NE-3, nfe-api:NFE.E4.P3.T2 — D-NE42, D-NE196, D-NE39/D-NE106/D-NE208,
 * D-NE209, D-NE40/D-NE207, D-NE108, D-NE33, D-NE210, D-NE206; regras RF-NFE-20 a RF-NFE-26).
 *
 * - Entrada: o `xml` que o `callSoap` devolve em `answered` OU `rejected` (o `soap.ts` chama de `rejected` todo cStat fora da faixa 1xx — 217,
 *   301, 563, 256 chegam assim; quem decide o que eles SÃO é o leitor do serviço).
 * - Leitor estrito do núcleo, nome LOCAL no namespace da NF-e (D-NE86); o cStat do TOPO é filho direto do retorno (o `protNFe` traz outro).
 * - Saída: `fact` (o que o fisco afirma sobre a NOSSA pergunta) · `rejection` (recusou; nada mudou) · `no-voice` (106 — D-NE108) ·
 *   `ambiguous` (não dá para afirmar nada — a saída é consultar de novo).
 * - O ELO: o eco que liga a resposta à pergunta TEM de vir e ser igual (D-NE42, D-NE210); chave diferente nunca vira autorizada. A exigência
 *   vale para o que muda estado (autorizada, denegada, cancelada, inutilizada); uma rejeição sem eco segue rejeição (nada aconteceu).
 * - Resposta ASSINADA no trecho que decide → ambígua (D-NE206 — a conferência do certificado do fisco é a F-NFE-8); o PR não assina.
 * - Nada aqui grava voz nem banco (NE-5).
 */

export type ReadResult<F> =
  | { readonly kind: 'fact'; readonly fact: F }
  /** `note`: a rejeição é da NOTA (o cStat do `protNFe` da nossa chave); sem ele é a recusa da PERGUNTA (656, 108/109, 999…) — nunca fecha a tentativa (NFE.E6.P1, gate socrático H1). */
  | { readonly kind: 'rejection'; readonly cStat: string; readonly xMotivo: string | null; readonly note?: true; /** a recusa da PERGUNTA pelo serviço (656, 108/109, 999): nunca conclui nada — alimenta o disjuntor (NFE.E6.P2) */ readonly refused?: true }
  | { readonly kind: 'no-voice'; readonly cStat: string }
  | { readonly kind: 'ambiguous'; readonly cause: AmbiguousCause }

const NFE: XmlReadOptions = { match: 'local', namespaces: [NFE_NS] }
const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#'

const ambiguous = (cause: AmbiguousCause): ReadResult<never> => ({ kind: 'ambiguous', cause })
const rejection = (cStat: string, xMotivo: string | null): ReadResult<never> => ({ kind: 'rejection', cStat, xMotivo })
/** A recusa da PERGUNTA (consumo indevido 656, serviço paralisado 108/109, erro interno 999): nunca é rejeição do evento nem da faixa (RF-NFE-74, NFE.E6.P2). */
const REFUSED = new Set(['656', '108', '109', '999'])
const refusedOr = (cStat: string, xMotivo: string | null): ReadResult<never> => (REFUSED.has(cStat) ? { kind: 'rejection', cStat, xMotivo, refused: true } : rejection(cStat, xMotivo))

class Unreadable extends Error {}

/** Filhos ELEMENTO diretos com o nome local [name] no namespace da NF-e. */
function children(el: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = []
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i]
    if (c.nodeType === ELEMENT && nameIs(c, name, NFE)) out.push(c)
  }
  return out
}
function child(el: XmlNode, name: string): XmlNode | null {
  const all = children(el, name)
  if (all.length > 1) throw new Unreadable()
  return all[0] ?? null
}
/** Texto do filho direto [name] (vazio = ausente — D-NE85). */
function text(el: XmlNode | null, name: string): string | null {
  const c = el ? child(el, name) : null
  if (!c) return null
  const v = textOf(c)
  return v === '' ? null : v
}
/** O elemento de retorno (raiz ou dentro do envelope SOAP) — exatamente UM. */
function retOf(xml: string, name: string): XmlNode {
  const doc = parseXml(xml)
  const found = elementsOf(doc, false).filter(e => nameIs(e, name, NFE))
  if (found.length !== 1) throw new Unreadable()
  return found[0]
}
/** Há `ds:Signature` (filho direto) no elemento? */
function signed(el: XmlNode): boolean {
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i]
    if (c.nodeType === ELEMENT && (c.localName ?? c.nodeName) === 'Signature' && c.namespaceURI === DSIG_NS) return true
  }
  return false
}
const sameNumber = (a: string | null, b: string | number): boolean => a !== null && /^[0-9]+$/.test(a) && Number(a) === Number(b)

/** Roda [fn] tratando XML ilegível e forma inesperada como ambíguo (falha fechada). */
function guarded<F>(fn: () => ReadResult<F>): ReadResult<F> {
  try { return fn() } catch (e) {
    if (e instanceof XmlUnreadableError || e instanceof Unreadable) return ambiguous('envelope-ilegivel')
    throw e
  }
}

export type DuplicateCStat = '204' | '539' | '205' | '206' | '218' | '635'
const DUPLICATE: ReadonlySet<string> = new Set<DuplicateCStat>(['204', '539', '205', '206', '218', '635'])
/** Rejeição da NOTA de fato: cStat de 3 ou 4 dígitos na faixa 2xx a 9xx. Todo 1xx fora das classes conhecidas (100 sem protocolo, 101 no envio, 108/109, 104 em lugar errado…) NÃO é rejeição: é ambíguo e nada fecha (gate adversarial HIGH-1). */
const NOTE_REJECTION_FORM = /^[2-9][0-9]{2,3}$/
/** Dentro da faixa mas NÃO rejeição da nota: denegada (110, 301–303), 217 (não consta — só a `reconfirm` conclui), 656 (consumo indevido), 999 (erro interno), 108/109 (serviço). */
const NOT_A_NOTE_REJECTION = new Set(['110', '301', '302', '303', '217', '656', '999', '108', '109'])
const NOTE_REJECTION = { test: (cStat: string): boolean => NOTE_REJECTION_FORM.test(cStat) && !NOT_A_NOTE_REJECTION.has(cStat) }
const NPROT_FORM = /^([0-9]{15}|[0-9]{17})$/
const DIGVAL_FORM = /^[A-Za-z0-9+/]{27}=$/
const DH_FORM = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([-+][0-9]{2}:[0-9]{2}|Z)$/
const DENIED = new Set(['110', '301', '302', '303'])
const AUTHORIZED = new Set(['100', '150'])

// ---------------------------------------------------------------------------------------------------------------------------------------

export interface StatusQuestion { readonly tpAmb: '1' | '2'; readonly cUF: string }
export interface StatusFact { readonly state: 'operating' | 'paused'; readonly cStat: string }

/** Status do serviço (`retConsStatServ` — RF-NFE-20): 107 em operação; 108/109 paralisado. */
export function readStatus(q: StatusQuestion, xml: string): ReadResult<StatusFact> {
  return guarded<StatusFact>(() => {
    const ret = retOf(xml, 'retConsStatServ')
    const cStat = text(ret, 'cStat')
    if (!cStat) return ambiguous('envelope-ilegivel')
    if (cStat !== '107' && cStat !== '108' && cStat !== '109') return rejection(cStat, text(ret, 'xMotivo'))
    if (text(ret, 'tpAmb') !== q.tpAmb || !sameNumber(text(ret, 'cUF'), q.cUF)) return ambiguous('nao-classificada')
    return { kind: 'fact', fact: { state: cStat === '107' ? 'operating' : 'paused', cStat } }
  })
}

// ---------------------------------------------------------------------------------------------------------------------------------------

export interface ProtocolQuestion { readonly chNFe: string; readonly tpAmb: '1' | '2' }
export type ProtocolFact =
  /** `digVal` e `dhRecbto` do `protNFe` (NFE.E6.P1): a reconciliação confere o `digVal` (D-NE41) e o `dh_recbto` é gravado write-once. */
  | { readonly status: 'authorized'; readonly cStat: string; readonly nProt: string; readonly digVal: string | null; readonly dhRecbto: string | null }
  | { readonly status: 'denied'; readonly cStat: string; readonly nProt: string | null; readonly digVal: string | null; readonly dhRecbto: string | null }
  | { readonly status: 'cancelled'; readonly cStat: string }
  | { readonly status: 'not-found'; readonly cStat: '217'; /** o `chNFe` DO RETORNO (já igual à pergunta): a peça `notRegisteredProven` do núcleo o compara com a chave da tentativa */ readonly chNFe: string }
  | { readonly status: 'processing'; readonly cStat: '105' }
  /**
   * 204 (duplicidade, mesma chave) e 539 (chave diferente — D-NE36), mais 205 (denegada na base), 218 (cancelada), 206 (inutilizada) e 635 (mesmo número e série
   * aguardando processamento — RF-NFE-75): NUNCA concluem como rejeição — o número pode já ser de uma nota; a saída é a consulta da chave.
   */
  | { readonly status: 'duplicate'; readonly cStat: DuplicateCStat }

/** O `protNFe` da NOSSA chave (sem assinatura) → autorizada/denegada; senão ambíguo. Usado na consulta e no recibo. */
function readProt(parent: XmlNode, chNFe: string, tpAmb: string): ReadResult<ProtocolFact> {
  const prots = children(parent, 'protNFe')
  if (prots.length !== 1) return ambiguous('nao-classificada')
  const prot = prots[0]
  if (signed(prot)) return ambiguous('nao-classificada')                       // D-NE206 — F-NFE-8
  const inf = child(prot, 'infProt')
  if (!inf) return ambiguous('envelope-ilegivel')
  if (text(inf, 'chNFe') !== chNFe || text(inf, 'tpAmb') !== tpAmb) return ambiguous('nao-classificada')   // D-NE42, D-NE210
  const cStat = text(inf, 'cStat')
  const nProt = text(inf, 'nProt')
  const digVal = text(inf, 'digVal')
  const dhRecbto = text(inf, 'dhRecbto')
  // a FORMA dos campos que vão ao banco é conferida AQUI: fora da forma é ambíguo (nProt, digVal e dhRecbto malformados quebrariam a transação da voz e deixariam a tentativa sem saída — gate adversarial M4)
  if ((nProt !== null && !NPROT_FORM.test(nProt)) || (digVal !== null && !DIGVAL_FORM.test(digVal)) || (dhRecbto !== null && (!DH_FORM.test(dhRecbto) || Number.isNaN(Date.parse(dhRecbto)) || toUtcDb(dhRecbto) === null))) return ambiguous('nao-classificada')
  if (cStat && protStatusOf(cStat) === 'authorized' && nProt) return { kind: 'fact', fact: { status: 'authorized', cStat, nProt, digVal, dhRecbto } }
  if (cStat && protStatusOf(cStat) === 'denied') return { kind: 'fact', fact: { status: 'denied', cStat, nProt, digVal, dhRecbto } }
  if (cStat && DUPLICATE.has(cStat)) return { kind: 'fact', fact: { status: 'duplicate', cStat: cStat as DuplicateCStat } }
  if (cStat && NOTE_REJECTION.test(cStat)) return { kind: 'rejection', cStat, xMotivo: text(inf, 'xMotivo'), note: true }
  return ambiguous(cStat ? 'nao-classificada' : 'envelope-ilegivel')
}
function protStatusOf(cStat: string): 'authorized' | 'denied' | null {
  return AUTHORIZED.has(cStat) ? 'authorized' : DENIED.has(cStat) ? 'denied' : null
}

/** Consulta de protocolo (`retConsSitNFe` — RF-NFE-21; D-NE209: cancelada = 101/151 no topo; 155 só dentro do evento). */
export function readProtocol(q: ProtocolQuestion, xml: string): ReadResult<ProtocolFact> {
  return guarded<ProtocolFact>(() => {
    const ret = retOf(xml, 'retConsSitNFe')
    const cStat = text(ret, 'cStat')
    if (!cStat) return ambiguous('situacao-ilegivel')
    if (cStat === '217') return text(ret, 'chNFe') === q.chNFe ? { kind: 'fact', fact: { status: 'not-found', cStat: '217', chNFe: q.chNFe } } : ambiguous('nao-classificada')
    const located = AUTHORIZED.has(cStat) || DENIED.has(cStat) || cStat === '101' || cStat === '151'
    if (!located) return cStat === '155' ? ambiguous('situacao-ilegivel') : rejection(cStat, text(ret, 'xMotivo'))
    if (text(ret, 'chNFe') !== q.chNFe || text(ret, 'tpAmb') !== q.tpAmb) return ambiguous('nao-classificada')   // D-NE42, D-NE210
    if (cStat === '101' || cStat === '151') return { kind: 'fact', fact: { status: 'cancelled', cStat } }
    const prot = readProt(ret, q.chNFe, q.tpAmb)
    return prot.kind === 'rejection' ? ambiguous('nao-classificada') : prot       // nota LOCALIZADA no topo e rejeitada no protNFe é inconsistente: a consulta pela chave nunca fecha por rejeição
  })
}

// ---------------------------------------------------------------------------------------------------------------------------------------

export interface ReceiptQuestion { readonly nRec: string; readonly chNFe: string; readonly tpAmb: '1' | '2' }

/** Consulta de recibo (`retConsReciNFe`): 106 não grava voz (D-NE108); 105 em processamento (D-NE33); 104 → o `protNFe` da nossa chave. */
export function readReceipt(q: ReceiptQuestion, xml: string): ReadResult<ProtocolFact> {
  return guarded<ProtocolFact>(() => {
    const ret = retOf(xml, 'retConsReciNFe')
    const cStat = text(ret, 'cStat')
    if (!cStat) return ambiguous('envelope-ilegivel')
    if (cStat === '106') return { kind: 'no-voice', cStat }
    if (cStat !== '104' && cStat !== '105') return rejection(cStat, text(ret, 'xMotivo'))
    if (text(ret, 'nRec') !== q.nRec || text(ret, 'tpAmb') !== q.tpAmb) return ambiguous('nao-classificada')
    if (cStat === '105') return { kind: 'fact', fact: { status: 'processing', cStat: '105' } }
    return readProt(ret, q.chNFe, q.tpAmb)
  })
}

// ---------------------------------------------------------------------------------------------------------------------------------------

export interface SendQuestion { readonly chNFe: string; readonly tpAmb: '1' | '2' }
export type SendFact = ProtocolFact | { readonly status: 'received'; readonly cStat: '103'; readonly nRec: string }

/**
 * Retorno do envio (`retEnviNFe`, NFE.E6.P1 — D-NE33, D-NE36, D-NE42, D-NE210): 104 → o `protNFe` da NOSSA chave (autorizada/denegada, ou 204/539 que
 * mandam consultar a chave, ou a rejeição da nota); 103 → lote recebido com o `nRec` (voz P + consulta do recibo); 105 → em processamento (P);
 * 204/539 no topo também só mandam consultar; qualquer outro cStat de topo é rejeição do LOTE (a nota não foi recebida). O eco de `tpAmb`
 * tem de ser o perguntado. `protNFe` assinado, mais de um, chave diferente ou XML ilegível → ambíguo (nada grava).
 */
export function readSend(q: SendQuestion, xml: string): ReadResult<SendFact> {
  return guarded<SendFact>(() => {
    const ret = retOf(xml, 'retEnviNFe')
    const cStat = text(ret, 'cStat')
    if (!cStat) return ambiguous('envelope-ilegivel')
    if (DUPLICATE.has(cStat)) return { kind: 'fact', fact: { status: 'duplicate', cStat: cStat as DuplicateCStat } }
    // serviço paralisado (108/109), consumo indevido (656) e erro interno (999) NÃO dizem que a NOTA foi rejeitada: o lote pode ter sido processado — nada se conclui, a tentativa fica em voo e a consulta esclarece (gate socrático M2)
    if (cStat === '108' || cStat === '109' || cStat === '656' || cStat === '999') return ambiguous('nao-classificada')
    if (cStat !== '103' && cStat !== '104' && cStat !== '105') return NOTE_REJECTION.test(cStat) ? rejection(cStat, text(ret, 'xMotivo')) : ambiguous('nao-classificada')
    if (text(ret, 'tpAmb') !== q.tpAmb) return ambiguous('nao-classificada')
    if (cStat === '105') return { kind: 'fact', fact: { status: 'processing', cStat: '105' } }
    if (cStat === '103') {
      const nRec = text(child(ret, 'infRec'), 'nRec')
      return nRec !== null && /^[0-9]{15}$/.test(nRec) ? { kind: 'fact', fact: { status: 'received', cStat: '103', nRec } } : ambiguous('nao-classificada')
    }
    return readProt(ret, q.chNFe, q.tpAmb)
  })
}

// ---------------------------------------------------------------------------------------------------------------------------------------

export type RegistryQuestion = { readonly UF: string } & ({ readonly CNPJ: string } | { readonly IE: string } | { readonly CPF: string })
export interface RegistryEntry { readonly IE: string | null; readonly CNPJ: string | null; readonly CPF: string | null; readonly UF: string | null; readonly cSit: string | null }
export interface RegistryFact { readonly cStat: '111' | '112'; readonly entries: readonly RegistryEntry[] }

/** Consulta cadastro (`retConsCad` 2.00 — RF-NFE-22): 111/112 com o eco da UF e do documento perguntado. */
export function readRegistry(q: RegistryQuestion, xml: string): ReadResult<RegistryFact> {
  return guarded<RegistryFact>(() => {
    const ret = retOf(xml, 'retConsCad')
    const inf = child(ret, 'infCons')
    if (!inf) return ambiguous('envelope-ilegivel')
    const cStat = text(inf, 'cStat')
    if (!cStat) return ambiguous('envelope-ilegivel')
    if (cStat !== '111' && cStat !== '112') return rejection(cStat, text(inf, 'xMotivo'))
    const [field, value] = 'CNPJ' in q ? ['CNPJ', q.CNPJ] : 'IE' in q ? ['IE', q.IE] : ['CPF', q.CPF]
    if (text(inf, 'UF') !== q.UF || text(inf, field) !== value) return ambiguous('nao-classificada')
    const entries = children(inf, 'infCad').map(c => ({
      IE: text(c, 'IE'), CNPJ: text(c, 'CNPJ'), CPF: text(c, 'CPF'), UF: text(c, 'UF'), cSit: text(c, 'cSit'),
    }))
    if (entries.length === 0) return ambiguous('nao-classificada')
    return { kind: 'fact', fact: { cStat, entries } }
  })
}

// ---------------------------------------------------------------------------------------------------------------------------------------

export interface VoidQuestion {
  readonly tpAmb: '1' | '2'; readonly cUF: string; readonly ano: string; readonly CNPJ: string; readonly mod: '55' | '65'
  readonly serie: number; readonly nNFIni: number; readonly nNFFin: number
}
/** `dhRecbto` (do fisco, com offset) e `xMotivo` entram no rastro da faixa (NFE.E6.P2): o preenchimento write-once da linha pendente. */
export interface VoidFact { readonly status: 'withdrawn'; readonly cStat: '102' | '563'; readonly nProt: string | null; readonly dhRecbto: string | null; readonly xMotivo: string | null }

/** Inutilização (`retInutNFe` — RF-NFE-23): 102 homologada; 563 = mesma faixa já pedida (prova, com o nProt se vier — D-NE40); 256/241 = rejeição (D-NE207). */
export function readVoid(q: VoidQuestion, xml: string): ReadResult<VoidFact> {
  return guarded<VoidFact>(() => {
    const ret = retOf(xml, 'retInutNFe')
    if (signed(ret)) return ambiguous('nao-classificada')                         // D-NE206 — F-NFE-8
    const inf = child(ret, 'infInut')
    if (!inf) return ambiguous('envelope-ilegivel')
    const cStat = text(inf, 'cStat')
    if (!cStat) return ambiguous('envelope-ilegivel')
    if (REFUSED.has(cStat)) return refusedOr(cStat, text(inf, 'xMotivo'))
    // D-NE210: TODAS as partes do eco presentes e iguais — ANTES de decidir qualquer cStat (a rejeição também precisa ser da NOSSA faixa)
    const echoOk = text(inf, 'tpAmb') === q.tpAmb && sameNumber(text(inf, 'cUF'), q.cUF) && sameNumber(text(inf, 'ano'), q.ano)
      && text(inf, 'CNPJ') === q.CNPJ && text(inf, 'mod') === q.mod && sameNumber(text(inf, 'serie'), q.serie)
      && sameNumber(text(inf, 'nNFIni'), q.nNFIni) && sameNumber(text(inf, 'nNFFin'), q.nNFFin)
    if (!echoOk) return ambiguous('nao-classificada')
    if (cStat !== '102' && cStat !== '563') return rejection(cStat, text(inf, 'xMotivo'))
    const nProt = text(inf, 'nProt')
    if (cStat === '102' && !nProt) return ambiguous('envelope-ilegivel')
    if (nProt !== null && !NPROT_FORM.test(nProt)) return ambiguous('nao-classificada')
    const dhRecbto = text(inf, 'dhRecbto')
    if (dhRecbto !== null && (!DH_FORM.test(dhRecbto) || Number.isNaN(Date.parse(dhRecbto)) || toUtcDb(dhRecbto) === null)) return ambiguous('nao-classificada')
    return { kind: 'fact', fact: { status: 'withdrawn', cStat, nProt, dhRecbto, xMotivo: text(inf, 'xMotivo') } }
  })
}

// ---------------------------------------------------------------------------------------------------------------------------------------

export interface CancelQuestion { readonly chNFe: string; readonly tpAmb: '1' | '2'; readonly nSeqEvento: 1 }
/** `dhRegEvento` (do fisco, com offset) e `xMotivo` entram no rastro (voz C — NFE.E6.P2, Q1); o `nProt` vive no `-evt110111-1.xml` guardado. */
export interface CancelFact { readonly status: 'cancelled'; readonly cStat: '135' | '155'; readonly nProt: string; readonly dhRegEvento: string; readonly xMotivo: string | null }

/** Evento 110111 (`retEnvEvento` — RF-NFE-24): decide o `retEvento`, nunca o 128 do lote; 135/155 cancelam; 136/573/580 ambíguos (D-NE208). */
export function readCancelEvent(q: CancelQuestion, xml: string): ReadResult<CancelFact> {
  return guarded<CancelFact>(() => {
    const ret = retOf(xml, 'retEnvEvento')
    const evs = children(ret, 'retEvento')
    if (evs.length === 0) {
      const lote = text(ret, 'cStat')
      return lote === '128' || !lote ? ambiguous('evento-sem-retorno') : refusedOr(lote, text(ret, 'xMotivo'))
    }
    if (evs.length !== 1) return ambiguous('nao-classificada')                    // D-NE39: 1 evento por lote
    const ev = evs[0]
    if (signed(ev)) return ambiguous('nao-classificada')                          // D-NE206 — F-NFE-8
    const inf = child(ev, 'infEvento')
    if (!inf) return ambiguous('envelope-ilegivel')
    const cStat = text(inf, 'cStat')
    if (!cStat) return ambiguous('envelope-ilegivel')
    if (cStat === '136' || cStat === '573' || cStat === '580') return ambiguous('evento-nao-conferido')
    if (REFUSED.has(cStat)) return refusedOr(cStat, text(inf, 'xMotivo'))
    // D-NE210: o eco (chave, tipo, sequência e ambiente) ANTES de decidir qualquer cStat — a rejeição também precisa ser do NOSSO evento
    const echoOk = text(inf, 'chNFe') === q.chNFe && text(inf, 'tpEvento') === '110111'
      && sameNumber(text(inf, 'nSeqEvento'), q.nSeqEvento) && text(inf, 'tpAmb') === q.tpAmb
    if (!echoOk) return ambiguous('nao-classificada')                             // D-NE42, D-NE210
    if (cStat !== '135' && cStat !== '155') return rejection(cStat, text(inf, 'xMotivo'))
    const nProt = text(inf, 'nProt')
    if (!nProt || !NPROT_FORM.test(nProt)) return ambiguous('envelope-ilegivel')
    const dhRegEvento = text(inf, 'dhRegEvento')
    if (!dhRegEvento || !DH_FORM.test(dhRegEvento) || Number.isNaN(Date.parse(dhRegEvento)) || toUtcDb(dhRegEvento) === null) return ambiguous('nao-classificada')
    return { kind: 'fact', fact: { status: 'cancelled', cStat, nProt, dhRegEvento, xMotivo: text(inf, 'xMotivo') } }
  })
}
