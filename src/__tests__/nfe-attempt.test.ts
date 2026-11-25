/// <reference types="jest" />
/**
 * NFE.E6.P1 mudança 6 (ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-6; D-NE7, D-NE37, D-NE56, D-NE61, D-NE257, D-NE265, D-NE282): a tentativa da NF-e — o
 * INSERT com o sorteio do `cNF`, os escritores write-once, a barreira de nova tentativa e a política do número. O banco é uma conexão falsa dentro do `withInvoiceTx`
 * do núcleo (como os testes do núcleo e da nfse-api); o motor real (corrida entre duas tentativas, 409 em produção fechada) só no `scripts/prove-006-descartavel.ts`.
 */
import fs from 'fs'
import path from 'path'
import { invoiceRef, withInvoiceTx } from 'fiscal-api'
import {
  attemptsOfLife, barrierOf, drawCnf, fillAuthorityData, fillReceipt, findKeyHolder, generateNumber, getAttempt, insertAttempt, latestAttempt, numberPolicy, touchQueriedAt,
  type AttemptRow,
} from '../nfe/attempt'

jest.mock('fiscal-api', () => ({ ...jest.requireActual('fiscal-api'), nextInvoiceNumber: jest.fn() }))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { nextInvoiceNumber } = require('fiscal-api') as { nextInvoiceNumber: jest.Mock }

const REF = invoiceRef(98, 5001, 0)
const LOCKED = { alive: true, lifeEvent: 3, lastEvent: 3, lastKind: 'E' }
const KEY = (cnf: string, number = 15, serie = 1) => `412611${'07742094000113'}55${String(serie).padStart(3, '0')}${String(number).padStart(9, '0')}1${cnf}7`

type Call = { sql: string; params: unknown[] }
function fakePool(handler: (sql: string, params: unknown[]) => unknown = () => [{ affectedRows: 1 }, []]) {
  const calls: Call[] = []
  // o servidor responde DEPOIS (fila da conexão): uma chamada sem `await` no callback só chega ao INSERT depois do COMMIT
  const query = jest.fn(async (sql: string, params: unknown[] = []) => { await new Promise(r => setImmediate(r)); calls.push({ sql, params }); return handler(sql, params) })
  const conn = { query, beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}), release: jest.fn(() => {}) }
  return { calls, pool: { query, getConnection: jest.fn(async () => conn) } as any }
}
const tx = <T>(pool: any, fn: Parameters<typeof withInvoiceTx<T>>[4]) => withInvoiceTx(pool, { schemaName: 'setes_x', institutionId: 98 }, REF, { label: 'teste', lock: async () => LOCKED as any }, fn)

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  attempt: 1, lifeEvent: 3, environment: 'H', authorizer: 'PR', accessKey: KEY('48213057'), dhEmission: '2026-11-24 13:15:30', digestValue: 'A'.repeat(27) + '=',
  receipt: null, protocol: null, dhRecbto: null, lastQueriedAt: null, nfeNotRegisteredAt: null, lastEvent: null, lastKind: null, lastCode: null, ...over,
})
const att = (over: Partial<Record<string, unknown>> = {}): AttemptRow => {
  const key = String(over.accessKey ?? KEY('48213057'))
  return { ...row(over), number: Number(key.slice(25, 34)), serie: Number(key.slice(22, 25)) } as unknown as AttemptRow
}
const code = (e: unknown): string | undefined => (e as { code?: string }).code
const thrown = (fn: () => unknown): { status?: number; code?: string; message: string } => {
  try { fn() } catch (e: any) { return { status: e.statusCode, code: e.code, message: String(e.message) } }
  return { message: '(não recusou)' }
}

