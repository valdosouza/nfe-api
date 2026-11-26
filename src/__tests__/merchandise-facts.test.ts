/**
 * NFE.E5.P2.T1 — a nfe-api lê o ramo de mercadoria da nota no ERP pela fonte de fatos, escopada por estabelecimento e terminal, sem escrever
 * dado (D-F10, D-F31, D-NE248, D-NE268, D-NE269; ficha-nfe-e5-p2-fonte-de-fatos-mercadoria.md §6-4). O banco é um `Queryable` falso que grava
 * cada SQL com os parâmetros e devolve linhas de exemplo pela tabela que dirige a consulta.
 */
import { invoiceRef } from 'fiscal-api'
import {
  listMerchandiseItems, MerchandiseFactsErrors, readEmitter, readMerchandiseInvoice, readOperationNature, readPayments, readRecipient,
  readReturnOrigins, readShipping,
} from '../facts/merchandise-facts'
import { dhEmiOf } from '../nfe/dh-emi'

type Row = Record<string, unknown>
type Call = { sql: string; params: unknown[] }

/** A vida e o evento E de faturamento padrão da nota (D-NE296): vida 1, faturada em 2026-11-23 13:05:09 UTC. Regra explícita do teste vence. */
const LIFE_DEFAULTS: [string, Row[]][] = [['vw_invoice_life', [{ lifeEvent: 1 }]], ['tb_invoice_event', [{ createdAt: '2026-11-23 13:05:09', lifeDate: '2026-11-23' }]]]

