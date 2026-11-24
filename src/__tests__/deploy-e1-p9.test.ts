/// <reference types="jest" />
// nfe-api DEPLOY.E1.P9.T1 (D-NE158, D-NE161, D-NE170, D-NE76, D-F237 — 2026-11-22; ficha
// `projetos/nfe-api/GERAL/ficha-deploy-e1-p9-p10-adocao-5-0-0-e-grant.md` no Vault): o núcleo 5.0.0 (janela da NE-6) entra com a nfse-api
// (o mesmo tgz). A família NF-e ENTROU no catálogo `VOICE_READINGS`, a conferência das views perdeu a lista padrão, a migration 007 do
// núcleo publica a habilitação por modelo (`vw_establishment_issuer`) e `fiscal-api/reading` ganhou a leitura da NF-e, as faixas retiradas
// e a habilitação. As peças têm a prova na suíte do NÚCLEO (FAMILIA.E5.P3); aqui se prova a LIGAÇÃO na nfe-api: o pacote instalado, o boot
// que segue passando a PRÓPRIA leitura (nunca o catálogo inteiro — D-NE76) e a superfície que o ERP vai ler.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import {
  CORE_MIGRATIONS_DIR, CORE_MIGRATIONS_PROJECT, VOICE_READINGS, MERCHANDISE_VOICE_READING, SERVICE_VOICE_READING, assertFamilyViewsReadable,
  countLiveTransmissions, branchOf,
} from 'fiscal-api'
import * as reading from 'fiscal-api/reading'
import { MIGRATION_SETS, NFE_MIGRATIONS_PROJECT } from '../migrations'

const SRC = path.resolve(__dirname, '..')
const PKG_DIR = path.dirname(require.resolve('fiscal-api/package.json'))

describe('núcleo 5.0.0 ou posterior — o pacote instalado (DEPLOY.E1.P9, D-F237)', () => {
  it('a versão instalada é a 5.0.0 ou posterior (a exata é a cerca do passo de adoção vigente) e o vendor é o do package.json', () => {
    const [major] = String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version).split('.').map(Number)
    expect(major >= 5).toBe(true)
    const own = JSON.parse(fs.readFileSync(path.resolve(SRC, '..', 'package.json'), 'utf8'))
    expect(own.dependencies['fiscal-api']).toMatch(/^file:vendor\/fiscal-api-5\.\d+\.\d+\.tgz$/)
    expect(fs.readdirSync(path.resolve(SRC, '..', 'vendor')).filter(f => f.endsWith('.tgz'))).toEqual([own.dependencies['fiscal-api'].replace('file:vendor/', '')])
  })

  it('a migration 007 do núcleo (view da habilitação — D-NE170) está no pacote, e o boot aplica o núcleo ANTES da família', () => {
    const core = fs.readdirSync(CORE_MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    expect(core.map(f => f.slice(0, 3)).slice(0, 7)).toEqual(['001', '002', '003', '004', '005', '006', '007'])   // as seguintes (008 …) são dos passos de adoção seguintes
    expect(core[6]).toBe('007_issuer_view.sql')
    const sql = fs.readFileSync(path.join(CORE_MIGRATIONS_DIR, core[6]), 'utf8')
    expect(sql).toContain(`CREATE OR REPLACE VIEW \`${reading.ISSUER_VIEW}\``)
    expect(MIGRATION_SETS.map(s => s.project)).toEqual([CORE_MIGRATIONS_PROJECT, NFE_MIGRATIONS_PROJECT])
    expect(MIGRATION_SETS[0].dir).toBe(CORE_MIGRATIONS_DIR)
  })
})

