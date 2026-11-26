/// <reference types="jest" />
/**
 * NFE.E6.P4 mudança 2 (ficha-nfe-e6-p4-rotas-email-operacao.md §6-2; S-5, S-6, S-9): os leitores novos — `pending`, `numbering`, a listagem de inutilizações e as configs do e-mail.
 * `Queryable` falso que responde pelo texto do SQL; nenhuma conexão. A prova de que a junção acha a vida certa no motor real é a do passeio (mudança 10).
 */
import { listPending } from '../nfe/pending'
import { readNumbering } from '../nfe/numbering'
import { listVoids } from '../nfe/void-range'
import { DEFAULT_MAIL_SUBJECT, readMailConfig } from '../facts/nfe-lists'

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return { __esModule: true, ...actual, readWithdrawnRanges: jest.fn(), erp: { ...actual.erp, invoiceLives: jest.fn() } }
})
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fiscal = require('fiscal-api') as { readWithdrawnRanges: jest.Mock; erp: { invoiceLives: jest.Mock } }

type Row = Record<string, unknown>
const SCOPE = { institutionId: 7, terminal: 0 }
const life = (id: number, over: Partial<{ deleted: boolean; lifeEvent: number | null; lastKind: string | null }> = {}) => [id, { invoiceId: id, invoiceDeleted: over.deleted ?? false, lifeEvent: over.lifeEvent === undefined ? 1 : over.lifeEvent, lastEvent: 1, lastKind: over.lastKind === undefined ? 'E' : over.lastKind }] as const

function fakeQ(handlers: { match: RegExp; rows: Row[] | ((sql: string, params: unknown) => Row[]) }[]) {
  const calls: { sql: string; params: unknown }[] = []
  return {
    calls,
    async query(sql: string, params?: unknown): Promise<[any, any]> {
      calls.push({ sql, params })
      const h = handlers.find(x => x.match.test(sql))
      if (!h) throw new Error(`SQL sem resposta no falso: ${sql.slice(0, 80)}`)
      return [typeof h.rows === 'function' ? h.rows(sql, params) : h.rows, []]
    },
  }
}

const attemptRow = (invoiceId: number, lifeEvent: number, kind: string | null, over: Row = {}): Row => ({
  invoiceId, attempt: 1, lifeEvent, environment: 'H', authorizer: 'PR', accessKey: '41261111222333000181550010000000011000000019', dhEmission: '2026-11-20 12:00:00', digestValue: 'x',
  receipt: null, protocol: null, dhRecbto: null, lastQueriedAt: null, nfeNotRegisteredAt: null, lastEvent: kind ? 1 : null, lastKind: kind, lastCode: null, lastEventAt: null, createdAt: '2026-11-20 12:00:00', ...over,
})