/** Devolve as linhas da 1ª regra cujo texto aparece depois do FROM principal da consulta. */
function fakeDb(rules: [from: string, rows: Row[] | ((params: unknown[]) => Row[])][]) {
  const calls: Call[] = []
  const all = [...rules, ...LIFE_DEFAULTS]
  return {
    calls,
    async query(sql: string, params: unknown[] = []): Promise<[any, any]> {
      calls.push({ sql, params })
      const from = (/\bFROM\s+(\S+)/i.exec(sql)?.[1] ?? '').replace(/`/g, '')
      const rule = all.find(([name]) => from.endsWith(name))
      if (!rule) throw new Error(`fakeDb: consulta sem regra — FROM ${from}`)
      return [typeof rule[1] === 'function' ? rule[1](params) : rule[1], []]
    },
  }
}

const SCHEMA = 'setes_cliente_x'
const INST = 98
const TERMINAL = 7                                                   // de propósito diferente do terminal da web (0)
const REF = invoiceRef(INST, 5001, TERMINAL)

const invoiceRow: Row = {
  id: 5001, number: null, serie: '1', model: '55', dtEmission: '2026-11-23', entityId: 321, status: '0', note: 'obs da nota',
  branchId: 5001, totalValue: '4000.00', indPres: 3,
}

const itemRow = (itemId: number, over: Row = {}): Row => ({
  itemId, kind: 'Sale', productId: 500 + itemId, quantity: '2.0000', unitValue: '10.000000', discountValue: '0.000000',
  description: 'Flange usinada', merchandiseId: 900 + itemId, ncm: '73259990', cest: null, source: '0', manufScale: 'S', factoryCnpj: null,
  saleLevel: 1, saleAbbr: 'PC', saleFactor: '1.000000', saleGtin: null, taxLevel: 1, taxAbbr: 'PC', taxFactor: '1.000000', taxGtin: null,
  icmsItem: itemId, icmsCst: '101', icmsOrigin: '0', cfopId: '5101', credCalcAliq: '0.00', credExplValue: '0.000000', freightValue: '0.00',
  ipiItem: null,
  pisItem: itemId, pisCst: '07', pisBase: '0.00', pisAliq: '0.00', pisValue: '0.0000',
  cofinsItem: itemId, cofinsCst: '07', cofinsBase: '0.00', cofinsAliq: '0.00', cofinsValue: '0.00',
  ...over,
})

const refused = async (p: Promise<unknown>): Promise<{ status?: number; code?: string; fields?: unknown }> => {
  try { await p } catch (e: any) { return { status: e.statusCode, code: e.code, fields: e.fields } }
  return {}
}

describe('NFE.E5.P2.T1 — nota e ramo de mercadoria', () => {
  it('lê a nota do estabelecimento pelo ref (id, institution, terminal) e devolve só o vNF e o indPres do ramo', async () => {
    const db = fakeDb([['tb_invoice', [invoiceRow]]])
    const h = await readMerchandiseInvoice(db, SCHEMA, REF)
    expect(h).toEqual({
      invoiceId: 5001, number: null, serie: '1', model: '55', dtEmission: '2026-11-23', createdAt: '2026-11-23 13:05:09', lifeEvent: 1, lifeDate: '2026-11-23', entityId: 321, status: '0', note: 'obs da nota',
      totalValue: '4000.00', indPres: 3,
    })
    expect(db.calls).toHaveLength(3)                                     // a nota, a vida, o evento da vida
    expect(db.calls[0].params).toEqual([5001, INST, TERMINAL])
    expect(db.calls[0].sql).toContain('`setes_cliente_x`.tb_invoice i')
    expect(db.calls[0].sql).toContain('i.issuer = i.tb_institution_id')
    expect(db.calls[0].sql).not.toMatch(/created_at/)                    // a linha da nota NÃO dá a hora (D-NE296: guarda o 1º faturamento quando revive)
    expect(db.calls[0].sql).not.toMatch(/base_icms_value|icms_value|freight_value|ipi_value/)   // os outros totais do ramo NÃO são lidos (D-NE27)
  })

  it('D-NE296 — a vida vem da view com WHERE pela chave (forma do núcleo, nunca junção) e a hora e a data do evento E dessa vida pela chave, vivo', async () => {
    const db = fakeDb([['tb_invoice', [invoiceRow]]])
    await readMerchandiseInvoice(db, SCHEMA, REF)
    const norm = (x: string) => x.replace(/\s+/g, ' ').trim()
    expect(norm(db.calls[1].sql)).toBe('SELECT life_event AS lifeEvent FROM `setes_cliente_x`.vw_invoice_life WHERE tb_invoice_id = ? AND tb_institution_id = ? AND terminal = ?')
    expect(db.calls[1].params).toEqual([5001, INST, TERMINAL])
    expect(norm(db.calls[2].sql)).toBe("SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt, DATE_FORMAT(dt_record, '%Y-%m-%d') AS lifeDate FROM `setes_cliente_x`.tb_invoice_event WHERE tb_invoice_id = ? AND tb_institution_id = ? AND terminal = ? AND event = ? AND kind = 'E' AND deleted = 'N'")
    expect(db.calls[2].params).toEqual([5001, INST, TERMINAL, 1])
    for (const c of db.calls) expect(c.sql).not.toMatch(/\bJOIN\b[^]*vw_invoice_life/)   // a view nunca como lado de uma junção (materializa o schema)
  })

  it('D-NE296 — a nota que REVIVEU (faturada de novo depois do cancelamento) entrega a hora do evento E da vida nova', async () => {
    // o caso do dev de 2026-11-26 (nota 8014): vida 3, evento E de 26/11 18:05:55; o falso só acha o evento pela vida certa
    const db = fakeDb([
      ['tb_invoice', [{ ...invoiceRow, dtEmission: '2026-11-26' }]],
      ['vw_invoice_life', [{ lifeEvent: 3 }]],
      ['tb_invoice_event', (p: unknown[]) => p[3] === 3 ? [{ createdAt: '2026-11-26 18:05:55', lifeDate: '2026-11-26' }] : []],
    ])
    const h = await readMerchandiseInvoice(db, SCHEMA, REF)
    expect([h.dtEmission, h.createdAt, h.lifeEvent, h.lifeDate]).toEqual(['2026-11-26', '2026-11-26 18:05:55', 3, '2026-11-26'])
    expect(dhEmiOf(h.dtEmission, h.createdAt, 'America/Sao_Paulo', h.lifeDate)).toBe('2026-11-26T15:05:55-03:00')   // 18:05:55 UTC = 15:05:55 em Brasília
  })

  it('qualquer leitura com mais de uma linha → 409 RESOURCE_BUSY, nunca a primeira (PADROES_BANCO §11 regra 13)', async () => {
    const twoInvoices = fakeDb([['tb_invoice', [invoiceRow, { ...invoiceRow }]]])
    expect(await refused(readMerchandiseInvoice(twoInvoices, SCHEMA, REF))).toMatchObject({ status: 409, code: 'RESOURCE_BUSY' })
    const twoLives = fakeDb([['tb_invoice', [invoiceRow]], ['vw_invoice_life', [{ lifeEvent: 1 }, { lifeEvent: 2 }]]])
    expect(await refused(readMerchandiseInvoice(twoLives, SCHEMA, REF))).toMatchObject({ status: 409, code: 'RESOURCE_BUSY' })
    const twoEvents = fakeDb([['tb_invoice', [invoiceRow]], ['tb_invoice_event', [{ createdAt: '2026-11-23 13:05:09', lifeDate: '2026-11-23' }, { createdAt: '2026-11-23 20:00:00', lifeDate: '2026-11-23' }]]])
    expect(await refused(readMerchandiseInvoice(twoEvents, SCHEMA, REF))).toMatchObject({ status: 409, code: 'RESOURCE_BUSY' })
  })

  it('S-A — sem vida (carga ou sincronização) ou sem o evento E vivo dela: `createdAt` nulo, e o dhEmi é recusado com a causa certa', async () => {
    const noLife = fakeDb([['tb_invoice', [invoiceRow]], ['vw_invoice_life', [{ lifeEvent: null }]]])
    const a = await readMerchandiseInvoice(noLife, SCHEMA, REF)
    expect([a.createdAt, a.lifeEvent, a.lifeDate, noLife.calls.length]).toEqual([null, null, null, 2])     // sem vida, o evento nem é lido
    const noEvent = fakeDb([['tb_invoice', [invoiceRow]], ['tb_invoice_event', []]])
    const b = await readMerchandiseInvoice(noEvent, SCHEMA, REF)
    expect([b.createdAt, b.lifeEvent, b.lifeDate]).toEqual([null, 1, null])                               // a vida é crua: a corrida (409) é da transmissão
    let err: any
    try { dhEmiOf(b.dtEmission, b.createdAt, 'America/Sao_Paulo', b.lifeDate) } catch (e) { err = e }
    expect(err?.statusCode).toBe(422)
    expect(JSON.stringify(err?.fields)).toMatch(/evento de faturamento da vida da nota ausente/)
  })

  it('S-B — o evento E da vida tem OUTRA data que não a da nota (linha regravada): a leitura entrega as duas datas e o dhEmi recusa com a causa própria', async () => {
    const db = fakeDb([['tb_invoice', [invoiceRow]], ['tb_invoice_event', [{ createdAt: '2026-11-20 13:05:09', lifeDate: '2026-11-20' }]]])
    const h = await readMerchandiseInvoice(db, SCHEMA, REF)
    expect([h.dtEmission, h.lifeDate]).toEqual(['2026-11-23', '2026-11-20'])
    let err: any
    try { dhEmiOf(h.dtEmission, h.createdAt, 'America/Sao_Paulo', h.lifeDate) } catch (e) { err = e }
    expect(err?.statusCode).toBe(422)
    expect(JSON.stringify(err?.fields)).toMatch(/tem a data 2026-11-20 e a nota tem a data 2026-11-23/)
  })

  it('nota inexistente ou de outro estabelecimento → 404 INVOICE_NOT_FOUND; sem ramo → 422 INVOICE_MERCHANDISE_BRANCH_MISSING', async () => {
    expect(await refused(readMerchandiseInvoice(fakeDb([['tb_invoice', []]]), SCHEMA, REF))).toMatchObject({ status: 404, code: 'INVOICE_NOT_FOUND' })
    const semRamo = fakeDb([['tb_invoice', [{ ...invoiceRow, branchId: null }]]])
    expect(await refused(readMerchandiseInvoice(semRamo, SCHEMA, REF))).toMatchObject({ status: 422, code: MerchandiseFactsErrors.BRANCH_MISSING })
  })

  it('schema malformado é recusado antes de qualquer consulta', async () => {
    const db = fakeDb([])
    await expect(readMerchandiseInvoice(db, 'setes`; DROP', REF)).rejects.toBeTruthy()
    expect(db.calls).toHaveLength(0)
  })
})

