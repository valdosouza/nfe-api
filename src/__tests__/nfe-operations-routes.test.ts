/// <reference types="jest" />
/**
 * NFE.E6.P4 mudança 5 (ficha-nfe-e6-p4-rotas-email-operacao.md §6-5; D-E14, D-F14/D-F37, D-NE26, D-NE254): as operações do ESTABELECIMENTO — `GET …/invoices/pending`, `POST /v1/nfe/refresh`,
 * `GET /v1/nfe/numbering` e `GET`/`POST /v1/nfe/voids`. As rotas são provadas com o service falso (guardas, validação estrita, envelope); o service é provado com o código real e o fisco
 * simulado (`refreshAll` e `voidRange` são provados nos testes deles). Nada vai ao fisco nem ao banco.
 */
import { generateKeyPairSync, randomBytes } from 'crypto'
import path from 'path'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { FsFiscalStorage, MasterKeyRing, ProductTokenVerifier } from 'fiscal-api'
import { createApp } from '../app'
import type { AppContext } from '../context'
import { loadServerCa } from '../authority/server-ca'
import { Breaker } from '../nfe/breaker'
import * as invoicesService from '../modules/invoices/invoices.service'
import * as opsService from '../modules/operations/operations.service'
import * as refreshAllModule from '../nfe/refresh-all'
import * as voidModule from '../nfe/void-range'
import { StatusBoard } from '../authority/status-board'
import * as probeModule from '../authority/status-probe'
import { FAKE_TECH } from './technical-responsible-fake'

jest.mock('../modules/invoices/invoices.service', () => ({ ...jest.requireActual('../modules/invoices/invoices.service'), pending: jest.fn() }))
jest.mock('../nfe/refresh-all', () => ({ ...jest.requireActual('../nfe/refresh-all'), refreshAll: jest.fn() }))
jest.mock('../nfe/void-range', () => ({ ...jest.requireActual('../nfe/void-range'), voidRange: jest.fn(), listVoids: jest.fn(), findVoidItem: jest.fn() }))
jest.mock('../nfe/numbering', () => ({ readNumbering: jest.fn() }))
jest.mock('../authority/status-probe', () => ({ probeAuthorityStatus: jest.fn() }))
jest.mock('../facts/merchandise-facts', () => ({ ...jest.requireActual('../facts/merchandise-facts'), readEmitter: jest.fn() }))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    erp: { ...actual.erp, institutionZone: jest.fn() },
    acquireRefreshLease: jest.fn(), releaseRefreshLease: jest.fn(), getIssuer: jest.fn(), openIssuer: jest.fn(),
    access: { ...actual.access, liveIdentity: jest.fn(), accessVerdict: jest.fn(), reachableKeys: jest.fn() },
  }
})
jest.setTimeout(60_000)

