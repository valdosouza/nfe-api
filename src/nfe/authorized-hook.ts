import { logger, type InvoiceRef } from 'fiscal-api'
import type { NfeActor } from './transmission'

/**
 * O gancho "a NF-e passou a AUTORIZADA" (NFE.E6.P4 mudança 7; D-NE261 via automática; parecer do `setes-conceito`: o fato é "passou a A", não "transmitiu"). A voz A nasce em DOIS lugares
 * (`transmission.ts`, no envio, e `reconcile.ts`, na consulta que resolve a tentativa em voo) e os dois chamam ESTE ponto único, só depois de gravar a voz E o `-procNFe.xml` e só quando ESTA chamada
 * gravou a voz (consulta que apenas lê o A não dispara: é o dedup mínimo, sem tabela). É efeito pós-fato: fora de qualquer transação, nunca desfaz o A — qualquer falha vai ao log, sem conteúdo.
 */

export interface AuthorizedEvent { readonly actor: NfeActor; readonly ref: InvoiceRef; readonly attempt: number; readonly accessKey: string }
export type OnAuthorized = (e: AuthorizedEvent) => Promise<void>

export async function notifyAuthorized(deps: { readonly onAuthorized?: OnAuthorized }, e: AuthorizedEvent): Promise<void> {
  if (!deps.onAuthorized) return
  try { await deps.onAuthorized(e) } catch (err) {
    logger.warn('Pós-autorização falhou; a NF-e segue autorizada', { accessKey: e.accessKey, error: err instanceof Error ? err.name : 'erro' })
  }
}
