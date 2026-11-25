/// <reference types="jest" />
// nfe-api DEPLOY.E1.P12.T1 (D-F237, D-NE41, D-NE111, D-NE235, D-NE291, D-NE292 — 2026-11-25; ficha
// `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-deploy-e1-p12-pacote-5-2-0.md` no Vault): o núcleo 5.2.0 entra com a nfse-api (o mesmo tgz). A trava de gravação única do
// `FsFiscalStorage` e a peça `notRegisteredProven` vivem no núcleo e têm a prova na suíte DELE (FAMILIA.E5.P6); aqui se prova a LIGAÇÃO: o pacote, o `warm()` no boot, na
// posição certa, e as duas cercas do 217 (a rota única e o escritor único do fato).
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import * as core from 'fiscal-api'
import { FiscalFileConflictError, FsFiscalStorage } from 'fiscal-api'

const SRC = path.resolve(__dirname, '..')
const PKG_DIR = path.dirname(require.resolve('fiscal-api/package.json'))

describe('núcleo 5.2.0 — o pacote instalado (DEPLOY.E1.P12, D-F237)', () => {
  it('a versão instalada é a 5.2.0 ou posterior e o vendor é o do package.json', () => {
    const [major, minor] = String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version).split('.').map(Number)
    expect(major > 5 || (major === 5 && minor >= 2)).toBe(true)
    const own = JSON.parse(fs.readFileSync(path.resolve(SRC, '..', 'package.json'), 'utf8'))
    expect(own.dependencies['fiscal-api']).toMatch(/^file:vendor\/fiscal-api-5\.\d+\.\d+\.tgz$/)
  })

  it('o barrel exporta a peça do 217, o erro de conflito e o `warm` do armazenamento', () => {
    expect(typeof core.notRegisteredProven).toBe('function')
    expect(new FiscalFileConflictError('x').code).toBe('FISCAL_FILE_CONFLICT')
    expect(typeof FsFiscalStorage.prototype.warm).toBe('function')
  })
})

describe('o `warm()` no boot — cerca do server.ts (DEPLOY.E1.P12)', () => {
  const raw = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8')
  const sf = ts.createSourceFile('server.ts', raw, ts.ScriptTarget.Latest, true)
  const warmCalls: ts.CallExpression[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.questionDotToken !== undefined && /\.warm\?\.$|\bwarm$/.test(n.expression.getText(sf).replace(/\?\.\s*$/, '')) && n.expression.getText(sf) === 'ctx.storage.warm') warmCalls.push(n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  const position = (needle: string): number => { const i = raw.indexOf(needle); expect([needle, i >= 0]).toEqual([needle, true]); return i }

  it('a chamada opcional `ctx.storage.warm?.()` existe UMA vez, depois das migrations e antes da conferência dos códigos fiscais, da sonda do número e da porta', () => {
    expect(warmCalls).toHaveLength(1)
    const call = warmCalls[0].getStart(sf)
    expect(call).toBeGreaterThan(position('await runMigrations('))
    expect(call).toBeLessThan(position('await assertFiscalCodeDomainsEnforced(ctx.pool)'))
    expect(call).toBeLessThan(position('await assertNumberSequenceDomainsEnforced(ctx.pool)'))
    expect(call).toBeLessThan(position('.listen('))
  })

  it('ninguém engole a recusa do `warm`: não há try/catch no corpo do boot até ouvir a porta', () => {
    const body = raw.slice(position('async function main()'), position('.listen('))
    expect(body.replace(/\/\/[^\n]*/g, '')).not.toMatch(/\bcatch\b|\btry\b/)
  })
})

describe('as cercas do 217 (RF-NFE-72)', () => {
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : files(full)
    return /\.(ts|js|mjs)$/.test(e.name) ? [full] : []
  })
  const code = (file: string): string => ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true))

  it("só `reconfirmNotRegistered` (reconcile.ts) declara `route: 'reconfirm'` para a peça — o refresh nunca", () => {
    const hits = files(SRC).filter(f => /route:\s*'reconfirm'/.test(code(f))).map(f => path.relative(SRC, f))
    expect(hits).toEqual([path.join('nfe', 'reconcile.ts')])
    const reconcile = code(path.join(SRC, 'nfe', 'reconcile.ts'))
    const fn = reconcile.slice(reconcile.indexOf('async function reconfirmNotRegistered('))
    expect(fn).toMatch(/route:\s*'reconfirm'/)
    expect(reconcile.slice(0, reconcile.indexOf('async function reconfirmNotRegistered(')).match(/route:\s*'reconfirm'/)).toBeNull()
    expect(files(SRC).filter(f => /route:\s*'(refresh|manual)'/.test(code(f)))).toEqual([])
  })

  it('só `recordNfeNotRegistered` atribui a coluna do fato, e só `reconfirmNotRegistered` o chama', () => {
    const writers = files(SRC).filter(f => /nfe_not_registered_at\s*=/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(SRC, f))
    expect(writers).toEqual([path.join('nfe', 'not-registered.ts')])
    const callers = files(SRC).filter(f => /\brecordNfeNotRegistered\s*\(/.test(code(f)) && !f.endsWith(path.join('nfe', 'not-registered.ts'))).map(f => path.relative(SRC, f))
    expect(callers).toEqual([path.join('nfe', 'reconcile.ts')])
  })

  it('o arquivo fiscal só é gravado pelo `save` do núcleo (gravação única): nenhum `find` antes do `save` e nenhum `writeFile` fiscal fora dele', () => {
    const t = code(path.join(SRC, 'nfe', 'transmission.ts'))
    const r = code(path.join(SRC, 'nfe', 'reconcile.ts'))
    expect(t).not.toMatch(/storage\.find\(/)
    expect(r.match(/storage\.find\(/g)?.length).toBe(1)                                      // só `buildProc` LÊ o `-nfe.xml` guardado para montar o procNFe
    expect(`${t}\n${r}`).not.toMatch(/\bwriteFile(Sync)?\b/)
    // NFE.E6.P2: os módulos novos que gravam arquivo fiscal também só gravam pelo `save` do núcleo (gravação única) — nunca `writeFile`
    for (const f of ['cancellation.ts', 'void-range.ts', 'refresh-all.ts', 'proc-evento.ts']) {
      const file = path.join(SRC, 'nfe', f)
      if (fs.existsSync(file)) expect([f, /\bwriteFile(Sync)?\b/.test(code(file))]).toEqual([f, false])
    }
  })
})