describe('listPending — as notas faturadas sem NF-e viva, autorizada ou denegada', () => {
  const billed = [1, 2, 3, 4, 5, 6, 7, 8].map(id => ({ id, number: String(id), serie: '1', dtEmission: `2026-11-0${id}` }))
  const interfaces = [1, 2, 3, 4, 5, 6, 7, 8].map(id => ({ orderId: id, k: id === 8 ? 'service-orders' : id === 7 ? 'order-returns' : 'orders' }))
  const attempts = [
    attemptRow(2, 1, 'A'), attemptRow(3, 1, 'R'), attemptRow(4, 1, 'D'), attemptRow(5, 1, null), attemptRow(6, 1, 'K'),
    attemptRow(1, 1, 'R'),
  ]
  const q = () => fakeQ([
    { match: /FROM `setes_x`\.tb_invoice i/, rows: billed },
    { match: /vw_order_interface/, rows: interfaces },
    { match: /tb_invoice_merchandise_transmission/, rows: attempts },
  ])
  beforeEach(() => {
    fiscal.erp.invoiceLives.mockResolvedValue(new Map([life(1), life(2), life(3), life(4), life(5), life(6), life(7), life(8)]))
  })

  it('fica na lista a nota sem tentativa e a de última voz R (rejeitada); sai A, D, K e a reserva sem voz; a nota de serviço nunca entra', async () => {
    const r = await listPending(q() as never, 'setes_x', SCOPE, { page: 1, pageSize: 25, allowed: ['orders', 'order-returns'] })
    expect(r.items.map(i => i.invoiceId)).toEqual([1, 3, 7])                          // 1 (R), 3 (R), 7 (devolução, sem tentativa)
    expect(r.total).toBe(3)
    expect(r.items.find(i => i.invoiceId === 7)).toMatchObject({ finality: '4', interfaceKey: 'order-returns' })
    expect(r.items.find(i => i.invoiceId === 1)).toMatchObject({ finality: '1', interfaceKey: 'orders', dtEmission: '2026-11-01' })
  })

  it('a P e a C também tiram a nota da fila', async () => {
    const qq = fakeQ([
      { match: /FROM `setes_x`\.tb_invoice i/, rows: billed.slice(0, 2) },
      { match: /vw_order_interface/, rows: interfaces },
      { match: /tb_invoice_merchandise_transmission/, rows: [attemptRow(1, 1, 'P'), attemptRow(2, 1, 'C')] },
    ])
    expect((await listPending(qq as never, 'setes_x', SCOPE, { page: 1, pageSize: 25, allowed: ['orders'] })).items).toEqual([])
  })

  it('o N (cancelamento liberado) é nota AUTORIZADA e também sai da fila (gate adversarial M1)', async () => {
    const qq = fakeQ([
      { match: /FROM `setes_x`\.tb_invoice i/, rows: billed.slice(0, 2) },
      { match: /vw_order_interface/, rows: interfaces },
      { match: /tb_invoice_merchandise_transmission/, rows: [attemptRow(1, 1, 'N'), attemptRow(2, 1, 'R')] },
    ])
    expect((await listPending(qq as never, 'setes_x', SCOPE, { page: 1, pageSize: 25, allowed: ['orders'] })).items.map(i => i.invoiceId)).toEqual([2])
  })

  it('só os ramos contratados: o filtro do ramo e a lista vazia sem ramo (sem ir ao banco)', async () => {
    expect((await listPending(q() as never, 'setes_x', SCOPE, { page: 1, pageSize: 25, allowed: ['order-returns'] })).items.map(i => i.invoiceId)).toEqual([7])
    const none = q()
    expect(await listPending(none as never, 'setes_x', SCOPE, { page: 1, pageSize: 25, allowed: [] })).toEqual({ total: 0, items: [] })
    expect(none.calls).toHaveLength(0)
  })

  it('nota sem vida, apagada, sem o evento E ou de vida cancelada não entra (nunca transmite)', async () => {
    fiscal.erp.invoiceLives.mockResolvedValue(new Map([life(1, { deleted: true }), life(2, { lifeEvent: null }), life(3, { lastKind: 'C' })]))
    const qq = fakeQ([
      { match: /FROM `setes_x`\.tb_invoice i/, rows: billed.slice(0, 4) },
      { match: /vw_order_interface/, rows: interfaces },
      { match: /tb_invoice_merchandise_transmission/, rows: [] },
    ])
    expect((await listPending(qq as never, 'setes_x', SCOPE, { page: 1, pageSize: 25, allowed: ['orders'] })).items).toEqual([])   // 4 não tem vida na view
  })

  it('a página 2 devolve o resto e o total continua inteiro', async () => {
    const r = await listPending(q() as never, 'setes_x', SCOPE, { page: 2, pageSize: 2, allowed: ['orders', 'order-returns'] })
    expect(r.total).toBe(3)
    expect(r.items.map(i => i.invoiceId)).toEqual([7])
  })

  it('nenhuma view entra como lado de dentro de junção: as leituras são por lote com WHERE', async () => {
    const qq = q()
    await listPending(qq as never, 'setes_x', SCOPE, { page: 1, pageSize: 25, allowed: ['orders'] })
    for (const c of qq.calls) expect(c.sql).not.toMatch(/JOIN\s+`?[a-z_]+`?\.?vw_/i)
  })
})