describe('NFE.E5.P2.T1 — itens: cadastro ao vivo + cálculo registrado', () => {
  const dbItems = (rows: Row[], fcp: Row[] = [], rules: Row[] = [{ itemId: 10, kind: 'Sale', approxTaxAliq: '13.4500' }, { itemId: 10, kind: 'Service', approxTaxAliq: '99.0000' }]) =>
    fakeDb([['tb_order_item_icms_fcp', fcp], ['tb_order_item_tax_rule', rules], ['tb_order_item', rows]])

  it('devolve os itens com o cProd = id da mercadoria (D-NE269), unidade, GTIN e o cálculo registrado, decimais como texto', async () => {
    const db = dbItems([itemRow(10), itemRow(30, { ipiItem: 30, ipiCst: '99', classFrameCode: '999', ipiBase: '20.00', ipiAliq: '5.00', ipiValue: '1.00' })],
      [{ itemId: 30, vbcfcp: '20.00', pfcp: '2.0000', vfcp: '0.40' }])
    const items = await listMerchandiseItems(db, SCHEMA, REF)
    expect(items.map(i => [i.itemId, i.merchandiseId])).toEqual([[10, 910], [30, 930]])
    expect(items[0]).toMatchObject({
      description: 'Flange usinada', ncm: '73259990', quantity: '2.0000', unitValue: '10.000000', approxTaxAliq: '13.4500',
      saleUnit: { level: 1, measureAbbreviation: 'PC', factor: '1.000000', gtin: null },
      icms: { cst: '101', origin: '0', cfopId: '5101', credCalcAliq: '0.00' },
      pis: { cst: '07', tagValue: '0.0000' }, cofins: { cst: '07' }, ipi: null, fcp: null,
    })
    expect(items[1].ipi).toMatchObject({ cst: '99', classFrameCode: '999', tagValue: '1.00' })
    expect(items[1].fcp).toMatchObject({ vbcfcp: '20.00', pfcp: '2.0000', vfcp: '0.40' })
  })

  it('o SQL dos itens: escopo pelo ref, só item vivo, serviço fora, ordem do id, cálculo com deleted = N e a regra pelo kind do item', async () => {
    const db = dbItems([itemRow(10)])
    await listMerchandiseItems(db, SCHEMA, REF)
    const [items, rule, fcp] = db.calls
    expect(items.params).toEqual([5001, INST, TERMINAL])
    expect(rule.params).toEqual([5001, INST, TERMINAL])
    expect(fcp.params).toEqual([5001, INST, TERMINAL])
    expect(rule.sql).toContain('tb_order_item_tax_rule')
    expect(items.sql).not.toContain('tb_order_item_tax_rule')                                                    // colação diferente: nunca no JOIN (provado no banco real)
    const sql = items.sql.replace(/\s+/g, ' ')
    expect(sql).toContain("WHERE oi.tb_order_id = ? AND oi.tb_institution_id = ? AND oi.terminal = ? AND oi.deleted = 'N' AND (p.id IS NULL OR p.kind <> 'S') ORDER BY oi.id")
    for (const alias of ['ic', 'ip', 'pi', 'co']) {
      expect(sql).toContain(`${alias}.tb_order_item_id = oi.id AND ${alias}.tb_institution_id = oi.tb_institution_id AND ${alias}.terminal = oi.terminal AND ${alias}.deleted = 'N'`)
    }
    expect(sql).toContain('su.level = COALESCE(m.default_sale_trade_level, 1)')                                  // D-PR16: NULL = unidade-base
    expect(sql).toContain('tu.level = COALESCE(m.taxable_trade_level, m.default_sale_trade_level, 1)')           // D-PR16: NULL = a vendida
    expect(sql).toContain('p.tb_institution_id = oi.tb_institution_id')
    for (const col of ['oi.quantity', 'oi.unit_value', 'ic.base_value', 'ic.value', 'ic.cred_expl_value', 'pi.tag_value', 'co.tag_value', 'ip.tag_value']) {
      expect(sql).toContain(`CAST(${col} AS CHAR)`)                                                               // decimal como texto exato, nunca ponto flutuante
    }
    expect(sql).not.toMatch(/identifier|id_internal/)                                                            // D-NE269: nem um nem outro
  })

  it('nota sem item de mercadoria → 422 INVOICE_MERCHANDISE_ITEMS_MISSING', async () => {
    expect(await refused(listMerchandiseItems(dbItems([]), SCHEMA, REF))).toMatchObject({ status: 422, code: MerchandiseFactsErrors.ITEMS_MISSING })
  })

  it('item de mercadoria sem cálculo registrado de ICMS → 422 com os ids; PIS/COFINS ausentes não recusam aqui (camada 1 — RF-NFE-63)', async () => {
    const db = dbItems([itemRow(10), itemRow(20, { pisItem: null, cofinsItem: null }), itemRow(30, { icmsItem: null })])
    const r = await refused(listMerchandiseItems(db, SCHEMA, REF))
    expect(r).toMatchObject({ status: 422, code: MerchandiseFactsErrors.ITEM_TAX_RECORD_MISSING })
    expect(r.fields).toEqual([
      { field: 'items[30]', message: 'Sem cálculo registrado de ICMS' },
    ])
    expect(db.calls).toHaveLength(1)                                                                             // recusou antes de ler o FCP
  })

  it('IPI ausente não recusa (o grupo é condicional): ipi = null', async () => {
    expect((await listMerchandiseItems(dbItems([itemRow(10)]), SCHEMA, REF))[0].ipi).toBeNull()
  })

  it('PIS e COFINS não registrados pelo faturamento → pis e cofins nulos, sem inventar CST (a camada 1 recusa — rej. 745/748)', async () => {
    const [item] = await listMerchandiseItems(dbItems([itemRow(10, { pisItem: null, cofinsItem: null, pisCst: null, cofinsCst: null })]), SCHEMA, REF)
    expect([item.pis, item.cofins]).toEqual([null, null])
    expect(item.icms.cst).toBe('101')
  })
})

