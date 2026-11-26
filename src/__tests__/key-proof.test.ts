/// <reference types="jest" />
// nfe-api DEPLOY.E1.P6.T1 (D-NE189; D-F243, D-F244, D-F245, D-F250, D-F251 — 2026-11-19; ficha `projetos/nfe-api/GERAL/
// ficha-deploy-e1-p6-chave-mestra-health.md` no Vault): a prova da chave do SERVIDOR abre os segredos guardados — A1 e, desde a DEPLOY.E1.P13, a senha SMTP (`verifyStoredKeys` REAL), roda na
// partida antes do `listen` e a cada 5 min; o health só lê o sinal; falha = `masterKey=false` e o motivo no log. Gêmea: nfse-api b3f192e.
import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import { MasterKeyRing } from 'fiscal-api'
import type { StoredKeyCheck } from 'fiscal-api'
import { KeyProof, KEY_PROOF_INTERVAL_MINUTES, KEY_PROOF_LOG_CODES, KEY_PROOF_STALE_AFTER_MS } from '../key-proof'
import { OPENAPI_PATH } from '../app'
import { storedA1Pool } from './stored-a1-fake'

const SRC = path.resolve(__dirname, '..')
const keyA = randomBytes(32)
const keyB = randomBytes(32)
const ringA = MasterKeyRing.of({ 1: keyA })
const ringB = MasterKeyRing.of({ 1: keyB })        // a chave ERRADA de 32 bytes na mesma versão (o `selfTest` passava com ela)
const okCheck: StoredKeyCheck = { ok: true, degraded: false, versions: [{ version: 1, ok: true, unreadable: 0 }] }
const degradedCheck: StoredKeyCheck = { ok: true, degraded: true, versions: [{ version: 1, ok: true, unreadable: 2 }] }
const badCheck: StoredKeyCheck = { ok: false, degraded: false, versions: [{ version: 1, ok: false, code: 'FISCAL_CERT_INVALID', unreadable: 3 }] }
const pool = { query: jest.fn(), getConnection: jest.fn() } as any

/** Todas as formas em que uma chave poderia vazar num texto. */
function leakForms(...keys: Buffer[]): string[] {
  return keys.flatMap(k => [k.toString('base64'), k.toString('base64url'), k.toString('hex'), k.toString('hex').toUpperCase()])
}
function recordingLog() {
  const calls: Array<[string, string, any]> = []
  return {
    calls,
    log: {
      info: (m: string, meta?: object) => { calls.push(['info', m, meta]) },
      warn: (m: string, meta?: object) => { calls.push(['warn', m, meta]) },
      error: (m: string, meta?: object) => { calls.push(['error', m, meta]) },
    },
  }
}

describe('D-F243 — a prova abre A1 guardado pelo verifyStoredKeys REAL do núcleo', () => {
  const stored = [{ institutionId: 3, sealedWith: ringA }, { institutionId: 9, sealedWith: ringA }]

  it('(a) chave certa: A1 selados com o anel {1:A} e prova com o mesmo anel → true', async () => {
    const p = new KeyProof({ pool: storedA1Pool(stored), keyring: ringA }, { log: recordingLog().log })
    expect(await p.run()).toBe(true)
    expect(p.masterKey).toBe(true)
  })

  it('(b) chave ERRADA de 32 bytes na mesma versão → false, KEY_PROOF_FAILED com versão e código, nada da chave no log', async () => {
    expect(ringB.selfTest()).toBe(true)                                   // o que o health antigo aceitava — a razão do passo
    const { calls, log } = recordingLog()
    const p = new KeyProof({ pool: storedA1Pool(stored), keyring: ringB }, { log })
    expect(await p.run()).toBe(false)
    expect(p.masterKey).toBe(false)
    expect(calls).toHaveLength(1)
    const [level, , meta] = calls[0]
    expect([level, meta.code]).toEqual(['error', KEY_PROOF_LOG_CODES.failed])
    expect(meta.versions).toEqual([{ version: 1, ok: false, code: 'FISCAL_CERT_INVALID', unreadable: 2 }])
    const text = JSON.stringify(calls)
    for (const form of leakForms(keyA, keyB)) expect(text).not.toContain(form)
  })

  it('(c) versão guardada que o anel não tem (rotação mal feita) → false', async () => {
    const v2 = MasterKeyRing.of({ 2: keyB })
    const { calls, log } = recordingLog()
    const p = new KeyProof({ pool: storedA1Pool([...stored, { institutionId: 4, sealedWith: v2 }]), keyring: ringA }, { log })
    expect(await p.run()).toBe(false)
    expect(calls.map(c => [c[0], c[2]?.code])).toEqual([['error', KEY_PROOF_LOG_CODES.failed]])
    expect(calls[0][2].versions).toEqual([
      { version: 1, ok: true, code: null, unreadable: 0 },
      { version: 2, ok: false, code: 'FISCAL_MASTER_KEY_UNAVAILABLE', unreadable: 1 },
    ])
  })
})

