import { erp, readWithdrawnRanges, type Queryable } from 'fiscal-api'
import { attemptsOfSerie, highestAttemptNumber } from './attempt'
import type { Environment } from '../authority/authorizers'

/**
 * A numeração do 55 por série (NFE.E6.P4 mudança 2; contrato `Numbering`; S-9): leitura DERIVADA, nunca tabela, SEM trava. `highestNumber` = o último número JÁ GERADO pela nfe-api (D-NE257:
 * o contador é desta API; qualquer tentativa, viva ou não); os BURACOS são os números do 1º gerado (limite de baixo — o legado abaixo dele nunca é buraco nosso) até ele, sem dono e fora de faixa retirada. Dono (o mesmo critério de `findNumberOwner`): a tentativa
 * REGISTRADA no fisco (protocolo), sempre; ou a sem protocolo da vida ATUAL de uma nota viva (que reaproveita o número — D-NE282). A faixa retirada (pendente ou inutilizada) vem da view do núcleo
 * (`readWithdrawnRanges`). `oldestInvoiceMonth` = o mês (AAAA-MM, da zona do estabelecimento, pela emissão da tentativa mais antiga que passou por números do buraco); null se nenhum número do
 * buraco teve tentativa — o prazo legal de inutilizar é o 10º dia do mês seguinte (a tela avisa).
 */
export interface NumberGap { readonly from: number; readonly to: number; readonly oldestInvoiceMonth: string | null }
export interface NumberingView { readonly serie: number; readonly environment: Environment; readonly highestNumber: number | null; readonly gaps: readonly NumberGap[] }

export async function readNumbering(q: Queryable, db: string, schemaName: string, scope: { institutionId: number; terminal: number }, serie: number, environment: Environment, toZoneMonth: (utc: string) => string): Promise<NumberingView> {
  const highest = await highestAttemptNumber(q, scope.institutionId, environment, serie)
  if (highest === null) return { serie, environment, highestNumber: null, gaps: [] }
  const [attempts, ranges] = await Promise.all([
    attemptsOfSerie(q, scope.institutionId, environment, serie),
    readWithdrawnRanges(q as never, db, { institutionId: scope.institutionId, model: '55', serie, environment }),
  ])
  const owned = new Set<number>()
  const open = attempts.filter(a => a.protocol === null)
  for (const a of attempts) if (a.protocol !== null) owned.add(a.number)
  const byInvoice = new Map<number, typeof open>()
  for (const a of open) byInvoice.set(a.invoiceId, [...(byInvoice.get(a.invoiceId) ?? []), a])
  const ids = [...byInvoice.keys()]
  for (let i = 0; i < ids.length; i += 500) {
    const lives = await erp.invoiceLives(q, schemaName, scope, ids.slice(i, i + 500))
    for (const id of ids.slice(i, i + 500)) {
      const life = lives.get(id)
      for (const a of byInvoice.get(id) ?? []) if (life && !life.invoiceDeleted && life.lifeEvent !== null && life.lifeEvent === a.lifeEvent) owned.add(a.number)
    }
  }
  const withdrawn = (n: number): boolean => ranges.some(r => n >= r.numberFrom && n <= r.numberTo)
  const firstDh = new Map<number, string>()                                         // número → a emissão mais antiga das tentativas dele
  for (const a of attempts) if (!firstDh.has(a.number) || a.dhEmission < (firstDh.get(a.number) as string)) firstDh.set(a.number, a.dhEmission)
  const gaps: NumberGap[] = []
  let start: number | null = null
  const close = (end: number): void => {
    if (start === null) return
    let oldest: string | null = null
    for (let n = start; n <= end; n++) { const d = firstDh.get(n); if (d && (oldest === null || d < oldest)) oldest = d }
    gaps.push({ from: start, to: end, oldestInvoiceMonth: oldest === null ? null : toZoneMonth(oldest) })
    start = null
  }
  // o limite de baixo é o 1º número gerado por ESTA API na série e no ambiente (a sequência pode ter sido aberta em N > 1 para continuar a numeração do legado — D-NE265): os números do legado
  // abaixo dele NUNCA são buraco nosso (inutilizá-los queimaria nota do ERP Desktop)
  const lowest = attempts.length > 0 ? attempts[0].number : highest
  for (let n = lowest; n <= highest; n++) {
    const hole = !owned.has(n) && !withdrawn(n)
    if (hole && start === null) start = n
    if (!hole) close(n - 1)
  }
  close(highest)
  return { serie, environment, highestNumber: highest, gaps }
}
