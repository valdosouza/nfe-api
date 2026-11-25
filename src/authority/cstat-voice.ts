import { toUtcDb } from 'fiscal-api'
import type { CancelFact, DuplicateCStat, ReadResult, SendFact, VoidFact } from './responses'

/**
 * O que o cStat DIZ À NOSSA TENTATIVA (NFE.E6.P1 — D-NE33, D-NE34, D-NE35, D-NE36, D-NE108; ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §4 e §6-3;
 * RF-NFE-21 e RF-NFE-74/75). PURA: recebe o que o leitor entendeu da resposta (já conferida contra a pergunta) e devolve a AÇÃO — nunca
 * grava, nunca consulta.
 *
 * - `voice`: a voz do fisco a gravar (A autorizada, D denegada, R rejeitada, P em processamento), com o protocolo e o `digVal` quando há;
 * - `consult-key` (204/539 — D-NE36; 205/206/218/635 também: o número já é de uma nota): nenhuma conclusão, a saída é a consulta da chave; o 103/105 grava P e leva o `nRec`
 *   (D-NE33), e quem chama consulta o recibo;
 * - `none`: o 106 (D-NE108), o 217 (a consulta nunca prova "não registrada" — D-NE235) e a consulta que diz cancelada (a voz C é da P2): nenhuma voz;
 * - `ambiguous`: não dá para afirmar nada (D-NE34) — nada se grava, a tentativa segue em voo.
 * Cada `kind` é uma constante no próprio literal (cerca `voice-kind-fence`). O cStat da rejeição vai inteiro (3 a 4 dígitos) e a mensagem é o
 * `xMotivo` até 255 caracteres, cortado por inteiro e nunca em pedaço (o `xMotivo` do 539 NÃO é recortado para achar a chave — D-NE36).
 */

/** As vozes que a RESPOSTA do fisco (ou a falha conclusiva do envio) grava; C, K e N são do cancelamento (P2). Todas estão na lista de escrita da família. */
export type SendVoiceKind = 'A' | 'D' | 'R' | 'P' | 'F'

export interface VoiceEvent {
  readonly kind: SendVoiceKind
  /** O cStat (3 a 4 dígitos) em A/R/D/P; nulo no F (falha conclusiva sem cStat do fisco). */
  readonly authorityCode: string | null
  readonly message: string
  /** O `dhRecbto` do fisco em UTC (`toUtcDb`), ou nulo. */
  readonly dh: string | null
  readonly source: 'P' | 'Q'
}

export type VoiceDecision =
  | { readonly action: 'voice'; readonly event: VoiceEvent; readonly nProt: string | null; readonly digVal: string | null; readonly dhRecbto: string | null; readonly nRec: string | null }
  | { readonly action: 'consult-key'; readonly reason: DuplicateCStat }
  | { readonly action: 'none'; readonly reason: '106' | '217' | 'cancelled' | 'consulta-recusada' }
  | { readonly action: 'ambiguous'; readonly reason: string }

const MAX_MESSAGE = 255
const clip = (text: string | null | undefined, fallback: string): string => {
  const t = (text ?? '').trim() || fallback
  if (t.length <= MAX_MESSAGE) return t
  const cut = t.slice(0, MAX_MESSAGE)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut                     // nunca no meio de um par substituto
}
const dhOf = (dhRecbto: string | null): string | null => (dhRecbto ? toUtcDb(dhRecbto) : null)

/** `source`: P = a resposta do POST de envio; Q = a resposta de uma consulta (chave ou recibo). */
export function voiceOfCStat(result: ReadResult<SendFact>, source: 'P' | 'Q'): VoiceDecision {
  if (result.kind === 'ambiguous') return { action: 'ambiguous', reason: result.cause }
  if (result.kind === 'no-voice') return { action: 'none', reason: '106' }
  if (result.kind === 'rejection') {
    // a CONSULTA recusada (656, 108/109, 999…) recusa a pergunta, não a nota: só o `protNFe` da nossa chave fecha com R (gate socrático H1 — senão o número de uma nota possivelmente autorizada seria reaproveitado)
    if (source === 'Q' && !result.note) return { action: 'none', reason: 'consulta-recusada' }
    // R só com cStat legível de rejeição (D-NE34): a forma do cStat é conferida, senão é ambíguo
    if (!/^[0-9]{3,4}$/.test(result.cStat)) return { action: 'ambiguous', reason: 'cstat-ilegivel' }
    return { action: 'voice', event: { kind: 'R', authorityCode: result.cStat, message: clip(result.xMotivo, 'Rejeitada pelo fisco'), dh: null, source }, nProt: null, digVal: null, dhRecbto: null, nRec: null }
  }
  const f = result.fact
  switch (f.status) {
    case 'authorized':
      return {
        action: 'voice', nProt: f.nProt, digVal: f.digVal, dhRecbto: f.dhRecbto, nRec: null,
        event: { kind: 'A', authorityCode: f.cStat, message: f.cStat === '150' ? 'Autorizada fora de prazo' : 'Autorizado o uso da NF-e', dh: dhOf(f.dhRecbto), source },
      }
    case 'denied':
      return {
        action: 'voice', nProt: f.nProt, digVal: f.digVal, dhRecbto: f.dhRecbto, nRec: null,
        event: { kind: 'D', authorityCode: f.cStat, message: 'Uso denegado', dh: dhOf(f.dhRecbto), source },
      }
    case 'received':
      return { action: 'voice', nProt: null, digVal: null, dhRecbto: null, nRec: f.nRec, event: { kind: 'P', authorityCode: f.cStat, message: 'Lote recebido, aguardando processamento', dh: null, source } }
    case 'processing':
      return { action: 'voice', nProt: null, digVal: null, dhRecbto: null, nRec: null, event: { kind: 'P', authorityCode: f.cStat, message: 'Lote em processamento', dh: null, source } }
    case 'duplicate':
      return { action: 'consult-key', reason: f.cStat }
    case 'not-found':
      return { action: 'none', reason: '217' }
    case 'cancelled':
      return { action: 'none', reason: 'cancelled' }
  }
}

