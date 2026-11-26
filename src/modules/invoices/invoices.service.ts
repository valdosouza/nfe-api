import { ErrorCodes, HttpError, InstitutionPayload, InvoiceRef, MERCHANDISE_VOICE_READING, WEB_TERMINAL, erp, fiscalStateOf, localCancelPendingIn, toZoneWall } from 'fiscal-api'
import type { AppContext } from '../../context'
import { cancelDeadlineHours } from '../../authority/cancel-deadlines'
import { ufOfCode } from '../../authority/messages'
import { cancelInvoice, type CancelResult } from '../../nfe/cancellation'
import { renderDanfe } from '../../nfe/danfe/danfe'
import { NfeErrors } from '../../nfe/errors'
import { readCancelProc, readProcNfe } from '../../nfe/invoice-files'
import { listPending } from '../../nfe/pending'
import { attemptsOfLife, latestAttempt, voicesOfLife, type AttemptRow } from '../../nfe/attempt'
import { merchandiseFileKey } from '../../nfe/fiscal-file'
import { reconfirmNotRegistered, refreshInvoice, type ReconfirmResult, type RefreshResult } from '../../nfe/reconcile'
import { transmitInvoice, type TransmitResult } from '../../nfe/transmission'
import { reportIncident } from '../../mail/ops-alert'
import { actorOf, nfeDepsOf } from '../nfe-deps'

/**
 * A borda de serviço de `/v1/nfe/invoices` (NFE.E6.P1 mudança 10; ficha §6-10): monta as dependências da composição a partir do `AppContext` (o pool, o anel de chaves, o
 * arquivo fiscal, o CA do servidor do fisco e o responsável técnico) e traduz o que `transmitInvoice`, `refreshInvoice` e `reconfirmNotRegistered` devolvem para a resposta HTTP do
 * contrato. O router é fino; a regra mora em `src/nfe`. NADA aqui fala com o fisco por conta própria: o transporte é o do `callSoap` (o `request` real só entra sem injeção).
 */

export { actorOf, nfeDepsOf }

export interface TransmitResponse { readonly status: 201 | 202; readonly data: { invoiceId: number; attempt: number; accessKey: string; number: number; serie: number; protocol: string | null; receipt: string | null; kind: 'A' | 'P'; authorityCode: string | null; incident: TransmitResult['incident'] } }

