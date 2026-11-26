/// <reference types="jest" />
// nfe-api ACESSO.E1.P1 (D-AU3, D-AU12, D-AU16, D-AU19, D-EA7 — `Vault/prompts/prompt_frente_auth_api.md` §5; ficha
// `Vault/projetos/nfe-api/SUBJECT/ACESSO/ficha-acesso-e1-p1-sessao-viva.md`; molde nfse-api `app.ts`/`server.ts`/`grants-d-au12.test.ts`):
// toda rota protegida lê a SESSÃO viva (`access.liveIdentity` do núcleo — aqui o REAL do pacote, sobre um pool falso que responde à
// `setes_central.vw_user_link`) e o admin vem do PERFIL VIVO, nunca do `role` do token. A aceitação do token é provada contra o VETOR DE
// CONTRATO publicado pela auth-api (`auth-api/contract/token-vector.json` — par SÓ DE TESTE), lido de `AUTH_API_DIR` (padrão: a pasta irmã);
// o GRANT, contra a FONTE dos GRANTs do usuário 'fiscal_api' (`nfse-api/ops/grants.sql` seção 1a), lida de `NFSE_API_DIR` (padrão: a pasta
// irmã). Não achado = REPROVA (a cerca que some calada não prova nada).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadServerCa } from '../authority/server-ca'
import { generateKeyPairSync, randomBytes } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import ts from 'typescript'
import * as fiscal from 'fiscal-api'
import { MasterKeyRing, ProductTokenVerifier, FsFiscalStorage } from 'fiscal-api'
import { createApp, loadOpenApi } from '../app'
import { contextFromEnv } from '../context'
import { FAKE_TECH } from './technical-responsible-fake'
import type { AppContext } from '../context'
import { Breaker } from '../nfe/breaker'

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return { __esModule: true, ...actual, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, emitterView: jest.fn() }
})

const core = fiscal as unknown as Record<string, jest.Mock>
const ROOT = path.resolve(__dirname, '..', '..')
const WORKSPACE = path.resolve(ROOT, '..')

const AUTH_API_DIR = path.resolve(process.env.AUTH_API_DIR ?? path.join(WORKSPACE, 'auth-api'))
const VECTOR_PATH = path.join(AUTH_API_DIR, 'contract', 'token-vector.json')
if (!fs.existsSync(VECTOR_PATH)) {
  throw new Error(`ACESSO.E1.P1: o vetor de contrato da auth-api não está em ${VECTOR_PATH} — clone a auth-api ao lado ou aponte AUTH_API_DIR`)
}
const vector = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8')) as {
  kid: string; publicKeyPem: string
  claims: { institutionId: number; userId: number; schemaName: string }
  iat: number
  cases: Record<'final_sem_role' | 'final_com_role_legado' | 'selecao' | 'final_sem_iat', { token: string }>
}

const NFSE_API_DIR = path.resolve(process.env.NFSE_API_DIR ?? path.join(WORKSPACE, 'nfse-api'))
const GRANTS_PATH = path.join(NFSE_API_DIR, 'ops', 'grants.sql')
if (!fs.existsSync(GRANTS_PATH)) {
  throw new Error(`ACESSO.E1.P1: a fonte dos GRANTs do 'fiscal_api' não está em ${GRANTS_PATH} — clone a nfse-api ao lado ou aponte NFSE_API_DIR`)
}

// a chave "do setes-api" (par gerado aqui) e a da auth-api (do vetor) — os dois PEM em arquivos, como o `.env` aponta (JWT_PUBLIC_KEYS)
const setes = generateKeyPairSync('rsa', { modulusLength: 2048 })
const setesPub = setes.publicKey.export({ type: 'spki', format: 'pem' }) as string
const setesPriv = setes.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-api-acesso-'))
fs.writeFileSync(path.join(tmp, 'setes.pem'), setesPub)
fs.writeFileSync(path.join(tmp, 'auth-api.pem'), vector.publicKeyPem)
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const verifier = ProductTokenVerifier.fromEnv({
  JWT_PUBLIC_KEYS: `default=${path.join(tmp, 'setes.pem')},${vector.kid}=${path.join(tmp, 'auth-api.pem')}`,
})
const setesToken = (claims: Record<string, unknown> = {}) => jwt.sign(
  { institutionId: 1, userId: 7, schemaName: 'setes_setes', ...claims }, setesPriv, { algorithm: 'RS256', keyid: 'default', expiresIn: '1h' })

