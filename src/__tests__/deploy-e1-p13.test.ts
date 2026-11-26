/// <reference types="jest" />
// nfe-api DEPLOY.E1.P13.T1 (D-F237, D-F243, D-NE189, D-NE236 — 2026-11-26; ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-deploy-e1-p13-pacote-5-3-0.md` no
// Vault; gêmea: nfse-api 32cab45 `deploy-e1-p11.test.ts`): o núcleo 5.3.0 (fiscal-api:FAMILIA.E5.P7) traz a migration 009 (`tb_establishment_smtp_credential`,
// a senha da conta de e-mail do cliente, cifrada pelo cofre) e o cofre com DOIS donos (A1 e senha SMTP). Aqui se prova a LIGAÇÃO: o pacote, a sonda da 009 no
// boot (cerca pela árvore do TypeScript, com mutações em memória) e que a nfe-api ainda NÃO lê nem grava a credencial (é da NFE.E6.P4). A prova da chave com os
// dois donos está em `key-proof.test.ts`.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { CORE_MIGRATIONS_DIR } from 'fiscal-api'

const SRC = path.resolve(__dirname, '..')
const ROOT = path.resolve(SRC, '..')
const PKG_DIR = path.dirname(require.resolve('fiscal-api/package.json'))
const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => { visit(node); node.forEachChild(c => walk(c, visit)) }
const has = (node: ts.Node, test: (n: ts.Node) => boolean) => { let found = false; walk(node, n => { if (test(n)) found = true }); return found }
const isCall = (n: ts.Node, name: string): n is ts.CallExpression => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name
const isMethodCall = (n: ts.Node, name: string) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === name

describe('núcleo 5.3.0 — o pacote instalado (DEPLOY.E1.P13, D-F237)', () => {
  it('a versão instalada é a 5.3.0 ou posterior e o vendor é o do package.json', () => {
    const [major, minor] = String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version).split('.').map(Number)
    expect(major > 5 || (major === 5 && minor >= 3)).toBe(true)
    const own = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    expect(own.dependencies['fiscal-api']).toMatch(/^file:vendor\/fiscal-api-5\.\d+\.\d+\.tgz$/)
  })

  it('a migration 009 do núcleo está no pacote e cria `tb_establishment_smtp_credential`', () => {
    const file = fs.readdirSync(CORE_MIGRATIONS_DIR).filter(f => f.startsWith('009'))
    expect(file).toEqual(['009_establishment_smtp_credential.sql'])
    const sql = fs.readFileSync(path.join(CORE_MIGRATIONS_DIR, file[0]), 'utf8').replace(/--[^\n]*/g, '')
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `tb_establishment_smtp_credential`/)
  })
})

/** Onde está a sonda da 009 no `main` de um texto de `server.ts`. A regra inteira num lugar só (real e mutações). */
function smtpProbeFacts(source: string) {
  const sf = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
  const main = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'main')!
  const statements = [...main.body!.statements]
  const calls: ts.CallExpression[] = []
  walk(sf, n => { if (isCall(n, 'assertSmtpCredentialDomainsEnforced')) calls.push(n) })
  /** Instrução DIRETA de `main` que é EXATAMENTE `await assertSmtpCredentialDomainsEnforced(ctx.pool)` (sem `if`, `&&`, `try`, função). */
  const directIndex = calls.length === 1
    ? statements.findIndex(s => ts.isExpressionStatement(s) && ts.isAwaitExpression(s.expression) && s.expression.expression === calls[0])
    : -1
  const args = calls.length === 1 ? calls[0].arguments.map(a => a.getText(sf)) : []
  const at = (test: (n: ts.Node) => boolean) => statements.findIndex(s => has(s, test))
  const migrationsIndex = at(n => isCall(n, 'runMigrations'))
  const csrtIndex = at(n => isCall(n, 'assertRequiredProviderCodesPresent'))
  const sessionIndex = at(n => isMethodCall(n, 'assertSessionViewReadable'))
  const keyProofIndex = at(n => ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'KeyProof')
  const listenIndex = at(n => isMethodCall(n, 'listen'))
  const holds = calls.length === 1 && directIndex >= 0 && args.length === 1 && args[0] === 'ctx.pool' &&
    [migrationsIndex, csrtIndex, sessionIndex, keyProofIndex, listenIndex].every(i => i >= 0) &&
    migrationsIndex < directIndex && directIndex < csrtIndex && directIndex < sessionIndex && directIndex < keyProofIndex && keyProofIndex < listenIndex
  return { count: calls.length, directIndex, args, migrationsIndex, csrtIndex, sessionIndex, keyProofIndex, listenIndex, holds }
}