/** O que o fisco disse → a resposta do contrato: A = 201, P = 202; R, D, F e o que não fechou viram o erro tipado (o corpo tem o cStat e a saída seguinte). */
export function responseOfTransmit(r: TransmitResult): TransmitResponse {
  const o = r.outcome
  if (o.kind === 'A' || o.kind === 'P') {
    return { status: o.kind === 'A' ? 201 : 202, data: { invoiceId: r.invoiceId, attempt: r.attempt, accessKey: r.accessKey, number: r.number, serie: r.serie, protocol: r.nProt, receipt: r.nRec, kind: o.kind, authorityCode: r.authorityCode, incident: r.incident } }
  }
  const at = [{ field: 'attempt', message: String(r.attempt) }]
  if (o.kind === 'R') throw new HttpError(422, `NF-e rejeitada pelo fisco: ${o.message}`, [{ field: 'authorityCode', message: String(o.authorityCode) }, ...at], 'FISCAL_DOCUMENT_REJECTED')
  if (o.kind === 'D') throw new HttpError(409, `NF-e denegada pelo fisco (${o.authorityCode}): a nota existe no fisco e não se retransmite`, [{ field: 'authorityCode', message: String(o.authorityCode) }, ...at, ...(r.incident ? [{ field: 'incident', message: r.incident }] : [])], 'FISCAL_DENIED')
  if (o.kind === 'F') throw new HttpError(502, o.message, at, ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED)
  // nada concluiu (ambíguo, 204/539, 106…): a tentativa fica EM VOO e a saída é consultar (D-NE34/D-NE36)
  throw new HttpError(502, 'O fisco não concluiu a autorização: a tentativa ficou em voo — consulte a situação pela nossa chave', [...at, { field: 'next', message: r.next ?? 'consult-key' }, ...(r.incident ? [{ field: 'incident', message: r.incident }] : [])], ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
}

export async function transmit(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef): Promise<TransmitResponse> {
  const r = await transmitInvoice(nfeDepsOf(ctx), actorOf(inst), ref)
  if (r.incident) reportIncident(ctx, { route: 'invoice-transmit', institutionId: inst.institutionId, invoiceId: r.invoiceId, accessKey: r.accessKey, incident: r.incident })    // D-NE237
  return responseOfTransmit(r)
}

export interface RefreshResponse {
  invoiceId: number; attempt: number; accessKey: string; via: 'key' | 'receipt'; changed: boolean; kind: string | null; localCancelPending: false
  digestCheck: 'match' | 'mismatch' | 'absent' | 'not_applicable'; incident: RefreshResult['incident']; notRegistered: boolean; next: RefreshResult['next']; reason: string | null
}

export function responseOfRefresh(r: RefreshResult): RefreshResponse {
  const kind = r.outcome.kind === 'none' ? null : r.outcome.kind
  return {
    invoiceId: r.invoiceId, attempt: r.attempt, accessKey: r.accessKey, via: r.via, changed: kind !== null && kind !== 'cancelled', kind, localCancelPending: false,
    digestCheck: r.digestCheck === 'ok' ? 'match' : r.digestCheck ?? 'not_applicable', incident: r.incident, notRegistered: r.notRegistered, next: r.next,
    reason: r.outcome.kind === 'none' ? r.outcome.reason : null,
  }
}

export async function refresh(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef, all: boolean): Promise<RefreshResponse> {
  const r = await refreshInvoice(nfeDepsOf(ctx), actorOf(inst), ref, { all })
  if (r.incident) reportIncident(ctx, { route: 'invoice-refresh', institutionId: inst.institutionId, invoiceId: r.invoiceId, accessKey: r.accessKey, incident: r.incident })    // D-NE237
  return responseOfRefresh(r)
}

export async function reconfirm(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef): Promise<{ invoiceId: number; attempt: number; accessKey: string; recorded: boolean; reason: ReconfirmResult['reason']; detail?: string; refresh: RefreshResponse | null }> {
  const r = await reconfirmNotRegistered(nfeDepsOf(ctx), actorOf(inst), ref)
  if (r.refresh?.incident) reportIncident(ctx, { route: 'invoice-reconfirm', institutionId: inst.institutionId, invoiceId: r.invoiceId, accessKey: r.accessKey, incident: r.refresh.incident })    // D-NE237
  return { invoiceId: r.invoiceId, attempt: r.attempt, accessKey: r.accessKey, recorded: r.recorded, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}), refresh: r.refresh ? responseOfRefresh(r.refresh) : null }
}

/** O pedido de cancelamento ao fisco (NFE.E6.P4 mudança 3): 200 com o resultado; o ambíguo (o K fica) é 502 com a saída "consultar a chave"; o que o SERVIÇO recusou (656…) é 503. */
export interface CancelResponse { invoiceId: number; attempt: number; atAuthority: boolean; state: CancelResult['state']; eventSequence: number | null; protocol: string | null; warnings: readonly string[]; nextStep: CancelResult['nextStep']; incident: CancelResult['incident'] }

