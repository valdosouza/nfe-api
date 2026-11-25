import { ErrorCodes, HttpError, notRegisteredProven, recordVoiceOnce, toUtcDb, withInvoiceTx, type InvoiceRef, type InvoiceTx } from 'fiscal-api'
import { endpointOf, soapBindingOf, type Environment } from '../authority/authorizers'
import { checkDigest, voiceOfCStat, type VoiceDecision, type VoiceEvent } from '../authority/cstat-voice'
import { consReciNFe, consSitNFe } from '../authority/messages'
import { readProtocol, readReceipt, type ProtocolFact, type ReadResult } from '../authority/responses'
import { callSoap, type SoapOutcome } from '../authority/soap'
import { barrierOf, provenNotRegistered, fillAuthorityData, fillReceipt, getAttempt, attemptsOfLife, latestAttempt, touchQueriedAt, type AttemptRow } from './attempt'
import { isFileConflict, merchandiseFileKey } from './fiscal-file'
import { recordNfeNotRegistered } from './not-registered'
import { digestValueOf, procNfeXml } from './proc-nfe'
import { MERCHANDISE_VOICE_FAMILY } from './voice-family'
import type { NfeActor, NfeDeps } from './transmission'

/**
 * A RECONCILIAÇÃO da NF-e (NFE.E6.P1 — T2; D-NE33, D-NE35, D-NE36, D-NE41, D-NE108, D-NE111, D-NE235, D-NE254; ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-8).
 * Pergunta ao fisco, pela NOSSA chave ou pelo recibo, o que aconteceu com a tentativa e grava o que ele AFIRMA — nunca mais:
 *  - consulta pela chave (`consSitNFe`) ou pelo recibo (`consReciNFe`, só depois de 15 s — RF-NFE-17); cota por `last_queried_at` (um só carimbo: dá o INTERVALO mínimo —
 *    6 min por chave, 90 s por recibo —, não contagem; as 30 rejeições iguais da D-NE254 são da autorização);
 *  - o `digVal` do `protNFe` contra o `digest_value` da tentativa (D-NE41): divergência = pendência crítica, NADA se grava (o XML guardado não serve como nfeProc) — nunca
 *    sobrescreve; ausência = pendência crítica, mas o A que o fisco afirma pela NOSSA chave é gravado;
 *  - A numa tentativa FECHADA (R/F) = a D-NE7 violada = incidente crítico: nada se grava (D-NE36); 204/539 só mandam consultar as chaves de TODAS as tentativas (`all`);
 *  - o 217 NUNCA vira voz nem fato pelo refresh (D-NE235): só `reconfirmNotRegistered` grava `nfe_not_registered_at`, e só quando a peça `notRegisteredProven` do núcleo prova
 *    (RF-NFE-72); gravado o fato, a nota pode ser transmitida de novo por ato do usuário, com o mesmo número (D-NE292);
 *  - A/D numa tentativa FECHADA (R/F) ou com o fato gravado é incidente (`authorized-in-closed-attempt`); o `-procNFe.xml` em conflito de gravação única é `file-conflict`;
 *  - 101/151 (cancelada) não são ignorados: voltam como `cancelled` (a voz C é da P2).
 * Tudo sob a trava da nota na hora de gravar, relendo a tentativa: a voz que a pergunta viu é a que ainda vale, senão nada se grava. O fisco é chamado FORA de transação.
 */

export const MIN_KEY_INTERVAL_MS = 6 * 60_000          // D-NE254: 10 consultas/h da mesma chave
export const MIN_RECEIPT_INTERVAL_MS = 90_000          // D-NE254: 40 consultas/h do mesmo recibo
export const MIN_RECEIPT_WAIT_MS = 15_000              // RF-NFE-17: ≥ 15 s antes de consultar o recibo
/**
 * Idade mínima de uma tentativa SEM voz antes de o `reconfirm` aceitar o 217 (gate adversarial M2: com o envio ainda no ar, o 217 é verdadeiro e a resposta do envio pode ser A).
 * D-NE291 (Valdo, 2026-11-25): 10 minutos — folga sobre o timeout do envio (60 s) e sobre a janela de gravação.
 */
export const MIN_ATTEMPT_AGE_BEFORE_217_MS = 10 * 60_000

type Opened = { readonly cert: Buffer; readonly key: Buffer }
export type ReconcileDeps = Pick<NfeDeps, 'pool' | 'storage' | 'now' | 'openIssuer' | 'zoneOf' | 'ca' | 'request'>

