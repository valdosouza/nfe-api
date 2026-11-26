import type { Environment } from './authorizers'

/**
 * O QUADRO do estado por autorizador (NFE.E6.P4 mudança 8; D-NE54 c; contrato `Health.authorities`): o ÚLTIMO `consStatServ` de cada autorizador × ambiente CONSULTADO, em memória do processo (cai com
 * o reinício — o fisco é quem sabe). Quem consulta é a passada do rodízio (`status-probe.ts`, com o A1 de um estabelecimento — o health não tem certificado e nunca fala com o fisco); o health só LÊ o
 * quadro. Teto de frequência: nunca mais que uma pergunta por autorizador × ambiente a cada 3 minutos (MOC; mais que isso o fisco responde 656).
 */
export const STATUS_MIN_INTERVAL_MS = 3 * 60_000

export interface AuthorityStatus { readonly authorizer: string; readonly environment: Environment; readonly cStat: string; readonly checkedAt: string }

export class StatusBoard {
  private readonly last = new Map<string, AuthorityStatus & { readonly at: number }>()
  private readonly asked = new Map<string, number>()
  constructor(private readonly now: () => Date) {}

  private static key(authorizer: string, environment: Environment): string { return `${authorizer}|${environment}` }

  /** Está na hora de perguntar? Marca a pergunta JÁ (mesmo que o fisco não responda — a falha também respeita o teto). */
  due(authorizer: string, environment: Environment): boolean {
    const k = StatusBoard.key(authorizer, environment)
    const at = this.now().getTime()
    const prev = this.asked.get(k)
    if (prev !== undefined && at - prev < STATUS_MIN_INTERVAL_MS) return false
    this.asked.set(k, at)
    return true
  }

  /** Grava a resposta do fisco (107 em operação; 108/109 paralisado). */
  record(authorizer: string, environment: Environment, cStat: string): void {
    const at = this.now().getTime()
    this.last.set(StatusBoard.key(authorizer, environment), { authorizer, environment, cStat, checkedAt: new Date(at).toISOString(), at })
  }

  /** Do contrato: só o que foi consultado, em ordem estável (autorizador, ambiente). */
  list(): AuthorityStatus[] {
    return [...this.last.values()].sort((a, b) => (a.authorizer + a.environment).localeCompare(b.authorizer + b.environment))
      .map(({ authorizer, environment, cStat, checkedAt }) => ({ authorizer, environment, cStat, checkedAt }))
  }
}
