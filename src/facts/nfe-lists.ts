import { Queryable, assertSchema } from 'fiscal-api'

/**
 * Leituras do ERP para as listas e para o e-mail da NF-e (NFE.E6.P4 mudança 2; ficha §5 e S-5/S-6). D-F10: a tabela do ERP só é nomeada em `src/facts`; D-F31: só SELECT.
 * Nenhuma view entra como lado de dentro de uma junção (a `vw_invoice_life` materializou o schema inteiro no dev — NFE.E6.P1, 2 min): as views vão em leitura própria, por lote,
 * com o WHERE, na forma que o MariaDB funde.
 */

const txt = (v: unknown): string | null => (v == null ? null : String(v))

/** A nota faturada com ramo de mercadoria do estabelecimento, como o ERP a tem (a vida e o ramo da interface vêm de leituras por lote, não daqui). */
export interface BilledInvoice {
  readonly invoiceId: number
  readonly number: string | null
  readonly serie: string | null
  readonly dtEmission: string
}

/**
 * As notas VIVAS do estabelecimento com ramo de mercadoria (as que podem gerar NF-e), da mais antiga à mais nova (data, id). Só tabelas: o cabeçalho da nota emitida POR este estabelecimento e o ramo de
 * mercadoria vivo — o mesmo recorte de `readMerchandiseInvoice`.
 */
export async function listBilledMerchandise(q: Queryable, schemaName: string, institutionId: number, terminal: number): Promise<BilledInvoice[]> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query(
    `SELECT i.id, i.number, i.serie, DATE_FORMAT(i.dt_emission, '%Y-%m-%d') AS dtEmission
       FROM \`${s}\`.tb_invoice i
       JOIN \`${s}\`.tb_invoice_merchandise mb
         ON mb.id = i.id AND mb.tb_institution_id = i.tb_institution_id AND mb.terminal = i.terminal AND mb.deleted = 'N'
      WHERE i.tb_institution_id = ? AND i.terminal = ? AND i.deleted = 'N' AND i.issuer = i.tb_institution_id
      ORDER BY i.dt_emission, i.id`,
    [institutionId, terminal])
  return (rows as any[]).map(r => ({ invoiceId: Number(r.id), number: txt(r.number), serie: txt(r.serie), dtEmission: String(r.dtEmission) }))
}

/** O ramo da interface de cada pedido (`vw_order_interface`, a verdade do ERP — D-F32), por lote com WHERE; pedido sem linha = 'orders' (como `erp.orderInterface`). */
export async function orderInterfacesOf(q: Queryable, schemaName: string, institutionId: number, terminal: number, orderIds: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (orderIds.length === 0) return out
  const s = assertSchema(schemaName)
  const [rows] = await q.query(
    `SELECT tb_order_id AS orderId, interface_key AS k FROM \`${s}\`.vw_order_interface WHERE tb_institution_id = ? AND terminal = ? AND tb_order_id IN (?)`,
    [institutionId, terminal, [...orderIds]])
  for (const r of rows as any[]) out.set(Number(r.orderId), String(r.k))
  return out
}

/** As configurações do e-mail da NF-e na interface de faturamento (seed 78 do setes-api, D-NE261/D-NE264): o valor da empresa (`tb_user_id` = 0) ou o padrão do catálogo. */
export interface MailConfig {
  /** `fiscal_email_auto_send`: 'S' liga o envio automático depois da autorização (padrão 'S', como no ERP Desktop). */
  readonly autoSend: boolean
  /** `nfe_email_subject`: o assunto, com `{number}`; sem o texto, o padrão do ERP Desktop. */
  readonly subject: string
}
export const DEFAULT_MAIL_SUBJECT = 'Envio de NF-e Nº {number}'

export async function readMailConfig(q: Queryable, schemaName: string, institutionId: number): Promise<MailConfig> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query(
    `SELECT c.name AS name, COALESCE(v.content, c.default_content) AS content
       FROM setes_central.tb_interface i
       JOIN setes_central.tb_interface_has_config c
         ON c.tb_interface_id = i.id AND c.name IN ('fiscal_email_auto_send', 'nfe_email_subject') AND c.deleted = 'N'
       LEFT JOIN \`${s}\`.tb_institution_has_config v
         ON v.tb_interface_id = i.id AND v.name = c.name AND v.tb_institution_id = ? AND v.tb_user_id = 0 AND v.deleted = 'N'
      WHERE i.i18n_key = 'billing' AND i.deleted = 'N'`,
    [institutionId])
  const byName = new Map<string, string | null>((rows as any[]).map(r => [String(r.name), txt(r.content)]))
  const subject = (byName.get('nfe_email_subject') ?? '').trim()
  return { autoSend: byName.get('fiscal_email_auto_send') !== 'N', subject: subject === '' ? DEFAULT_MAIL_SUBJECT : subject }
}