export interface RefreshResult {
  readonly invoiceId: number
  readonly attempt: number
  readonly accessKey: string
  readonly via: 'key' | 'receipt'
  readonly outcome: { readonly kind: 'A' | 'D' | 'R' | 'P' | 'F'; readonly authorityCode: string | null; readonly message: string }
    | { readonly kind: 'cancelled'; readonly authorityCode: string }
    | { readonly kind: 'none'; readonly reason: string }
  /** A conferência do `digVal` do `protNFe` com o `digest_value` da tentativa: `null` quando a resposta não traz protNFe. */
  readonly digestCheck: 'ok' | 'absent' | 'mismatch' | null
  /** O que pede a mão de alguém (pendência crítica / incidente) — nunca é gravado como voz. */
  readonly incident: 'digest-mismatch' | 'digest-absent' | 'authorized-in-closed-attempt' | 'file-conflict' | null
  /** O fisco respondeu 217 com a nossa chave (a consulta NUNCA o grava — só a `reconfirm`). */
  readonly notRegistered: boolean
  readonly next: 'consult-key' | 'consult-receipt' | null
}

const ms = (dbUtc: string | null): number | null => {
  const t = dbUtc ? Date.parse(`${dbUtc.replace(' ', 'T')}Z`) : NaN
  return Number.isNaN(t) ? null : t                                                            // ilegível = null (a idade ilegível é recusa, nunca passa)
}
const tpAmbOf = (e: Environment): '1' | '2' => (e === 'H' ? '2' : '1')
const tooSoon = (what: string, waitMs: number): HttpError =>
  new HttpError(429, `${what} — aguarde ${Math.ceil(waitMs / 1000)} s antes de consultar de novo o fisco`, undefined, ErrorCodes.RESOURCE_BUSY)

/** A saída em aberto de uma tentativa: viva sem recibo → pela chave; P com recibo → pelo recibo. Fechada (A, D, R, F, C): nada a perguntar. */
function viaOf(a: AttemptRow): 'key' | 'receipt' | null {
  if (a.protocol !== null) return null                                          // registrada: autorizada, denegada ou cancelada
  if (a.lastKind === 'R' || a.lastKind === 'F') return 'key'                    // fechada sem registro: só para detectar um A tardio (incidente)
  if (a.receipt !== null && a.lastKind === 'P') return 'receipt'
  return 'key'
}

interface Consulted { readonly row: AttemptRow; readonly via: 'key' | 'receipt'; readonly result: ReadResult<ProtocolFact>; readonly outcome: SoapOutcome | null }

/** Pergunta ao fisco sobre UMA tentativa (fora de transação). Resposta que não é legível/answered vira ambígua — nada grava. */
async function ask(deps: ReconcileDeps, row: AttemptRow, via: 'key' | 'receipt', opened: Opened): Promise<Consulted> {
  const environment = row.environment as Environment
  const service = via === 'key' ? 'NfeConsultaProtocolo' : 'NFeRetAutorizacao'
  const binding = soapBindingOf(row.authorizer as never, environment, service)
  const endpoint = endpointOf(row.authorizer as never, environment, service)
  if (!binding || !endpoint.ok) throw new HttpError(503, 'O serviço de consulta deste ambiente não está registrado nesta API — nada foi perguntado ao fisco', undefined, ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE)
  const body = via === 'key' ? consSitNFe(row.accessKey, tpAmbOf(environment)) : consReciNFe(row.receipt as string, tpAmbOf(environment))
  const outcome = await callSoap({
    url: endpoint.url, service, action: binding.action, namespace: binding.namespace, resultElement: via === 'key' ? 'retConsSitNFe' : 'retConsReciNFe',
    body, message: via === 'key' ? 'consSitNFe' : 'consReciNFe', cert: opened.cert, key: opened.key, ca: deps.ca(),
  }, deps.request)
  if (outcome.kind !== 'answered' && outcome.kind !== 'rejected') return { row, via, outcome, result: { kind: 'ambiguous', cause: outcome.kind === 'ambiguous' ? outcome.cause : 'nao-classificada' } }
  const result = via === 'key'
    ? readProtocol({ chNFe: row.accessKey, tpAmb: tpAmbOf(environment) }, outcome.xml)
    : readReceipt({ nRec: row.receipt as string, chNFe: row.accessKey, tpAmb: tpAmbOf(environment) }, outcome.xml)
  return { row, via, outcome, result }
}

