/// <reference types="jest" />
/**
 * A tentativa da NF-e no MOTOR REAL, num banco DESCARTÁVEL (NFE.E6.P1 mudanças 4 e 6 — ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6; D-F53): criado pelo
 * runner de migrations (núcleo 001–008 + família 001 e 002) e APAGADO no afterAll. Nunca escreve no `fiscal_api` nem nos `setes_*`. **Só roda com NFE_ADV_E6P1_DB=1**
 * (credenciais do `.env` da nfe-api; o usuário precisa poder criar `fiscal_api_adv%`) — **NÃO foi executado na sessão que o escreveu**: o dev local estava fora do ar e
 * rodar é do Valdo, com o "vai". O que prova: o runner e a sonda da coluna da 002; `insertAttempt` (MAX+1, e a colisão da UNIQUE da chave sorteia outra chave);
 * write-once no motor (`fillReceipt`, `fillAuthorityData`, `recordNfeNotRegistered` — este NÃO grava se entrou voz depois da que a pergunta viu); a política do número
 * com linhas reais.
 */
import path from 'path'
import { createFiscalPool, dbConfigFromEnv, invoiceRef, mod11Ascii48, runMigrations, withInvoiceTx, WEB_TERMINAL, type FiscalDbConfig } from 'fiscal-api'
import { MIGRATION_SETS } from '../migrations'
import { MERCHANDISE_TRANSMISSION_TABLE as T, MERCHANDISE_VOICE_FAMILY } from '../nfe/voice-family'
import { attemptsOfLife, drawCnf, fillAuthorityData, fillReceipt, insertAttempt, latestAttempt, numberPolicy } from '../nfe/attempt'
import { assertNfeNotRegisteredColumn, recordNfeNotRegistered } from '../nfe/not-registered'

/** O `mysql2` que o pool do núcleo usa (a mesma instância de módulo — D-F228). */
const CORE_MYSQL2 = require.resolve('mysql2/promise', { paths: [path.dirname(require.resolve('fiscal-api/package.json'))] })

const LIVE = process.env.NFE_ADV_E6P1_DB === '1'
const d = LIVE ? describe : describe.skip

const DB = `fiscal_api_adv_e6p1_${process.pid}`
const INST = 999_006
const EV = MERCHANDISE_VOICE_FAMILY.eventTable
const LOCKED = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
const keyOf = (number: number, cnf: string): string => {
  const body = '412611ABCDEF780001' + '95' + '55' + '001' + String(number).padStart(9, '0') + '1' + cnf
  return body + mod11Ascii48(body)
}
const cfg = (): FiscalDbConfig => ({ ...dbConfigFromEnv(), database: DB, connectionLimit: 10 })

