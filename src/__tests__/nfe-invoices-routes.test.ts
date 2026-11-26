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

jest.mock('../modules/invoices/invoices.service', () => ({ ...jest.requireActual('../modules/invoices/invoices.service'), transmit: jest.fn(), refresh: jest.fn(), reconfirm: jest.fn(), fiscalView: jest.fn(), cancel: jest.fn(), xml: jest.fn(), danfe: jest.fn() }))
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

describe('POST /v1/nfe/invoices/{id}/cancel (NFE.E6.P4 mudança 3)', () => {
  const real = jest.requireActual('../modules/invoices/invoices.service') as typeof import('../modules/invoices/invoices.service')
  const thrown = (fn: () => unknown): any => { try { fn() } catch (e) { return e } return null }
  const reason = 'Cancelamento por erro de digitação'
  const result: any = { invoiceId: 5001, attempt: 1, atAuthority: true, state: 'cancelled', eventSequence: 1, protocol: '141260000000009', warnings: [], nextStep: 'apply-local-cancel', incident: null, refusedCStat: null }

  it('200 no envelope {ok,data}, com o privilégio CANCELAR na interface do ramo e o motivo repassado', async () => {
    svc.cancel.mockResolvedValueOnce(real.responseOfCancel(result))
    const r = await request(createApp(ctx())).post('/v1/nfe/invoices/5001/cancel').set(A).send({ reason })
    expect([r.status, r.body.ok, r.body.data.state, r.body.data.protocol]).toEqual([200, true, 'cancelled', '141260000000009'])
    expect(accessM.accessVerdict.mock.calls[0].slice(2)).toEqual([['orders'], 'CANCELAR'])
    expect(svc.cancel.mock.calls[0][3]).toBe(reason)
    expect(r.body.data).not.toHaveProperty('refusedCStat')                              // detalhe de disjuntor não vai ao cliente
  })

  it('sem o privilégio = 403 e o service nem é chamado; motivo curto, ausente ou campo a mais = 400 VALIDATION_FAILED', async () => {
    accessM.accessVerdict.mockResolvedValueOnce('no-privilege')
    const a = await request(createApp(ctx())).post('/v1/nfe/invoices/5001/cancel').set(A).send({ reason })
    expect([a.status, a.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    for (const body of [{ reason: 'curto' }, {}, { reason, extra: 1 }, { reason: 'x'.repeat(256) }]) {
      const b = await request(createApp(ctx())).post('/v1/nfe/invoices/5001/cancel').set(A).send(body)
      expect([b.status, b.body.code]).toEqual([400, 'VALIDATION_FAILED'])
    }
    expect(svc.cancel).not.toHaveBeenCalled()
  })

  it('o mapa: já cancelada é 200 (idempotente); o pedido em voo é 502 com a saída "consult-key"; o 656 do serviço é 503', () => {
    expect(real.responseOfCancel({ ...result, atAuthority: false, state: 'already-cancelled' }).atAuthority).toBe(false)
    const e = thrown(() => real.responseOfCancel({ ...result, atAuthority: false, state: 'in-flight', nextStep: 'consult-key', protocol: null, eventSequence: null }))
    expect([e.statusCode, e.code, e.fields.find((f: any) => f.field === 'next').message]).toEqual([502, 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE', 'consult-key'])
    const u = thrown(() => real.responseOfCancel({ ...result, atAuthority: false, state: 'in-flight', nextStep: 'consult-key', refusedCStat: '656' }))
    expect([u.statusCode, u.code, u.fields.find((f: any) => f.field === 'authorityCode').message]).toEqual([503, 'FISCAL_AUTHORITY_UNAVAILABLE', '656'])
  })
})

describe('fiscalView — localCancelPending e cancelDeadline (S2 da P2, NFE.E6.P4 mudança 3)', () => {
  const real = jest.requireActual('../modules/invoices/invoices.service') as typeof import('../modules/invoices/invoices.service')
  const KEY = '41261107742094000113550010000000151514710954'
  const inst = { institutionId: 98, userId: 7, schemaName: 'setes_x' } as any
  function seeded(kind: string | null, withAuthority = true) {
    const db = new MemDb()
    db.attempts.push({ attempt: 1, lifeEvent: 1, environment: 'H', authorizer: 'PR', accessKey: KEY, dhEmission: '2026-11-24 13:15:30', digestValue: 'A'.repeat(27) + '=', receipt: null, protocol: withAuthority ? '141260000000001' : null, dhRecbto: withAuthority ? '2026-11-24 13:20:00' : null, lastQueriedAt: null, nfeNotRegisteredAt: null, createdAt: '2026-11-24 13:15:31' } as never)
    if (kind) db.events.push({ attempt: 1, event: 1, kind, authority_code: '100', message: 'ok', dh: '2026-11-24 13:20:00', source: 'P', createdAt: '2026-11-24 13:20:00' } as never)
    return db
  }
  const view = async (kind: string | null, lastKind: string | null, withAuthority = true): Promise<any> => {
    erpM.invoiceLife.mockResolvedValue({ invoiceId: 5001, lifeEvent: 1, lastKind }); erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
    return real.fiscalView(ctx({ pool: seeded(kind, withAuthority).connection() as never }), inst, invoiceRef(98, 5001, 0))
  }

  it('autorizada no PR: o prazo é a autorização + 168 h do PR (dado por UF), na zona do estabelecimento', async () => {
    const v = await view('A', 'E')
    expect(v.cancelDeadline).toBe('2026-12-01 10:20:00')                                 // 2026-11-24 13:20 UTC + 168 h = 2026-12-01 13:20 UTC = 10:20 em Brasília
    expect(v.localCancelPending).toBe(false)
  })

  it('sem autorização (em voo, rejeitada) não há prazo', async () => {
    expect((await view(null, 'E', false)).cancelDeadline).toBeNull()
    expect((await view('R', 'E', false)).cancelDeadline).toBeNull()
  })

  it('voz C com a nota ainda emitida no ERP = pendência local; com o C já aplicado no ERP, não', async () => {
    expect((await view('C', 'E')).localCancelPending).toBe(true)
    expect((await view('C', 'C')).localCancelPending).toBe(false)
    expect((await view('A', 'E')).localCancelPending).toBe(false)
  })
})

describe('GET …/xml e …/danfe (NFE.E6.P4 mudança 4) — código real, banco em memória e arquivo fiscal em mapa', () => {
  const real = jest.requireActual('../modules/invoices/invoices.service') as typeof import('../modules/invoices/invoices.service')
  const { authorizedProc } = jest.requireActual('./danfe-fixtures') as typeof import('./danfe-fixtures')
  const inst = { institutionId: 98, userId: 7, schemaName: 'setes_x' } as any
  const proc = authorizedProc()
  const KEY = proc.key
  /** O arquivo fiscal em mapa: o `find` acha pelo NOME (a chave de pasta e as dicas são do núcleo, provadas lá). */
  const fakeStorage = (files: Record<string, string>) => ({ find: (_k: unknown, name: string) => (name in files ? name : null), read: (ref: string) => files[ref], probe: () => true, save: jest.fn() }) as never
  function db(kind: string | null, protocol: string | null = '141260000012345') {
    const m = new MemDb()
    m.attempts.push({ attempt: 1, lifeEvent: 1, environment: 'H', authorizer: 'PR', accessKey: KEY, dhEmission: '2026-11-24 13:15:30', digestValue: 'A'.repeat(27) + '=', receipt: null, protocol, dhRecbto: protocol ? '2026-11-24 13:20:00' : null, lastQueriedAt: null, nfeNotRegisteredAt: null, createdAt: '2026-11-24 13:15:31' })
    if (kind) m.events.push({ attempt: 1, event: 1, kind, authority_code: '100', message: 'ok', dh: '2026-11-24 13:20:00', source: 'P', createdAt: '2026-11-24 13:20:00' })
    return m
  }
  const c = (m: MemDb, files: Record<string, string>) => ctx({ pool: m.connection() as never, storage: fakeStorage(files) })
  beforeEach(() => { erpM.invoiceLife.mockResolvedValue({ invoiceId: 5001, lifeEvent: 1, lastKind: 'E' }); erpM.institutionZone.mockResolvedValue('America/Sao_Paulo') })

  it('xml: autorizada devolve o procNFe guardado, sem cancelEvent; denegada também tem procNFe (D-NE35)', async () => {
    const a = await real.xml(c(db('A'), { [`${KEY}-procNFe.xml`]: proc.xml }), inst, invoiceRef(98, 5001, 0))
    expect(a).toEqual({ accessKey: KEY, procNFe: proc.xml, cancelEvent: null })
    expect((await real.xml(c(db('D'), { [`${KEY}-procNFe.xml`]: proc.xml }), inst, invoiceRef(98, 5001, 0))).procNFe).toBe(proc.xml)
  })

  it('xml: cancelada devolve também o procEventoNFe — o registrado pode estar sob -r<k> (depois de N)', async () => {
    const files = { [`${KEY}-procNFe.xml`]: proc.xml, [`${KEY}-evt110111-1-r2-proc.xml`]: '<procEventoNFe/>' }
    expect((await real.xml(c(db('C'), files), inst, invoiceRef(98, 5001, 0))).cancelEvent).toBe('<procEventoNFe/>')
  })

  it('xml: sem tentativa, sem protocolo ou rejeitada = 409 FISCAL_NOT_AUTHORIZED; nota inexistente = 404; arquivo que falta = 409 FISCAL_FILE_MISSING (nunca refeito)', async () => {
    for (const m of [new MemDb(), db(null, null), db('R', null)]) {
      await expect(real.xml(c(m, {}), inst, invoiceRef(98, 5001, 0))).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_NOT_AUTHORIZED' })
    }
    await expect(real.xml(c(db('A'), {}), inst, invoiceRef(98, 5001, 0))).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_FILE_MISSING' })
    erpM.invoiceLife.mockResolvedValue(null)
    await expect(real.xml(c(db('A'), {}), inst, invoiceRef(98, 5001, 0))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('danfe: autorizada devolve o PDF em base64 (começa por %PDF); cancelada também (com o carimbo, provado no danfe.test)', async () => {
    const a = await real.danfe(c(db('A'), { [`${KEY}-procNFe.xml`]: proc.xml }), inst, invoiceRef(98, 5001, 0))
    expect(a.accessKey).toBe(KEY)
    expect(Buffer.from(a.pdfBase64, 'base64').subarray(0, 4).toString()).toBe('%PDF')
    expect(Buffer.from((await real.danfe(c(db('C'), { [`${KEY}-procNFe.xml`]: proc.xml }), inst, invoiceRef(98, 5001, 0))).pdfBase64, 'base64').subarray(0, 4).toString()).toBe('%PDF')
  })

  it('danfe: nota rejeitada, em voo ou denegada = 409 FISCAL_NOT_AUTHORIZED (S-8); XML ilegível = 422 do renderDanfe', async () => {
    for (const m of [db('R', null), db(null, null), db('D')]) {
      await expect(real.danfe(c(m, { [`${KEY}-procNFe.xml`]: proc.xml }), inst, invoiceRef(98, 5001, 0))).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_NOT_AUTHORIZED' })
    }
    await expect(real.danfe(c(db('A'), { [`${KEY}-procNFe.xml`]: '<nfeProc/>' }), inst, invoiceRef(98, 5001, 0))).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_DOCUMENT_INVALID' })
  })

  it('a visão da nota diz danfeAvailable só com a voz que dá DANFE', async () => {
    expect((await real.fiscalView(c(db('A'), {}), inst, invoiceRef(98, 5001, 0)) as any).danfeAvailable).toBe(true)
    expect((await real.fiscalView(c(db('D'), {}), inst, invoiceRef(98, 5001, 0)) as any).danfeAvailable).toBe(false)
    expect((await real.fiscalView(c(db(null, null), {}), inst, invoiceRef(98, 5001, 0)) as any).danfeAvailable).toBe(false)
  })

  it('as rotas: leitura exige só a interface do ramo ao alcance; o service recebe a referência inteira', async () => {
    svc.xml.mockResolvedValue({ accessKey: KEY, procNFe: '<x/>', cancelEvent: null })
    svc.danfe.mockResolvedValue({ accessKey: KEY, pdfBase64: 'JVBERg==' })
    const a = await request(createApp(ctx())).get('/v1/nfe/invoices/5001/xml').set(A)
    const b = await request(createApp(ctx())).get('/v1/nfe/invoices/5001/danfe').set(A)
    expect([a.status, a.body.data.procNFe, b.status, b.body.data.pdfBase64]).toEqual([200, '<x/>', 200, 'JVBERg=='])
    expect(accessM.reachableKeys).toHaveBeenCalledTimes(2)
    expect(accessM.accessVerdict).not.toHaveBeenCalled()                                 // nenhum privilégio de ação: é leitura do arquivo (S-14)
    accessM.reachableKeys.mockResolvedValueOnce([])
    expect((await request(createApp(ctx())).get('/v1/nfe/invoices/5001/danfe').set(A)).body.code).toBe('INTERFACE_NOT_ALLOWED')
  })
})
