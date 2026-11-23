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
 * Devolve FATOS CRUS: nulo onde o cadastro não tem; valores decimais como TEXTO, como o banco os entrega (somar em centavos é do builder).
 * Não valida conteúdo (camada 1 — NFE.E5.P5) nem monta a entrada do leiaute (builder — NFE.E5.P3). Só recusa o que impede a leitura fiel.
 */

export const MERCHANDISE_MODEL = '55' as const
/** Nível da unidade-base na `tb_merchandise_trade_unit` (CHECK `ck_mtu_base_factor`: nível 1 tem fator 1). */
const BASE_TRADE_LEVEL = 1

/** Códigos de recusa desta fonte que o núcleo ainda não lista; entram no contrato com a rota `transmit` (NE-5). */
export const MerchandiseFactsErrors = Object.freeze({
  BRANCH_MISSING:          'INVOICE_MERCHANDISE_BRANCH_MISSING',
  ITEMS_MISSING:           'INVOICE_MERCHANDISE_ITEMS_MISSING',
  ITEM_TAX_RECORD_MISSING: 'INVOICE_ITEM_TAX_RECORD_MISSING',
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
  entityId:   number
  status:     string
  note:       string | null
  /** O vNF cunhado pelo faturamento (D-NE178/D-NE215), como texto decimal. */
  totalValue: string | null
  indPres:    number | null
}

/**
 * Nota emitida POR ESTE estabelecimento, viva, com o ramo de mercadoria. Não achou → 404 `INVOICE_NOT_FOUND`; sem ramo → 422
 * `INVOICE_MERCHANDISE_BRANCH_MISSING`. Leitura fora de transação (a reserva confere de novo sob a trava — NE-5).
 */
export async function readMerchandiseInvoice(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<MerchandiseInvoiceHeader> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query(
    `SELECT i.id, i.number, i.serie, i.model, DATE_FORMAT(i.dt_emission, '%Y-%m-%d') AS dtEmission, i.tb_entity_id AS entityId, i.status,
            CONVERT(i.note USING utf8mb4) AS note, mb.id AS branchId, mb.total_value AS totalValue, mb.indPres AS indPres
       FROM \`${s}\`.tb_invoice i
       LEFT JOIN \`${s}\`.tb_invoice_merchandise mb
         ON mb.id = i.id AND mb.tb_institution_id = i.tb_institution_id AND mb.terminal = i.terminal AND mb.deleted = 'N'
      WHERE i.id = ? AND i.tb_institution_id = ? AND i.terminal = ? AND i.deleted = 'N' AND i.issuer = i.tb_institution_id`,
    [ref.invoiceId, ref.institutionId, ref.terminal])
  const r = rows[0]
  if (!r) throw new HttpError(404, `Nota ${ref.invoiceId} emitida por este estabelecimento não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
  if (r.branchId == null) {
    throw new HttpError(422, `Nota ${ref.invoiceId} não tem ramo de mercadoria — só nota com mercadoria gera NF-e`,
      [{ field: 'merchandise', message: 'Ramo de mercadoria ausente' }], MerchandiseFactsErrors.BRANCH_MISSING)
  }
  return {
    invoiceId: Number(r.id), number: txt(r.number), serie: txt(r.serie), model: txt(r.model), dtEmission: String(r.dtEmission),
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
  pis:    ItemContributionRecord
  cofins: ItemContributionRecord
}

/**
 * Os itens da NF-e, na ordem do id. Recusa (422, com os ids) a nota sem item de mercadoria e o item de mercadoria sem cálculo registrado
 * de ICMS, PIS ou COFINS: ele entrou no vNF do faturamento e ficaria fora do `det`, e PIS e COFINS são obrigatórios em todo item do 55
 * (rej. 745 e 748 — RF-NFE-63).
 */
export async function listMerchandiseItems(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<MerchandiseItemFact[]> {
  const s = assertSchema(schemaName)
  const key = [ref.invoiceId, ref.institutionId, ref.terminal]
  const tax = (alias: string) =>
    `${alias}.tb_order_id = oi.tb_order_id AND ${alias}.tb_order_item_id = oi.id AND ${alias}.tb_institution_id = oi.tb_institution_id
            AND ${alias}.terminal = oi.terminal AND ${alias}.deleted = 'N'`
  const unit = (alias: string) => `${alias}.tb_institution_id = m.tb_institution_id AND ${alias}.tb_merchandise_id = m.id AND ${alias}.deleted = 'N'`
  const [rows] = await q.query(
    `SELECT oi.id AS itemId, oi.kind, oi.quantity, oi.unit_value AS unitValue, oi.discount_value AS discountValue,
            p.description, m.id AS merchandiseId, m.ncm, m.cest, m.source, m.manuf_sign_ind_scale AS manufScale, mf.cnpj AS factoryCnpj,
            su.level AS saleLevel, sm.abbreviation AS saleAbbr, su.factor AS saleFactor, su.gtin AS saleGtin,
            tu.level AS taxLevel, tm.abbreviation AS taxAbbr, tu.factor AS taxFactor, tu.gtin AS taxGtin,
            tr.approx_tax_aliq AS approxTaxAliq,
            ic.tb_order_item_id AS icmsItem, ic.cst AS icmsCst, ic.origem AS icmsOrigin, ic.tb_cfop_id AS cfopId,
            ic.determ_base AS determBase, ic.determ_base_st AS determBaseSt, ic.discharge, ic.aliq_rd_base AS aliqRdBase,
            ic.base_value AS icmsBase, ic.aliq AS icmsAliq, ic.aliq_rd AS aliqRd, ic.value AS icmsValue,
            ic.aliq_rd_base_st AS aliqRdBaseSt, ic.base_value_st AS baseValueSt, ic.aliq_st AS aliqSt, ic.aliq_rd_st AS aliqRdSt,
            ic.value_st AS valueSt, ic.mva, ic.withheld_base_value AS withheldBaseValue, ic.withheld_value AS withheldValue,
            ic.withheld_base_value_st AS withheldBaseValueSt, ic.withheld_value_st AS withheldValueSt,
            ic.cred_calc_aliq AS credCalcAliq, ic.cred_expl_value AS credExplValue, ic.freight_value AS freightValue,
            ic.insurance_Value AS insuranceValue, ic.expenses_value AS expensesValue, ic.approximate_tax AS approximateTax,
            ic.operation_value AS operationValue, ic.deferred_aliq AS deferredAliq, ic.deferred_value AS deferredValue,
            ip.tb_order_item_id AS ipiItem, ip.cst AS ipiCst, ip.class_frame_code AS classFrameCode, ip.base_value AS ipiBase,
            ip.aliq_value AS ipiAliq, ip.tag_value AS ipiValue, ip.unit_qtty AS ipiUnitQtty, ip.unit_value AS ipiUnitValue,
            pi.tb_order_item_id AS pisItem, pi.cst AS pisCst, pi.base_value AS pisBase, pi.aliq_value AS pisAliq, pi.tag_value AS pisValue,
            pi.qt_sale_qtty AS pisQtty, pi.qt_aliq_value AS pisQtAliq,
            co.tb_order_item_id AS cofinsItem, co.cst AS cofinsCst, co.base_value AS cofinsBase, co.aliq_value AS cofinsAliq,
            co.tag_value AS cofinsValue, co.qt_sale_qtty AS cofinsQtty, co.qt_aliq_value AS cofinsQtAliq
       FROM \`${s}\`.tb_order_item oi
       JOIN \`${s}\`.tb_product p ON p.id = oi.tb_product_id AND p.tb_institution_id = oi.tb_institution_id
       LEFT JOIN \`${s}\`.tb_merchandise m ON m.id = p.id AND m.tb_institution_id = p.tb_institution_id
       LEFT JOIN \`${s}\`.tb_merchandise_factory mf ON mf.tb_institution_id = m.tb_institution_id AND mf.tb_merchandise_id = m.id AND mf.deleted = 'N'
       LEFT JOIN \`${s}\`.tb_merchandise_trade_unit su ON ${unit('su')} AND su.level = COALESCE(m.default_sale_trade_level, ${BASE_TRADE_LEVEL})
       LEFT JOIN setes_central.tb_measure sm ON sm.id = su.tb_measure_id
       LEFT JOIN \`${s}\`.tb_merchandise_trade_unit tu
         ON ${unit('tu')} AND tu.level = COALESCE(m.taxable_trade_level, m.default_sale_trade_level, ${BASE_TRADE_LEVEL})
       LEFT JOIN setes_central.tb_measure tm ON tm.id = tu.tb_measure_id
       LEFT JOIN \`${s}\`.tb_order_item_tax_rule tr ON ${tax('tr')} AND tr.kind = oi.kind
       LEFT JOIN \`${s}\`.tb_order_item_icms ic ON ${tax('ic')}
       LEFT JOIN \`${s}\`.tb_order_item_ipi ip ON ${tax('ip')}
       LEFT JOIN \`${s}\`.tb_order_item_pis pi ON ${tax('pi')}
       LEFT JOIN \`${s}\`.tb_order_item_cofins co ON ${tax('co')}
      WHERE oi.tb_order_id = ? AND oi.tb_institution_id = ? AND oi.terminal = ? AND oi.deleted = 'N' AND p.kind <> 'S'
      ORDER BY oi.id`, key)
  if (rows.length === 0) {
    throw new HttpError(422, `Nota ${ref.invoiceId} não tem item de mercadoria`,
      [{ field: 'items', message: 'Nenhum item de mercadoria vivo no pedido' }], MerchandiseFactsErrors.ITEMS_MISSING)
  }
  const missing = (rows as any[]).filter(r => r.icmsItem == null || r.pisItem == null || r.cofinsItem == null)
  if (missing.length) {
    throw new HttpError(422, `Nota ${ref.invoiceId}: item de mercadoria sem cálculo de imposto registrado pelo faturamento`,
      missing.map(r => ({
        field: `items[${Number(r.itemId)}]`,
        message: `Sem cálculo registrado de ${[r.icmsItem == null && 'ICMS', r.pisItem == null && 'PIS', r.cofinsItem == null && 'COFINS'].filter(Boolean).join(', ')}`,
      })), MerchandiseFactsErrors.ITEM_TAX_RECORD_MISSING)
  }
  // O FCP não tem chave no banco (o faturamento apaga e reinsere): lido à parte; a linha mais recente de cada item vale.
  const [fcpRows] = await q.query(
    `SELECT tb_order_item_id AS itemId, vbcfcp, pfcp, vfcp, vbcfcpst, pfcpst, vfcpst, pst, vbcfcpstret, pfcpstret, vfcpstret
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
    quantity: txt(r.quantity), unitValue: txt(r.unitValue), discountValue: txt(r.discountValue), approxTaxAliq: txt(r.approxTaxAliq),
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
    pis:    { cst: txt(r.pisCst), baseValue: txt(r.pisBase), aliqValue: txt(r.pisAliq), tagValue: txt(r.pisValue), qtSaleQtty: txt(r.pisQtty), qtAliqValue: txt(r.pisQtAliq) },
    cofins: { cst: txt(r.cofinsCst), baseValue: txt(r.cofinsBase), aliqValue: txt(r.cofinsAliq), tagValue: txt(r.cofinsValue), qtSaleQtty: txt(r.cofinsQtty), qtAliqValue: txt(r.cofinsQtAliq) },
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
    `SELECT f.parcel, DATE_FORMAT(f.dt_expiration, '%Y-%m-%d') AS dueDate, f.tag_value AS value, f.tb_payment_types_id AS paymentTypeId,
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
  /** A transportadora (entidade), lida ao vivo; null = sem transportadora. Volumes, pesos e placa não têm origem no ERP web. */
  carrier:     PartyFact | null
}

export async function readShipping(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<ShippingFacts> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query(
    `SELECT sh.tb_freight_mode_id AS freightMode, ca.id AS carrierId
       FROM \`${s}\`.tb_order_shipping sh
       LEFT JOIN \`${s}\`.tb_carrier ca ON ca.id = sh.tb_carrier_id AND ca.tb_institution_id = sh.tb_institution_id AND ca.deleted = 'N'
      WHERE sh.id = ? AND sh.tb_institution_id = ? AND sh.terminal = ? AND sh.deleted = 'N'`,
    [ref.invoiceId, ref.institutionId, ref.terminal])
  const r = rows[0]
  if (!r) return { freightMode: null, carrier: null }
  const carrierId = int(r.carrierId)
  return { freightMode: txt(r.freightMode), carrier: carrierId == null ? null : await readParty(q, schemaName, ref.institutionId, carrierId) }
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