d('a tentativa da NF-e no banco descartável', () => {
  let pool: ReturnType<typeof createFiscalPool>
  const tx = <R>(invoiceId: number, fn: Parameters<typeof withInvoiceTx<R>>[4]) =>
    withInvoiceTx(pool, { schemaName: 'setes_x', institutionId: INST }, invoiceRef(INST, invoiceId, WEB_TERMINAL), { label: 'e6p1-db', lock: async () => LOCKED as never }, fn)
  const REF = (invoiceId: number) => invoiceRef(INST, invoiceId, WEB_TERMINAL)
  const base = { lifeEvent: 1, environment: 'H' as const, authorizer: 'PR', dhEmissionUtc: '2026-11-24 13:15:30' }
  const made = (key: () => string) => ({ make: () => ({ accessKey: key(), digestValue: 'A'.repeat(27) + '=' }) })

  beforeAll(async () => {
    const c = cfg()
    expect(c.database).toMatch(/^fiscal_api_adv_e6p1_\d+$/)
    const applied = await runMigrations(c, MIGRATION_SETS)
    expect(applied).toContain('nfe-api/002_nfe_reconfirm')
    expect((await runMigrations(c, MIGRATION_SETS)).length).toBe(0)           // idempotente
    pool = createFiscalPool(c)
  }, 120_000)

  afterAll(async () => {
    try { await pool?.end() } catch { /* */ }
    const mysql = require(CORE_MYSQL2)
    const c = cfg()
    const conn = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password })
    try { await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``) } finally { await conn.end() }
  }, 60_000)

  it('a sonda da coluna nfe_not_registered_at (002) passa', async () => {
    await expect(assertNfeNotRegisteredColumn(pool)).resolves.toBeUndefined()
  })

  it('insertAttempt: 1ª = 1; a colisão da UNIQUE da chave (outra nota, mesma chave) sorteia outra chave; a 2ª da mesma nota = MAX+1', async () => {
    const a1 = await tx(7001, itx => insertAttempt(itx, { ...base, ...made(() => keyOf(15, '48213057')) }, null))
    expect([a1.attempt, a1.accessKey]).toEqual([1, keyOf(15, '48213057')])
    let draws = 0
    const a2 = await tx(7002, itx => insertAttempt(itx, { ...base, ...made(() => keyOf(15, draws++ === 0 ? '48213057' : drawCnf(15))) }, null))
    expect(draws).toBe(2)
    expect(a2.accessKey).not.toBe(a1.accessKey)
    const a3 = await tx(7001, itx => insertAttempt(itx, { ...base, ...made(() => keyOf(15, drawCnf(15))) }, null))
    expect(a3.attempt).toBe(2)
  })

  it('write-once no motor: fillReceipt e fillAuthorityData gravam UMA vez e a 2ª chamada devolve false', async () => {
    expect(await tx(7001, itx => fillReceipt(itx, 1, '411000000000001'))).toBe(true)
    expect(await tx(7001, itx => fillReceipt(itx, 1, '411000000000002'))).toBe(false)
    expect(await tx(7001, itx => fillAuthorityData(itx, 1, { protocol: '141260000000001', dhRecbtoUtc: '2026-11-24 13:20:00' }))).toBe(true)
    expect(await tx(7001, itx => fillAuthorityData(itx, 1, { protocol: '141260000000009', dhRecbtoUtc: null }))).toBe(false)
    const [rows] = await pool.query(`SELECT receipt, protocol FROM ${T} WHERE tb_institution_id = ? AND tb_invoice_id = 7001 AND attempt = 1`, [INST])
    expect([(rows as any[])[0].receipt, (rows as any[])[0].protocol]).toEqual(['411000000000001', '141260000000001'])
  })

  it('recordNfeNotRegistered grava UMA vez e NÃO grava se entrou voz depois da que a pergunta viu (a mesma instrução)', async () => {
    expect(await recordNfeNotRegistered(pool, REF(7002), 1, 0)).toBe(true)
    expect(await recordNfeNotRegistered(pool, REF(7002), 1, 0)).toBe(false)
    await pool.query(
      `INSERT INTO ${EV} (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, source, created_at, updated_at, deleted)
       VALUES (?, 7001, 0, 2, 1, 'R', '703', 'P', NOW(), NOW(), 'N')`, [INST])
    expect(await recordNfeNotRegistered(pool, REF(7001), 2, 0)).toBe(false)
    expect(await recordNfeNotRegistered(pool, REF(7001), 2, 1)).toBe(true)
  })

  it('a política do número com linhas reais: R sem registro reaproveita número e série; em voo barra com 409', async () => {
    const life = await latestAttempt(pool, REF(7001), 1)
    expect([life?.attempt, life?.lastKind]).toEqual([2, 'R'])
    expect(numberPolicy(life)).toEqual({ action: 'reuse', number: 15, serie: 1 })
    expect((await attemptsOfLife(pool, REF(7001), 1)).map(a => a.attempt)).toEqual([1, 2])
    // a 7002 tem o fato "não registrada" (o teste anterior): o 217 PROVADO solta a nota, mesmo número (D-NE292); sem o fato, em voo barra com 409
    const proven = await latestAttempt(pool, REF(7002), 1)
    expect(numberPolicy(proven)).toMatchObject({ action: 'reuse' })
    await pool.query(`UPDATE ${T} SET nfe_not_registered_at = NULL WHERE tb_institution_id = ? AND tb_invoice_id = 7002 AND attempt = 1`, [INST])
    const flying = await latestAttempt(pool, REF(7002), 1)
    expect(() => numberPolicy(flying)).toThrow(/não está fechada|em andamento/)
  })
})