/** Escreve a voz, UMA chamada por `kind` com o literal e sem spread (cerca `voice-kind-fence`) — a mesma forma de `transmission.ts`. */
async function writeVoice(itx: InvoiceTx, attempt: number, userId: number | null, e: VoiceEvent): Promise<void> {
  const insertTransmissionEvent = MERCHANDISE_VOICE_FAMILY.insertTransmissionEvent
  const hasTransmissionEvent = MERCHANDISE_VOICE_FAMILY.hasTransmissionEvent
  switch (e.kind) {
    case 'A': await recordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, attempt, userId, { kind: 'A', source: e.source, authorityCode: e.authorityCode, message: e.message, dh: e.dh }); return
    case 'D': await recordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, attempt, userId, { kind: 'D', source: e.source, authorityCode: e.authorityCode, message: e.message, dh: e.dh }); return
    case 'R': await recordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, attempt, userId, { kind: 'R', source: e.source, authorityCode: e.authorityCode, message: e.message, dh: e.dh }); return
    case 'P': await recordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, attempt, userId, { kind: 'P', source: e.source, authorityCode: e.authorityCode, message: e.message, dh: e.dh }); return
    case 'F': await recordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, attempt, userId, { kind: 'F', source: e.source, authorityCode: e.authorityCode, message: e.message, dh: e.dh }); return
  }
}

function digestCheckOf(row: AttemptRow, decision: Extract<VoiceDecision, { action: 'voice' }>): RefreshResult['digestCheck'] {
  if (decision.event.kind !== 'A' && decision.event.kind !== 'D') return null
  return checkDigest(row.digestValue, decision.digVal)                       // Base64 exato: o hash distingue caixa
}

/**
 * Aplica o que o fisco afirmou, sob a trava da nota e relendo a tentativa: a voz que a pergunta viu (`seenEvent`) tem de ser a ÚLTIMA ainda, senão nada se grava
 * (outra rota gravou antes). Devolve o resultado e o `procNFe` a guardar (fora da transação).
 */
async function apply(deps: ReconcileDeps, actor: NfeActor, ref: InvoiceRef, c: Consulted): Promise<RefreshResult & { readonly proc: string | null }> {
  const base = { invoiceId: ref.invoiceId, attempt: c.row.attempt, accessKey: c.row.accessKey, via: c.via }
  const done = (outcome: RefreshResult['outcome'], extra: Partial<RefreshResult> = {}, proc: string | null = null): RefreshResult & { proc: string | null } =>
    ({ ...base, outcome, digestCheck: null, incident: null, notRegistered: false, next: null, ...extra, proc })
  const decision = voiceOfCStat(c.result, 'Q')
  if (decision.action === 'ambiguous') return done({ kind: 'none', reason: decision.reason })
  if (decision.action === 'consult-key') return done({ kind: 'none', reason: decision.reason }, { next: 'consult-key' })
  if (decision.action === 'none') {
    if (decision.reason === '217') return done({ kind: 'none', reason: '217' }, { notRegistered: true })
    if (decision.reason === 'cancelled') return done({ kind: 'cancelled', authorityCode: c.result.kind === 'fact' && 'cStat' in c.result.fact ? String(c.result.fact.cStat) : '101' })
    return done({ kind: 'none', reason: decision.reason })
  }
  const check = digestCheckOf(c.row, decision)
  const voice = decision.event
  if (check === 'mismatch') return done({ kind: 'none', reason: 'digest-divergente' }, { digestCheck: 'mismatch', incident: 'digest-mismatch' })
  if (voice.kind === 'D' && !decision.nProt) return done({ kind: 'none', reason: 'denegada-sem-protocolo' }, { next: 'consult-key' })
  const applied = await withInvoiceTx(deps.pool, actor, ref, { label: 'reconciliação da NF-e pelo fisco' }, async itx => {
    const current = await getAttempt(itx.conn, ref, c.row.attempt)
    if (!current || current.lastEvent !== c.row.lastEvent) return 'changed' as const                  // outra rota gravou depois da pergunta: nada se grava
    // R/F e a tentativa com o 217 PROVADO (o fato gravado) estão fechadas: o A/D que o fisco devolve para elas é incidente — a prova do 217 estava errada, nada se grava
    if ((voice.kind === 'A' || voice.kind === 'D') && (((current.lastKind === 'R' || current.lastKind === 'F') && current.protocol === null) || provenNotRegistered(current))) return 'closed' as const
    if (decision.nProt) await fillAuthorityData(itx, c.row.attempt, { protocol: decision.nProt, dhRecbtoUtc: decision.dhRecbto ? toUtcDb(decision.dhRecbto) : null })
    if (decision.nRec) await fillReceipt(itx, c.row.attempt, decision.nRec)
    await writeVoice(itx, c.row.attempt, actor.userId, voice)
    return 'written' as const
  })
  if (applied === 'changed') return done({ kind: 'none', reason: 'voz-mudou-depois-da-pergunta' })
  if (applied === 'closed') return done({ kind: 'none', reason: 'autorizada-em-tentativa-fechada' }, { digestCheck: check, incident: 'authorized-in-closed-attempt' })
  const proc = (voice.kind === 'A' || voice.kind === 'D') && c.outcome && (c.outcome.kind === 'answered' || c.outcome.kind === 'rejected')
    ? await buildProc(deps, actor, c) : null
  return done({ kind: voice.kind, authorityCode: voice.authorityCode, message: voice.message },
    { digestCheck: check, incident: check === 'absent' ? 'digest-absent' : null, next: voice.kind === 'P' ? 'consult-receipt' : null }, proc)
}

