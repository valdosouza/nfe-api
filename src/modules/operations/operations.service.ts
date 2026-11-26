import { ErrorCodes, HttpError, WEB_TERMINAL, acquireRefreshLease, erp, getIssuer, logger, openIssuer, releaseRefreshLease, toZoneWall, type InstitutionPayload } from 'fiscal-api'
import type { Environment } from '../../authority/authorizers'
import type { AppContext } from '../../context'
import { readNumbering, type NumberingView } from '../../nfe/numbering'
import { refreshAll } from '../../nfe/refresh-all'
import { findVoidItem, listVoids, voidRange, type VoidListItem, type VoidResult } from '../../nfe/void-range'
import { reportIncident } from '../../mail/ops-alert'
import { probeAuthorityStatus } from '../../authority/status-probe'
import { readEmitter } from '../../facts/merchandise-facts'
import { emitterFromParty } from '../../nfe/void-range'
import { actorOf, nfeDepsOf, voidDepsOf } from '../nfe-deps'
import type { NumberingQueryDto, RefreshRunDto, VoidDto, VoidsQueryDto } from './operations.dto'

/**
 * A borda de serviço das operações do ESTABELECIMENTO (NFE.E6.P4 mudança 5): a passada do rodízio, a numeração do 55 e os pedidos de inutilização. A regra mora em `src/nfe`
 * (`refresh-all.ts`, `numbering.ts`, `void-range.ts`); aqui se monta as dependências (`nfe-deps.ts`), se traduz o resultado para o contrato e se converte os instantes à zona do estabelecimento.
 */

/** O aluguel da passada por estabelecimento (molde da nfse-api): quem não obtém recebe 200 `skipped`. Mais que o tempo de uma passada de 50 notas com o fisco lento. */
export const REFRESH_LEASE_SECONDS = 600
const MODEL = '55' as const

export interface RefreshRunView {
  checked: number; changed: number; stoppedEarly: boolean; skipped: boolean; throttled: number; circuitOpen: boolean
  errors: { invoiceId: number; code: string | null; message: string }[]
}
const IDLE: RefreshRunView = { checked: 0, changed: 0, stoppedEarly: false, skipped: true, throttled: 0, circuitOpen: false, errors: [] }

export async function refreshRun(ctx: AppContext, inst: InstitutionPayload, body: RefreshRunDto): Promise<RefreshRunView> {
  const token = await acquireRefreshLease(ctx.pool as never, inst.institutionId, MODEL, REFRESH_LEASE_SECONDS)
  if (token === null) return IDLE                                                    // outra passada deste estabelecimento está rodando
  try {
    await probeStatus(ctx, inst)                                                  // D-NE54 c: alimenta o quadro do health (no máximo a cada 3 min por autorizador)
    const r = await refreshAll(nfeDepsOf(ctx), actorOf(inst), { limit: body.limit })
    for (const i of r.incidents) reportIncident(ctx, { route: 'refresh-all', institutionId: inst.institutionId, invoiceId: i.invoiceId, accessKey: null, incident: i.incident })    // D-NE237
    return {
      checked: r.consulted, changed: r.changed, stoppedEarly: r.circuitOpen, skipped: false, throttled: r.throttled, circuitOpen: r.circuitOpen,
      errors: r.incidents.map(i => ({ invoiceId: i.invoiceId, code: i.incident, message: i.incident })),
    }
  } finally {
    await releaseRefreshLease(ctx.pool as never, inst.institutionId, MODEL, token)
  }
}

/**
 * A sondagem do status do serviço (D-NE54 c): com o A1 do estabelecimento que roda a passada, UM `consStatServ` do autorizador dele (teto de 3 min no quadro). Nunca derruba a passada: qualquer
 * falha (sem habilitação, A1, cadastro do emitente, fisco) vira log e a passada segue.
 */
export async function probeStatus(ctx: AppContext, inst: InstitutionPayload, request?: Parameters<typeof probeAuthorityStatus>[2]): Promise<void> {
  if (!ctx.statusBoard) return
  try {
    const issuer = await getIssuer(ctx.pool as never, inst.institutionId, MODEL)
    if (!issuer) return
    const emitter = emitterFromParty(await readEmitter(ctx.pool, inst.schemaName, inst.institutionId))
    const opened = await openIssuer({ pool: ctx.pool, keyring: ctx.keyring }, inst.institutionId, MODEL, { schemaName: inst.schemaName })
    ctx.checkServerCa?.()
    await probeAuthorityStatus(ctx.statusBoard, { uf: emitter.uf, hasStateRegistration: emitter.hasStateRegistration, environment: issuer.environment as Environment, cert: opened.cert, key: opened.key, ca: ctx.serverCa.pem as never, now: new Date() }, request)
  } catch (e) {
    logger.warn('Sondagem do status do autorizador não feita', { error: e instanceof Error ? e.name : 'erro' })
  }
}

