import { HttpError, ErrorCodes, Queryable, assertSchema, erp, InvoiceRef } from 'fiscal-api'
import { numberItems } from '../nfe/item-numbering'

/**
 * FONTE DE FATOS DO RAMO DE MERCADORIA (D-F10; NFE.E5.P2.T1) — o que a nfe-api lê do ERP web para montar a NF-e 55. Com a base do núcleo
 * (`erp` — cadeia da entidade, código IBGE), é o ÚNICO lugar da nfe-api que conhece as tabelas do ERP (cerca em `app.test.ts`). Só LÊ (D-F31).
 *
 * O que é lido e de onde (ficha-nfe-e5-p2-fonte-de-fatos-mercadoria.md):
 *  - a nota É o pedido: `tb_invoice.id` = id do pedido; estabelecimento = `tb_institution_id`; o terminal vem SEMPRE do `ref` (nunca literal);
 *  - CADASTRO lido AO VIVO (D-NE248 — o faturamento não congela): produto, NCM, CEST, unidade, GTIN, fabricante, emitente, destinatário,
 *    transportadora. O que não muda mais é o XML autorizado;
 *  - o CÁLCULO por item é o REGISTRADO pelo faturamento (`tb_order_item_icms` e irmãs — D-NE248, complemento); a nfe-api não calcula imposto;
 *  - itens do 55 = itens vivos do pedido cujo produto NÃO é serviço — o mesmo conjunto que formou o vNF no faturamento; o serviço da nota
 *    conjugada fica fora (o ramo de mercadoria não o leva);
 *  - do `ICMSTot` só o vNF é do ERP (`tb_invoice_merchandise.total_value` — D-NE178); os outros totais gravados no ramo NÃO são lidos: o builder
 *    soma os itens (D-NE27);
 *  - cProd = `tb_merchandise.id` (D-NE269); natOp = descrição resumida do CFOP do item de nItem 1 (D-NE268);
 *  - unidade vendida = nível `default_sale_trade_level` (NULL = unidade-base, nível 1); unidade tributável = `taxable_trade_level` (NULL = a
 *    própria unidade vendida) — D-PR16.
 *
 * Devolve FATOS CRUS: nulo onde o cadastro não tem; valores decimais como TEXTO EXATO (`CAST(... AS CHAR)` no SQL — o pool do núcleo
 * entregaria número de ponto flutuante); somar em centavos inteiros é do builder.
 * Não valida conteúdo (camada 1 — NFE.E5.P5) nem monta a entrada do leiaute (builder — NFE.E5.P3). Só recusa o que impede a leitura fiel.
 */

/** O modelo que a NE-4 monta. A fonte NÃO filtra por ele (devolve o `model` da nota como fato): quem recusa outro modelo é quem monta (P3/P5). */
export const MERCHANDISE_MODEL = '55' as const
/** Nível da unidade-base na `tb_merchandise_trade_unit` (CHECK `ck_mtu_base_factor`: nível 1 tem fator 1). */
const BASE_TRADE_LEVEL = 1

/** Códigos de recusa desta fonte que o núcleo ainda não lista; entram no contrato com a rota `transmit` (NE-5). */
export const MerchandiseFactsErrors = Object.freeze({
  BRANCH_MISSING:          'INVOICE_MERCHANDISE_BRANCH_MISSING',
  ITEMS_MISSING:           'INVOICE_MERCHANDISE_ITEMS_MISSING',
  ITEM_TAX_RECORD_MISSING: 'INVOICE_ITEM_TAX_RECORD_MISSING',
  ITEM_PRODUCT_MISSING:    'INVOICE_ITEM_PRODUCT_MISSING',
  ITEM_ID_DUPLICATED:      'INVOICE_ITEM_ID_DUPLICATED',
} as const)

const txt = (v: unknown): string | null => (v == null ? null : String(v))
const int = (v: unknown): number | null => (v == null ? null : Number(v))

// ---------------------------------------------------------------------------------------------------------------------------------------
// Nota e ramo
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface MerchandiseInvoiceHeader {
  invoiceId:  number
  number:     string | null
  serie:      string | null
  model:      string | null
  dtEmission: string
  /**
   * O instante do faturamento da VIDA ATUAL da nota, em UTC ('AAAA-MM-DD HH:MM:SS' — PADROES_BANCO §10.1): o `created_at` do evento E da vida
   * (`vw_invoice_life.life_event` — D-F32), não o da `tb_invoice`, que fica com a hora do 1º faturamento quando a nota REVIVE na mesma linha
   * (D-NE296, que ajusta a D-NE284). A HORA do `dhEmi`. Nulo = a nota não tem evento E da vida (carga ou sincronização) — o `dhEmiOf` recusa (S-A).
   */
  createdAt:  string | null
  /** A vida da nota pela view (`vw_invoice_life.life_event`), crua; a transmissão confere que é a vida que ela travou (409 antes de qualquer 422). */
  lifeEvent:  number | null
  /** A data (`dt_record`, 'AAAA-MM-DD') do evento E da vida; diferente do `dt_emission` = linha regravada — o `dhEmiOf` recusa (S-B). */
  lifeDate:   string | null
  entityId:   number
  status:     string
  note:       string | null
  /** O vNF cunhado pelo faturamento (D-NE178/D-NE215), como texto decimal. */
  totalValue: string | null
  indPres:    number | null
}