describe('a família NF-e no catálogo (D-NE158) e a conferência sem lista padrão', () => {
  it('o catálogo tem as duas famílias, e a da mercadoria é a leitura que a nfe-api confere no boot', () => {
    expect(Object.keys(VOICE_READINGS).sort()).toEqual(['merchandise', 'service'])
    expect(VOICE_READINGS.merchandise).toBe(MERCHANDISE_VOICE_READING)
    expect(VOICE_READINGS.service).toBe(SERVICE_VOICE_READING)
    expect(Object.isFrozen(VOICE_READINGS)).toBe(true)
  })

  it('sem a lista não compila e, em execução, falha alto — antes de qualquer consulta; a lista vazia também', async () => {
    const q = { query: jest.fn() }
    // @ts-expect-error D-NE158: a lista é obrigatória — quem chama diz o que confere
    await expect(assertFamilyViewsReadable(q, 'fiscal_api')).rejects.toThrow(/D-NE158/)
    await expect(assertFamilyViewsReadable(q, 'fiscal_api', [])).rejects.toThrow(/D-NE158/)
    expect(q.query).not.toHaveBeenCalled()
  })

  it('com a própria leitura, a conferência consulta SÓ a view de tentativas da NF-e', async () => {
    const q = { query: jest.fn(async () => [[], []]) }
    await assertFamilyViewsReadable(q as never, 'fiscal_api', [MERCHANDISE_VOICE_READING])
    const sqls = q.query.mock.calls.map(c => String((c as unknown[])[0]))
    expect(sqls.length).toBeGreaterThan(0)
    for (const sql of sqls) {
      expect(sql).toContain(MERCHANDISE_VOICE_READING.transmissionView)
      expect(sql).not.toContain(SERVICE_VOICE_READING.transmissionView)
    }
  })
})

