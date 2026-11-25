import { ErrorCodes, HttpError, nowIsoIn, recordKindOnce, releaseCancelRequest, reserveCancelRequest, withInvoiceTx, type InvoiceRef } from 'fiscal-api'
import { endpointOf, soapBindingOf, type Environment, type Uf } from '../authority/authorizers'
import { CANCEL_HARD_LIMIT_HOURS, cancelDeadlineHours } from '../authority/cancel-deadlines'
import { voiceOfCancel } from '../authority/cstat-voice'
import { envEvento110111, eventoNFe110111, SAFE_JUSTIFICATION, signEventoNFe, ufOfCode } from '../authority/messages'
import { readCancelEvent } from '../authority/responses'
import { callSoap, type SoapOutcome } from '../authority/soap'
import { validateMessage } from '../authority/xsd'
import { getAttempt, latestAttempt, type AttemptRow } from './attempt'
import { documentInvalid, NfeErrors } from './errors'
import { isFileConflict, merchandiseFileKey } from './fiscal-file'
import { eventFileName, eventProcFileName, procEventoXml } from './proc-evento'
import { assertFamilyOf, type NfeActor, type NfeDeps } from './transmission'
import { MERCHANDISE_VOICE_FAMILY } from './voice-family'

/**
 * O CANCELAMENTO da NF-e (NFE.E6.P2.T1 — ficha-nfe-e6-p2-cancelar-inutilizar-rodizio.md §7-4; D-NE26, D-NE39, D-NE50, D-NE106, D-NE208, D-NE209, D-NE210, D-NE256; RF-NFE-18/24/80/82/83).
 * Molde: o cancelamento da NFS-e (a mesma reserva K → fisco FORA da transação → C ou N). Nenhuma chamada de rede em teste: o `request` do `callSoap` é injetado.
 *
 * - Só a voz A vigente cancela no fisco. D = 409 `FISCAL_DENIED` (a nota existe, não se cancela no fisco); R, F ou sem tentativa = 409 `FISCAL_NOT_AUTHORIZED`; em voo = 409; K vigente = 409
 *   `FISCAL_CANCEL_IN_FLIGHT`; C já gravada = idempotente (nada ao fisco).
 * - A TRAVA de 480 h da autorização (D-NE256) recusa SEM enviar (409 `FISCAL_CANCEL_DEADLINE_EXCEEDED`); sem o `dhRecbto` da autorização não há como medir: falha fechado. O prazo da UF só AVISA.
 * - O evento assinado é gravado ANTES do envio (gravação única do núcleo): conflito = 409 `FISCAL_FILE_CONFLICT` e a transação desfaz, sem K. Num 2º pedido (depois de N) o evento GUARDADO é
 *   reaproveitado byte a byte — nunca se gera outro `dhEvento` para o mesmo nSeq (a gravação única o recusaria).
 * - K = `reserveCancelRequest`, N = `releaseCancelRequest`, C = `recordKindOnce` (peças do núcleo, com o escritor da família). C só com 135/155; rejeição do evento libera com N; o que o serviço
 *   recusou (656…), 136/573/580 e a resposta sem eco MANTÊM o K — a consulta da chave reconcilia (S5). O nProt do evento vive no `-evt110111-1-proc.xml` guardado (Q1).
 */

export interface CancelResult {
  readonly invoiceId: number
  readonly attempt: number
  /** `true` se o fisco cancelou AGORA; `false` se a voz C já existia (idempotente) ou o pedido ficou em voo. */
  readonly atAuthority: boolean
  /** O pedido segue em voo (K mantido): a saída é consultar a chave. */
  readonly state: 'cancelled' | 'already-cancelled' | 'in-flight'
  /** O número do evento (voz C) no rastro da tentativa, quando há. */
  readonly eventSequence: number | null
  /** O protocolo do evento (do `retEvento`), quando o fisco cancelou agora. */
  readonly protocol: string | null
  readonly warnings: readonly string[]
  readonly nextStep: 'apply-local-cancel' | 'consult-key'
  /** Pendência crítica: o `-evt110111-1.xml` ou o procEvento em conflito de gravação única. */
  readonly incident: 'file-conflict' | null
  /** O cStat que o SERVIÇO recusou (656…), para o disjuntor; nunca é rejeição do evento. */
  readonly refusedCStat: string | null
}