/**
 * Nota emitida POR ESTE estabelecimento, viva, com o ramo de mercadoria. Não achou → 404 `INVOICE_NOT_FOUND`; sem ramo → 422
 * `INVOICE_MERCHANDISE_BRANCH_MISSING`. Na transmissão roda DENTRO da reserva, depois da trava da nota e da habilitação (`transmission.ts`).
 *
 * A hora do `dhEmi` (D-NE296) sai em DUAS leituras simples, nunca por junção com a view: (1) a vida pela view publicada `vw_invoice_life`
 * (D-F32: uma verdade só) com WHERE pela chave da nota — a forma do núcleo, que o MariaDB funde (a view como lado de dentro de um LEFT JOIN
 * materializou o schema inteiro no dev: mais de 2 min no banco de um cliente, contra 19 ms assim); (2) o evento E dessa vida pela chave
 * primária de `tb_invoice_event` (vivo), com a data dele (`dt_record`) — o faturamento grava `dt_record` = `dt_emission` na mesma transação
 * (setes-api `issueInvoice`); a conferência das duas datas é do `dhEmiOf` (S-B), com a causa própria. Mais de uma linha em qualquer leitura = 409
 * `RESOURCE_BUSY`, nunca a primeira (PADROES_BANCO §11 regra 13). Só dentro da reserva (`withInvoiceTx`): as leituras confiam no retrato aberto pela trava.
 */