describe('NFE.E5.P2.T1 — natOp (D-NE268): a descrição resumida do CFOP do item de nItem 1', () => {
  const items = [{ itemId: 30, icms: { cfopId: '5902' } }, { itemId: 10, icms: { cfopId: '5124' } }] as any

  it('vale o CFOP do MENOR id (nItem 1), não o primeiro da lista nem o último', async () => {
    const db = fakeDb([['setes_central.tb_cfop', p => (p[0] === '5124' ? [{ concise: ' Industrializacao efetuada p/ outra empresa ' }] : [{ concise: 'errado' }])]])
    expect(await readOperationNature(db, items)).toEqual({ cfopId: '5124', operationNature: 'Industrializacao efetuada p/ outra empresa' })
    expect(db.calls[0].params).toEqual(['5124'])
  })

  it('item sem CFOP ou cadastro sem o texto → nulo (a camada 1 recusa); nunca corta nem inventa', async () => {
    const semTexto = fakeDb([['setes_central.tb_cfop', [{ concise: '   ' }]]])
    expect(await readOperationNature(semTexto, items)).toEqual({ cfopId: '5124', operationNature: null })
    const semCfop = fakeDb([])
    expect(await readOperationNature(semCfop, [{ itemId: 1, icms: { cfopId: null } }] as any)).toEqual({ cfopId: null, operationNature: null })
    expect(semCfop.calls).toHaveLength(0)
  })
})

describe('NFE.E5.P2.T1 — emitente, destinatário e transportadora (cadastro ao vivo)', () => {
  const party = (taxRows: Row[]) => fakeDb([
    ['setes_central.tb_entity', [{ nameCompany: 'ANDRE PIAI USINAGEM LTDA', nickTrade: 'PIAI' }]],
    ['setes_central.tb_company', (p) => [{ cnpj: '12345678000195', im: null, ie: '9012345678' }]],
    ['setes_central.tb_person', []],
    ['setes_central.tb_address', [{ kind: 'C', main: 'S', street: 'Rua A', nmbr: '100', complement: null, neighborhood: 'Centro', zipCode: '83005000', cityId: 4125506, cityName: 'São José dos Pinhais', stateName: 'Paraná', stateCode: 'PR' }]],
    ['setes_central.tb_city', [{ ibge: '4125506' }]],
    ['tb_entity_tax', taxRows],
  ])

  it('emitente = a institution: IE, sigla da UF, IBGE e o CRT pelo 1º caractere do regime', async () => {
    const db = party([{ taxRegime: '1 - Simples Nacional', indIeDest: '1', consumer: 'N' }])
    const e = await readEmitter(db, SCHEMA, INST)
    expect(e).toMatchObject({
      entityId: INST, nameCompany: 'ANDRE PIAI USINAGEM LTDA', cnpj: '12345678000195', stateRegistration: '9012345678',
      tax: { taxRegime: '1 - Simples Nacional', crt: '1', indIeDest: '1', consumer: 'N' },
    })
    expect(e.addresses).toEqual([{
      kind: 'C', main: 'S', street: 'Rua A', number: '100', complement: null, neighborhood: 'Centro', zipCode: '83005000',
      cityName: 'São José dos Pinhais', cityIbge: '4125506', stateCode: 'PR',
    }])
    const tax = db.calls.find(c => c.sql.includes('tb_entity_tax'))!
    expect(tax.sql).toContain('`setes_cliente_x`.tb_entity_tax')
    expect(tax.params).toEqual([INST, INST])                                                    // id da entidade = a institution; e o estabelecimento
  })

  it('destinatário: lido pelo id da entidade, com a tributação da relação com ESTE estabelecimento; sem cadastro tributário → tax null', async () => {
    const db = party([])
    const r = await readRecipient(db, SCHEMA, INST, 321)
    expect(r.entityId).toBe(321)
    expect(r.tax).toBeNull()
    expect(db.calls.find(c => c.sql.includes('tb_entity_tax'))!.params).toEqual([321, INST])
  })

  it('regime sem dígito na frente → crt nulo (não adivinha)', async () => {
    const e = await readEmitter(party([{ taxRegime: 'Simples Nacional', indIeDest: null, consumer: null }]), SCHEMA, INST)
    expect(e.tax).toEqual({ taxRegime: 'Simples Nacional', crt: null, indIeDest: null, consumer: null })
  })

  it('entidade inexistente → 422 do emitente e do destinatário', async () => {
    const vazio = () => fakeDb([['setes_central.tb_entity', []]])
    expect(await refused(readEmitter(vazio(), SCHEMA, INST))).toMatchObject({ status: 422, code: 'FISCAL_EMITTER_INCOMPLETE' })
    expect(await refused(readRecipient(vazio(), SCHEMA, INST, 321))).toMatchObject({ status: 422, code: 'FISCAL_RECIPIENT_INCOMPLETE' })
  })
})