export function responseOfCancel(r: CancelResult): CancelResponse {
  const fields = [{ field: 'attempt', message: String(r.attempt) }, { field: 'next', message: r.nextStep }, ...(r.incident ? [{ field: 'incident', message: r.incident }] : [])]
  if (r.state === 'in-flight' && r.refusedCStat) throw new HttpError(503, `O serviço do fisco recusou o pedido (${r.refusedCStat}) — o cancelamento ficou em voo: consulte a chave antes de tentar de novo`, [...fields, { field: 'authorityCode', message: r.refusedCStat }], ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE)
  if (r.state === 'in-flight') throw new HttpError(502, 'O fisco não concluiu o cancelamento: o pedido ficou em voo — consulte a situação pela nossa chave', fields, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
  return { invoiceId: r.invoiceId, attempt: r.attempt, atAuthority: r.atAuthority, state: r.state, eventSequence: r.eventSequence, protocol: r.protocol, warnings: r.warnings, nextStep: r.nextStep, incident: r.incident }
}

export async function cancel(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef, reason: string): Promise<CancelResponse> {
  return responseOfCancel(await cancelInvoice(nfeDepsOf(ctx), actorOf(inst), ref, reason))
}

/** As vozes de uma NF-e que o fisco REGISTROU como autorizada (a A, e o K/N/C do cancelamento dela) — o procNFe existe e o DANFE sai; denegada (D) tem procNFe mas não DANFE (S-8). */
const AUTHORIZED_VOICES: ReadonlySet<string> = new Set(['A', 'K', 'N', 'C'])
const WITH_PROC_VOICES: ReadonlySet<string> = new Set(['A', 'K', 'N', 'C', 'D'])

const notAuthorized = (ref: InvoiceRef, why: string): HttpError => new HttpError(409, `Nota ${ref.invoiceId}: ${why}`, undefined, ErrorCodes.FISCAL_NOT_AUTHORIZED)

/** A última tentativa da vida vigente com a voz que dá direito ao arquivo: sem tentativa, sem voz ou fora de [allowed] = 409 `FISCAL_NOT_AUTHORIZED`. A zona do estabelecimento vem junto (a chave do arquivo). */
async function fileScope(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef, allowed: ReadonlySet<string>, what: string): Promise<{ latest: AttemptRow; zone: string }> {
  const life = await erp.invoiceLife(ctx.pool, inst.schemaName, ref)
  if (!life) throw new HttpError(404, `Nota ${ref.invoiceId} não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
  const latest = life.lifeEvent === null ? null : await latestAttempt(ctx.pool, ref, life.lifeEvent)
  if (!latest || latest.protocol === null || latest.lastKind === null || !allowed.has(latest.lastKind)) throw notAuthorized(ref, `não há NF-e registrada no fisco — ${what}`)
  return { latest, zone: await erp.institutionZone(ctx.pool, inst.schemaName, inst.institutionId) }
}

export interface XmlResponse { accessKey: string; procNFe: string; cancelEvent: string | null }

/** O XML com protocolo (`procNFe`) da NF-e autorizada ou denegada e, se cancelada, o `procEventoNFe`; arquivo que a tentativa diz ter e não está lá = 409 `FISCAL_FILE_MISSING` (nunca refeito — N10). */
export async function xml(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef): Promise<XmlResponse> {
  const { latest, zone } = await fileScope(ctx, inst, ref, WITH_PROC_VOICES, 'não há procNFe')
  const now = new Date()
  const procNFe = readProcNfe(ctx.storage, zone, latest, now)
  if (procNFe === null) throw new HttpError(409, `O procNFe de ${latest.accessKey} não está no arquivo fiscal — avise o suporte (o arquivo autorizado nunca é refeito)`, [{ field: 'file', message: `${latest.accessKey}-procNFe.xml` }], NfeErrors.FILE_MISSING)
  return { accessKey: latest.accessKey, procNFe, cancelEvent: latest.lastKind === 'C' ? readCancelProc(ctx.storage, zone, latest, now) : null }
}

export interface DanfeResponse { accessKey: string; pdfBase64: string }

/** O DANFE A4 (PDF nosso — NT 2026.010) da NF-e autorizada, com o carimbo CANCELADA pela voz C; nota sem autorização = 409 `FISCAL_NOT_AUTHORIZED` (S-8); XML ilegível = 422 do `renderDanfe`. */
export async function danfe(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef): Promise<DanfeResponse> {
  const { latest, zone } = await fileScope(ctx, inst, ref, AUTHORIZED_VOICES, 'sem autorização não há DANFE')
  const procNfeXml = readProcNfe(ctx.storage, zone, latest, new Date())
  if (procNfeXml === null) throw new HttpError(409, `O procNFe de ${latest.accessKey} não está no arquivo fiscal — avise o suporte (o DANFE sai do arquivo autorizado)`, [{ field: 'file', message: `${latest.accessKey}-procNFe.xml` }], NfeErrors.FILE_MISSING)
  const pdf = await renderDanfe({ procNfeXml, voice: latest.lastKind as never })
  return { accessKey: latest.accessKey, pdfBase64: pdf.toString('base64') }
}

/** A lista `pending` (leitura por lote em `src/nfe/pending.ts`); o terminal da web só existe na borda. */
export async function pending(ctx: AppContext, inst: InstitutionPayload, page: { page: number; pageSize: number }, allowed: readonly ('orders' | 'order-returns')[]) {
  return listPending(ctx.pool, inst.schemaName, { institutionId: inst.institutionId, terminal: WEB_TERMINAL }, { ...page, allowed })
}

const STATE_OF_NONE = 'none' as const

/**
 * O fim do prazo de cancelamento da UF (AVISO — a recusa é da SEFAZ; a única trava é a das 480 h, `cancellation.ts`): a hora da autorização (`dh_recbto`, UTC) + o prazo DADO da UF do emitente (`cancel-deadlines.ts`, nunca um
 * `if (uf === …)`), na zona do estabelecimento. Só da tentativa AUTORIZADA (voz A, K ou N com protocolo e hora gravados); outra coisa = null.
 */
function cancelDeadlineWall(a: AttemptRow, zone: string): string | null {
  if ((a.lastKind !== 'A' && a.lastKind !== 'K' && a.lastKind !== 'N') || a.protocol === null || a.dhRecbto === null) return null     // autorizada e ainda cancelável: A, K (pedido em voo) e N (pedido liberado)
  const uf = ufOfCode(a.accessKey.slice(0, 2))
  const at = Date.parse(`${a.dhRecbto.replace(' ', 'T')}Z`)
  if (uf === null || Number.isNaN(at)) return null
  const end = new Date(at + cancelDeadlineHours(uf, new Date(at)) * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')
  return toZoneWall(end, zone)
}

/** A situação fiscal da nota na VIDA vigente: as tentativas, as vozes e o estado derivado da última voz. Instantes na zona do estabelecimento (Q-TZ1). */
export async function fiscalView(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef): Promise<Record<string, unknown>> {
  const life = await erp.invoiceLife(ctx.pool, inst.schemaName, ref)
  if (!life) throw new HttpError(404, `Nota ${ref.invoiceId} não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
  const lifeEvent = life.lifeEvent
  const attempts: AttemptRow[] = lifeEvent === null ? [] : await attemptsOfLife(ctx.pool, ref, lifeEvent)
  const voices = lifeEvent === null ? [] : await voicesOfLife(ctx.pool, ref, lifeEvent)
  const zone = await erp.institutionZone(ctx.pool, inst.schemaName, inst.institutionId)
  const wall = (v: string | null): string | null => (v ? toZoneWall(v, zone) : null)
  const deadlineOf = (a: AttemptRow, z: string): string | null => cancelDeadlineWall(a, z)
  const latest = attempts[attempts.length - 1] ?? (lifeEvent === null ? null : await latestAttempt(ctx.pool, ref, lifeEvent))
  const key = latest ? merchandiseFileKey({ cnpj: latest.accessKey.slice(6, 20), model: '55', serie: latest.serie, environment: latest.environment, zone }) : null
  return {
    invoiceId: ref.invoiceId, state: latest ? fiscalStateOf({ lastKind: latest.lastKind }) : STATE_OF_NONE, authorityRecorded: latest ? latest.protocol !== null : false,
    currentAttempt: latest?.attempt ?? null,
    transmissions: attempts.map(a => ({
      attempt: a.attempt, environment: a.environment, accessKey: a.accessKey, number: a.number, serie: a.serie, authorizer: a.authorizer, emissionType: '1', dhEmi: wall(a.dhEmission),
      receipt: a.receipt, protocol: a.protocol, dhAuthorization: wall(a.dhRecbto), lastKind: a.lastKind, lastCode: a.lastCode,
      notRegisteredAt: wall(a.nfeNotRegisteredAt),
    })),
    voices: voices.map(v => ({ ...v, dh: wall(v.dh) })),
    documentEvents: [],
    // D-F28 (a pendência é DERIVADA, nada é gravado): a vigente tem voz C — ou D, nota denegada, cujo cancelamento é local (D-NE280) — e a nota no ERP ainda não tem o evento C
    localCancelPending: localCancelPendingIn(MERCHANDISE_VOICE_READING, latest ? { lastKind: latest.lastKind, lastCode: latest.lastCode } : null, life.lastKind)
      || (latest?.lastKind === 'D' && life.lastKind !== 'C'),
    cancelDeadline: latest ? deadlineOf(latest, zone) : null,
    xmlAvailable: !!(latest && key && ctx.storage.find(key, `${latest.accessKey}-nfe.xml`, [latest.dhEmission]) !== null),
    danfeAvailable: !!(latest && latest.protocol !== null && latest.lastKind !== null && AUTHORIZED_VOICES.has(latest.lastKind)),
  }
}
