/// <reference types="jest" />
// Borda HTTP da nfe-api na NE-2 (D-NE166): o MESMO login do produto (RS256 — D-F13), admin no emitente, só o 55 (D-NE2), série do ERP
// (D-F21/D-NE11), envelope de erro da casa, CORS por lista (D-F146), health (§12.8-1), a cerca CONTRATO × ROTAS com as marcas `x-onda`
// (design-first — D-F8/D-NE166), a cerca D-F31 (nada escrito no ERP) e a do ERP só na fonte de fatos (D-F10). Molde: nfse-api `app.test.ts`.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadServerCa } from '../authority/server-ca'
import { generateKeyPairSync, randomBytes } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { MasterKeyRing, ProductTokenVerifier, FsFiscalStorage } from 'fiscal-api'
import type { StoredKeyCheck } from 'fiscal-api'
import { createApp, loadOpenApi } from '../app'
import { KeyProof } from '../key-proof'
import type { AppContext } from '../context'
import { emitterRoutes } from '../modules/emitter/emitter.routes'
import { SERVED_MODELS } from '../modules/emitter/emitter.service'
import { FAKE_TECH } from './technical-responsible-fake'

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    emitterView: jest.fn(), writeIssuer: jest.fn(), deleteIssuer: jest.fn(), uploadCertificate: jest.fn(), deleteCertificate: jest.fn(),
    erp: { ...actual.erp, establishmentCnpj: jest.fn(), establishmentCnpjFact: jest.fn() },
    // ACESSO.E1.P1: a sessão viva é a do núcleo (provada com o `liveIdentity` REAL em `acesso-e1-p1-sessao-viva.test.ts`); aqui ela dá o
    // PERFIL VIVO pelo usuário (7 = admin, 8 = user) — o `role` do token nunca decide
    access: { ...actual.access, liveIdentity: jest.fn() },
  }
})