describe('readNumbering — os buracos derivados', () => {
  const KEY = (n: number) => n
  const attempts = (list: { n: number; id: number; protocol?: string | null; life?: number; dh?: string }[]) => list.map(a => ({ number: KEY(a.n), invoiceId: a.id, terminal: 0, lifeEvent: a.life ?? 1, protocol: a.protocol ?? null, dhEmission: a.dh ?? '2026-10-31 23:30:00' }))
  const qOf = (highest: number | null, rows: ReturnType<typeof attempts>) => fakeQ([
    { match: /MAX\(CAST/, rows: [{ highest }] },
    { match: /ORDER BY number/, rows: rows as never },
  ])
  const month = (utc: string): string => (utc.startsWith('2026-10-31 23') ? '2026-10' : utc.slice(0, 7))
  beforeEach(() => { fiscal.readWithdrawnRanges.mockResolvedValue([]) })

  it('sem nenhuma tentativa: sem último número e sem buraco', async () => {
    expect(await readNumbering(qOf(null, []) as never, 'fiscal_api', 'setes_x', SCOPE, 1, 'H', month)).toEqual({ serie: 1, environment: 'H', highestNumber: null, gaps: [] })
  })

  it('o buraco entre 1 e o último gerado aparece; o número registrado e o da nota viva têm dono', async () => {
    fiscal.erp.invoiceLives.mockResolvedValue(new Map([life(12)]))
    const q = qOf(5, attempts([{ n: 1, id: 11, protocol: '141' }, { n: 2, id: 12 }, { n: 5, id: 15, protocol: '142' }]))
    const r = await readNumbering(q as never, 'fiscal_api', 'setes_x', SCOPE, 1, 'H', month)
    expect(r.highestNumber).toBe(5)
    expect(r.gaps).toEqual([{ from: 3, to: 4, oldestInvoiceMonth: null }])           // 3 e 4 nunca tiveram tentativa; 2 é da nota viva sem protocolo (reaproveita)
  })

  it('a tentativa sem protocolo de nota apagada ou de vida velha deixa o número livre — o mês do buraco vem da emissão dela', async () => {
    fiscal.erp.invoiceLives.mockResolvedValue(new Map([life(12, { deleted: true }), life(13, { lifeEvent: 2 })]))
    const q = qOf(3, attempts([{ n: 1, id: 11, protocol: '141' }, { n: 2, id: 12 }, { n: 3, id: 13, life: 1 }]))
    const r = await readNumbering(q as never, 'fiscal_api', 'setes_x', SCOPE, 1, 'H', month)
    expect(r.gaps).toEqual([{ from: 2, to: 3, oldestInvoiceMonth: '2026-10' }])      // 23:30 UTC de 31/10 → mês 2026-10 pela zona injetada
  })

  it('a faixa retirada (pendente ou inutilizada) desconta o buraco', async () => {
    fiscal.readWithdrawnRanges.mockResolvedValue([{ numberFrom: 3, numberTo: 4 }])
    const q = qOf(6, attempts([{ n: 1, id: 11, protocol: '1' }, { n: 2, id: 12, protocol: '2' }, { n: 5, id: 15, protocol: '5' }, { n: 6, id: 16, protocol: '6' }]))
    const r = await readNumbering(q as never, 'fiscal_api', 'setes_x', SCOPE, 1, 'H', month)
    expect(r.gaps).toEqual([])
    expect(fiscal.readWithdrawnRanges).toHaveBeenCalledWith(expect.anything(), 'fiscal_api', { institutionId: 7, model: '55', serie: 1, environment: 'H' })
  })

  it('a sequência aberta em N > 1 (continua o legado — D-NE265): os números do legado ABAIXO do 1º gerado por esta API NUNCA são buraco; o buraco real dentro do trecho nosso aparece', async () => {
    fiscal.erp.invoiceLives.mockResolvedValue(new Map())
    const q = qOf(120010, attempts([{ n: 120000, id: 1, protocol: '1' }, { n: 120001, id: 2, protocol: '2' }, { n: 120004, id: 4, protocol: '4' }, { n: 120010, id: 10, protocol: '10' }]))
    const r = await readNumbering(q as never, 'fiscal_api', 'setes_x', SCOPE, 1, 'P', month)
    expect(r.gaps.map(g => [g.from, g.to])).toEqual([[120002, 120003], [120005, 120009]])
    expect(r.gaps.some(g => g.from < 120000)).toBe(false)
  })

  it('buraco no fim da série (o começo é o 1º gerado por esta API); sem trava (nenhuma instrução FOR UPDATE)', async () => {
    const q = qOf(4, attempts([{ n: 2, id: 12, protocol: '2' }]))
    const r = await readNumbering(q as never, 'fiscal_api', 'setes_x', SCOPE, 1, 'P', month)
    expect(r.gaps.map(g => [g.from, g.to])).toEqual([[3, 4]])                              // o começo NÃO é buraco: o 1º número é o 1º gerado por esta API (aqui o 2)
    for (const c of q.calls) expect(c.sql).not.toMatch(/FOR UPDATE|LOCK IN SHARE/i)
  })
})

describe('listVoids — a listagem paginada das inutilizações', () => {
  it('mapeia o estado (em voo, homologada, rejeitada), o ano do Id e a paginação', async () => {
    const q = fakeQ([
      { match: /COUNT\(\*\)/, rows: [{ n: 3 }] },
      { match: /ORDER BY id DESC LIMIT/, rows: [
        { id: 3, environment: 'H', serie: 1, year: 2026, nFrom: 10, nTo: 12, reason: 'faixa pulada por erro de numeração', voidId: 'ID', authorityCode: null, protocol: null, withdrawn: 'S', dh: null },
        { id: 2, environment: 'H', serie: 1, year: 2026, nFrom: 5, nTo: 6, reason: 'faixa pulada por erro de numeração', voidId: 'ID', authorityCode: '102', protocol: '141', withdrawn: 'S', dh: '2026-11-20 15:00:00' },
        { id: 1, environment: 'H', serie: 1, year: 2026, nFrom: 1, nTo: 2, reason: 'faixa pulada por erro de numeração', voidId: 'ID', authorityCode: '256', protocol: null, withdrawn: null, dh: '2026-11-19 15:00:00' },
      ] },
    ])
    const r = await listVoids(q as never, 7, 2, 3)
    expect(r.total).toBe(3)
    expect(r.items.map(i => i.state)).toEqual(['in_flight', 'homologated', 'rejected'])
    expect(q.calls[1].params).toEqual([7, 3, 3])                                      // estabelecimento, pageSize, offset (página 2)
    expect(q.calls[1].sql).toMatch(/model = '55'/)
  })
})

describe('readMailConfig — as configurações da interface billing (seed 78)', () => {
  it('o valor da empresa vence o padrão; o assunto vem do catálogo', async () => {
    const q = fakeQ([{ match: /tb_interface_has_config/, rows: [{ name: 'fiscal_email_auto_send', content: 'N' }, { name: 'nfe_email_subject', content: 'NF-e {number} da Setes' }] }])
    expect(await readMailConfig(q as never, 'setes_x', 7)).toEqual({ autoSend: false, subject: 'NF-e {number} da Setes' })
    expect(q.calls[0].sql).toMatch(/i\.i18n_key = 'billing'/)
    expect(q.calls[0].sql).toMatch(/v\.tb_user_id = 0/)
  })

  it('sem linha: nasce ligado (D-NE261) e o assunto é o padrão do ERP Desktop; assunto em branco cai no padrão', async () => {
    expect(await readMailConfig(fakeQ([{ match: /tb_interface_has_config/, rows: [] }]) as never, 'setes_x', 7)).toEqual({ autoSend: true, subject: DEFAULT_MAIL_SUBJECT })
    const blank = fakeQ([{ match: /tb_interface_has_config/, rows: [{ name: 'nfe_email_subject', content: '   ' }] }])
    expect((await readMailConfig(blank as never, 'setes_x', 7)).subject).toBe(DEFAULT_MAIL_SUBJECT)
  })

  it('o schema passa pela guarda (nome fora da forma recusa antes do SQL)', async () => {
    await expect(readMailConfig(fakeQ([]) as never, 'x`; DROP', 7)).rejects.toBeTruthy()
  })
})