const HOUR = 3_600_000
const tpAmbOf = (e: Environment): '1' | '2' => (e === 'H' ? '2' : '1')
const utcMs = (dbUtc: string | null): number | null => {
  const t = dbUtc ? Date.parse(`${dbUtc.replace(' ', 'T')}Z`) : NaN
  return Number.isNaN(t) ? null : t
}
const days = (from: number, to: number): Date[] => {
  const out: Date[] = []
  for (let t = from; t <= to + 86_400_000; t += 86_400_000) out.push(new Date(t))
  return out
}
const clip = (s: string): string => (s.length <= 255 ? s : s.slice(0, 255))

export async function cancelInvoice(deps: NfeDeps, actor: NfeActor, ref: InvoiceRef, reason: string): Promise<CancelResult> {
  assertFamilyOf(deps)
  if (typeof reason !== 'string' || !SAFE_JUSTIFICATION.test(reason)) {
    throw documentInvalid('O motivo do cancelamento não foi aceito', [{ field: 'reason', message: 'De 15 a 255 caracteres, só letras, números e . , ; : ( ) - /, sem espaço no início nem no fim' }])
  }
  const insertTransmissionEvent = MERCHANDISE_VOICE_FAMILY.insertTransmissionEvent
  const findTransmissionEventByKind = MERCHANDISE_VOICE_FAMILY.findTransmissionEventByKind
  const warnings: string[] = []

  // (1) a decisão e a RESERVA, sob a trava da nota. As saídas que NÃO falam com o fisco vêm ANTES de abrir o emissor (retry com C já gravada e A1 vencido não vira 409 de certificado).
  type Decision = { readonly already: AttemptRow } | { readonly prepared: Prepared }
  const decision = await withInvoiceTx(deps.pool, actor, ref, { label: 'decisão do cancelamento da NF-e', requireAlive: true }, async (itx): Promise<Decision> => {
    const latest = await latestAttempt(itx.conn, ref, itx.locked.lifeEvent as number)
    if (latest?.lastKind === 'C') return { already: latest }
    if (latest?.lastKind === 'K') throw new HttpError(409, 'Já há um pedido de cancelamento em andamento para esta nota', [{ field: 'attempt', message: String(latest.attempt) }], ErrorCodes.FISCAL_CANCEL_IN_FLIGHT)
    if (latest && (latest.lastKind === null || latest.lastKind === 'P')) {
      throw new HttpError(409, `Há transmissão em andamento (tentativa ${latest.attempt}) — consulte o fisco antes de cancelar`, undefined, ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS)
    }
    if (latest?.lastKind === 'D') {
      throw new HttpError(409, 'A NF-e foi denegada: a nota existe no fisco e não se cancela no fisco — cancele a nota direto no ERP', [{ field: 'attempt', message: String(latest.attempt) }], NfeErrors.DENIED)
    }
    if (!latest || (latest.lastKind !== 'A' && latest.lastKind !== 'N')) {
      throw new HttpError(409, 'Não há NF-e autorizada para cancelar no fisco — cancele a nota direto no ERP', [{ field: 'fiscal', message: latest ? `Última voz ${latest.lastKind}` : 'Nunca transmitida' }], ErrorCodes.FISCAL_NOT_AUTHORIZED)
    }
    if (latest.protocol === null) {
      throw new HttpError(409, `Tentativa ${latest.attempt} sem protocolo de autorização — consulte o fisco antes de cancelar`, undefined, ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS)
    }
    // a TRAVA de 480 h da autorização (D-NE256): recusa sem enviar; sem o dhRecbto não há como medir — falha fechado
    const authorizedAt = utcMs(latest.dhRecbto)
    const now = deps.now()
    if (authorizedAt === null) {
      throw new HttpError(409, 'A hora da autorização não está gravada — consulte o fisco antes de cancelar (a trava de prazo não pode ser medida)', undefined, ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS)
    }
    const elapsedHours = (now.getTime() - authorizedAt) / HOUR
    if (elapsedHours > CANCEL_HARD_LIMIT_HOURS) {
      throw new HttpError(409, `Passaram mais de ${CANCEL_HARD_LIMIT_HOURS} horas da autorização — a nota não é mais cancelada por aqui (nada foi enviado ao fisco)`, [{ field: 'dhRecbto', message: latest.dhRecbto as string }], NfeErrors.CANCEL_DEADLINE_EXCEEDED)
    }
    const uf = ufOfCode(latest.accessKey.slice(0, 2)) as Uf | null
    if (uf === null) throw new Error('chave da tentativa com cUF fora da tabela')
    const limit = cancelDeadlineHours(uf, now)
    if (elapsedHours > limit) warnings.push(`FISCAL_CANCEL_DEADLINE: passaram ${Math.floor(elapsedHours)} horas da autorização e o prazo de ${uf} é de ${limit} — a SEFAZ pode recusar (501)`)

    const environment = latest.environment as Environment
    deps.breaker?.check({ cnpj: latest.accessKey.slice(6, 20), environment, service: 'evento' })   // o disjuntor (D-NE254): 429 sem reservar e sem ir ao fisco
    const binding = soapBindingOf(latest.authorizer as never, environment, 'RecepcaoEvento')
    const endpoint = endpointOf(latest.authorizer as never, environment, 'RecepcaoEvento')
    if (!binding || !endpoint.ok) {
      throw new HttpError(503, 'O serviço de eventos deste ambiente não está registrado nesta API — nada foi reservado nem enviado', [{ field: 'authorizer', message: `${latest.authorizer} × ${environment}` }], ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE)
    }
    // a habilitação TRAVADA e o A1 conferidos ANTES do K (ordem nota → habilitação → A1; A1 ausente/vencido = 409 sem K)
    const opened = await deps.openIssuer(itx.conn, actor)
    const zone = await deps.zoneOf(itx.conn, actor)
    const cnpj = latest.accessKey.slice(6, 20)
    const key = merchandiseFileKey({ cnpj, model: '55', serie: latest.serie, environment, zone })
    const name = eventFileName(latest.accessKey)
    // o evento: o GUARDADO (2º pedido depois de N — mesmos bytes), ou o novo, assinado, validado no XSD e gravado ANTES do envio
    const hints = days(Math.min(authorizedAt, utcMs(latest.dhEmission) ?? authorizedAt), now.getTime())
    const stored = deps.storage.find({ ...key }, name, hints)
    let signedEvento: string
    if (stored !== null) {
      signedEvento = deps.storage.read(stored)
    } else {
      const built = eventoNFe110111({ tpAmb: tpAmbOf(environment), uf, cnpj, chNFe: latest.accessKey, dhEvento: nowIsoIn(zone, now).slice(0, 25), nProt: latest.protocol as string, xJust: reason })
      signedEvento = signEventoNFe(built, opened.cert, opened.key)
      const xsd = await validateMessage('envEvento110111', envEvento110111(signedEvento, 1))
      if (!xsd.ok) throw documentInvalid('O evento de cancelamento assinado não passou no XSD', [{ field: 'evento', message: 'Estrutura inválida segundo o leiaute (XSD) depois de assinar' }])
      try { deps.storage.save(key, name, signedEvento, now) } catch (e) {
        if (isFileConflict(e)) throw new HttpError(409, 'O arquivo do evento de cancelamento já existe com outro conteúdo — nada foi enviado ao fisco (D-NE41)', [{ field: 'file', message: name }], ErrorCodes.FISCAL_FILE_CONFLICT)
        throw e
      }
    }
    // a RESERVA (K, fato NOSSO — dh NULL): peça do núcleo sobre o escritor da família
    await reserveCancelRequest(insertTransmissionEvent, itx, latest.attempt, actor.userId)
    return { prepared: { attempt: latest, signedEvento, environment, url: endpoint.url, action: binding.action, namespace: binding.namespace, cnpj, zone, opened } }
  })

  if ('already' in decision) {
    const voice = await findTransmissionEventByKind(deps.pool as never, ref, decision.already.attempt, 'C')
    return { invoiceId: ref.invoiceId, attempt: decision.already.attempt, atAuthority: false, state: 'already-cancelled', eventSequence: voice?.event ?? decision.already.lastEvent, protocol: null, warnings: [], nextStep: 'apply-local-cancel', incident: null, refusedCStat: null }
  }
  const p = decision.prepared
  const attempt = p.attempt.attempt

  /** O pedido NÃO vigora (rejeitado pelo fisco ou nem enviado): N devolve a nota a autorizada (só se a última voz ainda é o K). */
  const release = (message: string) => withInvoiceTx(deps.pool, actor, ref, { label: 'pedido de cancelamento não vigora' }, async itx => {
    const cur = await getAttempt(itx.conn, ref, attempt)                          // sob a MESMA trava
    await releaseCancelRequest(insertTransmissionEvent, itx, attempt, actor.userId, clip(message), cur)
  })

  // (2) o FISCO — fora de qualquer transação (D-NE33)
  let outcome: SoapOutcome
  try {
    outcome = await callSoap({
      url: p.url, service: 'RecepcaoEvento', action: p.action, namespace: p.namespace, resultElement: 'retEnvEvento',
      body: envEvento110111(p.signedEvento, 1), message: 'envEvento110111', cert: p.opened.cert, key: p.opened.key, ca: deps.ca(),
    }, deps.request)
  } catch (e) {
    await release('Pedido de cancelamento não enviado: falha local antes de falar com o fisco')
    throw e
  }
  const base = { invoiceId: ref.invoiceId, attempt, warnings, incident: null as 'file-conflict' | null }
  if (outcome.kind === 'local-credential') { await release('Pedido de cancelamento não enviado: credencial local inválida'); throw new HttpError(502, 'Credencial local inválida — nada foi enviado', undefined, ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED) }
  if (outcome.kind === 'credential') { await release('Pedido de cancelamento recusado: credencial recusada pelo fisco'); throw new HttpError(502, 'Credencial recusada pelo fisco', undefined, ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED) }
  if (outcome.kind === 'chain') { await release('Pedido de cancelamento não enviado: cadeia de certificados do servidor não confiável'); throw new HttpError(502, 'Cadeia de certificados do servidor do fisco não confiável', undefined, ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED) }
  if (outcome.kind !== 'answered' && outcome.kind !== 'rejected') {
    // ambíguo, indisponível, desativado: o fisco pode ter cancelado — o K FICA e a consulta reconcilia (D-NE34)
    return { ...base, atAuthority: false, state: 'in-flight', eventSequence: null, protocol: null, nextStep: 'consult-key', refusedCStat: null }
  }

  // (3) a resposta decide: C (135/155), N (rejeição do evento) ou K mantido
  const decided = voiceOfCancel(readCancelEvent({ chNFe: p.attempt.accessKey, tpAmb: tpAmbOf(p.environment), nSeqEvento: 1 }, outcome.xml))
  const scope = { cnpj: p.cnpj, environment: p.environment, service: 'evento' } as const
  if (decided.action === 'keep') {
    if (decided.breaker) deps.breaker?.recordRefused(scope, decided.breaker)                       // o serviço RECUSOU (656…): o disjuntor abre por 1 h, o K fica
    return { ...base, atAuthority: false, state: 'in-flight', eventSequence: null, protocol: null, nextStep: 'consult-key', refusedCStat: decided.breaker }
  }
  if (decided.action === 'release') {
    deps.breaker?.recordRejection(scope, decided.cStat)                                             // a rejeição do evento conta na hora (até 20 iguais)
    await release(decided.message)
    throw new HttpError(409, `O fisco recusou o cancelamento (${decided.cStat}): ${decided.message}`, [{ field: 'authorityCode', message: decided.cStat }, { field: 'attempt', message: String(attempt) }], ErrorCodes.FISCAL_CANCEL_REFUSED)
  }
  const recorded = await withInvoiceTx(deps.pool, actor, ref, { label: 'voz C do cancelamento da NF-e' }, async itx => {
    // um C por tentativa, qualquer dh (HIGH-3a): a política por kind é do núcleo; já havendo, vale a que está
    const r = await recordKindOnce({ insertTransmissionEvent, findTransmissionEventByKind }, itx, attempt, actor.userId, {
      kind: 'C', source: 'P', dh: decided.dh, message: decided.message, authorityCode: decided.authorityCode,
    })
    return r.event
  })
  // o `-evt110111-1.xml` já está guardado (assinado); o procEventoNFe (evento + retEvento) é guardado agora — conflito = pendência crítica, outra falha só avisa
  let incident: 'file-conflict' | null = null
  const proc = procEventoXml(p.signedEvento, outcome.xml, p.attempt.accessKey)
  if (proc !== null) {
    const key = merchandiseFileKey({ cnpj: p.cnpj, model: '55', serie: p.attempt.serie, environment: p.environment, zone: p.zone })
    try { deps.storage.save(key, eventProcFileName(p.attempt.accessKey), proc, deps.now()) } catch (e) { if (isFileConflict(e)) incident = 'file-conflict' }
  }
  return { ...base, atAuthority: true, state: 'cancelled', eventSequence: recorded, protocol: decided.nProt, nextStep: 'apply-local-cancel', incident, refusedCStat: null }
}

interface Prepared {
  readonly attempt: AttemptRow
  readonly signedEvento: string
  readonly environment: Environment
  readonly url: string
  readonly action: string
  readonly namespace: string
  readonly cnpj: string
  readonly zone: string
  readonly opened: Awaited<ReturnType<NfeDeps['openIssuer']>>
}