describe('leituras da tentativa', () => {
  it('latestAttempt lê a última da vida, com a última voz e as colunas internas, e deriva o número e a série da chave (D-NE283)', async () => {
    const { calls, pool } = fakePool(() => [[row({ attempt: 2, lastEvent: 7, lastKind: 'R', lastCode: '703' })], []])
    const a = await latestAttempt(pool, REF, 3)
    expect(a).toMatchObject({ attempt: 2, number: 15, serie: 1, environment: 'H', authorizer: 'PR', lastKind: 'R', lastCode: '703', protocol: null })
    expect(calls[0].params).toEqual([98, 5001, 0, 3])
    expect(calls[0].sql).toMatch(/ORDER BY t\.attempt DESC LIMIT 1/)
    expect(calls[0].sql).toMatch(/e\.event = \(SELECT MAX\(x\.event\)/)
  })

  it('sem tentativa → null; getAttempt, findKeyHolder e attemptsOfLife filtram por nota e terminal', async () => {
    const { calls, pool } = fakePool(() => [[], []])
    expect(await latestAttempt(pool, REF, 3)).toBeNull()
    expect(await getAttempt(pool, REF, 4)).toBeNull()
    expect(await findKeyHolder(pool, REF, KEY('48213057'))).toBeNull()
    expect(await attemptsOfLife(pool, REF, 3)).toEqual([])
    for (const c of calls) { expect(c.sql).toContain("t.deleted = 'N'"); expect(c.params.slice(0, 3)).toEqual([98, 5001, 0]) }
  })

  it('recusa a linha com chave fora da forma ou ambiente fora de H/P (falha alto, nunca "sobe e descobre")', async () => {
    await expect(latestAttempt(fakePool(() => [[row({ accessKey: '123' })], []]).pool, REF, 3)).rejects.toThrow(/chave/)
    await expect(latestAttempt(fakePool(() => [[row({ environment: 'X' })], []]).pool, REF, 3)).rejects.toThrow(/ambiente/)
  })
})

describe('a barreira de nova tentativa e a política do número (D-NE7, D-NE257, D-NE282)', () => {
  it('sem tentativa na vida: pode abrir e o número é gerado', () => {
    expect(barrierOf(null)).toBeNull()
    expect(numberPolicy(null)).toEqual({ action: 'generate' })
  })

  it.each(['R', 'F'] as const)('fechada por %s sem registro do fisco: pode abrir e REAPROVEITA o mesmo número e a mesma série', kind => {
    const a = att({ accessKey: KEY('48213057', 15, 3), lastKind: kind, lastEvent: 2 })
    expect(barrierOf(a)).toBeNull()
    expect(numberPolicy(a)).toEqual({ action: 'reuse', number: 15, serie: 3 })
  })

  it('em voo (sem voz), em processamento (P): barreira 409 FISCAL_TRANSMISSION_IN_PROGRESS, nunca reaproveita', () => {
    for (const a of [att({ lastKind: null }), att({ lastKind: 'P', lastEvent: 1, lastCode: '103' })]) {
      expect(code(barrierOf(a))).toBe('FISCAL_TRANSMISSION_IN_PROGRESS')
      expect(thrown(() => numberPolicy(a)).code).toBe('FISCAL_TRANSMISSION_IN_PROGRESS')
    }
  })

  it('autorizada: 409 FISCAL_ALREADY_AUTHORIZED; denegada e cancelada (registradas): 409 — o número queimou, nunca reaproveita', () => {
    const authorized = att({ lastKind: 'A', lastEvent: 2, protocol: '141260000000001' })
    expect(code(barrierOf(authorized))).toBe('FISCAL_ALREADY_AUTHORIZED')
    for (const kind of ['D', 'C'] as const) {
      const a = att({ lastKind: kind, lastEvent: 3, protocol: '141260000000001' })
      expect(barrierOf(a)?.statusCode).toBe(409)
      expect(thrown(() => numberPolicy(a)).status).toBe(409)
    }
  })

  it('com o fato "não registrada" gravado (217 provado) a barreira SOLTA e o número é reaproveitado (D-NE292, RF-NFE-78); sem o fato, ou com recibo, voz ou protocolo, continua', () => {
    const a = att({ lastKind: null, nfeNotRegisteredAt: '2026-11-24 14:00:00' })
    expect(barrierOf(a)).toBeNull()
    expect(numberPolicy(a)).toEqual({ action: 'reuse', number: a.number, serie: a.serie })
    for (const over of [{ nfeNotRegisteredAt: null }, { receipt: '411000000000001' }, { lastKind: 'P' as const, lastEvent: 1 }, { protocol: '141260000000001' }]) {
      const b = att({ lastKind: null, nfeNotRegisteredAt: '2026-11-24 14:00:00', ...over })
      expect(barrierOf(b)?.statusCode).toBe(409)
      expect(thrown(() => numberPolicy(b)).status).toBe(409)
    }
  })
})
})