describe('NFE.E5.P2.T1 — pagamento, transporte e devolução', () => {
  it('pagamento: a condição do pedido e as parcelas do financeiro, com o tPag do cadastro central, na ordem da parcela', async () => {
    const db = fakeDb([
      ['tb_order_billing', [{ paymentTypeId: 4, nfePaymentCode: '15', plots: '2', deadline: '028/056' }]],
      ['tb_financial', [
        { parcel: 1, dueDate: '2026-12-21', value: '2000.00', paymentTypeId: 4, nfePaymentCode: '15' },
        { parcel: 2, dueDate: '2027-01-18', value: '2000.00', paymentTypeId: 4, nfePaymentCode: '15' },
      ]],
    ])
    const p = await readPayments(db, SCHEMA, REF)
    expect(p.billing).toEqual({ paymentTypeId: 4, nfePaymentCode: '15', plots: '2', deadline: '028/056' })
    expect(p.installments.map(i => [i.parcel, i.dueDate, i.value, i.nfePaymentCode])).toEqual([[1, '2026-12-21', '2000.00', '15'], [2, '2027-01-18', '2000.00', '15']])
    expect(db.calls.map(c => c.params)).toEqual([[5001, INST, TERMINAL], [5001, INST, TERMINAL]])
    expect(db.calls[1].sql.replace(/\s+/g, ' ')).toContain("f.tb_order_id = ? AND f.tb_institution_id = ? AND f.terminal = ? AND f.deleted = 'N' ORDER BY f.parcel")
  })

  it('pedido sem condição e sem parcela → billing null e lista vazia', async () => {
    expect(await readPayments(fakeDb([['tb_order_billing', []], ['tb_financial', []]]), SCHEMA, REF)).toEqual({ billing: null, installments: [] })
  })

  it('transporte sem a linha do pedido → nulos; com modalidade e sem transportadora → carrier null', async () => {
    expect(await readShipping(fakeDb([['tb_order_shipping', []]]), SCHEMA, REF)).toEqual({ freightMode: null, carrierId: null, carrier: null })
    const db = fakeDb([['tb_order_shipping', [{ freightMode: '0', orderCarrierId: 0, carrierId: null }]]])
    expect(await readShipping(db, SCHEMA, REF)).toEqual({ freightMode: '0', carrierId: 0, carrier: null })
    expect(db.calls[0].params).toEqual([5001, INST, TERMINAL])
  })

  it('transporte com transportadora → a entidade dela, lida ao vivo', async () => {
    const db = fakeDb([
      ['tb_order_shipping', [{ freightMode: '1', orderCarrierId: 77, carrierId: 77 }]],
      ['setes_central.tb_entity', [{ nameCompany: 'TRANSPORTES Y', nickTrade: null }]],
      ['setes_central.tb_company', [{ cnpj: '98765432000110', im: null, ie: '111' }]],
      ['setes_central.tb_person', []], ['setes_central.tb_address', []], ['tb_entity_tax', []],
    ])
    const s = await readShipping(db, SCHEMA, REF)
    expect(s.freightMode).toBe('1')
    expect(s.carrier).toMatchObject({ entityId: 77, nameCompany: 'TRANSPORTES Y', cnpj: '98765432000110', stateRegistration: '111', addresses: [], tax: null })
  })

  it('devolução: o elo item → pedido, terminal e item de origem; nota que não é devolução → vazio', async () => {
    const db = fakeDb([['tb_order_item_return', [{ itemId: 1, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 0, originItemId: 3, originKind: 'Sale' }]]])
    expect(await readReturnOrigins(db, SCHEMA, REF)).toEqual([{ itemId: 1, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 0, originItemId: 3, originKind: 'Sale' }])
    expect(db.calls[0].params).toEqual([5001, INST, TERMINAL])
    expect(await readReturnOrigins(fakeDb([['tb_order_item_return', []]]), SCHEMA, REF)).toEqual([])
  })
})

describe('NFE.E5.P2.T1 — a fonte SÓ LÊ e o terminal nunca é literal', () => {
  it('toda consulta de todas as funções é SELECT; trocar o terminal do ref troca o parâmetro; nenhum terminal fixo no SQL', async () => {
    const run = async (terminal: number) => {
      const ref = invoiceRef(INST, 5001, terminal)
      const db = fakeDb([
        ['tb_order_item_icms_fcp', []], ['tb_order_item_tax_rule', []], ['tb_order_item_return', []], ['tb_order_item', [itemRow(10)]], ['tb_order_billing', []], ['tb_financial', []],
        ['tb_order_shipping', []], ['tb_invoice', [invoiceRow]], ['setes_central.tb_cfop', [{ concise: 'Venda' }]],
        ['setes_central.tb_entity', [{ nameCompany: 'X', nickTrade: null }]], ['setes_central.tb_company', []], ['setes_central.tb_person', []],
        ['setes_central.tb_address', []], ['tb_entity_tax', []],
      ])
      await readMerchandiseInvoice(db, SCHEMA, ref)
      await readOperationNature(db, await listMerchandiseItems(db, SCHEMA, ref))
      await readEmitter(db, SCHEMA, INST)
      await readRecipient(db, SCHEMA, INST, 321)
      await readPayments(db, SCHEMA, ref)
      await readShipping(db, SCHEMA, ref)
      await readReturnOrigins(db, SCHEMA, ref)
      return db.calls
    }
    const [a, b] = [await run(0), await run(7)]
    expect(a.length).toBeGreaterThan(10)
    for (const c of a) {
      expect(c.sql.trim()).toMatch(/^SELECT\b/i)
      expect(c.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|FOR UPDATE|LOCK IN SHARE MODE)\b/i)
      expect(c.sql).not.toMatch(/terminal\s*=\s*\d/)
    }
    const scoped = (calls: Call[]) => calls.filter(c => /\bterminal = \?/.test(c.sql))
    expect(scoped(a)).toHaveLength(10)                              // nota, vida, evento da vida (D-NE296), itens, regra, FCP, condição, parcelas, transporte, devolução
    expect(scoped(a).every(c => c.params[1] === INST && c.params[2] === 0)).toBe(true)
    expect(scoped(b).every(c => c.params[1] === INST && c.params[2] === 7)).toBe(true)
  })
})

// =======================================================================================================================================
// G3 — os achados dos gates do passo viram sondas permanentes (socrático 0,80 · adversarial 0,72, 2026-11-23)
// =======================================================================================================================================

const norm = (sql: string) => sql.replace(/\s+/g, ' ')

