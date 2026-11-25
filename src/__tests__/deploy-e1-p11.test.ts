/// <reference types="jest" />
// nfe-api DEPLOY.E1.P11.T1 (D-NE255, D-NE257, D-NE265, D-F237 — 2026-11-24; ficha
// `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-deploy-e1-p11-pacote-5-1-0.md` no Vault): o núcleo 5.1.0 entrou com a nfse-api (o mesmo tgz; o 5.2.0 veio na DEPLOY.E1.P12). O último número da NF-e
// (`tb_fiscal_number_sequence`, migration 008) e as peças que o geram vivem no núcleo e têm a prova na suíte DELE (FAMILIA.E5.P5); aqui se prova a LIGAÇÃO: o pacote
// instalado, a migration 008 que o boot aplica e a sonda dos domínios no boot, na posição certa. Esta adoção NÃO gera número, NÃO abre sequência e NÃO cria rota.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import * as core from 'fiscal-api'
import { CORE_MIGRATIONS_DIR } from 'fiscal-api'

const SRC = path.resolve(__dirname, '..')
const PKG_DIR = path.dirname(require.resolve('fiscal-api/package.json'))

describe('núcleo 5.1.0 ou posterior — o pacote instalado (DEPLOY.E1.P11, D-F237)', () => {
  it('a versão instalada é a 5.1.0 ou posterior e o vendor é o do package.json', () => {
    const [major, minor] = String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version).split('.').map(Number)
    expect(major > 5 || (major === 5 && minor >= 1)).toBe(true)
    const own = JSON.parse(fs.readFileSync(path.resolve(SRC, '..', 'package.json'), 'utf8'))
    expect(own.dependencies['fiscal-api']).toMatch(/^file:vendor\/fiscal-api-5\.\d+\.\d+\.tgz$/)
  })

  it('o barrel exporta as quatro peças do último número, e nenhuma delas é chamada fora do boot nesta adoção', () => {
    for (const name of ['nextInvoiceNumber', 'lockNumberSequence', 'openNumberSequence', 'assertNumberSequenceDomainsEnforced']) {
      expect([name, typeof (core as Record<string, unknown>)[name]]).toEqual([name, 'function'])
    }
    // varre `src/` (menos o `src/__tests__` da raiz) e `scripts/`, em todas as extensões de código: gerar e abrir número é da NFE.E6.P1, aqui só a sonda.
    // Limite aceito (gate adversarial): acesso por elemento ao namespace do pacote (`core['next' + 'InvoiceNumber']`) não é visto por texto.
    // NFE.E6.P1 (mudança 6): `src/nfe/attempt.ts` passa a ser o ÚNICO que chama `nextInvoiceNumber` (o número gerado na transmissão — D-NE257); `lockNumberSequence` e
    // `openNumberSequence` seguem em lugar nenhum (a abertura da produção é do Valdo — D-NE265)
    const ATTEMPT = path.join('nfe', 'attempt.ts')
    // NFE.E6.P2 (T2): `src/nfe/void-range.ts` é o ÚNICO que chama `lockNumberSequence` (a trava da inutilização — D-NE263); `nextInvoiceNumber` e `openNumberSequence` seguem fora dele
    const VOID = path.join('nfe', 'void-range.ts')
    const callers = (dir: string, skip: string | null): string[] => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return full === skip || e.name === 'node_modules' ? [] : callers(full, skip)
      if (!/\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name)) return []
      const text = fs.readFileSync(full, 'utf8')
      const rel = path.relative(SRC, full)
      const names = rel === ATTEMPT ? /\b(lockNumberSequence|openNumberSequence)\b/ : rel === VOID ? /\b(nextInvoiceNumber|openNumberSequence)\b/ : /\b(nextInvoiceNumber|lockNumberSequence|openNumberSequence)\b/
      return names.test(text) ? [path.relative(SRC, full)] : []
    })
    expect([...callers(SRC, path.join(SRC, '__tests__')), ...callers(path.resolve(SRC, '..', 'scripts'), null)]).toEqual([])
  })

  it('a migration 008 do núcleo está no pacote com a tabela, a chave e as colunas decididas', () => {
    const file = fs.readdirSync(CORE_MIGRATIONS_DIR).filter(f => f.startsWith('008'))
    expect(file).toEqual(['008_fiscal_number_sequence.sql'])
    const sql = fs.readFileSync(path.join(CORE_MIGRATIONS_DIR, file[0]), 'utf8').replace(/--[^\n]*/g, '')
    const table = /CREATE TABLE[^`]*`tb_fiscal_number_sequence`\s*\(([\s\S]*?)\)\s*ENGINE/i.exec(sql)
    expect(table).not.toBeNull()
    const columns = [...(table as RegExpExecArray)[1].matchAll(/^\s*`(\w+)`\s/gm)].map(m => m[1])
    expect(columns).toEqual(['tb_institution_id', 'model', 'serie', 'environment', 'last_number', 'tb_user_id', 'created_at', 'updated_at', 'deleted'])
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*`tb_institution_id`\s*,\s*`model`\s*,\s*`serie`\s*,\s*`environment`\s*\)/)
  })
})

describe('a sonda do último número no boot — cerca do server.ts (DEPLOY.E1.P11)', () => {
  // o código SEM comentários (pelo printer do TypeScript): uma chamada comentada não conta
  const raw = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8')
  const server = ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('server.ts', raw, ts.ScriptTarget.Latest, true))
  const at = (s: string): number => { const i = server.indexOf(s); expect([s, i >= 0]).toEqual([s, true]); return i }
  const CALL = 'await assertNumberSequenceDomainsEnforced(ctx.pool)'

  it('a chamada existe uma vez, com await, depois das migrations e da sonda dos códigos fiscais e antes da conferência do CSRT, da sessão e da porta', () => {
    expect(server.split('assertNumberSequenceDomainsEnforced(').length - 1).toBe(1)
    const call = at(CALL)
    expect(call).toBeGreaterThan(at('await runMigrations('))
    expect(call).toBeGreaterThan(at('await assertFiscalCodeDomainsEnforced(ctx.pool)'))
    expect(call).toBeLessThan(at('await assertRequiredProviderCodesPresent(ctx.pool)'))
    expect(call).toBeLessThan(at('await access.assertSessionViewReadable(ctx.pool)'))
    expect(call).toBeLessThan(at('await keyProof.run()'))
    expect(call).toBeLessThan(at('.listen('))
  })

  it('é incondicional e ninguém engole a recusa: a linha inteira é a chamada, entre as duas vizinhas, e não há try/catch no corpo do boot até ouvir a porta', () => {
    const lines = server.split('\n').map(l => l.trim())
    expect(lines.filter(l => l.includes('assertNumberSequenceDomainsEnforced('))).toEqual([`${CALL};`])
    const body = server.slice(at('async function main()'), at('.listen('))
    expect(body).not.toMatch(/\bcatch\b|\btry\b/)
    // vizinhança exata: nada entre a sonda dos códigos, a nova e a conferência do CSRT (um `if` ou bloco em volta quebraria isto)
    const k = lines.indexOf(`${CALL};`)
    expect([lines[k - 1], lines[k + 1]]).toEqual(['await assertFiscalCodeDomainsEnforced(ctx.pool);', 'await assertRequiredProviderCodesPresent(ctx.pool);'])
  })

  it('o nome tem UMA só declaração (o import): nenhuma sombra local no server.ts', () => {
    expect(server).not.toMatch(/\b(?:const|let|var|function|class)\s+assertNumberSequenceDomainsEnforced\b/)
    expect(server).not.toMatch(/\bassertNumberSequenceDomainsEnforced\s*[:=]/)
    expect(server.match(/\bassertNumberSequenceDomainsEnforced\b/g)?.length).toBe(2)       // o import e a chamada
  })

  it('o nome vem do import de fiscal-api, sem apelido', () => {
    const imp = /import \{([\s\S]*?)\} from 'fiscal-api'/.exec(raw)
    expect(imp).not.toBeNull()
    const names = (imp as RegExpExecArray)[1].split(',').map(n => n.trim())
    expect(names).toContain('assertNumberSequenceDomainsEnforced')
    expect(names.filter(n => n.includes('assertNumberSequenceDomainsEnforced') && n.includes(' as '))).toEqual([])
  })
})
