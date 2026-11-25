import { ErrorCodes, HttpError, InstitutionPayload, InvoiceRef, erp, fiscalStateOf, openIssuer, requiredFiscalCredentialsFor, toZoneWall } from 'fiscal-api'
import type { AppContext } from '../../context'
import { attemptsOfLife, latestAttempt, voicesOfLife, type AttemptRow } from '../../nfe/attempt'
import { readComposedFacts } from '../../nfe/compose'
import { documentInvalid } from '../../nfe/errors'
import { merchandiseFileKey } from '../../nfe/fiscal-file'
import { reconfirmNotRegistered, refreshInvoice, type ReconfirmResult, type ReconcileDeps, type RefreshResult } from '../../nfe/reconcile'
import { transmitInvoice, type NfeActor, type NfeDeps, type TransmitResult } from '../../nfe/transmission'

/**
 * A borda de serviço de `/v1/nfe/invoices` (NFE.E6.P1 mudança 10; ficha §6-10): monta as dependências da composição a partir do `AppContext` (o pool, o anel de chaves, o
 * arquivo fiscal, o CA do servidor do fisco e o responsável técnico) e traduz o que `transmitInvoice`, `refreshInvoice` e `reconfirmNotRegistered` devolvem para a resposta HTTP do
 * contrato. O router é fino; a regra mora em `src/nfe`. NADA aqui fala com o fisco por conta própria: o transporte é o do `callSoap` (o `request` real só entra sem injeção).
 */

export const actorOf = (inst: InstitutionPayload): NfeActor => ({ institutionId: inst.institutionId, schemaName: inst.schemaName, userId: inst.userId })

/** As dependências (montadas por chamada: nada de estado de controle). */
export function nfeDepsOf(ctx: AppContext, now: () => Date = () => new Date()): NfeDeps & ReconcileDeps {
  return {
    pool: ctx.pool, storage: ctx.storage, now,
    openIssuer: (conn, actor) => openIssuer({ pool: ctx.pool, keyring: ctx.keyring }, actor.institutionId, '55', { conn, forUpdate: true, schemaName: actor.schemaName }),
    readFacts: (q, actor, ref, environment) => readComposedFacts(q, { storage: ctx.storage, techResponsible: ctx.technicalResponsible }, actor, ref, environment),
    zoneOf: (q, actor) => erp.institutionZone(q, actor.schemaName, actor.institutionId),
    establishmentCnpj: (q, actor) => erp.establishmentCnpj(q, actor.institutionId),
    credentialsFor: async (q, actor, scope) => {
      const required = await requiredFiscalCredentialsFor(q, { state: scope.uf, model: '55', environment: scope.environment, at: scope.at, institutionId: actor.institutionId })
      if (required.length === 0) return null                                      // a UF × modelo × ambiente não exige código
      if (required.length > 1) throw documentInvalid('A UF exige mais de um código fiscal — fora do 1º release', [{ field: 'infRespTec', message: 'Mais de uma credencial exigida' }])
      return { codeId: required[0].codeId, codeValue: required[0].codeValue }
    },
    ca: () => ctx.serverCa.pem as never,
  }
}

export interface TransmitResponse { readonly status: 201 | 202; readonly data: { invoiceId: number; attempt: number; accessKey: string; number: number; serie: number; protocol: string | null; receipt: string | null; kind: 'A' | 'P'; authorityCode: string | null; incident: TransmitResult['incident'] } }

/** O que o fisco disse → a resposta do contrato: A = 201, P = 202; R, D, F e o que não fechou viram o erro tipado (o corpo tem o cStat e a saída seguinte). */
export function responseOfTransmit(r: TransmitResult): TransmitResponse {
  const o = r.outcome
  if (o.kind === 'A' || o.kind === 'P') {
    return { status: o.kind === 'A' ? 201 : 202, data: { invoiceId: r.invoiceId, attempt: r.attempt, accessKey: r.accessKey, number: r.number, serie: r.serie, protocol: r.nProt, receipt: r.nRec, kind: o.kind, authorityCode: r.authorityCode, incident: r.incident } }
  }
  const at = [{ field: 'attempt', message: String(r.attempt) }]
  if (o.kind === 'R') throw new HttpError(422, `NF-e rejeitada pelo fisco: ${o.message}`, [{ field: 'authorityCode', message: String(o.authorityCode) }, ...at], 'FISCAL_DOCUMENT_REJECTED')
  if (o.kind === 'D') throw new HttpError(409, `NF-e denegada pelo fisco (${o.authorityCode}): a nota existe no fisco e não se retransmite`, [{ field: 'authorityCode', message: String(o.authorityCode) }, ...at], 'FISCAL_DENIED')
  if (o.kind === 'F') throw new HttpError(502, o.message, at, ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED)
  // nada concluiu (ambíguo, 204/539, 106…): a tentativa fica EM VOO e a saída é consultar (D-NE34/D-NE36)
  throw new HttpError(502, 'O fisco não concluiu a autorização: a tentativa ficou em voo — consulte a situação pela nossa chave', [...at, { field: 'next', message: r.next ?? 'consult-key' }, ...(r.incident ? [{ field: 'incident', message: r.incident }] : [])], ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
}

export async function transmit(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef): Promise<TransmitResponse> {
  return responseOfTransmit(await transmitInvoice(nfeDepsOf(ctx), actorOf(inst), ref))
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
  return responseOfRefresh(await refreshInvoice(nfeDepsOf(ctx), actorOf(inst), ref, { all }))
}

export async function reconfirm(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef): Promise<{ invoiceId: number; attempt: number; accessKey: string; recorded: boolean; reason: ReconfirmResult['reason']; refresh: RefreshResponse | null }> {
  const r = await reconfirmNotRegistered(nfeDepsOf(ctx), actorOf(inst), ref)
  return { invoiceId: r.invoiceId, attempt: r.attempt, accessKey: r.accessKey, recorded: r.recorded, reason: r.reason, refresh: r.refresh ? responseOfRefresh(r.refresh) : null }
}

const STATE_OF_NONE = 'none' as const

/** A situação fiscal da nota na VIDA vigente: as tentativas, as vozes e o estado derivado da última voz. Instantes na zona do estabelecimento (Q-TZ1). */
export async function fiscalView(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef): Promise<Record<string, unknown>> {
  const life = await erp.invoiceLife(ctx.pool, inst.schemaName, ref)
  if (!life) throw new HttpError(404, `Nota ${ref.invoiceId} não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
  const lifeEvent = life.lifeEvent
  const attempts: AttemptRow[] = lifeEvent === null ? [] : await attemptsOfLife(ctx.pool, ref, lifeEvent)
  const voices = lifeEvent === null ? [] : await voicesOfLife(ctx.pool, ref, lifeEvent)
  const zone = await erp.institutionZone(ctx.pool, inst.schemaName, inst.institutionId)
  const wall = (v: string | null): string | null => (v ? toZoneWall(v, zone) : null)
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
    localCancelPending: false, cancelDeadline: null,
    xmlAvailable: !!(latest && key && ctx.storage.find(key, `${latest.accessKey}-nfe.xml`, [latest.dhEmission]) !== null),
    danfeAvailable: false,
  }
}
