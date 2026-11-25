import { ErrorCodes, HttpError } from 'fiscal-api'
import type { Environment } from '../authority/authorizers'

/**
 * O DISJUNTOR contra o 656 — consumo indevido (NFE.E6.P2.T3 — D-NE26, D-NE54, D-NE254; RF-NFE-17, RF-NFE-74, RF-NFE-84). Estado EM MEMÓRIA do processo (D-NE54: `breakerOf(cnpj)`), por CNPJ × ambiente × serviço
 * (o bloqueio do fisco é por serviço, não pelo CNPJ inteiro — D-NE254). O padrão nacional, "o nacional no limite" (o PR não publica os parâmetros): até 20 rejeições IGUAIS em evento ou inutilização
 * e até 30 na autorização por hora passam — a seguinte é barrada aqui, antes de a SEFAZ barrar. O 656 DEVOLVIDO pelo fisco abre o disjuntor por 1 hora. Nunca fecha tentativa nem libera número (RF-NFE-74):
 * só diz "ainda não" (429 `RESOURCE_BUSY`).
 */
export type BreakerService = 'autorizacao' | 'evento' | 'inutilizacao' | 'consulta'
export interface BreakerScope { readonly cnpj: string; readonly environment: Environment; readonly service: BreakerService }

/** Rejeições iguais por hora que ainda passam (o padrão nacional; a constante datada do PR recebe o nacional — D-NE254). */
export const BREAKER_SAME_REJECTIONS_PER_HOUR: Readonly<Record<BreakerService, number | null>> = Object.freeze({ autorizacao: 30, evento: 20, inutilizacao: 20, consulta: null })
export const BREAKER_WINDOW_MS = 3_600_000
export const BREAKER_BLOCK_MS = 3_600_000

const keyOf = (s: BreakerScope): string => `${s.cnpj}|${s.environment}|${s.service}`

export class Breaker {
  private readonly openUntil = new Map<string, number>()
  private readonly rejections = new Map<string, number[]>()
  constructor(private readonly now: () => Date) {}

  private prune(k: string, at: number): number[] {
    const kept = (this.rejections.get(k) ?? []).filter(t => at - t < BREAKER_WINDOW_MS)
    this.rejections.set(k, kept)
    return kept
  }

  /** Barra (429) enquanto o serviço está bloqueado ou a hora já tem o limite de rejeições IGUAIS; não conta nada. */
  check(scope: BreakerScope): void {
    const at = this.now().getTime()
    const until = this.openUntil.get(keyOf(scope)) ?? 0
    if (until > at) throw new HttpError(429, 'O serviço do fisco recusou por consumo indevido — aguarde antes de tentar de novo (disjuntor)', [{ field: 'service', message: scope.service }, { field: 'retryAfterSeconds', message: String(Math.ceil((until - at) / 1000)) }], ErrorCodes.RESOURCE_BUSY)
    const limit = BREAKER_SAME_REJECTIONS_PER_HOUR[scope.service]
    if (limit === null) return
    for (const [k, list] of this.rejections) {
      if (!k.startsWith(`${keyOf(scope)}|`)) continue
      if (this.prune(k, at).length >= limit) throw new HttpError(429, `Já houve ${limit} rejeições iguais na última hora neste serviço — corrija antes de tentar de novo (disjuntor, D-NE254)`, [{ field: 'authorityCode', message: k.slice(keyOf(scope).length + 1) }], ErrorCodes.RESOURCE_BUSY)
    }
  }

  /** O fisco RECUSOU a pergunta: o 656 (consumo indevido) abre o serviço por 1 hora; 108/109/999 (serviço fora, erro interno) só abrem a CONSULTA (o rodízio para de perguntar) — nunca o evento nem a inutilização. */
  recordRefused(scope: BreakerScope, cStat: string): void {
    if (cStat !== '656' && scope.service !== 'consulta') return
    this.openUntil.set(keyOf(scope), this.now().getTime() + BREAKER_BLOCK_MS)
  }

  /** Uma rejeição do fisco com este cStat: conta na janela de 1 hora. */
  recordRejection(scope: BreakerScope, cStat: string): void {
    const k = `${keyOf(scope)}|${cStat}`
    const at = this.now().getTime()
    this.prune(k, at).push(at)
  }

  /** O que está aberto agora (para o `/health` futuro e para o relatório do rodízio). */
  isOpen(scope: BreakerScope): boolean { return (this.openUntil.get(keyOf(scope)) ?? 0) > this.now().getTime() }
}