/** O `-procNFe.xml` a partir do `-nfe.xml` guardado e do `protNFe` da resposta (D-NE35); `null` se algo faltar — falhar ao gravar só avisa. */
async function buildProc(deps: ReconcileDeps, actor: NfeActor, c: Consulted): Promise<string | null> {
  if (!c.outcome || (c.outcome.kind !== 'answered' && c.outcome.kind !== 'rejected')) return null
  const zone = await deps.zoneOf(deps.pool as never, actor)
  const key = merchandiseFileKey({ cnpj: c.row.accessKey.slice(6, 20), model: '55', serie: c.row.serie, environment: c.row.environment, zone })
  const name = `${c.row.accessKey}-nfe.xml`
  const found = deps.storage.find({ ...key }, name, [c.row.dhEmission])
  if (found === null) return null
  const stored = deps.storage.read(found)
  if (digestValueOf(stored) !== c.row.digestValue) return null               // o XML guardado não é mais o que assinamos: nenhum procNFe sobre ele (D-NE41)
  return procNfeXml(stored, c.outcome.xml, c.row.accessKey)
}

export interface RefreshOptions {
  /** Consulta as chaves de TODAS as tentativas da nota (o 539 — D-NE36), da mais nova à mais antiga, parando na primeira que o fisco registrou. */
  readonly all?: boolean
}