/**
 * Pool falso: a `vw_user_link` responde pela TUPLA (usuário, institution, schema) — o vínculo vivo existe só na institution 1 com o schema
 * dela (`setes_setes`; o do vetor: `setes_contrato`); [profiles] dá o perfil por usuário; `undefined` = nenhuma linha (sessão revogada).
 */
const LIVE_LINKS = new Set(['1|setes_setes', `${vector.claims.institutionId}|${vector.claims.schemaName}`])
let profiles: Record<number, string | undefined>
let dbDown: boolean
const pool = {
  query: jest.fn(async (sql: string, params: unknown[]) => {
    if (!/FROM setes_central\.vw_user_link/.test(sql)) throw new Error(`consulta inesperada: ${sql}`)
    if (dbDown) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const profile = LIVE_LINKS.has(`${params[1]}|${params[2]}`) ? profiles[Number(params[0])] : undefined
    return [profile === undefined ? [] : [{ profile, vendor: 'N' }]]
  }),
  getConnection: jest.fn(),
} as any

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-api-acesso-st-'))
const SERVER_CA = loadServerCa(path.resolve(__dirname, '..', '..', 'acervo', 'icp', 'raizes-icp-brasil.pem'), new Date('2026-11-21T12:00:00Z'))   // NFE.E4.P3.T3
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))
const ctx = (over: Partial<AppContext> = {}): AppContext => ({
  db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
  pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage(storageRoot),
  fiscalDb: 'fiscal_api', verifier, corsOrigins: [], checkIdentity: true, serverCa: SERVER_CA, technicalResponsible: FAKE_TECH, breaker: new Breaker(() => new Date()), ...over,
})
const EMITTER = { issuers: [], certificate: { certificate: false, privateKey: false, certificateInfo: null } }
const get = (app: ReturnType<typeof createApp>, token: string) => request(app).get('/v1/emitter').set('Authorization', `Bearer ${token}`)

beforeEach(() => {
  jest.clearAllMocks()
  profiles = { 7: 'admin', 8: 'user', [vector.claims.userId]: 'admin' }
  dbDown = false
  core.emitterView.mockResolvedValue(EMITTER)
})