export async function readMerchandiseInvoice(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<MerchandiseInvoiceHeader> {
  const s = assertSchema(schemaName)
  const busy = (what: string) => new HttpError(409, `Nota ${ref.invoiceId}: ${what} devolveu mais de uma linha — tente de novo`, undefined, ErrorCodes.RESOURCE_BUSY)
  const [rows] = await q.query(
    `SELECT i.id, i.number, i.serie, i.model, DATE_FORMAT(i.dt_emission, '%Y-%m-%d') AS dtEmission, i.tb_entity_id AS entityId, i.status,
            CONVERT(i.note USING utf8mb4) AS note, mb.id AS branchId, CAST(mb.total_value AS CHAR) AS totalValue, mb.indPres AS indPres
       FROM \`${s}\`.tb_invoice i
       LEFT JOIN \`${s}\`.tb_invoice_merchandise mb
         ON mb.id = i.id AND mb.tb_institution_id = i.tb_institution_id AND mb.terminal = i.terminal AND mb.deleted = 'N'
      WHERE i.id = ? AND i.tb_institution_id = ? AND i.terminal = ? AND i.deleted = 'N' AND i.issuer = i.tb_institution_id`,
    [ref.invoiceId, ref.institutionId, ref.terminal])
  if (rows.length > 1) throw busy('a leitura da nota')
  const r = rows[0]
  if (!r) throw new HttpError(404, `Nota ${ref.invoiceId} emitida por este estabelecimento não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
  if (r.branchId == null) {
    throw new HttpError(422, `Nota ${ref.invoiceId} não tem ramo de mercadoria — só nota com mercadoria gera NF-e`,
      [{ field: 'merchandise', message: 'Ramo de mercadoria ausente' }], MerchandiseFactsErrors.BRANCH_MISSING)
  }
  const dtEmission = String(r.dtEmission)
  // (1) a vida — a view com WHERE pela chave da nota
  const [lives] = await q.query(
    `SELECT life_event AS lifeEvent FROM \`${s}\`.vw_invoice_life WHERE tb_invoice_id = ? AND tb_institution_id = ? AND terminal = ?`,
    [ref.invoiceId, ref.institutionId, ref.terminal])
  if (lives.length > 1) throw busy('a leitura da vida')
  const lifeEvent = int(lives[0]?.lifeEvent)
  // (2) o evento E da vida, pela chave primária, vivo, com a data dele
  let createdAt: string | null = null
  let lifeDate: string | null = null
  if (lifeEvent !== null) {
    const [events] = await q.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt, DATE_FORMAT(dt_record, '%Y-%m-%d') AS lifeDate FROM \`${s}\`.tb_invoice_event
        WHERE tb_invoice_id = ? AND tb_institution_id = ? AND terminal = ? AND event = ? AND kind = 'E' AND deleted = 'N'`,
      [ref.invoiceId, ref.institutionId, ref.terminal, lifeEvent])
    if (events.length > 1) throw busy('a leitura do evento da vida')
    createdAt = txt(events[0]?.createdAt)
    lifeDate = txt(events[0]?.lifeDate)
  }
  return {
    invoiceId: Number(r.id), number: txt(r.number), serie: txt(r.serie), model: txt(r.model), dtEmission, createdAt, lifeEvent, lifeDate,
    entityId: Number(r.entityId), status: String(r.status ?? ''), note: txt(r.note), totalValue: txt(r.totalValue), indPres: int(r.indPres),
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Itens: cadastro ao vivo + cálculo registrado
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface TradeUnitFact {
  level:               number | null
  measureAbbreviation: string | null
  /** Quantas unidades-base o nível contém (texto decimal). */
  factor:              string | null
  gtin:                string | null
}

export interface ItemIcmsRecord {
  cst: string | null; origin: string | null; cfopId: string | null
  determBase: string | null; determBaseSt: string | null; discharge: number | null
  aliqRdBase: string | null; baseValue: string | null; aliq: string | null; aliqRd: string | null; value: string | null
  aliqRdBaseSt: string | null; baseValueSt: string | null; aliqSt: string | null; aliqRdSt: string | null; valueSt: string | null; mva: string | null
  withheldBaseValue: string | null; withheldValue: string | null; withheldBaseValueSt: string | null; withheldValueSt: string | null
  credCalcAliq: string | null; credExplValue: string | null
  freightValue: string | null; insuranceValue: string | null; expensesValue: string | null; approximateTax: string | null
  operationValue: string | null; deferredAliq: string | null; deferredValue: string | null
}

export interface ItemFcpRecord {
  vbcfcp: string | null; pfcp: string | null; vfcp: string | null
  vbcfcpst: string | null; pfcpst: string | null; vfcpst: string | null
  pst: string | null; vbcfcpstret: string | null; pfcpstret: string | null; vfcpstret: string | null
}

export interface ItemIpiRecord {
  cst: string | null; classFrameCode: string | null; baseValue: string | null; aliqValue: string | null; tagValue: string | null
  unitQtty: string | null; unitValue: string | null
}

export interface ItemContributionRecord {
  cst: string | null; baseValue: string | null; aliqValue: string | null; tagValue: string | null; qtSaleQtty: string | null; qtAliqValue: string | null
}

export interface MerchandiseItemFact {
  /** Id do item do pedido — a ordem do nItem (D-NE103). */
  itemId:        number
  kind:          string
  /** cProd (D-NE269): `tb_merchandise.id`; null se o produto não tem a linha de mercadoria. */
  merchandiseId: number | null
  description:   string | null
  ncm:           string | null
  cest:          string | null
  /** Origem do cadastro (`tb_merchandise.source`); a do cálculo registrado está em `icms.origin`. */
  source:        string | null
  manufScale:    string | null
  factoryCnpj:   string | null
  saleUnit:      TradeUnitFact
  taxableUnit:   TradeUnitFact
  quantity:      string | null
  unitValue:     string | null
  discountValue: string | null
  approxTaxAliq: string | null
  icms:   ItemIcmsRecord
  fcp:    ItemFcpRecord | null
  ipi:    ItemIpiRecord | null
  /** null = o faturamento não registrou PIS para o item (hoje ele só grava quando o motor calcula a contribuição). */
  pis:    ItemContributionRecord | null
  /** null = idem, COFINS. */
  cofins: ItemContributionRecord | null
}

/**
 * Os itens da NF-e, na ordem do id. Recusa (422, com os ids) a nota sem item de mercadoria e o item de mercadoria SEM o cálculo registrado
 * de ICMS: o faturamento não registrou imposto nenhum para ele, e o item entrou no vNF. PIS e COFINS ausentes NÃO recusam aqui — saem
 * nulos: os grupos são obrigatórios em todo item do 55 (rej. 745 e 748 — RF-NFE-63) e quem recusa o candidato é a camada 1 (NFE.E5.P5).
 * (Provado no banco do dev em 2026-11-23: o faturamento do ERP só grava PIS/COFINS quando o motor calcula a contribuição.)
 */
export async function listMerchandiseItems(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<MerchandiseItemFact[]> {
  const s = assertSchema(schemaName)
  const key = [ref.invoiceId, ref.institutionId, ref.terminal]
  const tax = (alias: string) =>
    `${alias}.tb_order_id = oi.tb_order_id AND ${alias}.tb_order_item_id = oi.id AND ${alias}.tb_institution_id = oi.tb_institution_id
            AND ${alias}.terminal = oi.terminal AND ${alias}.deleted = 'N'`
  const unit = (alias: string) => `${alias}.tb_institution_id = m.tb_institution_id AND ${alias}.tb_merchandise_id = m.id AND ${alias}.deleted = 'N'`
  const [rows] = await q.query(
    `SELECT oi.id AS itemId, oi.kind, p.id AS productId, CAST(oi.quantity AS CHAR) AS quantity, CAST(oi.unit_value AS CHAR) AS unitValue, CAST(oi.discount_value AS CHAR) AS discountValue,
            p.description, m.id AS merchandiseId, m.ncm, m.cest, m.source, m.manuf_sign_ind_scale AS manufScale, mf.cnpj AS factoryCnpj,
            su.level AS saleLevel, sm.abbreviation AS saleAbbr, CAST(su.factor AS CHAR) AS saleFactor, su.gtin AS saleGtin,
            tu.level AS taxLevel, tm.abbreviation AS taxAbbr, CAST(tu.factor AS CHAR) AS taxFactor, tu.gtin AS taxGtin,
            ic.tb_order_item_id AS icmsItem, ic.cst AS icmsCst, ic.origem AS icmsOrigin, ic.tb_cfop_id AS cfopId,
            ic.determ_base AS determBase, ic.determ_base_st AS determBaseSt, ic.discharge, CAST(ic.aliq_rd_base AS CHAR) AS aliqRdBase,
            CAST(ic.base_value AS CHAR) AS icmsBase, CAST(ic.aliq AS CHAR) AS icmsAliq, CAST(ic.aliq_rd AS CHAR) AS aliqRd, CAST(ic.value AS CHAR) AS icmsValue,
            CAST(ic.aliq_rd_base_st AS CHAR) AS aliqRdBaseSt, CAST(ic.base_value_st AS CHAR) AS baseValueSt, CAST(ic.aliq_st AS CHAR) AS aliqSt, CAST(ic.aliq_rd_st AS CHAR) AS aliqRdSt,
            CAST(ic.value_st AS CHAR) AS valueSt, CAST(ic.mva AS CHAR) AS mva, CAST(ic.withheld_base_value AS CHAR) AS withheldBaseValue, CAST(ic.withheld_value AS CHAR) AS withheldValue,
            CAST(ic.withheld_base_value_st AS CHAR) AS withheldBaseValueSt, CAST(ic.withheld_value_st AS CHAR) AS withheldValueSt,
            CAST(ic.cred_calc_aliq AS CHAR) AS credCalcAliq, CAST(ic.cred_expl_value AS CHAR) AS credExplValue, CAST(ic.freight_value AS CHAR) AS freightValue,
            CAST(ic.insurance_Value AS CHAR) AS insuranceValue, CAST(ic.expenses_value AS CHAR) AS expensesValue, CAST(ic.approximate_tax AS CHAR) AS approximateTax,
            CAST(ic.operation_value AS CHAR) AS operationValue, CAST(ic.deferred_aliq AS CHAR) AS deferredAliq, CAST(ic.deferred_value AS CHAR) AS deferredValue,
            ip.tb_order_item_id AS ipiItem, ip.cst AS ipiCst, ip.class_frame_code AS classFrameCode, CAST(ip.base_value AS CHAR) AS ipiBase,
            CAST(ip.aliq_value AS CHAR) AS ipiAliq, CAST(ip.tag_value AS CHAR) AS ipiValue, CAST(ip.unit_qtty AS CHAR) AS ipiUnitQtty, CAST(ip.unit_value AS CHAR) AS ipiUnitValue,
            pi.tb_order_item_id AS pisItem, pi.cst AS pisCst, CAST(pi.base_value AS CHAR) AS pisBase, CAST(pi.aliq_value AS CHAR) AS pisAliq, CAST(pi.tag_value AS CHAR) AS pisValue,
            CAST(pi.qt_sale_qtty AS CHAR) AS pisQtty, CAST(pi.qt_aliq_value AS CHAR) AS pisQtAliq,
            co.tb_order_item_id AS cofinsItem, co.cst AS cofinsCst, CAST(co.base_value AS CHAR) AS cofinsBase, CAST(co.aliq_value AS CHAR) AS cofinsAliq,
            CAST(co.tag_value AS CHAR) AS cofinsValue, CAST(co.qt_sale_qtty AS CHAR) AS cofinsQtty, CAST(co.qt_aliq_value AS CHAR) AS cofinsQtAliq
       FROM \`${s}\`.tb_order_item oi
       LEFT JOIN \`${s}\`.tb_product p ON p.id = oi.tb_product_id AND p.tb_institution_id = oi.tb_institution_id
       LEFT JOIN \`${s}\`.tb_merchandise m ON m.id = p.id AND m.tb_institution_id = p.tb_institution_id
       LEFT JOIN \`${s}\`.tb_merchandise_factory mf ON mf.tb_institution_id = m.tb_institution_id AND mf.tb_merchandise_id = m.id AND mf.deleted = 'N'
       LEFT JOIN \`${s}\`.tb_merchandise_trade_unit su ON ${unit('su')} AND su.level = COALESCE(m.default_sale_trade_level, ${BASE_TRADE_LEVEL})
       LEFT JOIN setes_central.tb_measure sm ON sm.id = su.tb_measure_id
       LEFT JOIN \`${s}\`.tb_merchandise_trade_unit tu
         ON ${unit('tu')} AND tu.level = COALESCE(m.taxable_trade_level, m.default_sale_trade_level, ${BASE_TRADE_LEVEL})
       LEFT JOIN setes_central.tb_measure tm ON tm.id = tu.tb_measure_id
       LEFT JOIN \`${s}\`.tb_order_item_icms ic ON ${tax('ic')}
       LEFT JOIN \`${s}\`.tb_order_item_ipi ip ON ${tax('ip')}
       LEFT JOIN \`${s}\`.tb_order_item_pis pi ON ${tax('pi')}
       LEFT JOIN \`${s}\`.tb_order_item_cofins co ON ${tax('co')}
      WHERE oi.tb_order_id = ? AND oi.tb_institution_id = ? AND oi.terminal = ? AND oi.deleted = 'N' AND (p.id IS NULL OR p.kind <> 'S')
      ORDER BY oi.id`, key)
  if (rows.length === 0) {
    throw new HttpError(422, `Nota ${ref.invoiceId} não tem item de mercadoria`,
      [{ field: 'items', message: 'Nenhum item de mercadoria vivo no pedido' }], MerchandiseFactsErrors.ITEMS_MISSING)
  }
  // Limite dos erros com lista: até 50 campos (uma nota com milhares de itens ruins não devolve um corpo de centenas de KB).
  const capped = <T,>(list: T[]): T[] => list.slice(0, 50)
  // Item vivo cujo produto não existe mais no cadastro: não dá para saber se é mercadoria — recusa, nunca some em silêncio do `det`.
  const orphans = (rows as any[]).filter(r => r.productId == null)
  if (orphans.length) {
    throw new HttpError(422, `Nota ${ref.invoiceId}: ${orphans.length} item(ns) do pedido sem o produto no cadastro`,
      capped(orphans).map(r => ({ field: `items[${Number(r.itemId)}]`, message: 'Produto do item não encontrado no cadastro' })),
      MerchandiseFactsErrors.ITEM_PRODUCT_MISSING)
  }
  // O id do item é único por pedido entre os `kind` (D-NE220 — a cerca é do faturamento). Nota que não passou por ela (sincronizada, antiga)
  // pode repetir o id em dois `kind`; as tabelas de imposto não têm `kind`, então os dois itens leriam o MESMO cálculo: recusa aqui.
  const seen = new Set<number>(), repeated = new Set<number>()
  for (const r of rows as any[]) { const id = Number(r.itemId); if (seen.has(id)) repeated.add(id); seen.add(id) }
  if (repeated.size) {
    throw new HttpError(422, `Nota ${ref.invoiceId}: ${repeated.size} id(s) de item repetido(s) entre tipos de item`,
      capped([...repeated]).map(id => ({ field: `items[${id}]`, message: 'Id de item repetido no pedido' })), MerchandiseFactsErrors.ITEM_ID_DUPLICATED)
  }
  const missing = (rows as any[]).filter(r => r.icmsItem == null)
  if (missing.length) {
    throw new HttpError(422, `Nota ${ref.invoiceId}: ${missing.length} item(ns) de mercadoria sem cálculo de imposto registrado pelo faturamento`,
      capped(missing).map(r => ({
        field: `items[${Number(r.itemId)}]`,
        message: 'Sem cálculo registrado de ICMS',
      })), MerchandiseFactsErrors.ITEM_TAX_RECORD_MISSING)
  }
  // A regra aplicada é por (item, kind) e a tabela dela tem colação diferente da do item (provado no banco real: comparar os dois `kind`
  // num JOIN dá "Illegal mix of collations"): lida à parte e casada aqui, como o faturamento do ERP faz.
  const [ruleRows] = await q.query(
    `SELECT tb_order_item_id AS itemId, kind, CAST(approx_tax_aliq AS CHAR) AS approxTaxAliq
       FROM \`${s}\`.tb_order_item_tax_rule
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'`, key)
  const approx = new Map<string, string | null>((ruleRows as any[]).map(r => [`${Number(r.itemId)}|${String(r.kind)}`, txt(r.approxTaxAliq)]))
  // O FCP não tem chave no banco (o faturamento apaga e reinsere): lido à parte; a linha mais recente de cada item vale.
  const [fcpRows] = await q.query(
    `SELECT tb_order_item_id AS itemId, CAST(vbcfcp AS CHAR) AS vbcfcp, CAST(pfcp AS CHAR) AS pfcp, CAST(vfcp AS CHAR) AS vfcp, CAST(vbcfcpst AS CHAR) AS vbcfcpst, CAST(pfcpst AS CHAR) AS pfcpst, CAST(vfcpst AS CHAR) AS vfcpst, CAST(pst AS CHAR) AS pst, CAST(vbcfcpstret AS CHAR) AS vbcfcpstret, CAST(pfcpstret AS CHAR) AS pfcpstret, CAST(vfcpstret AS CHAR) AS vfcpstret
       FROM \`${s}\`.tb_order_item_icms_fcp
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'
      ORDER BY tb_order_item_id, created_at`, key)
  const fcp = new Map<number, ItemFcpRecord>()
  for (const f of fcpRows as any[]) {
    fcp.set(Number(f.itemId), {
      vbcfcp: txt(f.vbcfcp), pfcp: txt(f.pfcp), vfcp: txt(f.vfcp), vbcfcpst: txt(f.vbcfcpst), pfcpst: txt(f.pfcpst), vfcpst: txt(f.vfcpst),
      pst: txt(f.pst), vbcfcpstret: txt(f.vbcfcpstret), pfcpstret: txt(f.pfcpstret), vfcpstret: txt(f.vfcpstret),
    })
  }
  return (rows as any[]).map(r => ({
    itemId: Number(r.itemId), kind: String(r.kind), merchandiseId: int(r.merchandiseId), description: txt(r.description),
    ncm: txt(r.ncm), cest: txt(r.cest), source: txt(r.source), manufScale: txt(r.manufScale), factoryCnpj: txt(r.factoryCnpj),
    saleUnit:    { level: int(r.saleLevel), measureAbbreviation: txt(r.saleAbbr), factor: txt(r.saleFactor), gtin: txt(r.saleGtin) },
    taxableUnit: { level: int(r.taxLevel),  measureAbbreviation: txt(r.taxAbbr),  factor: txt(r.taxFactor),  gtin: txt(r.taxGtin) },
    quantity: txt(r.quantity), unitValue: txt(r.unitValue), discountValue: txt(r.discountValue),
    approxTaxAliq: approx.get(`${Number(r.itemId)}|${String(r.kind)}`) ?? null,
    icms: {
      cst: txt(r.icmsCst), origin: txt(r.icmsOrigin), cfopId: txt(r.cfopId), determBase: txt(r.determBase), determBaseSt: txt(r.determBaseSt),
      discharge: int(r.discharge), aliqRdBase: txt(r.aliqRdBase), baseValue: txt(r.icmsBase), aliq: txt(r.icmsAliq), aliqRd: txt(r.aliqRd),
      value: txt(r.icmsValue), aliqRdBaseSt: txt(r.aliqRdBaseSt), baseValueSt: txt(r.baseValueSt), aliqSt: txt(r.aliqSt),
      aliqRdSt: txt(r.aliqRdSt), valueSt: txt(r.valueSt), mva: txt(r.mva), withheldBaseValue: txt(r.withheldBaseValue),
      withheldValue: txt(r.withheldValue), withheldBaseValueSt: txt(r.withheldBaseValueSt), withheldValueSt: txt(r.withheldValueSt),
      credCalcAliq: txt(r.credCalcAliq), credExplValue: txt(r.credExplValue), freightValue: txt(r.freightValue),
      insuranceValue: txt(r.insuranceValue), expensesValue: txt(r.expensesValue), approximateTax: txt(r.approximateTax),
      operationValue: txt(r.operationValue), deferredAliq: txt(r.deferredAliq), deferredValue: txt(r.deferredValue),
    },
    fcp: fcp.get(Number(r.itemId)) ?? null,
    ipi: r.ipiItem == null ? null : {
      cst: txt(r.ipiCst), classFrameCode: txt(r.classFrameCode), baseValue: txt(r.ipiBase), aliqValue: txt(r.ipiAliq), tagValue: txt(r.ipiValue),
      unitQtty: txt(r.ipiUnitQtty), unitValue: txt(r.ipiUnitValue),
    },
    pis:    r.pisItem == null ? null : { cst: txt(r.pisCst), baseValue: txt(r.pisBase), aliqValue: txt(r.pisAliq), tagValue: txt(r.pisValue), qtSaleQtty: txt(r.pisQtty), qtAliqValue: txt(r.pisQtAliq) },
    cofins: r.cofinsItem == null ? null : { cst: txt(r.cofinsCst), baseValue: txt(r.cofinsBase), aliqValue: txt(r.cofinsAliq), tagValue: txt(r.cofinsValue), qtSaleQtty: txt(r.cofinsQtty), qtAliqValue: txt(r.cofinsQtAliq) },
  }))
}

/**
 * natOp (D-NE268): a descrição RESUMIDA (`concise`, 60 posições — o tamanho do campo no leiaute) do CFOP do item de nItem 1, pela peça única
 * do nItem. Nulo quando o item não tem CFOP ou o cadastro central não tem o texto — a camada 1 recusa; aqui nunca se corta nem se inventa.
 */
export async function readOperationNature(q: Queryable, items: readonly Pick<MerchandiseItemFact, 'itemId' | 'icms'>[]): Promise<{ cfopId: string | null; operationNature: string | null }> {
  const firstId = numberItems(items.map(i => i.itemId)).items[0].itemId
  const cfopId = items.find(i => i.itemId === firstId)!.icms.cfopId
  if (cfopId == null) return { cfopId: null, operationNature: null }
  const [rows] = await q.query(`SELECT concise FROM setes_central.tb_cfop WHERE id = ?`, [cfopId])
  const text = txt(rows[0]?.concise)?.trim()
  return { cfopId, operationNature: text ? text : null }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Partes: emitente, destinatário, transportadora (cadastro ao vivo)
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface PartyAddressFact {
  kind: string | null; main: string | null; street: string | null; number: string | null; complement: string | null
  neighborhood: string | null; zipCode: string | null; cityName: string | null
  /** Código IBGE de 7 dígitos (peça do núcleo); null quando ausente ou malformado. */
  cityIbge: string | null
  /** Sigla da UF (`tb_state.abbreviation`). */
  stateCode: string | null
}

export interface PartyTaxFact {
  /** Rótulo completo do regime (`tb_entity_tax.tax_regime`). */
  taxRegime: string | null
  /** CRT = o 1º caractere do rótulo, quando é dígito (migration 006 do ERP: "o código NFe é o 1º caractere"). */
  crt:       string | null
  indIeDest: string | null
  /** 'S' = consumidor final (indFinal). */
  consumer:  string | null
}

export interface PartyFact {
  entityId:          number
  nameCompany:       string | null
  nickTrade:         string | null
  cnpj:              string | null
  cpf:               string | null
  /** IE (`tb_company.ie`) — D-NE96. */
  stateRegistration: string | null
  addresses:         PartyAddressFact[]
  /** Tributação da relação estabelecimento × entidade; null = sem cadastro tributário. */
  tax:               PartyTaxFact | null
}

async function readParty(q: Queryable, schemaName: string, institutionId: number, entityId: number): Promise<PartyFact | null> {
  const s = assertSchema(schemaName)
  const base = await erp.entityFiscal(q, entityId)
  if (!base) return null
  const [company] = await q.query(`SELECT ie FROM setes_central.tb_company WHERE id = ? AND deleted = 'N'`, [entityId])
  const [addr] = await q.query(
    `SELECT a.kind, a.main, a.street, a.nmbr, a.complement, a.neighborhood, a.zip_code AS zipCode, a.tb_city_id AS cityId,
            ci.name AS cityName, st.abbreviation AS stateCode
       FROM setes_central.tb_address a
       LEFT JOIN setes_central.tb_state st ON st.id = a.tb_state_id
       LEFT JOIN setes_central.tb_city  ci ON ci.id = a.tb_city_id
      WHERE a.id = ? AND a.deleted = 'N'
      ORDER BY a.kind`, [entityId])
  const addresses: PartyAddressFact[] = []
  for (const a of addr as any[]) {
    addresses.push({
      kind: txt(a.kind), main: txt(a.main), street: txt(a.street), number: txt(a.nmbr), complement: txt(a.complement),
      neighborhood: txt(a.neighborhood), zipCode: txt(a.zipCode), cityName: txt(a.cityName),
      cityIbge: await erp.cityIbge(q, int(a.cityId)), stateCode: txt(a.stateCode),
    })
  }
  const [taxRows] = await q.query(
    `SELECT tax_regime AS taxRegime, ind_ie_dest AS indIeDest, consumer
       FROM \`${s}\`.tb_entity_tax WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`, [entityId, institutionId])
  const t = taxRows[0]
  const regime = txt(t?.taxRegime)
  return {
    entityId, nameCompany: base.nameCompany, nickTrade: base.nickTrade, cnpj: base.cnpj, cpf: base.cpf,
    stateRegistration: txt(company[0]?.ie), addresses,
    tax: t ? { taxRegime: regime, crt: regime && /^[0-9]/.test(regime) ? regime[0] : null, indIeDest: txt(t.indIeDest), consumer: txt(t.consumer) } : null,
  }
}

/** O emitente É a institution (a entidade de mesmo id). Sem a entidade → 422 `FISCAL_EMITTER_INCOMPLETE`. */
export async function readEmitter(q: Queryable, schemaName: string, institutionId: number): Promise<PartyFact> {
  const party = await readParty(q, schemaName, institutionId, institutionId)
  if (!party) {
    throw new HttpError(422, 'Estabelecimento emitente sem cadastro de entidade',
      [{ field: 'emitter', message: 'Entidade do estabelecimento não encontrada' }], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  return party
}

/** O destinatário é o `tb_invoice.tb_entity_id`, lido AGORA (D-NE248). Sem a entidade → 422 `FISCAL_RECIPIENT_INCOMPLETE`. */
export async function readRecipient(q: Queryable, schemaName: string, institutionId: number, entityId: number): Promise<PartyFact> {
  const party = await readParty(q, schemaName, institutionId, entityId)
  if (!party) {
    throw new HttpError(422, `Destinatário ${entityId} sem cadastro de entidade`,
      [{ field: 'recipient', message: 'Entidade do destinatário não encontrada' }], ErrorCodes.FISCAL_RECIPIENT_INCOMPLETE)
  }
  return party
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Pagamento, transporte, devolução
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface PaymentFacts {
  /** A condição do pedido (`tb_order_billing` — D-NE48); null = pedido sem condição gravada. */
  billing: { paymentTypeId: number | null; nfePaymentCode: string | null; plots: string | null; deadline: string | null } | null
  /** As parcelas que o faturamento materializou (`tb_financial`), na ordem da parcela. `nfePaymentCode` = `tb_payment_types.id_nfce` (tPag). */
  installments: { parcel: number; dueDate: string | null; value: string | null; paymentTypeId: number | null; nfePaymentCode: string | null }[]
}

export async function readPayments(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<PaymentFacts> {
  const s = assertSchema(schemaName)
  const key = [ref.invoiceId, ref.institutionId, ref.terminal]
  const [bill] = await q.query(
    `SELECT b.tb_payment_types_id AS paymentTypeId, pt.id_nfce AS nfePaymentCode, b.plots, b.deadline
       FROM \`${s}\`.tb_order_billing b
       LEFT JOIN setes_central.tb_payment_types pt ON pt.id = b.tb_payment_types_id
      WHERE b.id = ? AND b.tb_institution_id = ? AND b.terminal = ? AND b.deleted = 'N'`, key)
  const [fin] = await q.query(
    `SELECT f.parcel, DATE_FORMAT(f.dt_expiration, '%Y-%m-%d') AS dueDate, CAST(f.tag_value AS CHAR) AS value, f.tb_payment_types_id AS paymentTypeId,
            pt.id_nfce AS nfePaymentCode
       FROM \`${s}\`.tb_financial f
       LEFT JOIN setes_central.tb_payment_types pt ON pt.id = f.tb_payment_types_id
      WHERE f.tb_order_id = ? AND f.tb_institution_id = ? AND f.terminal = ? AND f.deleted = 'N'
      ORDER BY f.parcel`, key)
  const b = bill[0]
  return {
    billing: b ? { paymentTypeId: int(b.paymentTypeId), nfePaymentCode: txt(b.nfePaymentCode), plots: txt(b.plots), deadline: txt(b.deadline) } : null,
    installments: (fin as any[]).map(f => ({
      parcel: Number(f.parcel), dueDate: txt(f.dueDate), value: txt(f.value), paymentTypeId: int(f.paymentTypeId), nfePaymentCode: txt(f.nfePaymentCode),
    })),
  }
}

export interface ShippingFacts {
  /** modFrete (`tb_order_shipping.tb_freight_mode_id`); null = pedido sem a linha de transporte. */
  freightMode: string | null
  /** O id da transportadora GRAVADO no pedido (`tb_order_shipping.tb_carrier_id`), cru. Com id e `carrier` nulo, a transportadora foi
   *  excluída ou não tem entidade: quem monta decide (nunca "sem transportadora" em silêncio). */
  carrierId:   number | null
  /** A transportadora (entidade), lida ao vivo; null = sem transportadora. Volumes, pesos e placa não têm origem no ERP web. */
  carrier:     PartyFact | null
}

export async function readShipping(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<ShippingFacts> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query(
    `SELECT sh.tb_freight_mode_id AS freightMode, sh.tb_carrier_id AS orderCarrierId, ca.id AS carrierId
       FROM \`${s}\`.tb_order_shipping sh
       LEFT JOIN \`${s}\`.tb_carrier ca ON ca.id = sh.tb_carrier_id AND ca.tb_institution_id = sh.tb_institution_id AND ca.deleted = 'N'
      WHERE sh.id = ? AND sh.tb_institution_id = ? AND sh.terminal = ? AND sh.deleted = 'N'`,
    [ref.invoiceId, ref.institutionId, ref.terminal])
  const r = rows[0]
  if (!r) return { freightMode: null, carrierId: null, carrier: null }
  const carrierId = int(r.carrierId)
  return {
    freightMode: txt(r.freightMode), carrierId: int(r.orderCarrierId),
    carrier: carrierId == null ? null : await readParty(q, schemaName, ref.institutionId, carrierId),
  }
}

/** O elo da devolução por item (D-NE219): item desta nota → pedido (= nota), terminal e item de ORIGEM. Vazio = a nota não é devolução. */
export interface ReturnOriginFact {
  itemId: number; kind: string
  originInvoiceId: number; originTerminal: number; originItemId: number; originKind: string
}

export async function readReturnOrigins(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<ReturnOriginFact[]> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query(
    `SELECT r.id AS itemId, r.kind, r.tb_order_id_ori AS originInvoiceId, r.terminal_ori AS originTerminal,
            r.tb_order_item_id_ori AS originItemId, r.kind_ori AS originKind
       FROM \`${s}\`.tb_order_item_return r
      WHERE r.tb_order_id = ? AND r.tb_institution_id = ? AND r.terminal = ? AND r.deleted = 'N'
      ORDER BY r.id`, [ref.invoiceId, ref.institutionId, ref.terminal])
  return (rows as any[]).map(r => ({
    itemId: Number(r.itemId), kind: String(r.kind), originInvoiceId: Number(r.originInvoiceId), originTerminal: Number(r.originTerminal),
    originItemId: Number(r.originItemId), originKind: String(r.originKind),
  }))
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// IBS/CBS do Simples no DAS, de 2027 (NFE.E5.P6, D-NE286 a D-NE290) — o que o faturamento CONGELOU por item
// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * O grupo do Simples que o faturamento do ERP web congelou para UM item (`tb_order_item_ibscbs_simples`, migration 084 do setes-api,
 * D-IB138 a D-IB142) mais a classificação (`tb_order_item_ibscbs.classification_code`, 083; o CST é o prefixo de 3 dígitos — S1 da ficha).
 * Decimais como TEXTO EXATO. `classificationCode` é `null` quando a 083 não tem linha para o item (quem monta recusa).
 */
export interface ItemSimplesFact {
  itemId: number
  activityCode: string
  competence: string
  ibsRate: string
  cbsRate: string
  baseValue: string
  ibsValue: string
  cbsValue: string
  classificationCode: string | null
}

/**
 * Só VENDA de mercadoria do CRT 1, de 01/01/2027 em diante, tem linha (D-IB141, D-IB142): quem compõe só chama esta leitura nesse caso — em
 * 2026 a tabela nem precisa existir (a 084 não está aplicada no dev). Só SELECT; as duas tabelas são lidas à parte (nunca num JOIN pelo `kind`);
 * a linha `deleted = 'S'` (nota cancelada sem registro fiscal) não conta. Item sem linha simplesmente não aparece na lista.
 */
export async function readItemSimples(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<ItemSimplesFact[]> {
  const s = assertSchema(schemaName)
  const key = [ref.invoiceId, ref.institutionId, ref.terminal]
  const [rows] = await q.query(
    `SELECT tb_order_item_id AS itemId, activity_code AS activityCode, competence, CAST(ibs_rate AS CHAR) AS ibsRate, CAST(cbs_rate AS CHAR) AS cbsRate,
            CAST(base_value AS CHAR) AS baseValue, CAST(ibs_value AS CHAR) AS ibsValue, CAST(cbs_value AS CHAR) AS cbsValue
       FROM \`${s}\`.tb_order_item_ibscbs_simples
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'
      ORDER BY tb_order_item_id`, key)
  const [classRows] = await q.query(
    `SELECT tb_order_item_id AS itemId, classification_code AS classificationCode
       FROM \`${s}\`.tb_order_item_ibscbs
      WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'`, key)
  const classification = new Map<number, string | null>((classRows as any[]).map(r => [Number(r.itemId), txt(r.classificationCode)]))
  return (rows as any[]).map(r => ({
    itemId: Number(r.itemId), activityCode: String(r.activityCode), competence: String(r.competence), ibsRate: String(r.ibsRate), cbsRate: String(r.cbsRate),
    baseValue: String(r.baseValue), ibsValue: String(r.ibsValue), cbsValue: String(r.cbsValue), classificationCode: classification.get(Number(r.itemId)) ?? null,
  }))
}
