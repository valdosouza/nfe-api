/// <reference types="jest" />
/**
 * NFE.E6.P4 mudança 8 (ficha-nfe-e6-p4-rotas-email-operacao.md §6-8; D-NE54 a e c, D-NE187; S-7, S-11): o estado por autorizador no health (`authorities`: o último `consStatServ` que a passada do rodízio
 * consultou, teto de 3 min), a cadeia ICP do servidor como DADO RECARREGÁVEL com o alarme dos 60 dias, e o `stateRegistration` do emitente. O health nunca fala com o fisco (não tem certificado);
 * nenhuma chamada de rede: o `request` do SOAP é injetado.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync, randomBytes } from 'crypto'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { MasterKeyRing, ProductTokenVerifier } from 'fiscal-api'
import { createApp } from '../app'
import type { AppContext } from '../context'
import { fichaPathOf, loadServerCa, serverCaDaysLeft, watchServerCa, CA_EXPIRY_WARN_DAYS, type ServerCa } from '../authority/server-ca'
import { StatusBoard, STATUS_MIN_INTERVAL_MS } from '../authority/status-board'
import { probeAuthorityStatus } from '../authority/status-probe'
import { Breaker } from '../nfe/breaker'
import * as emitterService from '../modules/emitter/emitter.service'
import { FAKE_TECH } from './technical-responsible-fake'
import { NS } from './xsd-fixtures'
import { ok } from './nfe-memdb'
import { testA1 } from './test-a1'

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return { __esModule: true, ...actual, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, emitterView: jest.fn(), access: { ...actual.access, liveIdentity: jest.fn() } }
})
jest.mock('../facts/merchandise-facts', () => ({ ...jest.requireActual('../facts/merchandise-facts'), readEmitter: jest.fn() }))
jest.setTimeout(60_000)

const f = fiscal as unknown as Record<string, any>
// eslint-disable-next-line @typescript-eslint/no-var-requires
const readEmitterM = require('../facts/merchandise-facts').readEmitter as jest.Mock
const PEM = path.resolve(__dirname, '..', '..', 'acervo', 'icp', 'raizes-icp-brasil.pem')
const NOW = new Date('2026-11-21T12:00:00Z')

const envelope = (inner: string) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg xmlns="urn:x">${inner}</nfeResultMsg></soap:Body></soap:Envelope>`
const statusXml = (cStat: string, tpAmb = '2', cUF = '41') => envelope(`<retConsStatServ xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>Servico</xMotivo><cUF>${cUF}</cUF><dhRecbto>2026-11-21T09:00:00-03:00</dhRecbto></retConsStatServ>`)

describe('StatusBoard — o último consStatServ por autorizador × ambiente, teto de 3 minutos', () => {
  it('só lista o que foi consultado, em ordem estável; a resposta nova substitui a velha', () => {
    let now = NOW
    const b = new StatusBoard(() => now)
    expect(b.list()).toEqual([])
    b.record('SVRS', 'H', '107'); b.record('PR', 'H', '108'); now = new Date(NOW.getTime() + 1000); b.record('PR', 'H', '107')
    expect(b.list()).toEqual([{ authorizer: 'PR', environment: 'H', cStat: '107', checkedAt: now.toISOString() }, { authorizer: 'SVRS', environment: 'H', cStat: '107', checkedAt: NOW.toISOString() }])
  })

  it('o teto: a 2ª pergunta ao mesmo autorizador × ambiente em menos de 3 min NÃO é devida (mesmo que o fisco não tenha respondido); outro autorizador ou ambiente é independente', () => {
    let now = NOW
    const b = new StatusBoard(() => now)
    expect([b.due('PR', 'H'), b.due('PR', 'H'), b.due('PR', 'P'), b.due('SVRS', 'H')]).toEqual([true, false, true, true])
    now = new Date(NOW.getTime() + STATUS_MIN_INTERVAL_MS - 1); expect(b.due('PR', 'H')).toBe(false)
    now = new Date(NOW.getTime() + STATUS_MIN_INTERVAL_MS); expect(b.due('PR', 'H')).toBe(true)
  })
})

describe('probeAuthorityStatus — uma pergunta ao autorizador do estabelecimento, com o A1 dele', () => {
  const a1 = testA1()
  const input = (over: Record<string, unknown> = {}) => ({ uf: 'PR' as const, hasStateRegistration: true, environment: 'H' as const, cert: a1.cert, key: a1.key, ca: undefined, now: NOW, ...over })

  it('107 e 108 entram no quadro com o autorizador RESOLVIDO (PR); a 2ª em menos de 3 min é "throttled" e nem vai à rede', async () => {
    const board = new StatusBoard(() => NOW)
    const req = jest.fn(async () => ok(statusXml('107')))
    expect(await probeAuthorityStatus(board, input(), req as never)).toBe('recorded')
    expect(board.list()).toEqual([{ authorizer: 'PR', environment: 'H', cStat: '107', checkedAt: NOW.toISOString() }])
    expect(String((req.mock.calls[0] as unknown as [any])[0].url)).toMatch(/^https:\/\/homologacao\.nfe\.sefa\.pr\.gov\.br\//)
    expect(await probeAuthorityStatus(board, input(), req as never)).toBe('throttled')
    expect(req).toHaveBeenCalledTimes(1)
    const b2 = new StatusBoard(() => NOW)
    expect(await probeAuthorityStatus(b2, input(), (async () => ok(statusXml('108'))) as never)).toBe('recorded')
    expect(b2.list()[0].cStat).toBe('108')
  })

  it('sem IE o autorizador é o SVRS (D-NE96) — o quadro mostra quem foi de fato perguntado', async () => {
    const board = new StatusBoard(() => NOW)
    await probeAuthorityStatus(board, input({ hasStateRegistration: false }), (async () => ok(statusXml('107'))) as never)
    expect(board.list()[0].authorizer).toBe('SVRS')
  })

  it('resposta ilegível, outro cStat, ambiente sem serviço registrado (produção) ou falha de rede = "unavailable" e NENHUMA linha nova; nunca lança', async () => {
    for (const reply of [async () => ok('<lixo/>'), async () => ok(statusXml('999')), async () => { throw new Error('rede caiu') }]) {
      const board = new StatusBoard(() => NOW)
      expect(await probeAuthorityStatus(board, input(), reply as never)).toBe('unavailable')
      expect(board.list()).toEqual([])
    }
    const req = jest.fn()
    expect(await probeAuthorityStatus(new StatusBoard(() => NOW), input({ environment: 'P' }), req as never)).toBe('unavailable')
    expect(req).not.toHaveBeenCalled()                                                        // SOAP_BINDINGS só tem H: produção é recusada antes de qualquer chamada
  })
})

describe('watchServerCa — as raízes ICP como dado recarregável e o alarme dos 60 dias', () => {
  const tmp = (): { pem: string; ficha: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-ca-'))
    const pem = path.join(dir, 'raizes.pem')
    fs.copyFileSync(PEM, pem); fs.copyFileSync(fichaPathOf(PEM), fichaPathOf(pem))
    return { pem, ficha: fichaPathOf(pem) }
  }
  const touch = (p: string, ms: number): void => { const t = new Date(Date.now() + ms); fs.utimesSync(p, t, t) }

  it('arquivo igual: nada recarrega; arquivo mudou e passa na conferência: recarrega a cadeia nova; a mesma mudança não recarrega de novo', () => {
    const { pem } = tmp()
    const target = { serverCa: loadServerCa(pem, NOW) }
    const first = target.serverCa
    const onReload = jest.fn()
    const w = watchServerCa(target, pem, { now: () => NOW, onReload })
    w.check(); w.check()
    expect([onReload.mock.calls.length, target.serverCa === first]).toEqual([0, true])
    touch(pem, 10_000)
    w.check(); w.check()
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(target.serverCa).not.toBe(first)
    expect(target.serverCa.certificates).toHaveLength(first.certificates.length)
  })

  it('PEM ou ficha ruins NÃO derrubam: fica a cadeia anterior, o motivo (sem conteúdo) vai ao hook UMA vez; consertado, recarrega', () => {
    const { pem, ficha } = tmp()
    const target = { serverCa: loadServerCa(pem, NOW) }
    const first = target.serverCa
    const onRefused = jest.fn(), onReload = jest.fn()
    const w = watchServerCa(target, pem, { now: () => NOW, onRefused, onReload })
    const good = fs.readFileSync(ficha, 'utf8')
    fs.writeFileSync(ficha, JSON.stringify({ source: 'x', certificates: [] })); touch(ficha, 20_000)
    w.check(); w.check(); w.check()
    expect(onRefused.mock.calls).toEqual([['ficha-mismatch']])
    expect(target.serverCa).toBe(first)
    fs.writeFileSync(ficha, good); touch(ficha, 40_000)
    w.check()
    expect([onReload.mock.calls.length, target.serverCa === first]).toEqual([1, false])
    fs.unlinkSync(pem); w.check()
    expect(onRefused.mock.calls[1]).toEqual(['file-missing'])
    expect(target.serverCa.certificates.length).toBeGreaterThan(0)                           // o serviço nunca fica sem raízes por causa de um arquivo ruim
  })

  it('o alarme: a 60 dias da raiz que vence primeiro, no máximo UMA vez por dia; longe do vencimento, nunca', () => {
    const { pem } = tmp()
    const ca: ServerCa = loadServerCa(pem, NOW)
    const days = serverCaDaysLeft(ca, NOW)
    expect(days).toBeGreaterThan(CA_EXPIRY_WARN_DAYS)                                        // hoje o acervo está longe do vencimento
    const calm = jest.fn(); watchServerCa({ serverCa: ca }, pem, { now: () => NOW, onExpiring: calm }).check()
    expect(calm).not.toHaveBeenCalled()
    const firstEnd = Math.min(...ca.certificates.map(c => Date.parse(c.notAfter)))
    let now = new Date(firstEnd - 30 * 86_400_000)
    const warn = jest.fn()
    const w = watchServerCa({ serverCa: ca }, pem, { now: () => now, onExpiring: warn })
    w.check(); w.check()
    const endDay = new Date(firstEnd).toISOString().slice(0, 10)
    expect(warn.mock.calls).toEqual([[30, endDay]])                                          // a data é a do VENCIMENTO da raiz (não a do boot)
    now = new Date(now.getTime() + 86_400_000); w.check()
    expect(warn.mock.calls).toEqual([[30, endDay], [29, endDay]])
    expect(serverCaDaysLeft({ ...ca, certificates: [] }, NOW)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('GET /v1/health — authorities e a cadeia recarregável', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  const ctx = (over: Partial<AppContext> = {}): AppContext => ({
    db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' }, pool: { query: jest.fn(async () => [[{ x: 1 }]]), getConnection: jest.fn() } as any, keyring: MasterKeyRing.of({ 1: randomBytes(32) }),
    storage: { probe: () => true } as never, fiscalDb: 'fiscal_api', verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: [], checkIdentity: false,
    serverCa: loadServerCa(PEM, NOW), technicalResponsible: FAKE_TECH, breaker: new Breaker(() => new Date()), ...over,
  })
  const keyProofOk = { masterKey: true, run: jest.fn(), start: jest.fn() } as never

  it('lista o que o quadro tem (formato do contrato) e chama a recarga das raízes a cada leitura; sem quadro, lista vazia', async () => {
    const board = new StatusBoard(() => NOW); board.record('PR', 'H', '107')
    const check = jest.fn()
    const r = await request(createApp(ctx({ statusBoard: board, checkServerCa: check }), keyProofOk)).get('/v1/health')
    expect([r.status, r.body.authorities, check.mock.calls.length]).toEqual([200, [{ authorizer: 'PR', environment: 'H', cStat: '107', checkedAt: NOW.toISOString() }], 1])
    expect((await request(createApp(ctx(), keyProofOk)).get('/v1/health')).body.authorities).toEqual([])
  })

  it('autorizador paralisado (108) NÃO derruba o health: continua 200; o que derruba é dependência LOCAL', async () => {
    const board = new StatusBoard(() => NOW); board.record('PR', 'H', '108')
    const r = await request(createApp(ctx({ statusBoard: board }), keyProofOk)).get('/v1/health')
    expect([r.status, r.body.status, r.body.authorities[0].cStat]).toEqual([200, 'ok', '108'])
    const bad = await request(createApp(ctx({ statusBoard: board, pool: { query: jest.fn(async () => { throw new Error('banco fora') }), getConnection: jest.fn() } as any }), keyProofOk)).get('/v1/health')
    expect([bad.status, bad.body.db, bad.body.authorities.length]).toEqual([503, false, 1])
  })

  it('o health só LÊ: nenhum campo da resposta carrega certificado, chave, caminho ou senha', async () => {
    const board = new StatusBoard(() => NOW); board.record('PR', 'H', '107')
    const text = JSON.stringify((await request(createApp(ctx({ statusBoard: board }), keyProofOk)).get('/v1/health')).body)
    expect(text).not.toMatch(/BEGIN|PRIVATE|password|senha|\.pem|\/tmp\//i)
  })
})

describe('GET /v1/emitter — stateRegistration (D-NE96)', () => {
  const inst = { institutionId: 1, userId: 7, schemaName: 'setes_x' } as any
  const ctx = {} as AppContext
  const issuers = (environment: 'H' | 'P' | null) => ({ issuers: environment ? [{ model: '55', environment, serie: null, enabled: true, authority: 'SEFAZ' }] : [], certificate: { present: false } })
  const party = (ie: string | null, uf = 'PR') => ({ cnpj: '07742094000113', stateRegistration: ie, addresses: [{ main: 'S', stateCode: uf }] })

  it('com IE no PR em H: present e o autorizador PR; sem IE: o autorizador é o SVRS (exclusivo do IBS/CBS)', async () => {
    f.emitterView.mockResolvedValue(issuers('H'))
    readEmitterM.mockResolvedValueOnce(party('9012345678'))
    expect((await emitterService.fetchEmitter(ctx, inst)).stateRegistration).toEqual({ present: true, authorizer55: 'PR' })
    readEmitterM.mockResolvedValueOnce(party(null))
    expect((await emitterService.fetchEmitter(ctx, inst)).stateRegistration).toEqual({ present: false, authorizer55: 'SVRS' })
  })

  it('sem habilitação do 55 o autorizador é nulo; cadastro do emitente ilegível não derruba o status (present falso, sem autorizador)', async () => {
    f.emitterView.mockResolvedValue(issuers(null))
    readEmitterM.mockResolvedValueOnce(party('9012345678'))
    expect((await emitterService.fetchEmitter(ctx, inst)).stateRegistration).toEqual({ present: true, authorizer55: null })
    f.emitterView.mockResolvedValue(issuers('H'))
    readEmitterM.mockRejectedValueOnce(new fiscal.HttpError(422, 'sem entidade', undefined, 'FISCAL_EMITTER_INCOMPLETE'))
    const r = await emitterService.fetchEmitter(ctx, inst)
    expect([r.stateRegistration, r.issuers]).toEqual([{ present: false, authorizer55: null }, issuers('H').issuers])
    readEmitterM.mockRejectedValueOnce(new Error('ERP fora'))                                  // erro do banco NUNCA vira "sem IE → SVRS" calado
    await expect(emitterService.fetchEmitter(ctx, inst)).rejects.toThrow('ERP fora')
  })
})