/** Pergunta ao fisco sobre a(s) tentativa(s) da nota, grava o que ele afirma e devolve o resultado. A cota por `last_queried_at` vale por tentativa. */
export async function refreshInvoice(deps: ReconcileDeps, actor: NfeActor, ref: InvoiceRef, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const now = deps.now().getTime()
  // a pergunta: sob a trava, escolhe a(s) tentativa(s), confere a cota e carimba
  const chosen = await withInvoiceTx(deps.pool, actor, ref, { label: 'consulta da NF-e ao fisco' }, async itx => {
    const life = itx.locked.lifeEvent
    if (life === null) throw new HttpError(409, 'A nota ainda não tem vida fiscal — nada a consultar', undefined, ErrorCodes.FISCAL_NOT_TRANSMITTED)
    const all = opts.all ? await attemptsOfLife(itx.conn, ref, life) : []
    const latest = await latestAttempt(itx.conn, ref, life)
    if (!latest) throw new HttpError(409, 'A nota não tem tentativa de transmissão — nada a consultar', undefined, ErrorCodes.FISCAL_NOT_TRANSMITTED)
    const rows = opts.all ? [...all].reverse() : [latest]
    const picked: { row: AttemptRow; via: 'key' | 'receipt' }[] = []
    for (const row of rows) {
      const via = viaOf(row)
      if (via === null) continue
      const last = ms(row.lastQueriedAt)
      const minInterval = via === 'receipt' ? MIN_RECEIPT_INTERVAL_MS : MIN_KEY_INTERVAL_MS
      if (last !== null && now - last < minInterval) { if (!opts.all) throw tooSoon(via === 'receipt' ? 'Recibo consultado há pouco' : 'Chave consultada há pouco', minInterval - (now - last)); continue }
      if (via === 'receipt') {
        const since = ms(row.lastEventAt)
        if (since !== null && now - since < MIN_RECEIPT_WAIT_MS) { if (!opts.all) throw tooSoon('Lote recebido há pouco', MIN_RECEIPT_WAIT_MS - (now - since)); continue }
      }
      await touchQueriedAt(itx.conn, ref, row.attempt)
      picked.push({ row, via })
    }
    if (!picked.length && !opts.all) {
      const barrier = barrierOf(latest)
      return { picked, closedReason: barrier ? barrier.message : 'tentativa já fechada', opened: null as Opened | null }
    }
    return { picked, closedReason: null as string | null, opened: picked.length ? await deps.openIssuer(itx.conn, actor) : null }
  })
  if (!chosen.picked.length) {
    const row = (await withInvoiceTx(deps.pool, actor, ref, { label: 'leitura da tentativa' }, async itx => latestAttempt(itx.conn, ref, itx.locked.lifeEvent as number)))
    if (!row) throw new HttpError(409, 'A nota não tem tentativa de transmissão — nada a consultar', undefined, ErrorCodes.FISCAL_NOT_TRANSMITTED)
    return { invoiceId: ref.invoiceId, attempt: row.attempt, accessKey: row.accessKey, via: 'key', outcome: { kind: 'none', reason: chosen.closedReason ?? 'nada-a-consultar' }, digestCheck: null, incident: null, notRegistered: false, next: null }
  }
  let last: RefreshResult | null = null
  for (const p of chosen.picked) {
    const consulted = await ask(deps, p.row, p.via, chosen.opened as Opened)                 // o fisco, FORA de transação
    const applied = await apply(deps, actor, ref, consulted)
    const { proc, ...result } = applied
    let fileConflict = false
    if (proc) {
      try {
        const zone = await deps.zoneOf(deps.pool as never, actor)
        const key = merchandiseFileKey({ cnpj: p.row.accessKey.slice(6, 20), model: '55', serie: p.row.serie, environment: p.row.environment, zone })
        deps.storage.save(key, `${p.row.accessKey}-procNFe.xml`, proc, deps.now())         // gravação única do núcleo 5.2.0: bytes iguais = ok, outros = conflito
      } catch (e) { fileConflict = isFileConflict(e) }                                     // conflito = incidente; outra falha só avisa
    }
    last = fileConflict ? { ...result, incident: 'file-conflict' } : result
    if (result.outcome.kind === 'A' || result.outcome.kind === 'D' || (last as RefreshResult).incident !== null) break
  }
  return last as RefreshResult
}

export interface ReconfirmResult {
  readonly invoiceId: number
  readonly attempt: number
  readonly accessKey: string
  /** `true` se o fato `nfe_not_registered_at` foi gravado agora. */
  readonly recorded: boolean
  readonly reason: 'registrada-agora' | 'ja-registrada' | 'nao-e-217' | 'recibo-em-aberto' | 'voz-mudou-depois-da-pergunta' | 'tentativa-fechada' | 'peca-recusou'
  /** Com `peca-recusou`: a razão que a peça `notRegisteredProven` do núcleo devolveu (falha fechado: nada se grava). */
  readonly detail?: string
  /** O que a consulta disse quando NÃO foi o 217 (a mesma resposta do refresh). */
  readonly refresh: RefreshResult | null
}

/**
 * A ROTA PRÓPRIA do 217 (D-NE111, D-NE235): só com o 217 e a `chNFe` igual (o leitor já exige o eco), sem recibo 103/105 em aberto, no autorizador gravado na tentativa e se a
 * última voz ainda é a que a pergunta viu — tudo decidido pela peça `notRegisteredProven` do núcleo (RF-NFE-72), depois da idade mínima da D-NE291 —, grava o FATO
 * `nfe_not_registered_at` (nunca voz). A tentativa continua sem voz (e viva para o núcleo); a nova tentativa sai por ato do usuário, com o mesmo número (D-NE292). Qualquer outra resposta do fisco é tratada como o `refresh` trata (pousa A, D…), sem gravar o fato.
 */
/** A razão da peça → o motivo que a rota devolve; o que não está aqui (falha fechado) vira `peca-recusou` com a razão em `detail`. */
const REFUSAL: Partial<Record<string, ReconfirmResult['reason']>> = {
  'voz-mudou': 'voz-mudou-depois-da-pergunta', 'recibo-em-aberto': 'recibo-em-aberto', 'voz-de-registro': 'tentativa-fechada',
  'rota-nao-reconfirm': 'nao-e-217', 'cstat-nao-217': 'nao-e-217', 'chave-diferente': 'nao-e-217', 'autorizador-diferente': 'nao-e-217', 'entrada-invalida': 'nao-e-217',
}