const core = fiscal as unknown as Record<string, jest.Mock>
const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const accessM = fiscal.access as unknown as Record<string, jest.Mock>
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const token = (claims: any = {}) => jwt.sign({ institutionId: 1, userId: 7, schemaName: 'setes_setes', ...claims }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-api-app-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const pool = { query: jest.fn(async () => [[{ x: 1 }]]), getConnection: jest.fn() } as any
// NFE.E4.P3.T3: as raízes ICP do acervo, com a data fixa (a v5 vence em 2029)
const SERVER_CA = loadServerCa(path.resolve(__dirname, '..', '..', 'acervo', 'icp', 'raizes-icp-brasil.pem'), new Date('2026-11-21T12:00:00Z'))
const SERVER_CHAIN = { loaded: true, source: 'ITI ACcompactado.zip' }
const ctx = (over: Partial<AppContext> = {}): AppContext => ({
  db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
  pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage(storageRoot),
  fiscalDb: 'fiscal_api', verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: ['https://app.setesgestao.com.br'],
  checkIdentity: true, serverCa: SERVER_CA, technicalResponsible: FAKE_TECH, ...over,
})
const EMITTER = { issuers: [{ model: '55', environment: 'H', serie: null, enabled: false, authority: 'SEFAZ', cutoverAt: '2026-10-20 00:00:00' }], certificate: { certificate: false, privateKey: false, certificateInfo: null } }

beforeEach(() => {
  jest.clearAllMocks()
  core.emitterView.mockResolvedValue(EMITTER)
  core.writeIssuer.mockResolvedValue(undefined)
  core.deleteIssuer.mockResolvedValue(undefined)
  core.uploadCertificate.mockResolvedValue(EMITTER.certificate)
  core.deleteCertificate.mockResolvedValue(EMITTER.certificate)
  erpM.establishmentCnpj.mockResolvedValue('12345678000195')
  accessM.liveIdentity.mockImplementation(async (_q: unknown, p: any) => ({ ...p, role: p.userId === 8 ? 'user' : 'admin' }))
})

describe('autenticação — JWT do produto (D-F13)', () => {
  it('sem token / HS256 forjado com a chave pública / expirado → 401 no envelope da casa', async () => {
    const app = createApp(ctx())
    expect((await request(app).get('/v1/emitter')).status).toBe(401)
    const forged = jwt.sign({ institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }, pubPem, { algorithm: 'HS256', keyid: 'k1', expiresIn: '1h' })
    const r = await request(app).get('/v1/emitter').set('Authorization', `Bearer ${forged}`)
    expect([r.status, r.body.code]).toEqual([401, 'UNAUTHORIZED'])
    const expired = jwt.sign({ institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '-1s' })
    expect((await request(app).get('/v1/emitter').set('Authorization', `Bearer ${expired}`)).status).toBe(401)
    expect(core.emitterView).not.toHaveBeenCalled()
  })
  it('ACESSO.E1.P1: a sessão viva decide — revogada → 401 SESSION_REVOKED; o [check] recebe o payload SEM `role` e o `iat` do token', async () => {
    accessM.liveIdentity.mockRejectedValueOnce(new fiscal.HttpError(401, 'x', undefined, fiscal.ErrorCodes.SESSION_REVOKED))
    const r = await request(createApp(ctx())).get('/v1/emitter').set('Authorization', `Bearer ${token({ role: 'admin' })}`)
    expect([r.status, r.body.code]).toEqual([401, 'SESSION_REVOKED'])
    expect(core.emitterView).not.toHaveBeenCalled()
    expect(accessM.liveIdentity).toHaveBeenCalledWith(pool, { institutionId: 1, userId: 7, role: '', schemaName: 'setes_setes' }, expect.any(Number))
  })
  it('ACESSO.E1.P1: sem o [check] da sessão ninguém é admin — nem com `role: admin` no token (fecha, não abre)', async () => {
    const r = await request(createApp(ctx({ checkIdentity: false }))).get('/v1/emitter').set('Authorization', `Bearer ${token({ role: 'admin' })}`)
    expect([r.status, r.body.code]).toEqual([403, 'ADMIN_REQUIRED'])
    expect(accessM.liveIdentity).not.toHaveBeenCalled()
  })
})

describe('emitente (D-NE9 — o emitter do núcleo montado para o ramo de mercadoria)', () => {
  it('é ato do ADMIN → usuário comum 403 ADMIN_REQUIRED em todas as rotas; admin lê a situação pelo ramo merchandise', async () => {
    const app = createApp(ctx())
    const user = token({ userId: 8, role: 'admin' })   // o `role` do token é ignorado: o perfil VIVO do usuário 8 é `user`
    for (const [m, p] of [['get', '/v1/emitter'], ['put', '/v1/emitter/certificate'], ['delete', '/v1/emitter/certificate'], ['put', '/v1/emitter/issuers/55'], ['delete', '/v1/emitter/issuers/55']] as const) {
      const r = await (request(app) as any)[m](p).set('Authorization', `Bearer ${user}`).send({})
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 403, 'ADMIN_REQUIRED'])
    }
    expect(core.emitterView).not.toHaveBeenCalled()
    const r = await request(app).get('/v1/emitter').set('Authorization', `Bearer ${token()}`)
    expect([r.status, r.body.ok, r.body.data]).toEqual([200, true, EMITTER])
    expect(core.emitterView).toHaveBeenCalledWith(expect.anything(), 1, 'merchandise')
  })
  it('PUT /issuers/55 { environment } → 200; o núcleo recebe a SÉRIE NULA (D-F21/D-NE11); corpo com `serie` → 400 e nada gravado; ambiente torto → 400', async () => {
    const app = createApp(ctx())
    const ok = await request(app).put('/v1/emitter/issuers/55').set('Authorization', `Bearer ${token()}`).send({ environment: 'H' })
    expect([ok.status, ok.body.ok]).toEqual([200, true])
    expect(core.writeIssuer).toHaveBeenCalledWith(expect.anything(), { institutionId: 1, userId: 7, schemaName: 'setes_setes' }, '55', { environment: 'H', serie: null })
    for (const body of [{ environment: 'H', serie: '1' }, { environment: 'h' }, {}, { environment: 'X' }]) {
      const r = await request(app).put('/v1/emitter/issuers/55').set('Authorization', `Bearer ${token()}`).send(body)
      expect([JSON.stringify(body), r.status, r.body.code, Array.isArray(r.body.fields)]).toEqual([JSON.stringify(body), 400, 'VALIDATION_FAILED', true])
    }
    expect(core.writeIssuer).toHaveBeenCalledTimes(1)
  })
  it('D-NE2/D-NE166: só o 55 — SE (da nfse-api), 65 (F5) e lixo → 422 FISCAL_MODEL_NOT_SUPPORTED, sem tocar o núcleo', async () => {
    const app = createApp(ctx())
    expect([...SERVED_MODELS]).toEqual(['55'])
    for (const model of ['SE', '65', '5', '55 ', 'se']) {
      const put = await request(app).put(`/v1/emitter/issuers/${encodeURIComponent(model)}`).set('Authorization', `Bearer ${token()}`).send({ environment: 'H' })
      const del = await request(app).delete(`/v1/emitter/issuers/${encodeURIComponent(model)}`).set('Authorization', `Bearer ${token()}`)
      expect([model, put.status, put.body.code, del.status, del.body.code]).toEqual([model, 422, 'FISCAL_MODEL_NOT_SUPPORTED', 422, 'FISCAL_MODEL_NOT_SUPPORTED'])
    }
    expect(core.writeIssuer).not.toHaveBeenCalled()
    expect(core.deleteIssuer).not.toHaveBeenCalled()
    const del = await request(app).delete('/v1/emitter/issuers/55').set('Authorization', `Bearer ${token()}`)
    expect(del.status).toBe(200)
    expect(core.deleteIssuer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ institutionId: 1 }), '55')
  })
  it('A1: PUT envia o par ao núcleo com o CNPJ do emitente lido no ERP (D-N29/D-CJ2); corpo inválido → 400; DELETE → 200; erro do núcleo → envelope', async () => {
    const app = createApp(ctx())
    const ok = await request(app).put('/v1/emitter/certificate').set('Authorization', `Bearer ${token()}`).send({ pfxBase64: 'AAAA', password: 'x' })
    expect(ok.status).toBe(200)
    expect(core.uploadCertificate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ institutionId: 1 }), { pfxBase64: 'AAAA', password: 'x' }, { expectedCnpj: '12345678000195' })
    expect(erpM.establishmentCnpjFact).not.toHaveBeenCalled()            // caminho feliz: UMA leitura
    erpM.establishmentCnpj.mockResolvedValueOnce(null)
    erpM.establishmentCnpjFact.mockResolvedValueOnce({ state: 'absent' })
    await request(app).put('/v1/emitter/certificate').set('Authorization', `Bearer ${token()}`).send({ pfxBase64: 'AAAA', password: 'x' })
    expect(core.uploadCertificate).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.anything(), { expectedCnpj: { state: 'absent' } })
    for (const body of [{ password: 'x' }, { pfxBase64: '', password: 'x' }, { pfxBase64: 'AAAA' }]) {
      const r = await request(app).put('/v1/emitter/certificate').set('Authorization', `Bearer ${token()}`).send(body)
      expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED'])
    }
    core.deleteCertificate.mockRejectedValueOnce(new fiscal.HttpError(409, 'vivas', undefined, fiscal.ErrorCodes.FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS))
    const busy = await request(app).delete('/v1/emitter/certificate').set('Authorization', `Bearer ${token()}`)
    expect([busy.status, busy.body.code]).toEqual([409, 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS'])
    expect((await request(app).delete('/v1/emitter/certificate').set('Authorization', `Bearer ${token()}`)).status).toBe(200)
  })
})

