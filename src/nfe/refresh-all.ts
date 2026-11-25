import { ErrorCodes, HttpError, type InvoiceRef, invoiceRef } from 'fiscal-api'
import type { Environment, Uf } from '../authority/authorizers'
import { cancelDeadlineHours } from '../authority/cancel-deadlines'
import { ufOfCode } from '../authority/messages'
import { refreshInvoice, type ReconcileDeps, type RefreshResult } from './reconcile'
import { assertFamilyOf, type NfeActor, type NfeDeps } from './transmission'
import { MERCHANDISE_TRANSMISSION_TABLE, MERCHANDISE_VOICE_FAMILY } from './voice-family'

/**
 * O RODÍZIO (NFE.E6.P2.T3 — ficha-nfe-e6-p2-cancelar-inutilizar-rodizio.md §7-6; D-NE26, D-NE54, D-NE254, D-NE256; RF-NFE-17, RF-NFE-74; S3 e S5): reconcilia, estabelecimento por estabelecimento, as tentativas
 * ABERTAS — sem voz (em voo), P (recibo) e K (cancelamento em voo) — consultando o fisco pela nossa chave ou pelo recibo, pelo MESMO `refreshInvoice` da consulta por nota (cota por chave de 6 min,
 * K reconciliado em C ou, depois da carência, N). Nada de efeito no ERP (o setes-api lê a voz). Duas travas:
 *  - o TETO DE IDADE: tentativa aberta mais velha que o prazo de cancelamento da UF + uma margem não é mais consultada pelo rodízio (a consulta por nota e a `reconfirm` seguem valendo);
 *  - o DISJUNTOR (D-NE254): com o serviço de consulta bloqueado (656 devolvido pelo fisco) a passada PARA (`circuitOpen`); a consulta recusada abre o disjuntor.
 * O rodízio NÃO reenvia inutilização pendente (S3): a faixa pendente só se resolve pelo reenvio explícito da MESMA faixa.
 */

/** A margem somada ao prazo de cancelamento da UF para o teto de idade do rodízio (horas). */
export const ROUNDROBIN_AGE_MARGIN_HOURS = 24
/** Quantas tentativas uma passada olha, no máximo. */
export const ROUNDROBIN_DEFAULT_LIMIT = 50

export interface RefreshRunReport {
  /** Tentativas abertas olhadas nesta passada. */
  readonly scanned: number
  /** Notas efetivamente consultadas no fisco. */
  readonly consulted: number
  /** Puladas pela cota de intervalo por chave/recibo (429 da consulta). */
  readonly throttled: number
  /** Puladas pelo teto de idade (prazo da UF + margem). */
  readonly tooOld: number
  /** O disjuntor da consulta estava (ou ficou) aberto: a passada parou. */
  readonly circuitOpen: boolean
  /** Notas cuja voz mudou (A, D, R, P, C, N…). */
  readonly changed: number
  /** Pendências críticas devolvidas pelas consultas (`incident`). */
  readonly incidents: readonly { readonly invoiceId: number; readonly incident: string }[]
  readonly results: readonly RefreshResult[]
}

export type RefreshAllDeps = ReconcileDeps & Pick<NfeDeps, 'breaker' | 'catalog'>

interface Candidate { readonly ref: InvoiceRef; readonly accessKey: string; readonly environment: Environment; readonly lastKind: string | null; readonly since: string | null }