describe('G3 [FIXED] — o conjunto de itens não muda em silêncio', () => {
  const db = (rows: Row[]) => fakeDb([['tb_order_item_icms_fcp', []], ['tb_order_item_tax_rule', []], ['tb_order_item', rows]])

  it('item vivo cujo produto sumiu do cadastro → 422 INVOICE_ITEM_PRODUCT_MISSING (nunca some do det)', async () => {
    const r = await refused(listMerchandiseItems(db([itemRow(10), itemRow(20, { productId: null, merchandiseId: null })]), SCHEMA, REF))
    expect(r).toMatchObject({ status: 422, code: MerchandiseFactsErrors.ITEM_PRODUCT_MISSING })
    expect(r.fields).toEqual([{ field: 'items[20]', message: 'Produto do item não encontrado no cadastro' }])
  })

  it('o produto entra por LEFT JOIN e o filtro de serviço não derruba o item sem produto', async () => {
    const d = db([itemRow(10)])
    await listMerchandiseItems(d, SCHEMA, REF)
    const sql = norm(d.calls[0].sql)
    expect(sql).toContain('LEFT JOIN `setes_cliente_x`.tb_product p ON p.id = oi.tb_product_id AND p.tb_institution_id = oi.tb_institution_id')
    expect(sql).toContain("AND oi.deleted = 'N' AND (p.id IS NULL OR p.kind <> 'S') ORDER BY oi.id")
  })

  it('mesmo id em dois kind (nota que não passou pela cerca do faturamento — D-NE220) → 422 INVOICE_ITEM_ID_DUPLICATED, não 500', async () => {
    const r = await refused(listMerchandiseItems(db([itemRow(10), itemRow(10, { kind: 'Adjust' }), itemRow(30)]), SCHEMA, REF))
    expect(r).toMatchObject({ status: 422, code: MerchandiseFactsErrors.ITEM_ID_DUPLICATED })
    expect(r.fields).toEqual([{ field: 'items[10]', message: 'Id de item repetido no pedido' }])
  })

  it('erro com lista tem teto de 50 campos (5.000 itens sem ICMS não devolvem 5.000 campos)', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => itemRow(i + 1, { icmsItem: null }))
    const r = await refused(listMerchandiseItems(db(rows), SCHEMA, REF))
    expect(r.code).toBe(MerchandiseFactsErrors.ITEM_TAX_RECORD_MISSING)
    expect((r.fields as unknown[]).length).toBe(50)
  })
})