describe('entrada — corpo, envelope, CORS e health', () => {
  it('JSON malformado → 400; corpo > 128 kb → 413; charset não suportado → 415; erro inesperado → 500 com ref; rota desconhecida → 404', async () => {
    const app = createApp(ctx())
    const bad = await request(app).put('/v1/emitter/issuers/55').set('Authorization', `Bearer ${token()}`).set('Content-Type', 'application/json').send('{"environment":')
    expect([bad.status, bad.body.code]).toEqual([400, 'VALIDATION_FAILED'])
    const big = await request(app).put('/v1/emitter/certificate').set('Authorization', `Bearer ${token()}`).send({ pfxBase64: 'A'.repeat(140_000), password: 'x' })
    expect(big.status).toBe(413)
    const cs = await request(app).put('/v1/emitter/issuers/55').set('Authorization', `Bearer ${token()}`).set('Content-Type', 'application/json; charset=latin1').send('{"environment":"H"}')
    expect([cs.status, cs.body.code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE'])
    core.emitterView.mockRejectedValueOnce(new Error('boom'))
    const crash = await request(app).get('/v1/emitter').set('Authorization', `Bearer ${token()}`)
    expect([crash.status, crash.body.code, typeof crash.body.ref]).toEqual([500, 'INTERNAL', 'string'])
    expect((await request(app).get('/v1/nope')).status).toBe(404)
  })
  it('CORS por lista (D-F146): origem da lista recebe os cabeçalhos; outra não; preflight 204; lista torta recusa na montagem', async () => {
    const app = createApp(ctx())
    const yes = await request(app).get('/v1/health').set('Origin', 'https://app.setesgestao.com.br')
    expect(yes.headers['access-control-allow-origin']).toBe('https://app.setesgestao.com.br')
    const no = await request(app).get('/v1/health').set('Origin', 'https://evil.example')
    expect(no.headers['access-control-allow-origin']).toBeUndefined()
    expect((await request(app).options('/v1/emitter').set('Origin', 'https://app.setesgestao.com.br')).status).toBe(204)
    expect(() => createApp(ctx({ corsOrigins: ['*'] }))).toThrow(/D-F146/)
  })
  // DEPLOY.E1.P6 (D-NE189 → D-F243/D-F244/D-F245): o sinal `masterKey` é o último resultado da prova (abre A1 guardado); o health só LÊ
  const quiet = { info() {}, warn() {}, error() {} }
  const proof = (check: StoredKeyCheck | Error) => {
    const verify = jest.fn(async () => { if (check instanceof Error) throw check; return check })
    return { verify, keyProof: new KeyProof({ pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }) }, { verify, log: quiet }) }
  }

  it('health: banco + chave-mestra provada + storage → 200 só com os 4 campos; a chamada ao health NÃO roda a prova', async () => {
    const { verify, keyProof } = proof({ ok: true, degraded: false, versions: [{ version: 1, ok: true, unreadable: 0 }] })
    await keyProof.run()
    const before = verify.mock.calls.length
    const app = createApp(ctx(), keyProof)
    for (let i = 0; i < 3; i++) {
      const r = await request(app).get('/v1/health')
      expect([r.status, r.body]).toEqual([200, { status: 'ok', db: true, masterKey: true, storage: true, serverChain: SERVER_CHAIN }])   // `authorities` é da NE-5 (§16.3-4)
    }
    expect(verify.mock.calls.length).toBe(before)
  })

  it('health: chave que não abre os A1, prova que não rodou, nunca provou ou degraded → só o sinal (nada de versão/código); banco fora → db false', async () => {
    const bad = proof({ ok: false, degraded: false, versions: [{ version: 1, ok: false, code: 'FISCAL_CERT_INVALID', unreadable: 3 }] })
    await bad.keyProof.run()
    const r = await request(createApp(ctx(), bad.keyProof)).get('/v1/health')
    expect([r.status, r.body]).toEqual([503, { status: 'degraded', db: true, masterKey: false, storage: true, serverChain: SERVER_CHAIN }])
    const notRun = proof(new Error('ECONNREFUSED'))
    await notRun.keyProof.run()
    const n = await request(createApp(ctx(), notRun.keyProof)).get('/v1/health')
    expect([n.status, n.body]).toEqual([503, { status: 'degraded', db: true, masterKey: false, storage: true, serverChain: SERVER_CHAIN }])
    const never = await request(createApp(ctx())).get('/v1/health')            // sem prova passada (nunca rodou) → masterKey false
    expect([never.status, never.body.masterKey]).toEqual([503, false])
    const deg = proof({ ok: true, degraded: true, versions: [{ version: 1, ok: true, unreadable: 2 }] })
    await deg.keyProof.run()
    const d = await request(createApp(ctx(), deg.keyProof)).get('/v1/health')   // degraded com a chave certa → 200 e o corpo NÃO diz
    expect([d.status, d.body]).toEqual([200, { status: 'ok', db: true, masterKey: true, storage: true, serverChain: SERVER_CHAIN }])
    const down = { query: jest.fn(async () => { throw new Error('down') }), getConnection: jest.fn() } as any
    const noDb = await request(createApp(ctx({ pool: down }), deg.keyProof)).get('/v1/health')
    expect([noDb.status, noDb.body.db, noDb.body.masterKey]).toEqual([503, false, true])
  })
  it('o contrato é servido: /v1/openapi.yaml e /docs', async () => {
    const app = createApp(ctx())
    const y = await request(app).get('/v1/openapi.yaml')
    expect([y.status, y.headers['content-type']?.includes('yaml'), y.text.startsWith('openapi: 3.0.3')]).toEqual([200, true, true])
    expect([200, 301].includes((await request(app).get('/docs')).status)).toBe(true)
  })
})