describe('o emitter passa a contar as NF-e vivas (o núcleo percorre o catálogo) — a ligação na nfe-api', () => {
  // a peça tem a prova no núcleo (`ne2-merchandise`); aqui: o ramo do 55, que a borda desta API usa, agora LÊ a view de tentativas da NF-e
  // (antes do 5.0.0 contava 0 sem SQL) — o `PUT`/`DELETE` da habilitação do 55 e o `DELETE` do A1 podem responder 409 (contrato já previsto)
  it('o ramo do modelo 55 consulta a view da NF-e, nunca a da NFS-e, e devolve a contagem dela', async () => {
    const sqls: string[] = []
    const q = { query: jest.fn(async (sql: string) => { sqls.push(String(sql)); return [/COUNT\(/i.test(String(sql)) ? [{ n: 2 }] : [{ n: 1 }], []] }) }
    const live = await countLiveTransmissions(q as never, 98, { branches: [branchOf('55')], environment: 'H' })
    expect(live).toBe(2)
    const counts = sqls.filter(s => /COUNT\(/i.test(s))
    expect(counts.length).toBe(1)
    expect(counts[0]).toContain(MERCHANDISE_VOICE_READING.transmissionView)
    expect(sqls.join('\n')).not.toContain(SERVICE_VOICE_READING.transmissionView)
  })
})

describe('o boot segue passando a PRÓPRIA leitura (D-NE76) — cerca do server.ts', () => {
  // o código SEM comentários (pelo printer do TypeScript): uma chamada comentada não conta (molde da deploy-e1-p8)
  const raw = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8')
  const server = ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('server.ts', raw, ts.ScriptTarget.Latest, true))
  const at = (s: string) => { const i = server.indexOf(s); expect([s, i >= 0]).toEqual([s, true]); return i }

  it('a conferência da view da família roda com a lista de UMA leitura, depois das migrations e antes de ouvir a porta', () => {
    const call = at('await assertFamilyViewsReadable(ctx.pool, ctx.fiscalDb, [MERCHANDISE_VOICE_READING])')
    expect(call).toBeGreaterThan(at('await runMigrations('))
    expect(call).toBeLessThan(at('.listen('))
    expect(server.split('assertFamilyViewsReadable(').length - 1).toBe(1)     // uma chamada só (o import não tem parêntese)
  })

  // gate adversarial: a cerca por TEXTO deixava passar a chamada condicional, a chamada em função morta, o catálogo por arquivo auxiliar
  // e a leitura sombreada por reexportação. Por AST: as conferências são instruções `await` DIRETAS do corpo de `main`, e os nomes vêm
  // do import de 'fiscal-api' sem apelido
  const source = ts.createSourceFile('server.ts', raw, ts.ScriptTarget.Latest, true)
  const printer = ts.createPrinter({ removeComments: true })
  const text = (n: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, n, source).replace(/\s+/g, ' ')
  const main = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'main')
  const direct = (main?.body?.statements ?? []).map(text)

  it('as conferências do boot são instruções DIRETAS de `main` (sem `if`, sem função auxiliar), depois das migrations e antes de ouvir', () => {
    const pos = (stmt: string) => { const i = direct.indexOf(stmt); expect([stmt, i >= 0]).toEqual([stmt, true]); return i }
    const migrations = pos('const applied = await runMigrations(ctx.db, MIGRATION_SETS);')
    const family = pos('await assertFamilyViewsReadable(ctx.pool, ctx.fiscalDb, [MERCHANDISE_VOICE_READING]);')
    const ranges = pos('await assertWithdrawnRangesViewReadable(ctx.pool, ctx.fiscalDb);')
    const issuer = pos('await assertIssuerViewReadable(ctx.pool, ctx.fiscalDb);')     // D-NE170: a 3ª view concedida ao setes-api
    expect(Math.min(family, ranges, issuer)).toBeGreaterThan(migrations)
    const listen = direct.findIndex(s => s.includes('.listen('))
    expect(listen).toBeGreaterThan(Math.max(family, ranges, issuer))
  })

  it('os nomes da conferência vêm do import de `fiscal-api`, sem apelido, e `MIGRATION_SETS` do módulo de migrations daqui', () => {
    const imported = new Map<string, string>()      // nome local → `módulo:nome exportado`
    for (const s of source.statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue
      const named = s.importClause?.namedBindings
      if (named && ts.isNamedImports(named)) for (const el of named.elements) imported.set(el.name.text, `${s.moduleSpecifier.text}:${(el.propertyName ?? el.name).text}`)
    }
    for (const name of ['assertFamilyViewsReadable', 'MERCHANDISE_VOICE_READING', 'assertWithdrawnRangesViewReadable', 'assertIssuerViewReadable', 'runMigrations']) {
      expect([name, imported.get(name)]).toEqual([name, `fiscal-api:${name}`])
    }
    expect(imported.get('MIGRATION_SETS')).toBe('./migrations:MIGRATION_SETS')
  })

  it('o catálogo inteiro NUNCA entra no código da nfe-api: prenderia o boot às migrations da nfse-api', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(path.join(dir, e.name)) } else if (e.name.endsWith('.ts')) files.push(path.join(dir, e.name))
      }
    }
    walk(SRC)
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      const code = printer.printFile(ts.createSourceFile(rel, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true))
      // NFE.E6.P1.T3 (D-NE158): a única exceção é a CONFERÊNCIA de que a própria leitura está no catálogo, em `nfe/transmission.ts` — o catálogo nunca vai a
      // `assertFamilyViewsReadable` (a cerca logo abaixo o proíbe fora do `server.ts`, e o `server.ts` passa só a própria leitura)
      expect([rel, rel !== 'nfe/transmission.ts' && /\bVOICE_READINGS\b/.test(code)]).toEqual([rel, false])
      expect([rel, /\bSERVICE_VOICE_READING\b/.test(code)]).toEqual([rel, false])
      // a conferência das views da família só é chamada no boot
      expect([rel, /\bassertFamilyViewsReadable\b/.test(code) && rel !== 'server.ts']).toEqual([rel, false])
    }
  })
})

describe('a superfície de leitura do ERP — `fiscal-api/reading` (D-NE161, D-NE170)', () => {
  it('traz a leitura da NF-e, as faixas retiradas e a habilitação por modelo', () => {
    expect(reading.MERCHANDISE_VOICE_READING).toBe(MERCHANDISE_VOICE_READING)
    expect(reading.VOICE_READINGS).toBe(VOICE_READINGS)
    expect(reading.ISSUER_VIEW).toBe('vw_establishment_issuer')
    expect(reading.WITHDRAWN_RANGES_VIEW).toBe('vw_invoice_number_void')
    for (const fn of [reading.readWithdrawnRanges, reading.assertWithdrawnRangesViewReadable, reading.readIssuerView, reading.assertIssuerViewReadable]) {
      expect(typeof fn).toBe('function')
    }
  })

  it('o SQL cru fica FORA da superfície (D-NE66 (b)) — o leitor publicado já mapeia', () => {
    for (const name of ['withdrawnRangesSelect', 'withdrawnRangesQuery', 'issuerViewSelect', 'issuerViewQuery', 'familyViewSelect']) {
      expect([name, name in reading]).toEqual([name, false])
    }
  })
})