/** As tentativas abertas do estabelecimento (sem voz, P ou K na ÚLTIMA voz), as menos consultadas primeiro; uma por nota. */
async function openAttempts(q: { query(sql: string, params?: unknown[]): Promise<[any, any]> }, institutionId: number, limit: number): Promise<Candidate[]> {
  const EV = MERCHANDISE_VOICE_FAMILY.eventTable
  const [rows] = await q.query(
    `SELECT t.tb_invoice_id AS invoiceId, t.terminal, t.attempt, t.access_key AS accessKey, t.environment, e.kind AS lastKind, DATE_FORMAT(COALESCE(e.created_at, t.created_at), '%Y-%m-%d %H:%i:%s') AS since
       FROM ${MERCHANDISE_TRANSMISSION_TABLE} t
       LEFT JOIN ${EV} e ON e.tb_institution_id = t.tb_institution_id AND e.tb_invoice_id = t.tb_invoice_id AND e.terminal = t.terminal AND e.attempt = t.attempt AND e.deleted = 'N'
        AND e.event = (SELECT MAX(x.event) FROM ${EV} x WHERE x.tb_institution_id = t.tb_institution_id AND x.tb_invoice_id = t.tb_invoice_id AND x.terminal = t.terminal AND x.attempt = t.attempt AND x.deleted = 'N')
      WHERE t.tb_institution_id = ? AND t.deleted = 'N' AND (e.kind IS NULL OR e.kind IN ('P', 'K'))
      ORDER BY t.last_queried_at IS NOT NULL, t.last_queried_at ASC, t.tb_invoice_id ASC LIMIT ?`,
    [institutionId, limit])
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = `${r.invoiceId}/${r.terminal}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ ref: invoiceRef(institutionId, Number(r.invoiceId), Number(r.terminal)), accessKey: String(r.accessKey), environment: r.environment === 'P' ? 'P' : 'H', lastKind: r.lastKind == null ? null : String(r.lastKind), since: r.since == null ? null : String(r.since) })
  }
  return out
}

const utcMs = (dbUtc: string | null): number | null => {
  const t = dbUtc ? Date.parse(`${dbUtc.replace(' ', 'T')}Z`) : NaN
  return Number.isNaN(t) ? null : t
}

export async function refreshAll(deps: RefreshAllDeps, actor: NfeActor, opts: { limit?: number } = {}): Promise<RefreshRunReport> {
  assertFamilyOf(deps)
  const limit = Number.isInteger(opts.limit) && (opts.limit as number) > 0 ? Math.min(opts.limit as number, 500) : ROUNDROBIN_DEFAULT_LIMIT
  const candidates = await openAttempts(deps.pool as never, actor.institutionId, limit)
  const now = deps.now().getTime()
  const results: RefreshResult[] = []
  const incidents: { invoiceId: number; incident: string }[] = []
  let consulted = 0, throttled = 0, tooOld = 0, changed = 0, circuitOpen = false
  for (const c of candidates) {
    const uf = ufOfCode(c.accessKey.slice(0, 2)) as Uf | null
    const cap = (uf === null ? 24 : cancelDeadlineHours(uf, deps.now())) + ROUNDROBIN_AGE_MARGIN_HOURS
    const since = utcMs(c.since)
    if (since !== null && (now - since) / 3_600_000 > cap) { tooOld++; continue }
    const scope = { cnpj: c.accessKey.slice(6, 20), environment: c.environment, service: 'consulta' } as const
    try { deps.breaker?.check(scope) } catch (e) {
      if (e instanceof HttpError && e.code === ErrorCodes.RESOURCE_BUSY) { circuitOpen = true; break }
      throw e
    }
    try {
      const r = await refreshInvoice(deps, actor, c.ref)
      consulted++
      results.push(r)
      if (r.incident) incidents.push({ invoiceId: r.invoiceId, incident: r.incident })
      if (r.outcome.kind !== 'none') changed++
      // a consulta RECUSADA pelo serviço (656, 108/109, 999) abre o disjuntor da consulta e encerra a passada (RF-NFE-74: nunca fecha tentativa)
      if (r.outcome.kind === 'none' && r.outcome.reason === 'consulta-recusada') { deps.breaker?.recordRefused(scope, '656'); circuitOpen = true; break }
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 429) { throttled++; continue }                   // a cota por chave/recibo: a próxima volta a pega
      throw e
    }
  }
  return { scanned: candidates.length, consulted, throttled, tooOld, circuitOpen, changed, incidents, results }
}