describe('G3 [FIXED] — cada coluna do item chega ao fato certo (gate adversarial: 47 de 59 mutações sobreviviam)', () => {
  // [tabela, coluna, alias, decimal?] — a MESMA tabela confere o SQL e monta a linha de exemplo, com um valor ÚNICO por alias.
  const COLS: [string, string, string, boolean][] = [
    ['oi', 'quantity', 'quantity', true], ['oi', 'unit_value', 'unitValue', true], ['oi', 'discount_value', 'discountValue', true],
    ['m', 'manuf_sign_ind_scale', 'manufScale', false], ['mf', 'cnpj', 'factoryCnpj', false],
    ['sm', 'abbreviation', 'saleAbbr', false], ['su', 'factor', 'saleFactor', true], ['su', 'gtin', 'saleGtin', false],
    ['tm', 'abbreviation', 'taxAbbr', false], ['tu', 'factor', 'taxFactor', true], ['tu', 'gtin', 'taxGtin', false],
    ['ic', 'cst', 'icmsCst', false], ['ic', 'origem', 'icmsOrigin', false], ['ic', 'tb_cfop_id', 'cfopId', false],
    ['ic', 'determ_base', 'determBase', false], ['ic', 'determ_base_st', 'determBaseSt', false],
    ['ic', 'aliq_rd_base', 'aliqRdBase', true], ['ic', 'base_value', 'icmsBase', true], ['ic', 'aliq', 'icmsAliq', true], ['ic', 'aliq_rd', 'aliqRd', true],
    ['ic', 'value', 'icmsValue', true], ['ic', 'aliq_rd_base_st', 'aliqRdBaseSt', true], ['ic', 'base_value_st', 'baseValueSt', true],
    ['ic', 'aliq_st', 'aliqSt', true], ['ic', 'aliq_rd_st', 'aliqRdSt', true], ['ic', 'value_st', 'valueSt', true], ['ic', 'mva', 'mva', true],
    ['ic', 'withheld_base_value', 'withheldBaseValue', true], ['ic', 'withheld_value', 'withheldValue', true],
    ['ic', 'withheld_base_value_st', 'withheldBaseValueSt', true], ['ic', 'withheld_value_st', 'withheldValueSt', true],
    ['ic', 'cred_calc_aliq', 'credCalcAliq', true], ['ic', 'cred_expl_value', 'credExplValue', true], ['ic', 'freight_value', 'freightValue', true],
    ['ic', 'insurance_Value', 'insuranceValue', true], ['ic', 'expenses_value', 'expensesValue', true], ['ic', 'approximate_tax', 'approximateTax', true],
    ['ic', 'operation_value', 'operationValue', true], ['ic', 'deferred_aliq', 'deferredAliq', true], ['ic', 'deferred_value', 'deferredValue', true],
    ['ip', 'cst', 'ipiCst', false], ['ip', 'class_frame_code', 'classFrameCode', false], ['ip', 'base_value', 'ipiBase', true],
    ['ip', 'aliq_value', 'ipiAliq', true], ['ip', 'tag_value', 'ipiValue', true], ['ip', 'unit_qtty', 'ipiUnitQtty', true], ['ip', 'unit_value', 'ipiUnitValue', true],
    ['pi', 'cst', 'pisCst', false], ['pi', 'base_value', 'pisBase', true], ['pi', 'aliq_value', 'pisAliq', true], ['pi', 'tag_value', 'pisValue', true],
    ['pi', 'qt_sale_qtty', 'pisQtty', true], ['pi', 'qt_aliq_value', 'pisQtAliq', true],
    ['co', 'cst', 'cofinsCst', false], ['co', 'base_value', 'cofinsBase', true], ['co', 'aliq_value', 'cofinsAliq', true], ['co', 'tag_value', 'cofinsValue', true],
    ['co', 'qt_sale_qtty', 'cofinsQtty', true], ['co', 'qt_aliq_value', 'cofinsQtAliq', true],
  ]
  const v = (alias: string) => `v:${alias}`
  const row: Row = {
    itemId: 10, kind: 'Sale', productId: 501, merchandiseId: 902, description: 'v:description', ncm: 'v:ncm', cest: 'v:cest', source: 'v:source',
    saleLevel: 3, taxLevel: 4, discharge: 77, icmsItem: 10, ipiItem: 10, pisItem: 10, cofinsItem: 10,
    ...Object.fromEntries(COLS.map(([, , alias]) => [alias, v(alias)])),
  }
  const db = () => fakeDb([
    ['tb_order_item_icms_fcp', [
      { itemId: 10, vbcfcp: 'velha', pfcp: 'velha', vfcp: 'velha' },
      { itemId: 10, vbcfcp: 'v:vbcfcp', pfcp: 'v:pfcp', vfcp: 'v:vfcp', vbcfcpst: 'v:vbcfcpst', pfcpst: 'v:pfcpst', vfcpst: 'v:vfcpst', pst: 'v:pst', vbcfcpstret: 'v:vbcfcpstret', pfcpstret: 'v:pfcpstret', vfcpstret: 'v:vfcpstret' },
    ]],
    ['tb_order_item_tax_rule', [{ itemId: 10, kind: 'Service', approxTaxAliq: 'errada' }, { itemId: 10, kind: 'Sale', approxTaxAliq: 'v:approxTaxAliq' }]],
    ['tb_order_item', [row]],
  ])

  it('o SQL liga cada alias à coluna certa (decimal sempre por CAST … AS CHAR) e cada tabela pelo JOIN certo', async () => {
    const d = db()
    await listMerchandiseItems(d, SCHEMA, REF)
    const sql = norm(d.calls[0].sql)
    for (const [t, col, alias, dec] of COLS) {
      const expr = dec ? `CAST(${t}.${col} AS CHAR)` : `${t}.${col}`
      expect(sql).toContain(alias === col ? (dec ? `${expr} AS ${alias}` : expr) : `${expr} AS ${alias}`)
    }
    for (const frag of [
      'oi.id AS itemId', 'p.id AS productId', 'p.description', 'm.id AS merchandiseId', 'm.ncm', 'm.cest', 'm.source', 'su.level AS saleLevel', 'tu.level AS taxLevel', 'ic.discharge',
      'ic.tb_order_item_id AS icmsItem', 'ip.tb_order_item_id AS ipiItem', 'pi.tb_order_item_id AS pisItem', 'co.tb_order_item_id AS cofinsItem',
      'LEFT JOIN `setes_cliente_x`.tb_merchandise m ON m.id = p.id AND m.tb_institution_id = p.tb_institution_id',
      "LEFT JOIN `setes_cliente_x`.tb_merchandise_factory mf ON mf.tb_institution_id = m.tb_institution_id AND mf.tb_merchandise_id = m.id AND mf.deleted = 'N'",
      "tb_merchandise_trade_unit su ON su.tb_institution_id = m.tb_institution_id AND su.tb_merchandise_id = m.id AND su.deleted = 'N' AND su.level =",
      "tb_merchandise_trade_unit tu ON tu.tb_institution_id = m.tb_institution_id AND tu.tb_merchandise_id = m.id AND tu.deleted = 'N' AND tu.level =",
      'LEFT JOIN setes_central.tb_measure sm ON sm.id = su.tb_measure_id', 'LEFT JOIN setes_central.tb_measure tm ON tm.id = tu.tb_measure_id',
      'LEFT JOIN `setes_cliente_x`.tb_order_item_icms ic ON ic.tb_order_id = oi.tb_order_id', 'LEFT JOIN `setes_cliente_x`.tb_order_item_ipi ip ON ip.tb_order_id',
      'LEFT JOIN `setes_cliente_x`.tb_order_item_pis pi ON pi.tb_order_id', 'LEFT JOIN `setes_cliente_x`.tb_order_item_cofins co ON co.tb_order_id',
    ]) expect(sql).toContain(frag)
    expect(norm(d.calls[1].sql)).toContain("CAST(approx_tax_aliq AS CHAR) AS approxTaxAliq FROM `setes_cliente_x`.tb_order_item_tax_rule WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'")
    expect(norm(d.calls[2].sql)).toContain("FROM `setes_cliente_x`.tb_order_item_icms_fcp WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N' ORDER BY tb_order_item_id, created_at")
  })

  it('o fato inteiro, campo a campo — a regra do MESMO kind e o FCP da linha mais recente', async () => {
    const [item] = await listMerchandiseItems(db(), SCHEMA, REF)
    expect(item).toEqual({
      itemId: 10, kind: 'Sale', merchandiseId: 902, description: 'v:description', ncm: 'v:ncm', cest: 'v:cest', source: 'v:source',
      manufScale: v('manufScale'), factoryCnpj: v('factoryCnpj'),
      saleUnit:    { level: 3, measureAbbreviation: v('saleAbbr'), factor: v('saleFactor'), gtin: v('saleGtin') },
      taxableUnit: { level: 4, measureAbbreviation: v('taxAbbr'),  factor: v('taxFactor'),  gtin: v('taxGtin') },
      quantity: v('quantity'), unitValue: v('unitValue'), discountValue: v('discountValue'), approxTaxAliq: 'v:approxTaxAliq',
      icms: {
        cst: v('icmsCst'), origin: v('icmsOrigin'), cfopId: v('cfopId'), determBase: v('determBase'), determBaseSt: v('determBaseSt'), discharge: 77,
        aliqRdBase: v('aliqRdBase'), baseValue: v('icmsBase'), aliq: v('icmsAliq'), aliqRd: v('aliqRd'), value: v('icmsValue'),
        aliqRdBaseSt: v('aliqRdBaseSt'), baseValueSt: v('baseValueSt'), aliqSt: v('aliqSt'), aliqRdSt: v('aliqRdSt'), valueSt: v('valueSt'), mva: v('mva'),
        withheldBaseValue: v('withheldBaseValue'), withheldValue: v('withheldValue'), withheldBaseValueSt: v('withheldBaseValueSt'), withheldValueSt: v('withheldValueSt'),
        credCalcAliq: v('credCalcAliq'), credExplValue: v('credExplValue'), freightValue: v('freightValue'), insuranceValue: v('insuranceValue'),
        expensesValue: v('expensesValue'), approximateTax: v('approximateTax'), operationValue: v('operationValue'), deferredAliq: v('deferredAliq'), deferredValue: v('deferredValue'),
      },
      fcp: { vbcfcp: 'v:vbcfcp', pfcp: 'v:pfcp', vfcp: 'v:vfcp', vbcfcpst: 'v:vbcfcpst', pfcpst: 'v:pfcpst', vfcpst: 'v:vfcpst', pst: 'v:pst', vbcfcpstret: 'v:vbcfcpstret', pfcpstret: 'v:pfcpstret', vfcpstret: 'v:vfcpstret' },
      ipi: { cst: v('ipiCst'), classFrameCode: v('classFrameCode'), baseValue: v('ipiBase'), aliqValue: v('ipiAliq'), tagValue: v('ipiValue'), unitQtty: v('ipiUnitQtty'), unitValue: v('ipiUnitValue') },
      pis:    { cst: v('pisCst'), baseValue: v('pisBase'), aliqValue: v('pisAliq'), tagValue: v('pisValue'), qtSaleQtty: v('pisQtty'), qtAliqValue: v('pisQtAliq') },
      cofins: { cst: v('cofinsCst'), baseValue: v('cofinsBase'), aliqValue: v('cofinsAliq'), tagValue: v('cofinsValue'), qtSaleQtty: v('cofinsQtty'), qtAliqValue: v('cofinsQtAliq') },
    })
  })
})