/** A conferência do `digVal` do `protNFe` com o `DigestValue` da tentativa (D-NE41): Base64 exato (o hash distingue caixa). */
export function checkDigest(expected: string, digVal: string | null): 'ok' | 'absent' | 'mismatch' {
  if (digVal === null) return 'absent'
  return digVal === expected ? 'ok' : 'mismatch'
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// NFE.E6.P2 — o que a resposta do evento e da inutilização diz (D-NE208, D-NE40, D-NE207, D-NE210; RF-NFE-18/23/24/74). PURAS: a AÇÃO, nunca a gravação.
// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * O cancelamento (110111): 135 e 155 provam (voz C com o `xMotivo`, o `dhRegEvento` em UTC e o `tpEvento` em `authority_code`); a rejeição do EVENTO (501, 222…) libera a
 * reserva (voz N); o que o serviço RECUSOU (656, 108/109, 999), o 136/573/580 e a resposta sem eco são ambíguos e MANTÊM a reserva K — a saída é consultar a chave.
 * `breaker`: o cStat recusado, para o disjuntor do 656.
 */
export type CancelDecision =
  | { readonly action: 'cancelled'; readonly authorityCode: '110111'; readonly cStat: '135' | '155'; readonly message: string; readonly dh: string; readonly nProt: string }
  | { readonly action: 'release'; readonly cStat: string; readonly message: string }
  | { readonly action: 'keep'; readonly reason: string; readonly breaker: string | null }

export function voiceOfCancel(result: ReadResult<CancelFact>): CancelDecision {
  if (result.kind === 'fact') {
    const f = result.fact
    const dh = toUtcDb(f.dhRegEvento)
    if (dh === null) return { action: 'keep', reason: 'dhRegEvento-ilegivel', breaker: null }
    return { action: 'cancelled', authorityCode: '110111', cStat: f.cStat, message: clip(`Cancelada no fisco: ${f.xMotivo ?? ''} — protocolo ${f.nProt}`, 'Cancelada no fisco'), dh, nProt: f.nProt }
  }
  if (result.kind === 'rejection') {
    if (result.refused) return { action: 'keep', reason: 'servico-recusou', breaker: result.cStat }
    return { action: 'release', cStat: result.cStat, message: clip(result.xMotivo, `Pedido de cancelamento rejeitado (${result.cStat})`) }
  }
  if (result.kind === 'ambiguous') return { action: 'keep', reason: result.cause, breaker: null }
  return { action: 'keep', reason: 'sem-voz', breaker: null }
}

/**
 * A inutilização: 102 e 563 retiram a faixa (D-NE40; o 563 com o nProt do pedido anterior é a prova); 256/241 e as demais são REJEIÇÃO (D-NE207: história, nunca retira); o
 * que o serviço recusou (656…) e a resposta sem eco ficam PENDENTES — o reenvio da MESMA faixa reconcilia (S6). `breaker`: o cStat recusado, para o disjuntor.
 */
export type VoidDecision =
  | { readonly action: 'withdrawn'; readonly cStat: '102' | '563'; readonly nProt: string | null; readonly dhRecbto: string | null; readonly message: string }
  | { readonly action: 'rejected'; readonly cStat: string; readonly message: string }
  | { readonly action: 'pending'; readonly reason: string; readonly breaker: string | null }

export function voiceOfVoid(result: ReadResult<VoidFact>): VoidDecision {
  if (result.kind === 'fact') {
    const f = result.fact
    const dh = f.dhRecbto === null ? null : toUtcDb(f.dhRecbto)
    return { action: 'withdrawn', cStat: f.cStat, nProt: f.nProt, dhRecbto: dh, message: clip(f.xMotivo, f.cStat === '102' ? 'Inutilização de número homologada' : 'Faixa já inutilizada') }
  }
  if (result.kind === 'rejection') {
    if (result.refused) return { action: 'pending', reason: 'servico-recusou', breaker: result.cStat }
    return { action: 'rejected', cStat: result.cStat, message: clip(result.xMotivo, `Inutilização rejeitada (${result.cStat})`) }
  }
  if (result.kind === 'ambiguous') return { action: 'pending', reason: result.cause, breaker: null }
  return { action: 'pending', reason: 'sem-voz', breaker: null }
}
