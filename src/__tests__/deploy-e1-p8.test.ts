/// <reference types="jest" />
// nfe-api DEPLOY.E1.P8.T1 (D-NE214, D-NE215, D-NE217, D-NE221, D-NE223, D-NE229, D-F237 — 2026-11-22; ficha
// `projetos/nfe-api/GERAL/ficha-deploy-e1-p8-adocao-pacote-4-1-0.md` no Vault): o núcleo 4.1.0 entra com a nfse-api (o mesmo tgz). O boot
// confere o RESPONSÁVEL TÉCNICO (`technicalResponsibleFromEnv`, no `contextFromEnv`) e a CONFIGURAÇÃO FISCAL POR UF (sondas da 006 +
// recusa sem o CSRT exigido) antes de ouvir a porta. As funções do núcleo têm a prova na suíte DELE (FAMILIA.E5.P4.T3/T4); aqui se prova
// a LIGAÇÃO na nfe-api e a superfície que o builder (NFE.E5.P3) vai usar.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import {
  CORE_MIGRATIONS_DIR, CORE_MIGRATIONS_PROJECT, TECHNICAL_RESPONSIBLE_ENV, isXsdTString, xmlElement, xmlGroup,
  fiscalCodeRequirementsOf, requiredFiscalCredentialsFor, assertFiscalCodeDomainsEnforced, assertRequiredProviderCodesPresent,
  FiscalCodeMissingError, technicalResponsibleFromEnv,
} from 'fiscal-api'
import { merchandiseInvoiceTotal, merchandiseTotalFormulaAt } from 'fiscal-api/merchandise-total'
import { contextFromEnv } from '../context'
import { MIGRATION_SETS, NFE_MIGRATIONS_PROJECT } from '../migrations'
import { FAKE_TECH, FAKE_TECH_ENV } from './technical-responsible-fake'

const SRC = path.resolve(__dirname, '..')
const PKG_DIR = path.dirname(require.resolve('fiscal-api/package.json'))

describe('núcleo 4.1.0 em diante — as peças da NE-4 no pacote instalado (DEPLOY.E1.P8, D-F237)', () => {
  // a versão EXATA instalada e a lista inteira das migrations do núcleo são da adoção vigente (`deploy-e1-p9.test.ts`); aqui fica o que a
  // P8 trouxe e não pode sumir numa versão seguinte
  it('o pacote instalado é o 4.1.0 ou posterior', () => {
    const [major, minor] = String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version).split('.').map(Number)
    expect(major > 4 || (major === 4 && minor >= 1)).toBe(true)
  })

  it('a migration 006 do núcleo (configuração fiscal por UF) está no pacote, e o boot aplica o núcleo ANTES da família', () => {
    const core = fs.readdirSync(CORE_MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    expect(core.slice(0, 6).map(f => f.slice(0, 3))).toEqual(['001', '002', '003', '004', '005', '006'])
    expect(core[5]).toBe('006_fiscal_code.sql')
    expect(MIGRATION_SETS.map(s => s.project)).toEqual([CORE_MIGRATIONS_PROJECT, NFE_MIGRATIONS_PROJECT])
    expect(MIGRATION_SETS[0].dir).toBe(CORE_MIGRATIONS_DIR)
  })

  it('a superfície que o builder vai usar existe: escritor de XML (D-NE214), fórmula do vNF (D-NE215), exigências e credenciais (D-NE221)', () => {
    expect(isXsdTString('Setes', 2, 60)).toBe(true)
    expect(isXsdTString(' x', 2, 60)).toBe(false)
    expect(xmlGroup('infRespTec', xmlElement('CNPJ', FAKE_TECH.cnpj))).toBe(`<infRespTec><CNPJ>${FAKE_TECH.cnpj}</CNPJ></infRespTec>`)
    expect(typeof merchandiseInvoiceTotal).toBe('function')
    expect(typeof merchandiseTotalFormulaAt).toBe('function')
    for (const fn of [fiscalCodeRequirementsOf, requiredFiscalCredentialsFor, assertFiscalCodeDomainsEnforced, assertRequiredProviderCodesPresent]) {
      expect(typeof fn).toBe('function')
    }
  })
})