export async function reconfirmNotRegistered(deps: ReconcileDeps, actor: NfeActor, ref: InvoiceRef): Promise<ReconfirmResult> {
  const now = deps.now().getTime()
  const picked = await withInvoiceTx(deps.pool, actor, ref, { label: 'reconfirmação do 217' }, async itx => {
    const life = itx.locked.lifeEvent
    const row = life === null ? null : await latestAttempt(itx.conn, ref, life)
    if (!row) throw new HttpError(409, 'A nota não tem tentativa de transmissão — nada a reconfirmar', undefined, ErrorCodes.FISCAL_NOT_TRANSMITTED)
    if (row.protocol !== null || row.lastKind === 'R' || row.lastKind === 'F') return { row, early: 'tentativa-fechada' as const, opened: null as Opened | null }
    if (row.nfeNotRegisteredAt !== null) return { row, early: 'ja-registrada' as const, opened: null as Opened | null }
    if (row.receipt !== null || row.lastKind === 'P') return { row, early: 'recibo-em-aberto' as const, opened: null as Opened | null }
    const born = ms(row.createdAt)
    if (row.lastKind === null && born === null) throw tooSoon('A idade da tentativa não pôde ser lida — sem ela o 217 não é aceito (falha fechado)', MIN_ATTEMPT_AGE_BEFORE_217_MS)
    if (row.lastKind === null && born !== null && now - born < MIN_ATTEMPT_AGE_BEFORE_217_MS) throw tooSoon('Tentativa criada há pouco (o envio pode estar no ar)', MIN_ATTEMPT_AGE_BEFORE_217_MS - (now - born))
    const last = ms(row.lastQueriedAt)
    if (last !== null && now - last < MIN_KEY_INTERVAL_MS) throw tooSoon('Chave consultada há pouco', MIN_KEY_INTERVAL_MS - (now - last))
    await touchQueriedAt(itx.conn, ref, row.attempt)
    return { row, early: null, opened: await deps.openIssuer(itx.conn, actor) as Opened | null }
  })
  const row = picked.row
  const base = { invoiceId: ref.invoiceId, attempt: row.attempt, accessKey: row.accessKey }
  if (picked.early) return { ...base, recorded: false, reason: picked.early, refresh: null }
  const consulted = await ask(deps, row, 'key', picked.opened as Opened)                    // o fisco, FORA de transação
  if (consulted.result.kind !== 'fact' || consulted.result.fact.status !== 'not-found') {
    const applied = await apply(deps, actor, ref, consulted)
    const { proc: _proc, ...refresh } = applied
    return { ...base, recorded: false, reason: 'nao-e-217', refresh }
  }
  const fact = consulted.result.fact
  const decided = await withInvoiceTx(deps.pool, actor, ref, { label: 'fato "o fisco não registrou"' }, async itx => {
    const current = await getAttempt(itx.conn, ref, row.attempt)
    if (!current) return { recorded: false, reason: 'voz-mudou-depois-da-pergunta' as const }
    // a peça do núcleo decide (RF-NFE-72): o 0 do `COALESCE(MAX(event), 0)` vira `null` SÓ para ela; quem grava segue com `?? 0`
    const verdict = notRegisteredProven({
      route: 'reconfirm', cStat: Number(fact.cStat), queriedAccessKey: fact.chNFe, attemptAccessKey: row.accessKey, answeredBy: row.authorizer, attemptAuthorizer: row.authorizer,
      receipt: row.receipt, lastKind: row.lastKind, seenLastEvent: row.lastEvent || null, currentLastEvent: current.lastEvent || null,
    })
    if (!verdict.proven) return { recorded: false, reason: REFUSAL[verdict.reason] ?? 'peca-recusou' as const, detail: verdict.reason }
    const recorded = await recordNfeNotRegistered(itx.conn, ref, row.attempt, row.lastEvent ?? 0)
    return { recorded, reason: recorded ? 'registrada-agora' as const : 'voz-mudou-depois-da-pergunta' as const }
  })
  return { ...base, recorded: decided.recorded, reason: decided.reason, refresh: null, ...('detail' in decided ? { detail: decided.detail } : {}) }
}
