/// <reference types="jest" />
// nfe-api DEPLOY.E1.P13.T1 (D-F237, D-F243, D-NE189, D-NE236 — 2026-11-26; ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-deploy-e1-p13-pacote-5-3-0.md` no
// Vault; gêmea: nfse-api 32cab45 `deploy-e1-p11.test.ts`): o núcleo 5.3.0 (fiscal-api:FAMILIA.E5.P7) traz a migration 009 (`tb_establishment_smtp_credential`,
// a senha da conta de e-mail do cliente, cifrada pelo cofre) e o cofre com DOIS donos (A1 e senha SMTP). Aqui se prova a LIGAÇÃO: o pacote, a sonda da 009 no
// boot (cerca pela árvore do TypeScript, com mutações em memória) e que a nfe-api ainda NÃO lê nem grava a credencial (é da NFE.E6.P4). A prova da chave com os
// dois donos está em `key-proof.test.ts`.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import * as core from 'fiscal-api'
import { CORE_MIGRATIONS_DIR } from 'fiscal-api'

const SRC = path.resolve(__dirname, '..')
const ROOT = path.resolve(SRC, '..')
const PKG_DIR = path.dirname(require.resolve('fiscal-api/package.json'))
const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => { visit(node); node.forEachChild(c => walk(c, visit)) }
const has = (node: ts.Node, test: (n: ts.Node) => boolean) => { let found = false; walk(node, n => { if (test(n)) found = true }); return found }
const isCall = (n: ts.Node, name: string): n is ts.CallExpression => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name
const isMethodCall = (n: ts.Node, name: string) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === name
/** `x.listen(…)` ou `x['listen'](…)`. */
const isListen = (n: ts.Node) => isMethodCall(n, 'listen') || (ts.isCallExpression(n) && ts.isElementAccessExpression(n.expression) &&
  ts.isStringLiteralLike(n.expression.argumentExpression) && n.expression.argumentExpression.text === 'listen')
const isProcessExit = (n: ts.Node) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'exit' &&
  ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'process'
/** Como `has`, sem descer em função aninhada (o `return` de um callback não sai do `main`). */
const hasOutsideFunctions = (node: ts.Node, test: (n: ts.Node) => boolean): boolean => {
  let found = false
  const go = (n: ts.Node): void => { if (found) return; if (test(n)) { found = true; return } if (ts.isFunctionLike(n)) return; n.forEachChild(go) }
  go(node)
  return found
}

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
  const listenIndex = at(isListen)
  // gate adversarial: o arquivo ouve a porta UMA vez, dentro do `main` (também por elemento, `x['listen']`), e o `main` não tem saída antecipada
  // (return, throw ou process.exit) — senão um `if (…) return outraPartida()` sobe o serviço sem a sonda com as posições todas certas
  let listenCalls = 0
  walk(sf, n => { if (isListen(n)) listenCalls++ })
  const earlyExit = statements.some(s => hasOutsideFunctions(s, n => ts.isReturnStatement(n) || ts.isThrowStatement(n) || isProcessExit(n)))
  const holds = calls.length === 1 && directIndex >= 0 && args.length === 1 && args[0] === 'ctx.pool' &&
    [migrationsIndex, csrtIndex, sessionIndex, keyProofIndex, listenIndex].every(i => i >= 0) && listenCalls === 1 && !earlyExit &&
    migrationsIndex < directIndex && directIndex < csrtIndex && directIndex < sessionIndex && directIndex < keyProofIndex && keyProofIndex < listenIndex
  return { count: calls.length, directIndex, args, migrationsIndex, csrtIndex, sessionIndex, keyProofIndex, listenIndex, listenCalls, earlyExit, holds }
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
      // gate adversarial (MEDIUM 1): outra partida antes da sonda, por retorno antecipado, com `listen` por elemento
      'retorno antecipado para outra partida': real
        .replace('async function main', "async function devMain() { const c = contextFromEnv(); const k = new KeyProof(c); await k.run(); createApp(c, k)['listen'](3003) }\nasync function main")
        .replace('  const applied = await runMigrations(', "  if (process.env.NFE_FAST_BOOT === '1') return devMain()\n  const applied = await runMigrations("),
      'throw antecipado': real.replace('  const applied = await runMigrations(', "  if (process.env.X === '1') throw new Error('x')\n  const applied = await runMigrations("),
      'process.exit antecipado': real.replace('  const applied = await runMigrations(', "  if (process.env.X === '1') process.exit(0)\n  const applied = await runMigrations("),
      'listen por elemento fora do main': real + "\nfunction other(app: any) { app['listen'](1) }\n",
    }
    for (const [what, source] of Object.entries(mutations)) {
      expect([what, source !== real]).toEqual([what, true])
      expect([what, smtpProbeFacts(source).holds]).toEqual([what, false])
    }
  })
})