describe('G3 [FIXED] — escopo e vida no texto do SQL das outras leituras (mutações de escopo e de deleted sobreviviam)', () => {
  it('nota, ramo, pagamento, transporte, devolução, partes e natOp', async () => {
    const db = fakeDb([
      ['tb_order_item_return', []], ['tb_order_billing', []], ['tb_financial', []], ['tb_order_shipping', []], ['tb_invoice', [invoiceRow]],
      ['setes_central.tb_cfop', [{ concise: 'Venda' }]], ['setes_central.tb_entity', [{ nameCompany: 'X', nickTrade: null }]],
      ['setes_central.tb_company', []], ['setes_central.tb_person', []], ['setes_central.tb_address', []], ['tb_entity_tax', []],
    ])
    await readMerchandiseInvoice(db, SCHEMA, REF)
    await readPayments(db, SCHEMA, REF)
    await readShipping(db, SCHEMA, REF)
    await readReturnOrigins(db, SCHEMA, REF)
    await readRecipient(db, SCHEMA, INST, 321)
    await readOperationNature(db, [{ itemId: 1, icms: { cfopId: '5101' } }] as any)
    const all = db.calls.map(c => norm(c.sql))
    const has = (frag: string) => expect(all.filter(sql => sql.includes(frag))).toHaveLength(1)
    has("LEFT JOIN `setes_cliente_x`.tb_invoice_merchandise mb ON mb.id = i.id AND mb.tb_institution_id = i.tb_institution_id AND mb.terminal = i.terminal AND mb.deleted = 'N' WHERE i.id = ? AND i.tb_institution_id = ? AND i.terminal = ? AND i.deleted = 'N' AND i.issuer = i.tb_institution_id")
    has('CAST(mb.total_value AS CHAR) AS totalValue, mb.indPres AS indPres')
    has("LEFT JOIN setes_central.tb_payment_types pt ON pt.id = b.tb_payment_types_id WHERE b.id = ? AND b.tb_institution_id = ? AND b.terminal = ? AND b.deleted = 'N'")
    has("CAST(f.tag_value AS CHAR) AS value, f.tb_payment_types_id AS paymentTypeId, pt.id_nfce AS nfePaymentCode FROM `setes_cliente_x`.tb_financial f LEFT JOIN setes_central.tb_payment_types pt ON pt.id = f.tb_payment_types_id")
    has("sh.tb_carrier_id AS orderCarrierId, ca.id AS carrierId FROM `setes_cliente_x`.tb_order_shipping sh LEFT JOIN `setes_cliente_x`.tb_carrier ca ON ca.id = sh.tb_carrier_id AND ca.tb_institution_id = sh.tb_institution_id AND ca.deleted = 'N' WHERE sh.id = ? AND sh.tb_institution_id = ? AND sh.terminal = ? AND sh.deleted = 'N'")
    has("r.tb_order_id_ori AS originInvoiceId, r.terminal_ori AS originTerminal, r.tb_order_item_id_ori AS originItemId, r.kind_ori AS originKind FROM `setes_cliente_x`.tb_order_item_return r WHERE r.tb_order_id = ? AND r.tb_institution_id = ? AND r.terminal = ? AND r.deleted = 'N' ORDER BY r.id")
    has("SELECT ie FROM setes_central.tb_company WHERE id = ? AND deleted = 'N'")
    has("st.abbreviation AS stateCode FROM setes_central.tb_address a LEFT JOIN setes_central.tb_state st ON st.id = a.tb_state_id LEFT JOIN setes_central.tb_city ci ON ci.id = a.tb_city_id WHERE a.id = ? AND a.deleted = 'N' ORDER BY a.kind")
    has("SELECT tax_regime AS taxRegime, ind_ie_dest AS indIeDest, consumer FROM `setes_cliente_x`.tb_entity_tax WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'")
    has('SELECT concise FROM setes_central.tb_cfop WHERE id = ?')
  })

  it('devolução e parcelas: cada coluna no campo certo', async () => {
    const db = fakeDb([
      ['tb_order_item_return', [{ itemId: 1, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 9, originItemId: 3, originKind: 'Sale' }]],
      ['tb_order_billing', [{ paymentTypeId: 4, nfePaymentCode: '15', plots: '2', deadline: '028/056' }]],
      ['tb_financial', [{ parcel: 2, dueDate: '2027-01-18', value: '1999.99', paymentTypeId: 5, nfePaymentCode: '17' }]],
    ])
    expect(await readReturnOrigins(db, SCHEMA, REF)).toEqual([{ itemId: 1, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 9, originItemId: 3, originKind: 'Sale' }])
    expect((await readPayments(db, SCHEMA, REF)).installments).toEqual([{ parcel: 2, dueDate: '2027-01-18', value: '1999.99', paymentTypeId: 5, nfePaymentCode: '17' }])
  })
})

describe('G3 [FIXED] — transportadora gravada no pedido e sem cadastro não vira "sem transportadora" em silêncio', () => {
  it('o id gravado no pedido sai cru em carrierId, mesmo com carrier nulo', async () => {
    const db = fakeDb([['tb_order_shipping', [{ freightMode: '1', orderCarrierId: 77, carrierId: null }]]])
    expect(await readShipping(db, SCHEMA, REF)).toEqual({ freightMode: '1', carrierId: 77, carrier: null })
  })
})
