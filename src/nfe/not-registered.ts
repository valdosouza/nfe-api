import type { InvoiceRef } from 'fiscal-api'
import { MERCHANDISE_TRANSMISSION_TABLE, MERCHANDISE_VOICE_FAMILY } from './voice-family'

/**
 * O FATO "o fisco não registrou esta nota" (NFE.E6.P1 — D-NE111, D-NE235; migration 002 desta API). É FATO da tentativa, nunca voz. O ÚNICO escritor da
 * coluna `nfe_not_registered_at` (cerca no teste): o `refresh` nunca a grava — só a rota `reconfirm`, depois de conferir o 217, a `chNFe`, a ausência de
 * recibo em aberto e o autorizador da tentativa (conferências do `reconcile`, sob a trava da nota).
 */

type Q = { query(sql: string, params?: unknown): Promise<[any, any]> }

/**
 * Grava o instante (relógio nosso, UTC) UMA vez, e só se NENHUMA voz nova entrou na tentativa depois da que a pergunta viu (`seenEvent` = o maior
 * nº de evento visto, 0 se a tentativa não tinha voz): o write-once e "a última voz ainda é a que a pergunta viu" são a MESMA instrução, sem janela.
 * Devolve `true` se gravou, `false` se já estava gravado, se entrou voz nova ou se a tentativa não existe.
 */
export async function recordNfeNotRegistered(q: Q, ref: InvoiceRef, attempt: number, seenEvent: number): Promise<boolean> {
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(seenEvent) || seenEvent < 0) throw new Error('recordNfeNotRegistered: tentativa e evento visto inteiros')
  const [res] = await q.query(
    `UPDATE ${MERCHANDISE_TRANSMISSION_TABLE} SET nfe_not_registered_at = NOW(), updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND attempt = ? AND deleted = 'N'
        AND nfe_not_registered_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ${MERCHANDISE_VOICE_FAMILY.eventTable} e
                         WHERE e.tb_institution_id = ? AND e.tb_invoice_id = ? AND e.terminal = ? AND e.attempt = ? AND e.event > ?)`,
    [ref.institutionId, ref.invoiceId, ref.terminal, attempt, ref.institutionId, ref.invoiceId, ref.terminal, attempt, seenEvent])
  return Number((res as { affectedRows?: number } | undefined)?.affectedRows ?? 0) === 1
}

/**
 * Sonda do boot: a coluna existe, é DATETIME e aceita NULL (a 002 foi aplicada). `CREATE`/`ALTER ... IF NOT EXISTS` mantém calado um banco que não
 * recebeu a migration; falha ALTO com o diagnóstico, nunca "sobe e descobre no 1º reconfirm".
 */
export async function assertNfeNotRegisteredColumn(q: Q): Promise<void> {
  const [rows] = await q.query(
    `SELECT DATA_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'nfe_not_registered_at'`,
    [MERCHANDISE_TRANSMISSION_TABLE])
  const r = Array.isArray(rows) ? rows[0] : undefined
  if (!r || String(r.type).toLowerCase() !== 'datetime' || String(r.nullable).toUpperCase() !== 'YES') {
    throw new Error(`A coluna nfe_not_registered_at de ${MERCHANDISE_TRANSMISSION_TABLE} (D-NE111) não está como a migration 002 a cria: aplicar \`npm run db:migrate\` antes de subir`)
  }
}