// eslint-disable-next-line @typescript-eslint/no-var-requires
const numberingModule = require('../nfe/numbering') as { readNumbering: jest.Mock }
const f = fiscal as unknown as Record<string, any>
const accessM = f.access as Record<string, jest.Mock>
const erpM = f.erp as Record<string, jest.Mock>
const pendingM = (invoicesService as unknown as Record<string, jest.Mock>).pending
const refreshAllM = refreshAllModule.refreshAll as unknown as jest.Mock
const voidRangeM = voidModule.voidRange as unknown as jest.Mock
const listVoidsM = voidModule.listVoids as unknown as jest.Mock
const findVoidM = voidModule.findVoidItem as unknown as jest.Mock

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const token = () => jwt.sign({ institutionId: 1, userId: 7, schemaName: 'setes_setes' }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
const SERVER_CA = loadServerCa(path.resolve(__dirname, '..', '..', 'acervo', 'icp', 'raizes-icp-brasil.pem'), new Date('2026-11-21T12:00:00Z'))
const ctx = (over: Partial<AppContext> = {}): AppContext => ({
  db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
  pool: { query: jest.fn(async () => [[{ x: 1 }]]), getConnection: jest.fn() } as any, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage('/tmp/nfe-ops-nao-usado'),
  fiscalDb: 'fiscal_api', verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: [], checkIdentity: true, serverCa: SERVER_CA, technicalResponsible: FAKE_TECH, breaker: new Breaker(() => new Date()), ...over,
})
const A = { Authorization: `Bearer ${token()}` }
const inst = { institutionId: 1, userId: 7, schemaName: 'setes_setes' } as any

beforeEach(() => {
  jest.clearAllMocks()
  accessM.liveIdentity.mockImplementation(async (_q: unknown, p: any) => ({ ...p, role: 'admin' }))
  accessM.accessVerdict.mockResolvedValue('ok')
  accessM.reachableKeys.mockResolvedValue(['orders', 'order-returns'])
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
})

describe('GET /v1/nfe/invoices/pending', () => {
  it('a rota vem antes de /:invoiceId; só os ramos contratados; o filtro do ramo vale dentro do contratado; envelope paginado da casa', async () => {
    pendingM.mockResolvedValue({ total: 1, items: [{ invoiceId: 9, number: '9', serie: '1', dtEmission: '2026-11-25', finality: '1', interfaceKey: 'orders' }] })
    const r = await request(createApp(ctx())).get('/v1/nfe/invoices/pending?page=2&pageSize=10').set(A)
    expect([r.status, r.body.ok, r.body.page, r.body.pageSize, r.body.total, r.body.data[0].invoiceId]).toEqual([200, true, 2, 10, 1, 9])
    expect(pendingM.mock.calls[0][2]).toEqual({ page: 2, pageSize: 10 })
    expect(pendingM.mock.calls[0][3]).toEqual(['orders', 'order-returns'])
    accessM.reachableKeys.mockResolvedValue(['order-returns'])
    await request(createApp(ctx())).get('/v1/nfe/invoices/pending?interfaceKey=orders').set(A)
    expect(pendingM.mock.calls[1][3]).toEqual([])                                       // pediu `orders`, só `order-returns` contratado → vazio
    accessM.reachableKeys.mockResolvedValue(['orders'])
    await request(createApp(ctx())).get('/v1/nfe/invoices/pending?interfaceKey=orders').set(A)
    expect(pendingM.mock.calls[2][3]).toEqual(['orders'])
  })

  it('parâmetro inválido = 400 VALIDATION_FAILED (ramo fora do enum, página 0, pageSize 101); sem token = 401', async () => {
    for (const q of ['interfaceKey=service-orders', 'page=0', 'pageSize=101']) {
      const r = await request(createApp(ctx())).get(`/v1/nfe/invoices/pending?${q}`).set(A)
      expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED'])
    }
    expect((await request(createApp(ctx())).get('/v1/nfe/invoices/pending')).status).toBe(401)
    expect(pendingM).not.toHaveBeenCalled()
  })
})

describe('POST /v1/nfe/refresh — a passada do rodízio', () => {
  it('pede TRANSMITIR em QUALQUER ramo da NF-e (uma só pergunta com os dois ramos); sem ele 403 e a passada nem começa', async () => {
    f.acquireRefreshLease.mockResolvedValue('tok'); f.releaseRefreshLease.mockResolvedValue(true)
    refreshAllM.mockResolvedValue({ scanned: 3, consulted: 2, throttled: 1, tooOld: 0, skipped: 0, circuitOpen: false, changed: 1, incidents: [], results: [] })
    const ok = await request(createApp(ctx())).post('/v1/nfe/refresh').set(A).send({ limit: 10 })
    expect([ok.status, ok.body.data]).toEqual([200, { checked: 2, changed: 1, stoppedEarly: false, skipped: false, throttled: 1, circuitOpen: false, errors: [] }])
    expect(accessM.accessVerdict.mock.calls[0].slice(2)).toEqual([['orders', 'order-returns'], 'TRANSMITIR'])
    expect(refreshAllM.mock.calls[0][2]).toEqual({ limit: 10 })
    accessM.accessVerdict.mockResolvedValueOnce('no-privilege')
    const a = await request(createApp(ctx())).post('/v1/nfe/refresh').set(A).send({})
    expect([a.status, a.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    accessM.accessVerdict.mockResolvedValueOnce('not-contracted')
    const b = await request(createApp(ctx())).post('/v1/nfe/refresh').set(A).send({})
    expect([b.status, b.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect(refreshAllM).toHaveBeenCalledTimes(1)
  })

  it('o aluguel por estabelecimento: quem não obtém recebe 200 skipped e a passada NÃO roda; o aluguel é devolvido mesmo quando a passada quebra', async () => {
    f.acquireRefreshLease.mockResolvedValueOnce(null)
    const idle = await request(createApp(ctx())).post('/v1/nfe/refresh').set(A).send({})
    expect([idle.status, idle.body.data.skipped, idle.body.data.checked]).toEqual([200, true, 0])
    expect(refreshAllM).not.toHaveBeenCalled(); expect(f.releaseRefreshLease).not.toHaveBeenCalled()
    f.acquireRefreshLease.mockResolvedValueOnce('tok2'); refreshAllM.mockRejectedValueOnce(new Error('quebrou'))
    await request(createApp(ctx())).post('/v1/nfe/refresh').set(A).send({})
    expect(f.releaseRefreshLease.mock.calls[0].slice(1)).toEqual([1, '55', 'tok2'])
    expect(f.acquireRefreshLease.mock.calls[0].slice(1)).toEqual([1, '55', opsService.REFRESH_LEASE_SECONDS])
  })

  it('o disjuntor aberto para a passada e sai no relatório; as pendências críticas viram errors; limite fora de 1–50 ou campo a mais = 400', async () => {
    f.acquireRefreshLease.mockResolvedValue('tok'); f.releaseRefreshLease.mockResolvedValue(true)
    refreshAllM.mockResolvedValue({ scanned: 5, consulted: 1, throttled: 0, tooOld: 0, skipped: 1, circuitOpen: true, changed: 0, incidents: [{ invoiceId: 77, incident: 'digest-mismatch' }], results: [] })
    const r = await request(createApp(ctx())).post('/v1/nfe/refresh').set(A).send({})
    expect(r.body.data).toMatchObject({ circuitOpen: true, stoppedEarly: true, errors: [{ invoiceId: 77, code: 'digest-mismatch' }] })
    for (const body of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { extra: true }]) {
      expect((await request(createApp(ctx())).post('/v1/nfe/refresh').set(A).send(body)).body.code).toBe('VALIDATION_FAILED')
    }
  })
})

describe('GET /v1/nfe/numbering e GET/POST /v1/nfe/voids', () => {
  const voidItem = { id: 3, environment: 'H', serie: 1, year: 2026, from: 10, to: 12, reason: 'faixa pulada por erro de numeração', voidId: 'ID', state: 'homologated', authorityCode: '102', protocol: '141', dh: '2026-11-20 15:00:00' }

  it('são atos do admin do estabelecimento: perfil comum = 403 ADMIN_REQUIRED nas três', async () => {
    accessM.liveIdentity.mockImplementation(async (_q: unknown, p: any) => ({ ...p, role: 'user' }))
    const calls = [request(createApp(ctx())).get('/v1/nfe/numbering?serie=1').set(A), request(createApp(ctx())).get('/v1/nfe/voids').set(A),
      request(createApp(ctx())).post('/v1/nfe/voids').set(A).send({ serie: '1', from: 1, to: 2, reason: 'faixa pulada por erro de numeração' })]
    for (const r of await Promise.all(calls)) expect([r.status, r.body.code]).toEqual([403, 'ADMIN_REQUIRED'])
    expect(listVoidsM).not.toHaveBeenCalled(); expect(voidRangeM).not.toHaveBeenCalled()
  })

  it('numbering: série obrigatória e no formato; sem ambiente, o da habilitação; sem habilitação 404 FISCAL_ISSUER_MISSING; a zona vira o mês do buraco; as faixas da série vêm junto', async () => {
    expect((await request(createApp(ctx())).get('/v1/nfe/numbering').set(A)).body.code).toBe('VALIDATION_FAILED')
    expect((await request(createApp(ctx())).get('/v1/nfe/numbering?serie=007').set(A)).body.code).toBe('VALIDATION_FAILED')
    f.getIssuer.mockResolvedValueOnce(null)
    const none = await request(createApp(ctx())).get('/v1/nfe/numbering?serie=1').set(A)
    expect([none.status, none.body.code]).toEqual([404, 'FISCAL_ISSUER_MISSING'])
    f.getIssuer.mockResolvedValue({ environment: 'H' })
    numberingModule.readNumbering.mockResolvedValue({ serie: 1, environment: 'H', highestNumber: 12, gaps: [{ from: 3, to: 4, oldestInvoiceMonth: '2026-10' }] })
    listVoidsM.mockResolvedValue({ total: 2, items: [voidItem, { ...voidItem, id: 4, serie: 2 }, { ...voidItem, id: 5, environment: 'P' }] })
    const r = await request(createApp(ctx())).get('/v1/nfe/numbering?serie=1').set(A)
    expect(r.body.data).toMatchObject({ serie: '1', environment: 'H', highestNumber: 12, gaps: [{ from: 3, to: 4, oldestInvoiceMonth: '2026-10' }] })
    expect(r.body.data.voids.map((v: any) => v.id)).toEqual([3])                           // só a série 1 de H
    expect(r.body.data.voids[0].dh).toBe('2026-11-20 12:00:00')                            // 15:00 UTC → Brasília
    const call = numberingModule.readNumbering.mock.calls[0]
    expect([call[1], call[2], call[3], call[4], call[5]]).toEqual(['fiscal_api', 'setes_setes', { institutionId: 1, terminal: 0 }, 1, 'H'])
    await request(createApp(ctx())).get('/v1/nfe/numbering?serie=1&environment=P').set(A)
    expect(numberingModule.readNumbering.mock.calls[1][5]).toBe('P')
    expect(f.getIssuer).toHaveBeenCalledTimes(2)                                           // o ambiente informado dispensa a habilitação (só a leitura do 404 e do primeiro)
  })

  it('voids GET: envelope paginado da casa, série em texto, dh na zona; parâmetros inválidos = 400', async () => {
    listVoidsM.mockResolvedValue({ total: 1, items: [voidItem] })
    const r = await request(createApp(ctx())).get('/v1/nfe/voids?page=1&pageSize=5').set(A)
    expect([r.status, r.body.ok, r.body.page, r.body.pageSize, r.body.total, r.body.data[0].serie, r.body.data[0].dh]).toEqual([200, true, 1, 5, 1, '1', '2026-11-20 12:00:00'])
    expect(listVoidsM.mock.calls[0].slice(1)).toEqual([1, 1, 5])
    expect((await request(createApp(ctx())).get('/v1/nfe/voids?pageSize=500').set(A)).status).toBe(400)
  })

  it('voids POST: homologada = 201 com o pedido inteiro; corpo estrito (campo a mais, motivo curto, from/to fora da faixa, série fora do formato = 400)', async () => {
    voidRangeM.mockResolvedValue({ id: 3, voidId: 'ID', serie: 1, from: 10, to: 12, environment: 'H', state: 'homologated', authorityCode: '102', protocol: '141', message: 'ok', incident: null, refusedCStat: null })
    findVoidM.mockResolvedValue(voidItem)
    const body = { serie: '1', year: 2026, from: 10, to: 12, reason: 'faixa pulada por erro de numeração' }
    const ok = await request(createApp(ctx())).post('/v1/nfe/voids').set(A).send(body)
    expect([ok.status, ok.body.data.id, ok.body.data.state, ok.body.data.serie]).toEqual([201, 3, 'homologated', '1'])
    expect(voidRangeM.mock.calls[0][2]).toEqual({ serie: 1, year: 2026, from: 10, to: 12, reason: body.reason })
    for (const bad of [{ ...body, extra: 1 }, { ...body, reason: 'curto' }, { ...body, from: 0 }, { ...body, to: 1_000_000_000 }, { ...body, serie: '01' }, { ...body, serie: 1 }, { ...body, year: 1999 }]) {
      expect((await request(createApp(ctx())).post('/v1/nfe/voids').set(A).send(bad)).body.code).toBe('VALIDATION_FAILED')
    }
    expect(voidRangeM).toHaveBeenCalledTimes(1)
  })

  it('voids POST: o ambíguo = 502 com a saída "reenviar a MESMA faixa"; o que o serviço recusou (656) = 503; o conflito de gravação única sobe como incident', async () => {
    const pend = { id: 3, voidId: 'ID', serie: 1, from: 10, to: 12, environment: 'H', state: 'in-flight', authorityCode: null, protocol: null, message: null, incident: null, refusedCStat: null }
    const body = { serie: '1', from: 10, to: 12, reason: 'faixa pulada por erro de numeração' }
    voidRangeM.mockResolvedValueOnce(pend)
    const a = await request(createApp(ctx())).post('/v1/nfe/voids').set(A).send(body)
    expect([a.status, a.body.code, a.body.fields.find((x: any) => x.field === 'next').message]).toEqual([502, 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE', 'resend-same-range'])
    voidRangeM.mockResolvedValueOnce({ ...pend, refusedCStat: '656' })
    const b = await request(createApp(ctx())).post('/v1/nfe/voids').set(A).send(body)
    expect([b.status, b.body.code, b.body.fields.find((x: any) => x.field === 'authorityCode').message]).toEqual([503, 'FISCAL_AUTHORITY_UNAVAILABLE', '656'])
    voidRangeM.mockResolvedValueOnce({ ...pend, state: 'homologated', authorityCode: '102', incident: 'file-conflict' }); findVoidM.mockResolvedValue(voidItem)
    expect((await request(createApp(ctx())).post('/v1/nfe/voids').set(A).send(body)).body.data.incident).toBe('file-conflict')
  })

  it('o montador do POST usa as dependências com o disjuntor do contexto (um por processo)', async () => {
    voidRangeM.mockResolvedValue({ id: 3, voidId: 'ID', serie: 1, from: 10, to: 12, environment: 'H', state: 'homologated', authorityCode: '102', protocol: '141', message: 'ok', incident: null, refusedCStat: null }); findVoidM.mockResolvedValue(voidItem)
    const c = ctx()
    await opsService.requestVoid(c, inst, { serie: '1', from: 10, to: 12, reason: 'faixa pulada por erro de numeração' })
    expect(voidRangeM.mock.calls[0][0].breaker).toBe(c.breaker)
    expect(typeof voidRangeM.mock.calls[0][0].emitterOf).toBe('function')
  })
})

describe('a sondagem do status do autorizador na passada do rodízio (NFE.E6.P4 mudança 8; D-NE54 c)', () => {
  const probeM = probeModule.probeAuthorityStatus as unknown as jest.Mock
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const readEmitterM = require('../facts/merchandise-facts').readEmitter as jest.Mock
  const idle = { scanned: 0, consulted: 0, throttled: 0, tooOld: 0, skipped: 0, circuitOpen: false, changed: 0, incidents: [], results: [] }
  beforeEach(() => {
    f.acquireRefreshLease.mockResolvedValue('tok'); f.releaseRefreshLease.mockResolvedValue(true); refreshAllM.mockResolvedValue(idle)
    f.getIssuer.mockResolvedValue({ environment: 'H' })
    readEmitterM.mockResolvedValue({ cnpj: '07742094000113', stateRegistration: '9012345678', addresses: [{ main: 'S', stateCode: 'PR' }] })
    f.openIssuer.mockResolvedValue({ cert: Buffer.from('c'), key: Buffer.from('k') })
  })

  it('consulta o autorizador do estabelecimento com o A1 dele ANTES do rodízio, sem travar a habilitação', async () => {
    const board = new StatusBoard(() => new Date())
    await request(createApp(ctx({ statusBoard: board }))).post('/v1/nfe/refresh').set(A).send({})
    expect(probeM).toHaveBeenCalledTimes(1)
    const [b, input] = probeM.mock.calls[0]
    expect(b).toBe(board)
    expect([input.uf, input.hasStateRegistration, input.environment, input.cert.toString(), input.key.toString()]).toEqual(['PR', true, 'H', 'c', 'k'])
    expect(f.openIssuer.mock.calls[0].slice(1, 3)).toEqual([1, '55'])
    expect(f.openIssuer.mock.calls[0][3]).toEqual({ schemaName: 'setes_setes' })            // sem `forUpdate`: a sondagem não trava a habilitação
    expect(probeM.mock.invocationCallOrder[0]).toBeLessThan(refreshAllM.mock.invocationCallOrder[0])
  })

  it('NUNCA derruba a passada: sem habilitação, sem A1, emitente incompleto ou falha na sondagem — o rodízio roda e devolve 200', async () => {
    const board = new StatusBoard(() => new Date())
    f.getIssuer.mockResolvedValueOnce(null)
    expect((await request(createApp(ctx({ statusBoard: board }))).post('/v1/nfe/refresh').set(A).send({})).status).toBe(200)
    f.openIssuer.mockRejectedValueOnce(new Error('A1 vencido'))
    expect((await request(createApp(ctx({ statusBoard: board }))).post('/v1/nfe/refresh').set(A).send({})).status).toBe(200)
    readEmitterM.mockResolvedValueOnce({ cnpj: null, stateRegistration: null, addresses: [] })
    expect((await request(createApp(ctx({ statusBoard: board }))).post('/v1/nfe/refresh').set(A).send({})).status).toBe(200)
    probeM.mockRejectedValueOnce(new Error('fisco fora'))
    expect((await request(createApp(ctx({ statusBoard: board }))).post('/v1/nfe/refresh').set(A).send({})).status).toBe(200)
    expect(refreshAllM).toHaveBeenCalledTimes(4)
  })

  it('sem quadro no contexto (testes, ou o processo ainda sem ele) não há sondagem nem leitura do A1', async () => {
    await request(createApp(ctx())).post('/v1/nfe/refresh').set(A).send({})
    expect([probeM.mock.calls.length, f.openIssuer.mock.calls.length]).toEqual([0, 0])
  })
})
