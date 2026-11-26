import { erp, type Queryable } from 'fiscal-api'
import { listBilledMerchandise, orderInterfacesOf } from '../facts/nfe-lists'
import { attemptsOfInvoices, type AttemptRow } from './attempt'

/**
 * A lista `GET /v1/nfe/invoices/pending` (NFE.E6.P4 mudança 2; contrato `openapi/nfe-api.v1.yaml`): as notas faturadas SEM NF-e viva, autorizada ou denegada. Fora da lista: a nota sem vida
 * (apagada, ou sem o evento E — nunca transmite, S-A da P1), a de vida cancelada e a cuja ÚLTIMA voz da vida vigente é P, A, D, K ou C; a reserva sem voz (em voo) também fica fora. Só os ramos
 * pedidos (o chamador passa os CONTRATADOS — D-F14/D-F37; nenhum = lista vazia). Ordem estável: a mais antiga primeiro, depois o id. Leitura por lote, sem junção com view.
 */
export interface PendingItem { readonly invoiceId: number; readonly number: string | null; readonly serie: string | null; readonly dtEmission: string; readonly finality: '1' | '4'; readonly interfaceKey: 'orders' | 'order-returns' }
export interface PendingPage { readonly total: number; readonly items: readonly PendingItem[] }

const BATCH = 500
export const PENDING_EXCLUDED_KINDS: ReadonlySet<string> = new Set(['P', 'A', 'D', 'K', 'C'])
const chunks = <T>(list: readonly T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < list.length; i += BATCH) out.push(list.slice(i, i + BATCH)); return out }

export async function listPending(q: Queryable, schemaName: string, scope: { institutionId: number; terminal: number }, opts: { page: number; pageSize: number; allowed: readonly ('orders' | 'order-returns')[] }): Promise<PendingPage> {
  if (opts.allowed.length === 0) return { total: 0, items: [] }
  const billed = await listBilledMerchandise(q, schemaName, scope.institutionId, scope.terminal)
  const kept: PendingItem[] = []
  for (const batch of chunks(billed)) {
    const ids = batch.map(b => b.invoiceId)
    const [lives, interfaces, attempts] = await Promise.all([
      erp.invoiceLives(q, schemaName, scope, ids),
      orderInterfacesOf(q, schemaName, scope.institutionId, scope.terminal, ids),
      attemptsOfInvoices(q, scope.institutionId, scope.terminal, ids),
    ])
    const latest = new Map<string, AttemptRow>()                                    // (nota, vida) → a última tentativa
    for (const a of attempts) latest.set(`${a.invoiceId}|${a.lifeEvent}`, a)       // da mais antiga à mais nova: a última sobrescreve
    for (const b of batch) {
      const life = lives.get(b.invoiceId)
      if (!life || life.invoiceDeleted || life.lifeEvent === null || life.lastKind !== 'E') continue
      const key = interfaces.get(b.invoiceId) ?? 'orders'
      if (key !== 'orders' && key !== 'order-returns') continue                       // a nota de serviço não é do 55
      if (!opts.allowed.includes(key)) continue
      const last = latest.get(`${b.invoiceId}|${life.lifeEvent}`)
      if (last && (last.lastKind === null || PENDING_EXCLUDED_KINDS.has(last.lastKind))) continue   // em voo (sem voz) e as vozes que tiram a nota da fila
      kept.push({ invoiceId: b.invoiceId, number: b.number, serie: b.serie, dtEmission: b.dtEmission, finality: key === 'order-returns' ? '4' : '1', interfaceKey: key })
    }
  }
  const from = (opts.page - 1) * opts.pageSize
  return { total: kept.length, items: kept.slice(from, from + opts.pageSize) }
}