describe('DEPLOY.E1.P13 → NFE.E6.P4 — só DOIS arquivos nomeados usam a credencial SMTP, cada um só as peças dele', () => {
  // Gate adversarial (MEDIUM 2): a lista sai do PACOTE INSTALADO — todo export com "smtp" no nome (menos a sonda do boot) entra sozinho, mais o acesso
  // genérico ao cofre (`SEALED_STORES` e os donos, que abrem qualquer segredo) e a rotação (que é da nfse-api); mais a tabela da 009 e os métodos do
  // dono do cofre (`.readSealedForUpdate(`, `.rewrap(`). Limite aceito (como na P11): acesso por elemento montado (`core['SEALED' + '_STORES']`) não é visto por texto.
  const ALLOWED = new Set(['assertSmtpCredentialDomainsEnforced'])
  const VAULT = ['SEALED_STORES', 'CERTIFICATE_SEALED_STORE', 'rotateStoredKeys', 'storedSecretsOutsideKeyVersion', 'StoredKeyRotationAborted', 'rotateCertificateKeys', 'KeyRotationAborted']
  const NAMES = [...Object.keys(core).filter(n => /smtp/i.test(n) && !ALLOWED.has(n)), ...VAULT]
  const FORBIDDEN = new RegExp(`\\b(${[...NAMES, 'tb_establishment_smtp_credential'].join('|')})\\b|\\.(readSealedForUpdate|rewrap)\\s*\\(`)
  const TESTS_DIR = path.join(SRC, '__tests__')

  // NFE.E6.P4 (mudança 6): o cadastro (rota do emitente) GRAVA, LÊ a situação e APAGA; o envio ABRE a senha para UM e-mail. Cada arquivo nomeado ganha SÓ as peças dele — o resto da lista
  // (o cofre, a rotação, a cifra, a tabela, os métodos do dono do cofre) segue proibido em TODO arquivo, inclusive nesses dois.
  const ALLOWED_USERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    'src/modules/emitter/smtp-credential.service.ts': ['storeSmtpCredential', 'smtpCredentialStatus', 'clearSmtpCredential'],
    'src/mail/client-mailer.ts': ['openSmtpCredential'],
  })
  const forbiddenFor = (rel: string): RegExp => {
    const mine = new Set(ALLOWED_USERS[rel] ?? [])
    return new RegExp(`\\b(${[...NAMES.filter(n => !mine.has(n)), 'tb_establishment_smtp_credential'].join('|')})\\b|\\.(readSealedForUpdate|rewrap)\\s*\\(`)
  }
  const usersOf = (dir: string): string[] => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return full === TESTS_DIR || e.name === 'node_modules' ? [] : usersOf(full)
    if (!/\.(ts|tsx|mts|cts|js|mjs|cjs|sql)$/.test(e.name)) return []
    const rel = path.relative(ROOT, full).split(path.sep).join('/')
    return forbiddenFor(rel).test(fs.readFileSync(full, 'utf8')) ? [rel] : []
  })

  it('nenhum arquivo de código ou SQL em `src/` (fora de `src/__tests__`) nem em `scripts/` usa a peça, o cofre ou cita a tabela — salvo os dois nomeados, cada um só nas peças dele', () => {
    expect([...usersOf(SRC), ...usersOf(path.join(ROOT, 'scripts'))]).toEqual([])
  })

  it('os dois arquivos nomeados existem (a exceção não é letra morta) e cada um usa a peça dele', () => {
    for (const [rel, names] of Object.entries(ALLOWED_USERS)) {
      const full = path.join(ROOT, rel)
      expect([rel, fs.existsSync(full)]).toEqual([rel, true])
      const text = fs.readFileSync(full, 'utf8')
      for (const n of names) expect([rel, n, new RegExp(`\\b${n}\\b`).test(text)]).toEqual([rel, n, true])
    }
  })

  it('a exceção é estreita: o arquivo nomeado NÃO pode abrir a senha de outra forma (o mutante cai), e o outro nomeado não usa a peça do vizinho', () => {
    const mailer = forbiddenFor('src/mail/client-mailer.ts')
    expect(mailer.test('x openSmtpCredential(')).toBe(false)                                  // a peça dele
    for (const text of ['storeSmtpCredential(', 'clearSmtpCredential(', 'SEALED_STORES.find(', 'store.readSealedForUpdate(conn, 1)', 'FROM tb_establishment_smtp_credential', 'rotateStoredKeys(', 'smtpCredentialAad(1)']) {
      expect([text, mailer.test(text)]).toEqual([text, true])
    }
    const cadastro = forbiddenFor('src/modules/emitter/smtp-credential.service.ts')
    expect(cadastro.test('storeSmtpCredential(')).toBe(false)
    expect(cadastro.test('openSmtpCredential(')).toBe(true)                                   // o cadastro nunca abre a senha
    expect(forbiddenFor('src/modules/outro.ts').test('storeSmtpCredential(')).toBe(true)      // qualquer outro arquivo: tudo proibido
  })

  it('a lista não é vazia: os nomes do 5.3.0 estão nela e o padrão reconhece cada forma', () => {
    for (const name of ['openSmtpCredential', 'saveSmtpCredential', 'smtpCredentialAad', 'SMTP_CREDENTIAL_SEALED_STORE', 'SEALED_STORES', 'rotateStoredKeys']) {
      expect([name, NAMES.includes(name)]).toEqual([name, true])
    }
    for (const text of ['x openSmtpCredential(', 'SEALED_STORES.find(', 'FROM tb_establishment_smtp_credential', 'store.readSealedForUpdate(conn, 1)', 's.rewrap (c)']) {
      expect([text, FORBIDDEN.test(text)]).toEqual([text, true])
    }
    expect(FORBIDDEN.test('await assertSmtpCredentialDomainsEnforced(ctx.pool)')).toBe(false)   // a sonda do boot é a única permitida
  })
})