/** O pedido de inutilização como o contrato o publica (`serie` texto, `dh` na zona do estabelecimento — Q-TZ1). */
export function voidView(v: VoidListItem, zone: string) {
  return { id: v.id, environment: v.environment, serie: String(v.serie), year: v.year, from: v.from, to: v.to, reason: v.reason, voidId: v.voidId, state: v.state, authorityCode: v.authorityCode, protocol: v.protocol, dh: v.dh ? toZoneWall(v.dh, zone) : null }
}

export interface NumberingResponse { serie: string; environment: Environment; highestNumber: number | null; gaps: NumberingView['gaps']; voids: ReturnType<typeof voidView>[] }

export async function numbering(ctx: AppContext, inst: InstitutionPayload, q: NumberingQueryDto): Promise<NumberingResponse> {
  const environment = q.environment ?? (await issuerEnvironment(ctx, inst))
  const zone = await erp.institutionZone(ctx.pool, inst.schemaName, inst.institutionId)
  const serie = Number(q.serie)
  const view = await readNumbering(ctx.pool as never, ctx.fiscalDb, inst.schemaName, { institutionId: inst.institutionId, terminal: WEB_TERMINAL }, serie, environment, utc => (toZoneWall(utc, zone) ?? utc).slice(0, 7))
  // as faixas inutilizadas da série e do ambiente (a tela as mostra ao lado dos buracos)
  const voids = (await listVoids(ctx.pool as never, inst.institutionId, 1, 100)).items.filter(v => v.serie === serie && v.environment === environment)
  return { serie: q.serie, environment, highestNumber: view.highestNumber, gaps: view.gaps, voids: voids.map(v => voidView(v, zone)) }
}

async function issuerEnvironment(ctx: AppContext, inst: InstitutionPayload): Promise<Environment> {
  const issuer = await getIssuer(ctx.pool as never, inst.institutionId, MODEL)
  if (!issuer) throw new HttpError(404, 'Estabelecimento sem habilitação do modelo 55 — informe o ambiente ou habilite o emitente', undefined, ErrorCodes.FISCAL_ISSUER_MISSING)
  return issuer.environment as Environment
}

export async function listVoidRequests(ctx: AppContext, inst: InstitutionPayload, q: VoidsQueryDto) {
  const zone = await erp.institutionZone(ctx.pool, inst.schemaName, inst.institutionId)
  const r = await listVoids(ctx.pool as never, inst.institutionId, q.page, q.pageSize)
  return { page: q.page, pageSize: q.pageSize, total: r.total, data: r.items.map(v => voidView(v, zone)) }
}

/**
 * Pede a inutilização da faixa: homologada (102, ou confirmada pelo 563) = 201 com o pedido inteiro; o ambíguo (sem resposta) fica pendente e a saída é reenviar a MESMA faixa (502); o que o SERVIÇO
 * recusou (656…) é 503. A rejeição da faixa (256, 201…) já sobe do `voidRange` como 422 `FISCAL_VOID_REJECTED`.
 */
export async function requestVoid(ctx: AppContext, inst: InstitutionPayload, body: VoidDto): Promise<ReturnType<typeof voidView> & { incident?: VoidResult['incident'] }> {
  const r = await voidRange(voidDepsOf(ctx), actorOf(inst), { serie: Number(body.serie), year: body.year, from: body.from, to: body.to, reason: body.reason })
  const fields = [{ field: 'voidId', message: r.voidId }, { field: 'next', message: 'resend-same-range' }, ...(r.incident ? [{ field: 'incident', message: r.incident }] : [])]
  if (r.state === 'in-flight' && r.refusedCStat) throw new HttpError(503, `O serviço do fisco recusou o pedido (${r.refusedCStat}): a faixa ficou pendente — reenvie a MESMA faixa depois`, [...fields, { field: 'authorityCode', message: r.refusedCStat }], ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE)
  if (r.state === 'in-flight') throw new HttpError(502, 'O fisco não respondeu à inutilização: a faixa ficou pendente — reenvie a MESMA faixa (o 563 fecha o pedido)', fields, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
  const row = await findVoidItem(ctx.pool as never, inst.institutionId, r.id)
  const zone = await erp.institutionZone(ctx.pool, inst.schemaName, inst.institutionId)
  if (!row) throw new HttpError(409, 'O pedido de inutilização não foi achado depois de gravado — tente de novo', undefined, ErrorCodes.RESOURCE_BUSY)
  return { ...voidView(row, zone), ...(r.incident ? { incident: r.incident } : {}) }
}