describe('DEPLOY.E1.P13 — a prova com os dois donos do cofre (verifyStoredKeys REAL do núcleo 5.3.0)', () => {
  const smtps = [{ institutionId: 7, sealedWith: ringA }]

  it('só senha SMTP guardada (sem A1): o anel certo prova → true, e a prova LEU a tabela da 009 (não passou por não ver nada)', async () => {
    const pool = storedA1Pool([], smtps)
    const p = new KeyProof({ pool, keyring: ringA }, { log: recordingLog().log })
    expect(await p.run()).toBe(true)
    const sqls: string[] = pool.query.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(sqls.some(s => /tb_establishment_smtp_credential/.test(s) && /ROW_NUMBER\(\)/.test(s))).toBe(true)
  })

  it('senha SMTP com a chave ERRADA de 32 bytes → false e KEY_PROOF_FAILED pelo dono SMTP; nada da chave nem da senha no log', async () => {
    const { calls, log } = recordingLog()
    const pool = storedA1Pool([], smtps)
    const p = new KeyProof({ pool, keyring: ringB }, { log })
    expect(await p.run()).toBe(false)
    expect(calls.map(c => [c[0], c[2]?.code])).toEqual([['error', KEY_PROOF_LOG_CODES.failed]])
    expect(calls[0][2].versions).toEqual([{ version: 1, ok: false, code: 'SMTP_CREDENTIAL_UNREADABLE', unreadable: 1 }])
    const text = JSON.stringify(calls)
    for (const form of leakForms(keyA, keyB, ...pool.plains)) expect(text).not.toContain(form)
  })

  it('versão que só a senha SMTP usa e o anel não tem (rotação mal feita) → false, mesmo com os A1 abrindo', async () => {
    const v2 = MasterKeyRing.of({ 2: keyB })
    const { calls, log } = recordingLog()
    const p = new KeyProof({ pool: storedA1Pool([{ institutionId: 3, sealedWith: ringA }], [{ institutionId: 8, sealedWith: v2 }]), keyring: ringA }, { log })
    expect(await p.run()).toBe(false)
    expect(calls.map(c => [c[0], c[2]?.code])).toEqual([['error', KEY_PROOF_LOG_CODES.failed]])
    expect(calls[0][2].versions).toEqual([
      { version: 1, ok: true, code: null, unreadable: 0 },
      { version: 2, ok: false, code: 'FISCAL_MASTER_KEY_UNAVAILABLE', unreadable: 1 },
    ])
  })

  it('LIMITE do núcleo 5.3.0 (D-F243 entre donos; ficha §3): versão em que o A1 abre e TODAS as senhas SMTP não → true, só KEY_PROOF_DEGRADED no log', async () => {
    // fixado aqui para a NFE.E6.P4 herdar o aviso: um dono inteiro ilegível numa versão (cofre divergente) não derruba a prova — o alarme próprio é decisão do Valdo
    const { calls, log } = recordingLog()
    const pool = storedA1Pool([{ institutionId: 3, sealedWith: ringA }], [{ institutionId: 7, sealedWith: ringB }, { institutionId: 8, sealedWith: ringB }])
    const p = new KeyProof({ pool, keyring: ringA }, { log })
    expect(await p.run()).toBe(true)
    expect(calls.map(c => [c[0], c[2]?.code])).toEqual([['warn', KEY_PROOF_LOG_CODES.degraded]])
    const text = JSON.stringify(calls)
    for (const form of leakForms(keyA, keyB, ...pool.plains)) expect(text).not.toContain(form)
  })
})

describe('D-F244/D-F250 — o sinal e o motivo no log', () => {
  it('(d) anel vazio → false e KEY_PROOF_FAILED, SEM chamar a prova', async () => {
    const verify = jest.fn(async () => okCheck)
    const { calls, log } = recordingLog()
    const empty = new KeyProof({ pool, keyring: MasterKeyRing.of({}) }, { verify, log })
    expect(await empty.run()).toBe(false)
    expect(verify).not.toHaveBeenCalled()
    expect(calls.map(c => [c[0], c[2]?.code])).toEqual([['error', KEY_PROOF_LOG_CODES.failed]])
  })

  it('(e) erro de banco → false e KEY_PROOF_NOT_RUN com a mensagem', async () => {
    const { calls, log } = recordingLog()
    const p = new KeyProof({ pool, keyring: ringA }, { verify: async () => { throw new Error('ECONNREFUSED') }, log })
    expect(await p.run()).toBe(false)
    expect(calls.map(c => [c[0], c[2]?.code, c[2]?.err])).toEqual([['error', KEY_PROOF_LOG_CODES.notRun, 'ECONNREFUSED']])
  })

  it('(f) degraded (a chave abre, há A1 ilegível) → true e KEY_PROOF_DEGRADED no log (alarme, não queda)', async () => {
    const { calls, log } = recordingLog()
    const p = new KeyProof({ pool, keyring: ringA }, { verify: async () => degradedCheck, log })
    expect(await p.run()).toBe(true)
    expect(calls.map(c => [c[0], c[2]?.code])).toEqual([['warn', KEY_PROOF_LOG_CODES.degraded]])
  })

  it('(g) nunca provou → false; resultado mais velho que 2 intervalos (10 min) → false', async () => {
    expect(new KeyProof({ pool, keyring: ringA }, { verify: async () => okCheck }).masterKey).toBe(false)
    let now = 1_000_000
    const p = new KeyProof({ pool, keyring: ringA }, { verify: async () => okCheck, now: () => now })
    await p.run()
    expect(KEY_PROOF_STALE_AFTER_MS).toBe(10 * 60_000)
    now += KEY_PROOF_STALE_AFTER_MS
    expect(p.masterKey).toBe(true)
    now += 60_000
    expect(p.masterKey).toBe(false)
  })
})