/**
 * TODAS as rotas que o app REAL serve (rotas diretas + routers montados, recursivo), como `METHOD /path` com `{param}` — gate adversarial da NE-2
 * (ADV-03): a cerca lia uma lista À MÃO (`emitterRoutes` + health) e uma rota registrada direto no `app.ts` escapava de "nada servido fora do
 * contrato" (o `GET /v1/openapi.yaml` já escapava). Agora a cerca lê o `app._router`; as META-rotas toleradas são NOMEADAS (`META_ROUTES`).
 */
const prefixOf = (layer: any): string => {
  const m = /^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)/.exec(String(layer.regexp?.source ?? ''))      // express 4: /^\/v1\/emitter\/?(?=\/|$)/i
  return m ? '/' + m[1].replace(/\\\//g, '/') : ''
}
function appRoutes(app: any): string[] {
  const out: string[] = []
  const walk = (stack: any[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${(prefix + (layer.route.path === '/' ? '' : layer.route.path)).replace(/:(\w+)/g, '{$1}')}`)
      } else if (layer.name === 'router' && layer.handle?.stack) walk(layer.handle.stack, prefix + prefixOf(layer))
    }
  }
  walk(app._router.stack, '')
  return out
}
/** Middlewares montados com PREFIXO que não são rota nem router (o `/docs` do Swagger; a autenticação na frente de um router). */
function mountedPrefixes(app: any): string[] {
  const routers = new Set(app._router.stack.filter((l: any) => l.name === 'router').map(prefixOf))
  return [...new Set<string>(app._router.stack.filter((l: any) => !l.route && l.name !== 'router').map(prefixOf).filter(Boolean))].filter(p => !routers.has(p))
}
/** O que o app serve FORA do contrato de propósito (nomeado): o próprio contrato em YAML; o `/docs` é middleware, não rota (conferido à parte). */
const META_ROUTES = new Set(['GET /v1/openapi.yaml'])

describe('CERCA: contrato OpenAPI × rotas reais com as marcas `x-onda` (design-first — D-F8/D-NE166)', () => {
  it('a cerca enumera o APP REAL (não uma lista à mão): acha as rotas do router do emitente, a do health, a meta-rota do YAML e uma rota intrusa registrada direto no app', () => {
    const app = createApp(ctx())
    const routes = appRoutes(app)
    expect(routes).toEqual(expect.arrayContaining(['GET /v1/health', 'GET /v1/openapi.yaml', 'GET /v1/emitter', 'PUT /v1/emitter/certificate', 'DELETE /v1/emitter/certificate',
      'PUT /v1/emitter/issuers/{model}', 'DELETE /v1/emitter/issuers/{model}']))
    expect(routes).toHaveLength(7)
    expect(mountedPrefixes(app)).toEqual(['/docs'])
    // a mesma enumeração que `fromRouter` fazia à mão, agora derivada do app
    const byHand = emitterRoutes(ctx()).stack.filter((l: any) => l.route).flatMap((l: any) => Object.keys(l.route.methods).map(m => `${m.toUpperCase()} /v1/emitter${l.route.path === '/' ? '' : l.route.path}`)).map(r => r.replace(/:(\w+)/g, '{$1}'))
    expect(routes.filter(r => r.startsWith('GET /v1/emitter') || r.includes('/v1/emitter/')).sort()).toEqual(byHand.sort())
    app.get('/v1/intrusa', (_req: any, res: any) => res.end())
    const documented = new Set<string>(Object.entries<any>(loadOpenApi().paths).flatMap(([p, ops]) => Object.keys(ops).filter(m => ['get', 'post', 'put', 'delete', 'patch'].includes(m)).map(m => `${m.toUpperCase()} ${p}`)))
    expect(appRoutes(app).filter(r => !documented.has(r) && !META_ROUTES.has(r))).toEqual(['GET /v1/intrusa'])
  })
  it('servidas = contrato − marcadas; nada servido fora do contrato (salvo as meta-rotas NOMEADAS); nada marcado servido; toda marca é NE-3 ou NE-5; health e emitente nunca marcados', () => {
    const implemented = new Set(appRoutes(createApp(ctx())).filter(r => !META_ROUTES.has(r)))
    const doc = loadOpenApi()
    const documented = new Set<string>(), marked = new Map<string, string>()
    for (const [p, ops] of Object.entries<any>(doc.paths)) {
      for (const [m, op] of Object.entries<any>(ops)) {
        if (!['get', 'post', 'put', 'delete', 'patch'].includes(m)) continue
        const key = `${m.toUpperCase()} ${p}`
        documented.add(key)
        if (op['x-onda'] !== undefined) marked.set(key, String(op['x-onda']))
      }
    }
    const expectedServed = [...documented].filter(r => !marked.has(r))
    expect([...implemented].filter(r => !documented.has(r))).toEqual([])                 // nada servido fora do contrato
    expect(expectedServed.filter(r => !implemented.has(r))).toEqual([])                   // nada do contrato sem marca fica sem rota
    expect([...marked.keys()].filter(r => implemented.has(r))).toEqual([])                // nada marcado está servido
    expect([...marked.values()].filter(v => !['NE-3', 'NE-5'].includes(v))).toEqual([])
    expect(implemented.size).toBe(6)
    expect(marked.size).toBe(12)
    expect([...marked.keys()].every(r => r.includes('/v1/nfe/'))).toBe(true)
    // a meta-rota tolerada EXISTE no app (allowlist morta sai) e não está no contrato (se entrar, sai da allowlist)
    expect(appRoutes(createApp(ctx())).filter(r => META_ROUTES.has(r))).toEqual([...META_ROUTES])
    expect([...META_ROUTES].filter(r => documented.has(r))).toEqual([])
  })
  it('gate adversarial (DATA_EXPOSURE, LOW): o 422 do modelo ecoa o parâmetro CORTADO e sem caractere de controle — nunca os 3.000 caracteres do chamador', async () => {
    const app = createApp(ctx())
    const r = await request(app).put(`/v1/emitter/issuers/${'a'.repeat(3000)}`).set('Authorization', `Bearer ${token()}`).send({ environment: 'H' })
    expect([r.status, r.body.code, r.body.error.length < 200, /[\x00-\x1f]/.test(r.body.error)]).toEqual([422, 'FISCAL_MODEL_NOT_SUPPORTED', true, false])
    const nl = await request(app).put('/v1/emitter/issuers/55%0Ax').set('Authorization', `Bearer ${token()}`).send({ environment: 'H' })
    expect([nl.status, /\n/.test(nl.body.error)]).toEqual([422, false])
  })
})

describe('CERCAS do código (D-F31, D-F10, D-NE10)', () => {
  const root = path.resolve(__dirname, '..', '..')
  const files = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : files(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
  // `(?<!:)` — o `//` de uma URL dentro de texto não é comentário (gate adversarial da NFE.E5.P2: escondia o resto da linha das cercas).
  const clean = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
  it('D-F31: NENHUMA escrita de dado no ERP em src/ e scripts/ (escrita qualificada por schema de cliente ou pelo central)', () => {
    const ERP_WRITE = /(INSERT\s+(?:IGNORE\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:\\`\$\{\w+\}\\`|`?setes_\w*`?)\./g
    const writes = [path.join(root, 'src'), path.join(root, 'scripts')].flatMap(files).flatMap(f => (clean(f).match(ERP_WRITE) ?? []).map(m => `${path.relative(root, f)}: ${m}`))
    expect(writes).toEqual([])
  })
  // Limites conhecidos (gate adversarial da NFE.E5.P2): a cadeia central da entidade (`tb_company`, `tb_address`, `tb_state`, `tb_city`,
  // `tb_person`) e `tb_institution` NÃO estão na lista — o núcleo e o health as leem fora de `facts/`; nome de tabela MONTADO em tempo de
  // execução não é visto por regex. A flag `i` fecha as maiúsculas.
  it('D-F10: nenhum tb_invoice / tb_order / tb_entity* nem tabela de produto, mercadoria, estoque, financeiro, transportadora, CFOP, medida ou forma de pagamento do ERP fora de src/facts/ (as tabelas da FAMÍLIA no fiscal_api não contam)', () => {
    const ERP_TABLE = /\btb_(invoice|order|entity|product|merchandise|stock|financial|carrier|cfop|measure|payment_types)(?!_id\b)(?!_merchandise_transmission\w*)(?!_number_void\b)\w*/i
    const offenders = files(path.join(root, 'src')).filter(f => !f.includes(`${path.sep}facts${path.sep}`) && !f.includes(`${path.sep}migrations${path.sep}`))
      .filter(f => ERP_TABLE.test(clean(f))).map(f => path.relative(root, f))
    expect(offenders).toEqual([])
  })
  it('D-NE10: o 55 nasce virado — nenhuma cerca da virada na borda (requireCutover / emissionStillInErp / FISCAL_CUTOVER_PENDING) nem a variável aposentada', () => {
    const hits = files(path.join(root, 'src')).filter(f => /requireCutover|emissionStillInErp|FISCAL_CUTOVER_PENDING|FISCAL_LEGACY_INSTITUTIONS/.test(clean(f))).map(f => path.relative(root, f))
    expect(hits).toEqual([])
  })
})
