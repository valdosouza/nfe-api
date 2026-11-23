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

type Row = Record<string, unknown>
type Call = { sql: string; params: unknown[] }

/** Devolve as linhas da 1ª regra cujo texto aparece depois do FROM principal da consulta. */
function fakeDb(rules: [from: string, rows: Row[] | ((params: unknown[]) => Row[])][]) {
  const calls: Call[] = []
  return {
    calls,
    async query(sql: string, params: unknown[] = []): Promise<[any, any]> {
      calls.push({ sql, params })
      const from = (/\bFROM\s+(\S+)/i.exec(sql)?.[1] ?? '').replace(/`/g, '')
      const rule = rules.find(([name]) => from.endsWith(name))
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
  itemId, kind: 'Sale', quantity: '2.0000', unitValue: '10.000000', discountValue: '0.000000',
  description: 'Flange usinada', merchandiseId: 900 + itemId, ncm: '73259990', cest: null, source: '0', manufScale: 'S', factoryCnpj: null,
  saleLevel: 1, saleAbbr: 'PC', saleFactor: '1.000000', saleGtin: null, taxLevel: 1, taxAbbr: 'PC', taxFactor: '1.000000', taxGtin: null,
  approxTaxAliq: '13.4500',
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
      invoiceId: 5001, number: null, serie: '1', model: '55', dtEmission: '2026-11-23', entityId: 321, status: '0', note: 'obs da nota',
      totalValue: '4000.00', indPres: 3,
    })
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].params).toEqual([5001, INST, TERMINAL])
    expect(db.calls[0].sql).toContain('`setes_cliente_x`.tb_invoice i')
    expect(db.calls[0].sql).toContain('i.issuer = i.tb_institution_id')
    expect(db.calls[0].sql).not.toMatch(/base_icms_value|icms_value|freight_value|ipi_value/)   // os outros totais do ramo NÃO são lidos (D-NE27)
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
  const dbItems = (rows: Row[], fcp: Row[] = []) => fakeDb([['tb_order_item_icms_fcp', fcp], ['tb_order_item', rows]])

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
    const [items, fcp] = db.calls
    expect(items.params).toEqual([5001, INST, TERMINAL])
    expect(fcp.params).toEqual([5001, INST, TERMINAL])
    const sql = items.sql.replace(/\s+/g, ' ')
    expect(sql).toContain("WHERE oi.tb_order_id = ? AND oi.tb_institution_id = ? AND oi.terminal = ? AND oi.deleted = 'N' AND p.kind <> 'S' ORDER BY oi.id")
    for (const alias of ['tr', 'ic', 'ip', 'pi', 'co']) {
      expect(sql).toContain(`${alias}.tb_order_item_id = oi.id AND ${alias}.tb_institution_id = oi.tb_institution_id AND ${alias}.terminal = oi.terminal AND ${alias}.deleted = 'N'`)
    }
    expect(sql).toContain('tr.kind = oi.kind')
    expect(sql).toContain('su.level = COALESCE(m.default_sale_trade_level, 1)')                                  // D-PR16: NULL = unidade-base
    expect(sql).toContain('tu.level = COALESCE(m.taxable_trade_level, m.default_sale_trade_level, 1)')           // D-PR16: NULL = a vendida
    expect(sql).toContain('p.tb_institution_id = oi.tb_institution_id')
    expect(sql).not.toMatch(/identifier|id_internal/)                                                            // D-NE269: nem um nem outro
  })

  it('nota sem item de mercadoria → 422 INVOICE_MERCHANDISE_ITEMS_MISSING', async () => {
    expect(await refused(listMerchandiseItems(dbItems([]), SCHEMA, REF))).toMatchObject({ status: 422, code: MerchandiseFactsErrors.ITEMS_MISSING })
  })

  it('item de mercadoria sem cálculo registrado de ICMS, PIS ou COFINS → 422 com os ids e o que falta (RF-NFE-63: rej. 745/748)', async () => {
    const db = dbItems([itemRow(10), itemRow(20, { pisItem: null, cofinsItem: null }), itemRow(30, { icmsItem: null })])
    const r = await refused(listMerchandiseItems(db, SCHEMA, REF))
    expect(r).toMatchObject({ status: 422, code: MerchandiseFactsErrors.ITEM_TAX_RECORD_MISSING })
    expect(r.fields).toEqual([
      { field: 'items[20]', message: 'Sem cálculo registrado de PIS, COFINS' },
      { field: 'items[30]', message: 'Sem cálculo registrado de ICMS' },
    ])
    expect(db.calls).toHaveLength(1)                                                                             // recusou antes de ler o FCP
  })

  it('IPI ausente não recusa (o grupo é condicional): ipi = null', async () => {
    expect((await listMerchandiseItems(dbItems([itemRow(10)]), SCHEMA, REF))[0].ipi).toBeNull()
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
    expect(await readShipping(fakeDb([['tb_order_shipping', []]]), SCHEMA, REF)).toEqual({ freightMode: null, carrier: null })
    const db = fakeDb([['tb_order_shipping', [{ freightMode: '0', carrierId: null }]]])
    expect(await readShipping(db, SCHEMA, REF)).toEqual({ freightMode: '0', carrier: null })
    expect(db.calls[0].params).toEqual([5001, INST, TERMINAL])
  })

  it('transporte com transportadora → a entidade dela, lida ao vivo', async () => {
    const db = fakeDb([
      ['tb_order_shipping', [{ freightMode: '1', carrierId: 77 }]],
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
        ['tb_order_item_icms_fcp', []], ['tb_order_item_return', []], ['tb_order_item', [itemRow(10)]], ['tb_order_billing', []], ['tb_financial', []],
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
    expect(scoped(a)).toHaveLength(7)                               // nota, itens, FCP, condição, parcelas, transporte, devolução
    expect(scoped(a).every(c => c.params[1] === INST && c.params[2] === 0)).toBe(true)
    expect(scoped(b).every(c => c.params[1] === INST && c.params[2] === 7)).toBe(true)
  })
})
