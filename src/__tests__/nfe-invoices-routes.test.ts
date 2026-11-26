/// <reference types="jest" />
/**
 * NFE.E6.P1 mudança 10 (ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-10; T1/T2 pelas rotas; D-PV40, D-NE235): `/v1/nfe/invoices` — a borda HTTP. Guardas (licença do ramo +
 * privilégio por NOME do verbo; consultar ≠ transmitir), o id de rota, o mapa resultado → resposta do contrato e a leitura da situação. O service é falso nos testes da borda
 * (a regra tem os testes dela); o mapa e a leitura são provados com o código real. Nada vai ao fisco.
 */
import { generateKeyPairSync, randomBytes } from 'crypto'
import path from 'path'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { FsFiscalStorage, invoiceRef, MasterKeyRing, ProductTokenVerifier } from 'fiscal-api'
import { createApp } from '../app'
import type { AppContext } from '../context'
import { Breaker } from '../nfe/breaker'
import { loadServerCa } from '../authority/server-ca'
import * as service from '../modules/invoices/invoices.service'
import type { TransmitResult } from '../nfe/transmission'
import { FAKE_TECH } from './technical-responsible-fake'
import { MemDb } from './nfe-memdb'

jest.mock('../modules/invoices/invoices.service', () => ({ ...jest.requireActual('../modules/invoices/invoices.service'), transmit: jest.fn(), refresh: jest.fn(), reconfirm: jest.fn(), fiscalView: jest.fn() }))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    erp: { ...actual.erp, orderInterface: jest.fn(), invoiceLife: jest.fn(), institutionZone: jest.fn() },
    access: { ...actual.access, liveIdentity: jest.fn(), accessVerdict: jest.fn(), reachableKeys: jest.fn() },
  }
})
jest.setTimeout(60_000)

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const accessM = fiscal.access as unknown as Record<string, jest.Mock>
const svc = service as unknown as Record<string, jest.Mock>
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const token = () => jwt.sign({ institutionId: 1, userId: 7, schemaName: 'setes_setes' }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
const SERVER_CA = loadServerCa(path.resolve(__dirname, '..', '..', 'acervo', 'icp', 'raizes-icp-brasil.pem'), new Date('2026-11-21T12:00:00Z'))
const ctx = (over: Partial<AppContext> = {}): AppContext => ({
  db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
  pool: { query: jest.fn(async () => [[{ x: 1 }]]), getConnection: jest.fn() } as any, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage('/tmp/nfe-routes-nao-usado'),
  fiscalDb: 'fiscal_api', verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: [], checkIdentity: true, serverCa: SERVER_CA, technicalResponsible: FAKE_TECH, breaker: new Breaker(() => new Date()), ...over,
})
const A = { Authorization: `Bearer ${token()}` }

beforeEach(() => {
  jest.clearAllMocks()
  accessM.liveIdentity.mockImplementation(async (_q: unknown, p: any) => ({ ...p, role: 'admin' }))
  erpM.orderInterface.mockResolvedValue('orders')
  accessM.accessVerdict.mockResolvedValue('ok')
  accessM.reachableKeys.mockResolvedValue(['orders'])
})

describe('POST /v1/nfe/invoices/{id}/transmit', () => {
  it('autorizada = 201 e em processamento = 202, no envelope {ok,data}, com o privilégio TRANSMITIR na interface do ramo', async () => {
    const data = { invoiceId: 5001, attempt: 1, accessKey: 'K', number: 15, serie: 1, protocol: '141260000000001', receipt: null, kind: 'A' }
    svc.transmit.mockResolvedValueOnce({ status: 201, data })
    const a = await request(createApp(ctx())).post('/v1/nfe/invoices/5001/transmit').set(A)
    expect([a.status, a.body]).toEqual([201, { ok: true, data }])
    expect(accessM.accessVerdict.mock.calls[0].slice(2)).toEqual([['orders'], 'TRANSMITIR'])
    svc.transmit.mockResolvedValueOnce({ status: 202, data: { ...data, kind: 'P', protocol: null, receipt: '411000000000001' } })
    expect((await request(createApp(ctx())).post('/v1/nfe/invoices/5001/transmit').set(A)).status).toBe(202)
  })

  it('sem o privilégio = 403 PRIVILEGE_REQUIRED; ramo não contratado = 403 INTERFACE_NOT_ALLOWED; o service nem é chamado', async () => {
    accessM.accessVerdict.mockResolvedValueOnce('no-privilege')
    const a = await request(createApp(ctx())).post('/v1/nfe/invoices/5001/transmit').set(A)
    expect([a.status, a.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    accessM.accessVerdict.mockResolvedValueOnce('not-contracted')
    const b = await request(createApp(ctx())).post('/v1/nfe/invoices/5001/transmit').set(A)
    expect([b.status, b.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect(svc.transmit).not.toHaveBeenCalled()
  })

  it('id inválido = 400 INVALID_ID antes de qualquer guarda; sem token = 401', async () => {
    for (const id of ['abc', '0', '-3', '1.5']) {
      const r = await request(createApp(ctx())).post(`/v1/nfe/invoices/${id}/transmit`).set(A)
      expect([r.status, r.body.code]).toEqual([400, 'INVALID_ID'])
    }
    expect((await request(createApp(ctx())).post('/v1/nfe/invoices/5001/transmit')).status).toBe(401)
    expect(accessM.accessVerdict).not.toHaveBeenCalled()
  })

  it('o terminal da web só existe na borda: o service recebe a referência da nota inteira (estabelecimento, nota, terminal 0)', async () => {
    svc.transmit.mockResolvedValueOnce({ status: 201, data: {} })
    await request(createApp(ctx())).post('/v1/nfe/invoices/5001/transmit').set(A)
    expect(svc.transmit.mock.calls[0][2]).toEqual(invoiceRef(1, 5001, 0))
  })
})

describe('POST /refresh, POST /reconfirm e GET', () => {
  it('refresh pede CONSULTAR (consultar ≠ transmitir) e repassa ?all=true; reconfirm pede TRANSMITIR', async () => {
    svc.refresh.mockResolvedValue({ changed: false })
    await request(createApp(ctx())).post('/v1/nfe/invoices/5001/refresh?all=true').set(A)
    expect(accessM.accessVerdict.mock.calls[0].slice(2)).toEqual([['orders'], 'CONSULTAR'])
    expect(svc.refresh.mock.calls[0][3]).toBe(true)
    await request(createApp(ctx())).post('/v1/nfe/invoices/5001/refresh').set(A)
    expect(svc.refresh.mock.calls[1][3]).toBe(false)
    svc.reconfirm.mockResolvedValue({ recorded: true })
    const r = await request(createApp(ctx())).post('/v1/nfe/invoices/5001/reconfirm').set(A)
    expect([r.status, r.body]).toEqual([200, { ok: true, data: { recorded: true } }])
    expect(accessM.accessVerdict.mock.calls[2].slice(2)).toEqual([['orders'], 'TRANSMITIR'])
  })

  it('o GET exige a interface do ramo ao alcance (leitura): sem ela 403 INTERFACE_NOT_ALLOWED; com ela 200', async () => {
    accessM.reachableKeys.mockResolvedValueOnce([])
    const no = await request(createApp(ctx())).get('/v1/nfe/invoices/5001').set(A)
    expect([no.status, no.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    svc.fiscalView.mockResolvedValueOnce({ invoiceId: 5001, state: 'none' })
    const ok = await request(createApp(ctx())).get('/v1/nfe/invoices/5001').set(A)
    expect([ok.status, ok.body.data.state]).toEqual([200, 'none'])
  })

  it('a regra de erro da borda passa adiante: o 429 da cota e o 409 da barreira chegam com o código', async () => {
    svc.refresh.mockRejectedValueOnce(new fiscal.HttpError(429, 'consultada há pouco', undefined, 'RESOURCE_BUSY'))
    const r = await request(createApp(ctx())).post('/v1/nfe/invoices/5001/refresh').set(A)
    expect([r.status, r.body.code]).toEqual([429, 'RESOURCE_BUSY'])
  })
})

describe('o mapa resultado → resposta do contrato (código real)', () => {
  const real = jest.requireActual('../modules/invoices/invoices.service') as typeof import('../modules/invoices/invoices.service')
  const base: Omit<TransmitResult, 'outcome' | 'nProt' | 'nRec' | 'next' | 'authorityCode' | 'incident'> = { invoiceId: 5001, attempt: 2, accessKey: 'K', number: 15, serie: 1 }
  const result = (outcome: TransmitResult['outcome'], extra: Partial<TransmitResult> = {}): TransmitResult => ({ ...base, outcome, nProt: null, nRec: null, next: null, incident: null, authorityCode: 'authorityCode' in outcome ? outcome.authorityCode : null, ...extra })
  const thrown = (fn: () => unknown): any => { try { fn() } catch (e) { return e } return null }

  it('A = 201 com o número e o protocolo; P = 202 com o recibo', () => {
    expect(real.responseOfTransmit(result({ kind: 'A', authorityCode: '100', message: 'm' }, { nProt: '141260000000001' }))).toEqual({ status: 201, data: { invoiceId: 5001, attempt: 2, accessKey: 'K', number: 15, serie: 1, protocol: '141260000000001', receipt: null, kind: 'A', authorityCode: '100', incident: null } })
    expect(real.responseOfTransmit(result({ kind: 'P', authorityCode: '103', message: 'm' }, { nRec: '411000000000001' })).status).toBe(202)
  })

  it('R = 422 FISCAL_DOCUMENT_REJECTED com o cStat; D = 409 FISCAL_DENIED; F = 502 FISCAL_AUTHORITY_AUTH_FAILED', () => {
    const r = thrown(() => real.responseOfTransmit(result({ kind: 'R', authorityCode: '703', message: 'Data posterior' })))
    expect([r.statusCode, r.code, r.fields[0]]).toEqual([422, 'FISCAL_DOCUMENT_REJECTED', { field: 'authorityCode', message: '703' }])
    const d = thrown(() => real.responseOfTransmit(result({ kind: 'D', authorityCode: '110', message: 'm' })))
    expect([d.statusCode, d.code]).toEqual([409, 'FISCAL_DENIED'])
    const f = thrown(() => real.responseOfTransmit(result({ kind: 'F', authorityCode: null, message: 'Credencial recusada pelo fisco' })))
    expect([f.statusCode, f.code]).toEqual([502, 'FISCAL_AUTHORITY_AUTH_FAILED'])
  })

  it('o que não concluiu (ambíguo, 204/539) = 502 FISCAL_AUTHORITY_UNKNOWN_RESPONSE, a tentativa em voo e a saída seguinte no corpo', () => {
    const e = thrown(() => real.responseOfTransmit(result({ kind: 'none', reason: '539' }, { next: 'consult-key' })))
    expect([e.statusCode, e.code, e.fields.find((f: any) => f.field === 'next').message]).toEqual([502, 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE', 'consult-key'])
  })

  it('o refresh: digVal ok vira match, ausência vira not_applicable, voz nova marca changed', () => {
    const r = { invoiceId: 5001, attempt: 1, accessKey: 'K', via: 'key' as const, outcome: { kind: 'A' as const, authorityCode: '100', message: 'm' }, digestCheck: 'ok' as const, incident: null, notRegistered: false, next: null }
    expect(real.responseOfRefresh(r)).toMatchObject({ changed: true, kind: 'A', digestCheck: 'match', localCancelPending: false })
    expect(real.responseOfRefresh({ ...r, outcome: { kind: 'none' as const, reason: '217' }, digestCheck: null, notRegistered: true })).toMatchObject({ changed: false, kind: null, digestCheck: 'not_applicable', notRegistered: true, reason: '217' })
    expect(real.responseOfRefresh({ ...r, outcome: { kind: 'cancelled' as const, authorityCode: '101' }, digestCheck: null }).changed).toBe(false)
  })
})

describe('a leitura da situação (código real, banco em memória)', () => {
  const real = jest.requireActual('../modules/invoices/invoices.service') as typeof import('../modules/invoices/invoices.service')
  const KEY = '41261107742094000113550010000000151514710954'
  function seeded(open = true) {
    const db = new MemDb()
    db.attempts.push({ attempt: 1, lifeEvent: 1, environment: 'H', authorizer: 'PR', accessKey: KEY, dhEmission: '2026-11-24 13:15:30', digestValue: 'A'.repeat(27) + '=', receipt: null, protocol: open ? null : '141260000000001', dhRecbto: open ? null : '2026-11-24 13:20:00', lastQueriedAt: null, nfeNotRegisteredAt: '2026-11-24 14:00:00' })
    if (!open) db.events.push({ attempt: 1, event: 1, kind: 'A', authority_code: '100', message: 'ok', dh: '2026-11-24 13:20:00', source: 'P', createdAt: '2026-11-24 13:20:00' })
    return db
  }
  const inst = { institutionId: 98, userId: 7, schemaName: 'setes_x' } as any

  it('em voo: state in_flight, sem registro, a tentativa com o número lido da chave e os instantes na zona do estabelecimento', async () => {
    erpM.invoiceLife.mockResolvedValue({ invoiceId: 5001, lifeEvent: 1 }); erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
    const v: any = await real.fiscalView(ctx({ pool: seeded().connection() as never }), inst, invoiceRef(98, 5001, 0))
    expect(v).toMatchObject({ invoiceId: 5001, state: 'in_flight', authorityRecorded: false, currentAttempt: 1, localCancelPending: false, cancelDeadline: null, danfeAvailable: false, documentEvents: [] })
    expect(v.transmissions[0]).toMatchObject({ number: 15, serie: 1, authorizer: 'PR', dhEmi: '2026-11-24 10:15:30', notRegisteredAt: '2026-11-24 11:00:00', lastKind: null })
  })

  it('autorizada: state authorized, registrada, com a voz A', async () => {
    erpM.invoiceLife.mockResolvedValue({ invoiceId: 5001, lifeEvent: 1 }); erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
    const v: any = await real.fiscalView(ctx({ pool: seeded(false).connection() as never }), inst, invoiceRef(98, 5001, 0))
    expect([v.state, v.authorityRecorded, v.voices.map((x: any) => [x.kind, x.authorityCode, x.dh])]).toEqual(['authorized', true, [['A', '100', '2026-11-24 10:20:00']]])
  })

  it('nota sem vida fiscal: state none; nota inexistente: 404', async () => {
    erpM.invoiceLife.mockResolvedValue({ invoiceId: 5001, lifeEvent: null }); erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
    const v: any = await real.fiscalView(ctx({ pool: seeded().connection() as never }), inst, invoiceRef(98, 5001, 0))
    expect([v.state, v.transmissions, v.currentAttempt]).toEqual(['none', [], null])
    erpM.invoiceLife.mockResolvedValue(null)
    await expect(real.fiscalView(ctx({ pool: seeded().connection() as never }), inst, invoiceRef(98, 5001, 0))).rejects.toMatchObject({ statusCode: 404 })
  })
})