describe('drawCnf — o cNF sorteado e conferido', () => {
  it('8 dígitos com zeros à esquerda', () => { expect(drawCnf(15, () => 48213057)).toBe('48213057'); expect(drawCnf(15, () => 7)).toBe('00000007') })

  it('sorteia de novo quando cai em sequência proibida ou é igual ao número da nota', () => {
    const seq = [11111111, 12345678, 15, 90123456, 48213057]
    expect(drawCnf(15, () => seq.shift() as number)).toBe('48213057')
  })

  it('64 sorteios recusados = falha (nunca um cNF proibido)', () => {
    expect(thrown(() => drawCnf(15, () => 11111111)).message).toMatch(/64 sorteios/)
  })

  it('o sorteador de produção é o crypto (nunca Math.random)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'nfe', 'attempt.ts'), 'utf8')
    expect(src).toContain('crypto.randomInt')
    expect(src).not.toContain('Math.random')
  })
})

describe('insertAttempt — MAX+1 sob a trava, a chave nossa e a UNIQUE da chave', () => {
  const NEW = (makeKey: () => string) => ({ lifeEvent: 3, environment: 'H' as const, authorizer: 'PR', make: async () => ({ accessKey: makeKey(), digestValue: 'A'.repeat(27) + '=' }), dhEmissionUtc: '2026-11-24 13:15:30' })
  const dup = (name = 'uk_invoice_merchandise_transmission_key') => Object.assign(new Error(`Duplicate entry 'x' for key '${name}'`), { errno: 1062, code: 'ER_DUP_ENTRY' })

  it('grava a tentativa MAX+1 com a chave, o autorizador, o ambiente, o dhEmi em UTC e o digest; nasce sem voz', async () => {
    const { calls, pool } = fakePool(sql => (/SELECT COALESCE\(MAX/.test(sql) ? [[{ next: 3 }], []] : [{ affectedRows: 1 }, []]))
    const r = await tx(pool, itx => insertAttempt(itx, NEW(() => KEY('48213057')), 77))
    expect(r).toEqual({ attempt: 3, accessKey: KEY('48213057') })
    const ins = calls.find(c => /^INSERT INTO/.test(c.sql.trim()))!
    expect(ins.params).toEqual([98, 5001, 0, 3, 3, 'H', 'PR', KEY('48213057'), '2026-11-24 13:15:30', 'A'.repeat(27) + '=', 77])
    expect(ins.sql).not.toMatch(/receipt|protocol|dh_recbto|last_queried_at/)       // nasce em voo: o resto é write-once, depois
  })

  it('a colisão da UNIQUE da chave sorteia OUTRA chave (cNF novo) e segue; a PK ou outro 1062 sobe', async () => {
    let n = 0
    const keys = [KEY('11111112'), KEY('22222223')]
    const make = () => keys[n++]
    let first = true
    const { pool } = fakePool(sql => {
      if (/SELECT COALESCE\(MAX/.test(sql)) return [[{ next: 1 }], []]
      if (/^INSERT INTO/.test(sql.trim()) && first) { first = false; throw dup() }
      return [{ affectedRows: 1 }, []]
    })
    expect((await tx(pool, itx => insertAttempt(itx, NEW(make), null))).accessKey).toBe(KEY('22222223'))
    const other = fakePool(sql => { if (/^INSERT INTO/.test(sql.trim())) throw dup('PRIMARY'); return [[{ next: 1 }], []] })
    await expect(tx(other.pool, itx => insertAttempt(itx, NEW(() => KEY('48213057')), null))).rejects.toThrow(/Duplicate/)
  })

  it('5 colisões seguidas = 409 (nunca laço sem fim)', async () => {
    const { pool } = fakePool(sql => { if (/^INSERT INTO/.test(sql.trim())) throw dup(); return [[{ next: 1 }], []] })
    const err = await tx(pool, itx => insertAttempt(itx, NEW(() => KEY('48213057')), null)).catch(e => e)
    expect([err.statusCode, err.code]).toEqual([409, 'FISCAL_TRANSMISSION_IN_PROGRESS'])
  })

  it('recusa o INSERT depois do COMMIT (InvoiceTx fechada): a 2ª conferência logo antes de gravar', async () => {
    const { pool, calls } = fakePool(sql => (/SELECT COALESCE\(MAX/.test(sql) ? [[{ next: 1 }], []] : [{ affectedRows: 1 }, []]))
    let leaked: Promise<unknown> = Promise.resolve()
    await tx(pool, async itx => { leaked = insertAttempt(itx, NEW(() => KEY('48213057')), null).catch(e => e) })
    await leaked
    expect(calls.some(c => /^INSERT INTO/.test(c.sql.trim()))).toBe(false)
  })
})

describe('escritores write-once e a cota', () => {
  it('fillReceipt grava o nRec UMA vez (receipt IS NULL) e devolve false quando já estava', async () => {
    const ok = fakePool()
    expect(await tx(ok.pool, itx => fillReceipt(itx, 2, '411000000000001'))).toBe(true)
    const upd = ok.calls.find(c => /^UPDATE/.test(c.sql.trim()))!
    expect(upd.sql).toContain('receipt = ?')
    expect(upd.sql).toContain('AND receipt IS NULL')
    expect(upd.params).toEqual(['411000000000001', 98, 5001, 0, 2])
    expect(await tx(fakePool(() => [{ affectedRows: 0 }, []]).pool, itx => fillReceipt(itx, 2, '411000000000001'))).toBe(false)
  })

  it('fillAuthorityData grava protocolo e dhRecbto UMA vez (protocol IS NULL) — o registro pelo fisco (D-NE56)', async () => {
    const { calls, pool } = fakePool()
    expect(await tx(pool, itx => fillAuthorityData(itx, 2, { protocol: '141260000000001', dhRecbtoUtc: '2026-11-24 13:20:00' }))).toBe(true)
    const upd = calls.find(c => /^UPDATE/.test(c.sql.trim()))!
    expect(upd.sql).toContain('protocol = ?, dh_recbto = ?')
    expect(upd.sql).toContain('AND protocol IS NULL')
    expect(upd.params).toEqual(['141260000000001', '2026-11-24 13:20:00', 98, 5001, 0, 2])
  })

  it('entradas fora da forma são recusadas antes de qualquer SQL', async () => {
    const { calls, pool } = fakePool()
    await expect(tx(pool, async itx => fillReceipt(itx, 1, '41100000000000A'))).rejects.toThrow(/nRec/)
    await expect(tx(pool, async itx => fillAuthorityData(itx, 1, { protocol: '123', dhRecbtoUtc: null }))).rejects.toThrow(/nProt/)
    expect(calls.filter(c => /^UPDATE/.test(c.sql.trim()))).toEqual([])
  })

  it('touchQueriedAt só carimba a cota da tentativa', async () => {
    const { calls, pool } = fakePool()
    await touchQueriedAt(pool, REF, 2)
    expect(calls[0].sql).toMatch(/^UPDATE tb_invoice_merchandise_transmission SET last_queried_at = NOW\(\)/)
    expect(calls[0].params).toEqual([98, 5001, 0, 2])
  })

  it('nenhum UPDATE da família muda uma coluna IMUTÁVEL desde o INSERT', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'nfe', 'attempt.ts'), 'utf8')
    for (const col of ['access_key', 'life_event', 'environment', 'authorizer', 'dh_emission', 'digest_value']) {
      expect([col, new RegExp(`SET[^\`]*\\b${col}\\s*=`).test(src)]).toEqual([col, false])
    }
  })
})

