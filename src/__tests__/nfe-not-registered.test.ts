/// <reference types="jest" />
/**
 * NFE.E6.P1 mudança 4 (ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-4; D-NE111, D-NE235): o fato "o fisco não registrou" — migration 002, o escritor
 * write-once e a sonda do boot. O banco é um `Queryable` falso; o motor real só no passeio do dev (com o "vai" do Valdo).
 */
import fs from 'fs'
import path from 'path'
import { invoiceRef, splitStatements } from 'fiscal-api'
import { assertNfeNotRegisteredColumn, recordNfeNotRegistered } from '../nfe/not-registered'

const REF = invoiceRef(98, 5001, 7)
const SRC = path.resolve(__dirname, '..')
const SQL_FILE = path.join(SRC, 'migrations', 'sql', '002_nfe_reconfirm.sql')

const fake = (reply: unknown) => {
  const calls: { sql: string; params: unknown[] }[] = []
  return { calls, async query(sql: string, params: unknown[] = []): Promise<[any, any]> { calls.push({ sql, params }); return [reply, []] } }
}

describe('a migration 002', () => {
  const raw = fs.readFileSync(SQL_FILE, 'utf8')
  const sql = raw.replace(/--[^\n]*/g, '')

  it('é UMA instrução: ADD COLUMN IF NOT EXISTS da coluna DATETIME nula, na tabela das tentativas', () => {
    const st = splitStatements(raw)
    expect(st).toHaveLength(1)
    expect(sql).toMatch(/ALTER TABLE `tb_invoice_merchandise_transmission`\s+ADD COLUMN IF NOT EXISTS `nfe_not_registered_at` DATETIME DEFAULT NULL/)
    expect(sql).not.toMatch(/DROP|UPDATE|DELETE|CREATE/i)
  })

  it('não toca a view publicada nem cria voz: a coluna fica fora de qualquer view e da lista de escrita da voz', () => {
    const baseline = fs.readFileSync(path.join(SRC, 'migrations', 'sql', '001_nfe_baseline.sql'), 'utf8')
    expect(baseline).not.toContain('nfe_not_registered_at')
    expect(sql).not.toMatch(/VIEW/i)
  })

  it('o texto do COMMENT não tem `--` nem `;` (o runner tira comentários de linha e corta no `;`)', () => {
    const comments = [...sql.matchAll(/COMMENT '([^']*)'/g)].map(m => m[1])
    expect(comments).toHaveLength(1)
    for (const c of comments) { expect(c).not.toContain('--'); expect(c).not.toContain(';') }
  })
})

describe('recordNfeNotRegistered — write-once e "a última voz ainda é a que a pergunta viu" na mesma instrução', () => {
  it('grava quando o UPDATE acerta uma linha; a instrução é write-once, escopada pela tentativa e não deixa voz nova passar', async () => {
    const db = fake({ affectedRows: 1 })
    expect(await recordNfeNotRegistered(db, REF, 2, 5)).toBe(true)
    const { sql, params } = db.calls[0]
    expect(sql).toContain('nfe_not_registered_at IS NULL')
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM tb_invoice_merchandise_transmission_event e/)
    expect(sql).toMatch(/e\.event > \?/)
    expect(sql).toContain("deleted = 'N'")
    expect(params).toEqual([98, 5001, 7, 2, 98, 5001, 7, 2, 5])
    expect(sql).not.toMatch(/last_queried_at|digest_value|protocol|receipt/)         // nenhuma outra coluna, nunca a cota
  })

  it('devolve false quando já estava gravado, quando entrou voz nova ou quando a tentativa não existe (0 linhas)', async () => {
    expect(await recordNfeNotRegistered(fake({ affectedRows: 0 }), REF, 1, 0)).toBe(false)
    expect(await recordNfeNotRegistered(fake(undefined), REF, 1, 0)).toBe(false)
  })

  it('tentativa e evento visto têm de ser inteiros (nunca SQL com parâmetro torto)', async () => {
    for (const [attempt, seen] of [[0, 0], [1.5, 0], [1, -1], [1, 0.5], [NaN, 0]] as const) {
      await expect(recordNfeNotRegistered(fake({ affectedRows: 1 }), REF, attempt, seen)).rejects.toThrow(/inteiros/)
    }
  })

  it('é o ÚNICO escritor da coluna: nenhum outro arquivo de src (fora dos testes) a nomeia', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name)
      return e.isDirectory() ? (e.name === '__tests__' ? [] : walk(full)) : /\.(ts|sql)$/.test(e.name) ? [full] : []
    })
    const named = walk(SRC).filter(f => fs.readFileSync(f, 'utf8').includes('nfe_not_registered_at')).map(f => path.relative(SRC, f).replace(/\\/g, '/')).sort()
    expect(named).toEqual(['migrations/sql/002_nfe_reconfirm.sql', 'nfe/not-registered.ts'])
  })
})

describe('assertNfeNotRegisteredColumn — a sonda do boot', () => {
  it('passa com a coluna DATETIME que aceita NULL', async () => {
    await expect(assertNfeNotRegisteredColumn(fake([{ type: 'datetime', nullable: 'YES' }]))).resolves.toBeUndefined()
  })

  it('falha ALTO sem a coluna, com tipo diferente ou NOT NULL, dizendo o que fazer', async () => {
    for (const rows of [[], [{ type: 'varchar', nullable: 'YES' }], [{ type: 'datetime', nullable: 'NO' }], undefined]) {
      await expect(assertNfeNotRegisteredColumn(fake(rows))).rejects.toThrow(/db:migrate/)
    }
  })

  it('o boot chama a sonda (server.ts), depois das migrations', () => {
    const server = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
    expect(server).toContain('await assertNfeNotRegisteredColumn(ctx.pool)')
    expect(server.indexOf('await assertNfeNotRegisteredColumn(ctx.pool)')).toBeGreaterThan(server.indexOf('await runMigrations('))
    expect(server.indexOf('await assertNfeNotRegisteredColumn(ctx.pool)')).toBeLessThan(server.indexOf('.listen('))
  })
})