describe('DEPLOY.E1.P13 — a partida confere a sonda da 009 (cerca do `server.ts` pela árvore do TypeScript)', () => {
  const real = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8').replace(/\r\n/g, '\n')   // o checkout pode trazer CRLF: a cerca não depende disso
  const CALL = '  await assertSmtpCredentialDomainsEnforced(ctx.pool)\n'

  it('o `server.ts` chama `await assertSmtpCredentialDomainsEnforced(ctx.pool)` UMA vez, como instrução direta do `main`, depois do `runMigrations` e antes do CSRT, da sessão viva, da prova da chave e do `listen`', () => {
    const f = smtpProbeFacts(real)
    expect(f.count).toBe(1)
    expect(f.args).toEqual(['ctx.pool'])
    expect(f.migrationsIndex).toBeGreaterThanOrEqual(0)
    expect(f.directIndex).toBeGreaterThan(f.migrationsIndex)
    expect(f.csrtIndex).toBeGreaterThan(f.directIndex)
    expect(f.sessionIndex).toBeGreaterThan(f.directIndex)
    expect(f.keyProofIndex).toBeGreaterThan(f.directIndex)      // a prova da chave lê a tabela da 009: a sonda antes dela
    expect(f.listenIndex).toBeGreaterThan(f.keyProofIndex)
    expect(f.holds).toBe(true)
  })

  it('o nome vem do import de fiscal-api, sem apelido, e não tem sombra local', () => {
    const imp = /import \{([\s\S]*?)\} from 'fiscal-api'/.exec(real)
    expect(imp).not.toBeNull()
    const names = (imp as RegExpExecArray)[1].split(',').map(n => n.trim())
    expect(names).toContain('assertSmtpCredentialDomainsEnforced')
    expect(real).not.toMatch(/\b(?:const|let|var|function|class)\s+assertSmtpCredentialDomainsEnforced\b/)
    expect(real.match(/\bassertSmtpCredentialDomainsEnforced\b/g)?.length).toBe(2)       // o import e a chamada (o comentário não cita o nome)
  })

  it('a cerca não é enganada: cada mutação do `server.ts` (em memória) quebra a regra', () => {
    expect(real.split(CALL)).toHaveLength(2)
    const without = real.replace(CALL, '')
    const listenAt = without.indexOf('  createApp(ctx, keyProof).listen(')
    const listenEnd = without.indexOf('\n', listenAt) + 1
    expect(listenAt).toBeGreaterThan(0)
    const CSRT = '  await assertRequiredProviderCodesPresent(ctx.pool)\n'
    expect(without.split(CSRT)).toHaveLength(2)
    const mutations: Record<string, string> = {
      'sem a chamada': without,
      'chamada em comentário': real.replace(CALL, '  // await assertSmtpCredentialDomainsEnforced(ctx.pool)\n'),
      'sem await': real.replace(CALL, '  assertSmtpCredentialDomainsEnforced(ctx.pool)\n'),
      'depois do listen': without.slice(0, listenEnd) + CALL + without.slice(listenEnd),
      'antes das migrations': without.replace('  const applied = await runMigrations(', CALL + '  const applied = await runMigrations('),
      'depois do CSRT': without.replace(CSRT, CSRT + CALL),
      'depois da prova da chave': without.replace('  keyProof.start()\n', '  keyProof.start()\n' + CALL),
      'atrás de if (false)': real.replace(CALL, '  if (false) await assertSmtpCredentialDomainsEnforced(ctx.pool)\n'),
      'atrás de false &&': real.replace(CALL, '  false && await assertSmtpCredentialDomainsEnforced(ctx.pool)\n'),
      'dentro de função nunca chamada': real.replace(CALL, '  const later = async () => assertSmtpCredentialDomainsEnforced(ctx.pool)\n'),
      'com falha engolida': real.replace(CALL, '  try { await assertSmtpCredentialDomainsEnforced(ctx.pool) } catch { /* sobe assim */ }\n'),
      'outro pool': real.replace(CALL, '  await assertSmtpCredentialDomainsEnforced(ctx.db)\n'),
      'duas chamadas': real.replace(CALL, CALL + CALL),
    }
    for (const [what, source] of Object.entries(mutations)) {
      expect([what, source !== real]).toEqual([what, true])
      expect([what, smtpProbeFacts(source).holds]).toEqual([what, false])
    }
  })
})

describe('DEPLOY.E1.P13 — a nfe-api ainda não lê nem grava a credencial SMTP (é da NFE.E6.P4)', () => {
  // os nomes da peça `smtp-credential` do 5.3.0 (funções, repositório e o dono do cofre) e a tabela da 009
  const SMTP_NAMES = /\b(openSmtpCredential|storeSmtpCredential|clearSmtpCredential|smtpCredentialStatus|getSmtpCredential|saveSmtpCredential|eraseSmtpCredential|rewrapSmtpCredentialPassword|readSmtpPasswordSealedForUpdate|smtpCredentialKeyVersions|smtpCredentialsOutsideKeyVersion|sampleSmtpCredentialsPerKeyVersion|SMTP_CREDENTIAL_SEALED_STORE|tb_establishment_smtp_credential)\b/

  it('nenhum arquivo de código em `src/` (fora de `__tests__`) nem em `scripts/` usa a peça ou cita a tabela', () => {
    const users = (dir: string): string[] => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : users(full)
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name)) return []
      return SMTP_NAMES.test(fs.readFileSync(full, 'utf8')) ? [path.relative(ROOT, full)] : []
    })
    expect([...users(SRC), ...users(path.join(ROOT, 'scripts'))]).toEqual([])
  })

  it('o padrão reconhece cada nome (a cerca não é vazia)', () => {
    for (const name of ['openSmtpCredential', 'saveSmtpCredential', 'SMTP_CREDENTIAL_SEALED_STORE', 'tb_establishment_smtp_credential']) {
      expect([name, SMTP_NAMES.test(`x ${name}(`)]).toEqual([name, true])
    }
  })
})