describe('o número novo pela peça do núcleo', () => {
  it('generateNumber chama o nextInvoiceNumber do núcleo com a conexão da transação, o modelo 55 e a série; o 409 sobe cru', async () => {
    nextInvoiceNumber.mockResolvedValueOnce({ number: 1, environment: 'H' })
    const { pool } = fakePool()
    expect(await tx(pool, itx => generateNumber(itx, 98, 1))).toEqual({ number: 1, environment: 'H' })
    expect(nextInvoiceNumber.mock.calls[0][1]).toEqual({ institutionId: 98, model: '55', serie: 1 })
    nextInvoiceNumber.mockRejectedValueOnce(Object.assign(new Error('não aberta'), { statusCode: 409, code: 'FISCAL_NUMBER_SEQUENCE_NOT_OPEN' }))
    const err = await tx(pool, itx => generateNumber(itx, 98, 1)).catch(e => e)
    expect([err.statusCode, err.code]).toEqual([409, 'FISCAL_NUMBER_SEQUENCE_NOT_OPEN'])
  })
})

describe('o arquivo da tentativa é o ÚNICO escritor da tabela (junto do fato "não registrada")', () => {
  it('só voice-family, attempt e not-registered nomeiam a tabela das tentativas em src (fora dos testes)', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name)
      return e.isDirectory() ? (e.name === '__tests__' ? [] : walk(full)) : /\.ts$/.test(e.name) ? [full] : []
    })
    const SRC = path.resolve(__dirname, '..')
    const named = walk(SRC).filter(f => /\bMERCHANDISE_TRANSMISSION_TABLE\b|tb_invoice_merchandise_transmission\b(?!_event)/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f).replace(/\\/g, '/')).sort()
    expect(named).toEqual(['nfe/attempt.ts', 'nfe/not-registered.ts', 'nfe/voice-family.ts'])
  })
})