describe('responsável técnico no boot (D-NE217/D-NE229)', () => {
  const base = { DB_HOST: 'x', DB_USER: 'x', DB_PASSWORD: 'x', FISCAL_DB_NAME: 'fiscal_api' }

  it('os nomes das variáveis são os do núcleo (os do .env.example)', () => {
    expect(Object.keys(FAKE_TECH_ENV).sort()).toEqual(Object.values(TECHNICAL_RESPONSIBLE_ENV).slice().sort())
    const example = fs.readFileSync(path.resolve(SRC, '..', '.env.example'), 'utf8')
    for (const name of Object.values(TECHNICAL_RESPONSIBLE_ENV)) expect([name, new RegExp(`^${name}=\r?$`, 'm').test(example)]).toEqual([name, true])
  })

  it('sem as variáveis o contexto NÃO se monta — o erro diz o NOME de cada uma, antes de qualquer outra conferência', () => {
    let msg = ''
    try { contextFromEnv(base as NodeJS.ProcessEnv, { pool: { query: jest.fn(), getConnection: jest.fn() } as any }) } catch (e) { msg = (e as Error).message }
    for (const name of Object.values(TECHNICAL_RESPONSIBLE_ENV)) expect(msg).toContain(`${name} ausente`)
  })

  it('valor fora da forma recusa (CNPJ com máscara, fone com traço) e o erro não ecoa o valor', () => {
    const env = { ...base, ...FAKE_TECH_ENV, FISCAL_TECH_RESPONSIBLE_CNPJ: '12.345.678/0001-95', FISCAL_TECH_RESPONSIBLE_PHONE: '41-3000-0000' }
    let msg = ''
    try { contextFromEnv(env as NodeJS.ProcessEnv, { pool: { query: jest.fn(), getConnection: jest.fn() } as any }) } catch (e) { msg = (e as Error).message }
    expect(msg).toMatch(/FISCAL_TECH_RESPONSIBLE_CNPJ fora da forma/)
    expect(msg).toMatch(/FISCAL_TECH_RESPONSIBLE_PHONE fora da forma/)
    expect(msg).not.toContain('12.345.678/0001-95')
    expect(msg).not.toContain('41-3000-0000')
  })

  it('com as variáveis certas o contexto leva o responsável técnico congelado, igual ao da peça do núcleo', () => {
    const env = { ...base, ...FAKE_TECH_ENV } as NodeJS.ProcessEnv
    expect(technicalResponsibleFromEnv(env)).toEqual(FAKE_TECH)
    // as outras conferências do contexto (CA da SEFAZ etc.) são de outras suítes: aqui basta o override do resto — o responsável vem do env
    const ctx = contextFromEnv(env, {
      pool: { query: jest.fn(), getConnection: jest.fn() } as any, serverCa: {} as any, keyring: {} as any, storage: {} as any, verifier: {} as any,
    })
    expect(ctx.technicalResponsible).toEqual(FAKE_TECH)
    expect(Object.isFrozen(ctx.technicalResponsible)).toBe(true)
  })
})

describe('configuração fiscal por UF no boot (D-NE221/D-NE223) — cerca do server.ts', () => {
  // o código SEM comentários (pelo printer do TypeScript): uma chamada comentada não conta (gates do P8)
  const raw = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8')
  const server = ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('server.ts', raw, ts.ScriptTarget.Latest, true))
  const at = (s: string) => { const i = server.indexOf(s); expect([s, i >= 0]).toEqual([s, true]); return i }

  it('as sondas da 006 e a recusa sem o CSRT exigido rodam DEPOIS das migrations e das sondas da família e ANTES de ouvir a porta', () => {
    const domains = at('await assertFiscalCodeDomainsEnforced(ctx.pool)')
    const required = at('await assertRequiredProviderCodesPresent(ctx.pool)')
    expect(domains).toBeGreaterThan(at('await runMigrations('))
    expect(domains).toBeGreaterThan(at('await assertWithdrawnRangesViewReadable('))
    expect(required).toBeGreaterThan(domains)
    expect(required).toBeLessThan(at('await access.assertSessionViewReadable(ctx.pool)'))
    expect(required).toBeLessThan(at('await keyProof.run()'))
    expect(required).toBeLessThan(at('.listen('))
    // ninguém engole a recusa: nenhum try/catch no corpo do boot antes de ouvir a porta (a recusa vai ao `main().catch` → saída 1)
    const body = server.slice(at('async function main()'), at('.listen('))
    expect(body).not.toMatch(/\bcatch\b|\btry\b/)
    expect(server).toMatch(/main\(\)\.catch\([\s\S]*process\.exit\(1\)/)
  })

  it('o log do responsável técnico não leva valor nenhum', () => {
    expect(server).toContain("logger.info('Responsável técnico (infRespTec — D-NE217): conferido')")
    expect(server).not.toMatch(/technicalResponsible\.(cnpj|contactName|email|phone)/)
    expect(server).not.toMatch(/logger\.\w+\([^;]*technicalResponsible/)
    expect(server).not.toMatch(/logger\.\w+\([^;]*\bctx\b(?!\.)/)          // nunca o contexto inteiro num log
  })

  it('a recusa do núcleo diz UF, tipo, modelo e ambiente (a mensagem que o passeio do boot espera)', () => {
    const err = new FiscalCodeMissingError([{ state: 'PR', type: 'CSRT', model: '55', environment: 'H', owner: 'provider' }])
    expect(err.message).toMatch(/CSRT/)
    expect(err.message).toMatch(/PR/)
    expect(err.message).toMatch(/55/)
    expect(err.message).toMatch(/ambiente H/)
  })
})