describe('D-F245/D-F251 — rodadas e intervalo', () => {
  it('(h) rodada em curso não é sobreposta', async () => {
    let release!: () => void
    const verify = jest.fn(() => new Promise<StoredKeyCheck>(r => { release = () => r(okCheck) }))
    const p = new KeyProof({ pool, keyring: ringA }, { verify })
    const a = p.run(); const b = p.run()
    expect(a).toBe(b)
    expect(verify).toHaveBeenCalledTimes(1)
    release()
    expect(await a).toBe(true)
  })

  it('(h) rodada SEM RESPOSTA no prazo (1 intervalo) → false, KEY_PROOF_NOT_RUN, e a rodada seguinte pode começar', async () => {
    const { calls, log } = recordingLog()
    const verify = jest.fn(() => new Promise<StoredKeyCheck>(() => { /* pendurada para sempre */ }))
    const p = new KeyProof({ pool, keyring: ringA }, { verify, log, intervalMs: 30 })
    expect(await p.run()).toBe(false)
    expect(calls.map(c => c[2]?.code)).toEqual([KEY_PROOF_LOG_CODES.notRun])
    expect(await p.run()).toBe(false)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('(i) KEY_PROOF_INTERVAL_MINUTES = 5; start agenda a cada 5 min (uma vez só), stop para; o timer não segura o processo', () => {
    expect(KEY_PROOF_INTERVAL_MINUTES).toBe(5)
    jest.useFakeTimers()
    try {
      const q = new KeyProof({ pool, keyring: ringA }, { verify: jest.fn(async () => okCheck) })
      const spy = jest.spyOn(q, 'run')
      q.start(); q.start()
      expect((q as any).timer.hasRef()).toBe(false)
      jest.advanceTimersByTime(5 * 60_000 - 1)
      expect(spy).toHaveBeenCalledTimes(0)
      jest.advanceTimersByTime(1)
      expect(spy).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(5 * 60_000)
      expect(spy).toHaveBeenCalledTimes(2)
      q.stop()
      jest.advanceTimersByTime(10 * 60_000)
      expect(spy).toHaveBeenCalledTimes(2)
    } finally { jest.useRealTimers() }
  })

  it('o intervalo é constante no código, sem variável de ambiente (D-F251)', () => {
    const src = fs.readFileSync(path.join(SRC, 'key-proof.ts'), 'utf8')
    expect(src).not.toMatch(/process\.env/)
  })
})

describe('D-F250 — boot', () => {
  const server = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8')
  it('a 1ª prova roda (com await) DEPOIS das sondas e ANTES de ouvir a porta; o timer começa; o app recebe a prova', () => {
    const lastProbe = server.indexOf('await assertWithdrawnRangesViewReadable(')
    const run = server.indexOf('await keyProof.run()')
    const start = server.indexOf('keyProof.start()')
    const listen = server.indexOf('.listen(')
    expect(lastProbe).toBeGreaterThan(0)
    expect(run).toBeGreaterThan(lastProbe)
    expect(start).toBeGreaterThan(run)
    expect(listen).toBeGreaterThan(start)
    expect(server).toMatch(/createApp\(ctx, keyProof\)\.listen\(/)
    expect(server).toContain("Prova da chave-mestra na partida (D-F243): ${await keyProof.run() ? 'ok' : 'FALHOU — /v1/health com masterKey=false (ver o log)'}")
  })
  it('o health não usa mais o selfTest nem abre A1 por chamada', () => {
    const health = fs.readFileSync(path.join(SRC, 'health.ts'), 'utf8')
    expect(health).not.toMatch(/\.selfTest\(|verifyStoredKeys\(|storedKeyVersions\(/)
    expect(health).toContain('keyProof.masterKey')
  })
})

describe('contrato — o health descreve a prova (D-F243/D-F244)', () => {
  it('o 200 e o 503 de /v1/health dizem a prova por A1 e o sinal masterKey; o texto da NE-3 fica', () => {
    const doc = YAML.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'))
    const r = doc.paths['/v1/health'].get.responses
    for (const code of ['200', '503']) {
      expect(r[code].description).toMatch(/D-F243/)
      expect(r[code].description).toMatch(/masterKey/)
    }
    expect(r['200'].description).toMatch(/authorities/)
    expect(Object.keys(doc.components.schemas.Health.properties).sort()).toEqual(['authorities', 'db', 'masterKey', 'serverChain', 'status', 'storage'])
  })
})