describe('ACESSO.E1.P1.T1 — toda rota protegida lê a sessão viva; o admin é o do perfil VIVO', () => {
  it('(a) sessão viva com perfil admin → 200 no emitente', async () => {
    const r = await get(createApp(ctx()), setesToken())
    expect([r.status, r.body.ok]).toEqual([200, true])
    expect(core.emitterView).toHaveBeenCalledTimes(1)
  })

  it('(b) sessão que não vale mais (nenhuma linha na vw_user_link) → 401 SESSION_REVOKED, e o emitente não é tocado', async () => {
    profiles[7] = undefined
    const r = await get(createApp(ctx()), setesToken({ role: 'admin' }))
    expect([r.status, r.body.code]).toEqual([401, 'SESSION_REVOKED'])
    expect(core.emitterView).not.toHaveBeenCalled()
  })

  it('(c) a sessão não pôde ser lida (banco fora) → 503 SESSION_UNAVAILABLE, sem a causa na resposta', async () => {
    dbDown = true
    const r = await get(createApp(ctx()), setesToken())
    expect([r.status, r.body.code]).toEqual([503, 'SESSION_UNAVAILABLE'])
    expect(JSON.stringify(r.body)).not.toMatch(/ECONNREFUSED/)
    expect(core.emitterView).not.toHaveBeenCalled()
  })

  it('(d) token com `role: admin` e perfil VIVO `user` → 403 ADMIN_REQUIRED em todas as rotas do emitente (o role do token não é lido)', async () => {
    const app = createApp(ctx())
    const t = setesToken({ userId: 8, role: 'admin' })
    for (const [m, p] of [['get', '/v1/emitter'], ['put', '/v1/emitter/certificate'], ['delete', '/v1/emitter/certificate'],
      ['put', '/v1/emitter/issuers/55'], ['delete', '/v1/emitter/issuers/55']] as const) {
      const r = await (request(app) as any)[m](p).set('Authorization', `Bearer ${t}`).send({})
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 403, 'ADMIN_REQUIRED'])
    }
    expect(core.emitterView).not.toHaveBeenCalled()
  })

  it('(d2) rebaixar vale na hora: o MESMO token passa de 200 a 403 quando o perfil vivo muda', async () => {
    const app = createApp(ctx())
    const t = setesToken()
    expect((await get(app, t)).status).toBe(200)
    profiles[7] = 'user'
    expect([(await get(app, t)).status]).toEqual([403])
  })

  it('(e) a leitura leva usuário, institution e schema DO TOKEN e o `iat` como DATETIME UTC (D-EA7)', async () => {
    const t = setesToken()
    const iat = (jwt.decode(t) as { iat: number }).iat
    await get(createApp(ctx()), t)
    expect(pool.query).toHaveBeenCalledTimes(1)
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toMatch(/tb_user_id = \? AND tb_institution_id = \? AND schema_name = \?/)
    expect(sql).toMatch(/password_set_at IS NULL OR password_set_at <= \?/)
    expect(params).toEqual([7, 1, 'setes_setes', new Date(iat * 1000).toISOString().slice(0, 19).replace('T', ' ')])
  })

  it('(b2) vínculo vivo só na institution 1: token da institution 2, ou com o schema de outra, → 401 SESSION_REVOKED', async () => {
    const app = createApp(ctx())
    for (const claims of [{ institutionId: 2, schemaName: 'setes_outra' }, { schemaName: 'setes_outra' }, { institutionId: 2 }]) {
      const r = await get(app, setesToken(claims))
      expect([JSON.stringify(claims), r.status, r.body.code]).toEqual([JSON.stringify(claims), 401, 'SESSION_REVOKED'])
    }
    expect(core.emitterView).not.toHaveBeenCalled()
  })

  it('(g) produção liga a sessão: `contextFromEnv` dá `checkIdentity: true`, e nenhuma variável de ambiente o desliga', () => {
    const over = { pool, verifier, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage(storageRoot), serverCa: SERVER_CA, technicalResponsible: FAKE_TECH }
    for (const env of [{}, { CHECK_IDENTITY: 'false', checkIdentity: 'false', NODE_ENV: 'production', FISCAL_CHECK_IDENTITY: '0' }]) {
      expect(contextFromEnv(env as NodeJS.ProcessEnv, over).checkIdentity).toBe(true)
    }
  })

  it('(f) sem o [check] da sessão ninguém é admin — nem com `role: admin` no token (fecha, não abre)', async () => {
    const r = await get(createApp(ctx({ checkIdentity: false })), setesToken({ role: 'admin' }))
    expect([r.status, r.body.code]).toEqual([403, 'ADMIN_REQUIRED'])
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('cerca: o [check] do app é o `access.liveIdentity` com o `iat`; nenhum código de produção lê o `role` do payload', () => {
    const app = codeOf(path.join(ROOT, 'src', 'app.ts'))
    expect(app).toMatch(/productAuth\(ctx\.verifier, ctx\.checkIdentity\s*\?\s*\(p, iat\) => access\.liveIdentity\(ctx\.pool, p, iat\)/)
    expect(app).not.toMatch(/assertInstitutionSchema/)
    const readers = codeFiles(path.join(ROOT, 'src'), 'ts').filter(f => /\.role\b|\[['"]role['"]\]|\{[^}]*\brole\b[^}]*\}\s*=/.test(codeOf(f)))
    expect(readers.map(f => path.relative(ROOT, f))).toEqual([])
  })

  it('cerca: TODA operação servida do contrato com segurança passa pela sessão viva (sem token → 401; revogada → 401 SESSION_REVOKED)', async () => {
    const doc = loadOpenApi()
    const app = createApp(ctx())
    const ops: string[] = []
    const open: string[] = []
    for (const [p, item] of Object.entries<any>(doc.paths)) {
      for (const m of ['get', 'put', 'post', 'delete', 'patch'] as const) {
        const op = item[m]
        if (!op || op['x-onda']) continue
        if (Array.isArray(op.security) && op.security.length === 0) { open.push(`${m.toUpperCase()} ${p}`); continue }
        ops.push(`${m.toUpperCase()} ${p}`)
        const url = p.replace(/\{[^}]+\}/g, '55')
        const anon = await (request(app) as any)[m](url).send({})
        expect([m, p, anon.status]).toEqual([m, p, 401])
        profiles[7] = undefined
        const revoked = await (request(app) as any)[m](url).set('Authorization', `Bearer ${setesToken()}`).send({})
        profiles[7] = 'admin'
        expect([m, p, revoked.status, revoked.body.code]).toEqual([m, p, 401, 'SESSION_REVOKED'])
      }
    }
    expect(open).toEqual(['GET /v1/health'])                           // lista FECHADA das operações sem sessão (`security: []`)
    expect(ops.length).toBeGreaterThanOrEqual(5)                       // as 5 do emitente hoje; rota nova entra sozinha nesta cerca
    expect(core.emitterView).not.toHaveBeenCalled()
  })

  it('cerca: o boot confere a vw_user_link (`assertSessionViewReadable`) ANTES do `listen`', () => {
    const server = codeOf(path.join(ROOT, 'src', 'server.ts'))
    const main = server.slice(server.indexOf('async function main()'))
    const check = main.indexOf('await access.assertSessionViewReadable(ctx.pool)')
    expect(check).toBeGreaterThan(0)
    expect(main.match(/\.listen\(/g)).toHaveLength(1)
    expect(main.indexOf('.listen(')).toBeGreaterThan(check)
    expect(server.slice(0, server.indexOf('async function main()'))).not.toMatch(/\.listen\(/)
  })
})

describe('ACESSO.E1.P1.T2 — o token sem `role` da auth-api (vetor de contrato) é aceito; o GRANT do fiscal lê a view da sessão', () => {
  it('final_sem_role → aceito; o perfil vem do banco (admin → 200, user → 403)', async () => {
    const app = createApp(ctx())
    expect((await get(app, vector.cases.final_sem_role.token)).status).toBe(200)
    const [, params] = pool.query.mock.calls[0]
    expect(params.slice(0, 3)).toEqual([vector.claims.userId, vector.claims.institutionId, vector.claims.schemaName])
    expect(params[3]).toBe(new Date(vector.iat * 1000).toISOString().slice(0, 19).replace('T', ' '))
    profiles[vector.claims.userId] = 'user'
    expect([(await get(app, vector.cases.final_sem_role.token)).body.code]).toEqual(['ADMIN_REQUIRED'])
  })

  it('final_com_role_legado (role "super" no token) → aceito e o role IGNORADO: perfil vivo user = 403; admin = 200', async () => {
    const app = createApp(ctx())
    profiles[vector.claims.userId] = 'user'
    const r = await get(app, vector.cases.final_com_role_legado.token)
    expect([r.status, r.body.code]).toEqual([403, 'ADMIN_REQUIRED'])
    profiles[vector.claims.userId] = 'admin'
    expect((await get(app, vector.cases.final_com_role_legado.token)).status).toBe(200)
  })

  it('selecao → 401 (token de seleção não serve aqui); final_sem_iat → 401; nenhum chega à sessão nem ao emitente', async () => {
    const app = createApp(ctx())
    for (const c of ['selecao', 'final_sem_iat'] as const) {
      const r = await get(app, vector.cases[c].token)
      expect([c, r.status, r.body.code]).toEqual([c, 401, 'UNAUTHORIZED'])
    }
    expect(pool.query).not.toHaveBeenCalled()
    expect(core.emitterView).not.toHaveBeenCalled()
  })

  it('os kids não se cruzam: assinado pela chave do setes-api com o kid da auth-api → 401', async () => {
    const forged = jwt.sign({ ...vector.claims }, setesPriv, { algorithm: 'RS256', keyid: vector.kid, expiresIn: '1h' })
    expect([(await get(createApp(ctx()), forged)).status]).toEqual([401])
  })

  it('GRANT (D-AU12): toda `setes_central.<nome>` lida pela nfe-api e pelo núcleo INSTALADO tem o SELECT do fiscal_api — vw_user_link inclusa', () => {
    const grants = fs.readFileSync(GRANTS_PATH, 'utf8')
    const granted = new Set([...grants.matchAll(/^GRANT SELECT ON `setes_central`\.`(\w+)`\s+TO 'fiscal_api'@'%';/gm)].map(m => m[1]))
    const reads = centralReads()
    expect(reads.has('vw_user_link')).toBe(true)
    expect(reads.get('${') ?? new Set()).toEqual(new Set())          // nome montado: a cerca não o leria
    const missing = [...reads].filter(([name]) => !granted.has(name)).map(([name, files]) => `${name} ← ${[...files].join(', ')}`)
    expect(missing).toEqual([])
    expect(granted.has('vw_user_link')).toBe(true)
    expect(granted.has('tb_user')).toBe(false)
  })
})

// --- leitura do código (molde: nfse-api `grants-d-au12.test.ts`) ---

function codeFiles(dir: string, ext: 'ts' | 'js'): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...codeFiles(p, ext)) }
    else if (e.name.endsWith(`.${ext}`) && !/\.(test|d)\.[jt]s$/.test(e.name)) out.push(p)
  }
  return out
}

/** Código sem comentários (o printer do compilador; texto com `//` fica intacto). */
function codeOf(file: string): string {
  const kind = file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind)
  return ts.createPrinter({ removeComments: true }).printFile(sf)
}

/** O núcleo monta o nome da view pela constante PUBLICADA (`setes_central.${exports.ACCESS_VIEWS.x}`): resolvida pelo pacote INSTALADO. */
const CORE_ACCESS_VIEWS: Record<string, unknown> = jest.requireActual('fiscal-api').access.ACCESS_VIEWS
function resolvePublishedViews(code: string): string {
  return code.replace(/setes_central(`?)\.(`?)\$\{exports\.ACCESS_VIEWS\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, a, b, key: string) => {
    const name = Object.prototype.hasOwnProperty.call(CORE_ACCESS_VIEWS, key) ? CORE_ACCESS_VIEWS[key] : undefined
    return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `setes_central${a}.${b}${name}` : all
  })
}

/** `setes_central.<nome>` lido pelo código de produção da nfe-api e pelo `dist` INSTALADO do núcleo — nome → arquivos. */
function centralReads(): Map<string, Set<string>> {
  const coreDist = path.join(path.dirname(require.resolve('fiscal-api/package.json')), 'dist')
  const out = new Map<string, Set<string>>()
  for (const f of [...codeFiles(path.join(ROOT, 'src'), 'ts'), ...codeFiles(coreDist, 'js')]) {
    for (const m of resolvePublishedViews(codeOf(f)).matchAll(/setes_central`?\.`?(\$\{|[A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!out.has(m[1])) out.set(m[1], new Set())
      out.get(m[1])!.add(path.relative(WORKSPACE, f).replace(/\\/g, '/'))
    }
  }
  return out
}
