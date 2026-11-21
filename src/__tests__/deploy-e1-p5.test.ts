/// <reference types="jest" />
// nfe-api DEPLOY.E1.P5 — adoção do pacote 2.0.0 do núcleo, por acompanhamento (D-F237/D-F249): o tipo da pasta pelo MODELO (D-F241),
// a raiz do arquivo fiscal pela regra do núcleo (`fiscalStorageRootFromEnv`, P-DEP-2) e o CORS com o AMBIENTE (D-F236).
// Ficha: Vault projetos/nfe-api/GERAL/ficha-deploy-e1-p5-adocao-pacote-2-0-0.md.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadServerCa } from '../authority/server-ca'
import { generateKeyPairSync, randomBytes } from 'crypto'
import { FsFiscalStorage, MasterKeyRing, ProductTokenVerifier } from 'fiscal-api'
import { merchandiseDocumentKind, merchandiseFileKey } from '../nfe/fiscal-file'
import { contextFromEnv } from '../context'
import { assertCorsOrigins } from '../cors-origins'

const SRC = path.resolve(__dirname, '..')
const CNPJ = '12345678000195'
const CHAVE = '41261112345678000195550010000000011000000010'   // 44 dígitos (só nome de arquivo aqui)
const WHEN = new Date('2026-11-18T02:30:00Z')                    // = 17/11 23:30 em America/Sao_Paulo (Q-TZ7: o dia é o da zona)
const PUB_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) as string
const tmpDirs: string[] = []
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d }
afterAll(() => tmpDirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })))

describe('D-F241 — o tipo da pasta pelo modelo (55 = nfe, 65 = nfce)', () => {
  it('o mapa: 55 → nfe, 65 → nfce; fora do ramo de mercadoria = erro (nunca outra pasta)', () => {
    expect(CHAVE).toHaveLength(44)
    expect(merchandiseDocumentKind('55')).toBe('nfe')
    expect(merchandiseDocumentKind('65')).toBe('nfce')
    for (const bad of ['57', '99', '', ' 55', 'nfe', 'SE', 'toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(() => merchandiseDocumentKind(bad)).toThrow(/fora do ramo de mercadoria/)
    }
  })

  it('a série é a da chave: 0–999; fora disso = erro (o núcleo aceitaria até 5 dígitos)', () => {
    const k = (serie: string | number) => merchandiseFileKey({ cnpj: CNPJ, model: '55', serie, environment: 'H', zone: 'America/Sao_Paulo' })
    for (const ok of ['0', '001', '999', 0, 1, 999]) expect(k(ok).serie).toBe(ok)
    for (const bad of ['1234', '', ' 1', '-1', '1.0', 1000, -1, 1.5, NaN]) expect(() => k(bad)).toThrow(/fora de 0–999/)
  })

  it('NF-e de homologação grava em <cnpj>/H/nfe/<série>/<ano>/<mês>/<dia na zona>/ e o find acha sem a série', () => {
    const root = tmp('nfe-api-p5-')
    const storage = new FsFiscalStorage(root)
    const key = merchandiseFileKey({ cnpj: CNPJ, model: '55', serie: '001', environment: 'H', zone: 'America/Sao_Paulo' })
    expect(key).toEqual({ cnpj: CNPJ, kind: 'nfe', serie: '001', environment: 'H', zone: 'America/Sao_Paulo' })
    const saved = storage.save(key, `${CHAVE}-nfe.xml`, '<x/>', WHEN)
    expect(saved).toBe(path.join(root, CNPJ, 'H', 'nfe', '1', '2026', '11', '17', `${CHAVE}-nfe.xml`))
    expect(storage.find({ cnpj: CNPJ, kind: 'nfe', environment: 'H', zone: 'America/Sao_Paulo' }, `${CHAVE}-nfe.xml`, [WHEN])).toBe(saved)
  })

  it('NFC-e de produção grava em <cnpj>/nfce/<série>/… (sem H/) e não aparece na pasta da NF-e', () => {
    const root = tmp('nfe-api-p5-')
    const storage = new FsFiscalStorage(root)
    const name = `${CHAVE}-nfce.xml`
    const saved = storage.save(merchandiseFileKey({ cnpj: CNPJ, model: '65', serie: 1, environment: 'P', zone: 'America/Sao_Paulo' }), name, '<x/>', WHEN)
    expect(saved).toBe(path.join(root, CNPJ, 'nfce', '1', '2026', '11', '17', name))
    expect(storage.find({ cnpj: CNPJ, kind: 'nfce', environment: 'P', zone: 'America/Sao_Paulo' }, name, [WHEN])).toBe(saved)
    expect(storage.find({ cnpj: CNPJ, kind: 'nfe', environment: 'P', zone: 'America/Sao_Paulo' }, name, [WHEN])).toBeNull()
  })

  // Cerca por AST (gates do passo, M1/M2): qualquer literal `nfe`/`nfce` (aspas ou template sem substituição) e qualquer uso de
  // `FISCAL_DOCUMENT_KINDS` fora de src/nfe/fiscal-file.ts, em src/ (menos os testes) e scripts/ — pega ternário, declaração tipada,
  // `satisfies`, chave computada. Nome de arquivo com `-nfe.xml` não casa (o literal inteiro tem de ser `nfe`/`nfce`).
  const ts = require('typescript') as typeof import('typescript')
  const fenceHits = (file: string, text: string): string[] => {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const hits: string[] = []
    const visit = (n: import('typescript').Node) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /^nfc?e$/.test(n.text)) hits.push(`'${n.text}'`)
      if (ts.isIdentifier(n) && n.text === 'FISCAL_DOCUMENT_KINDS') hits.push('FISCAL_DOCUMENT_KINDS')
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return hits
  }

  it('cerca: o detector pega as formas plausíveis (controle positivo) e não pega nome de arquivo', () => {
    const samples = [
      "const k = { kind: 'nfe' }", "const f = (m: string) => m === '65' ? 'nfce' : 'nfe'", "const K: FiscalDocumentKind = `nfce`",
      "const x = 'nfe' satisfies FiscalDocumentKind", "const o = { ['kind']: \"nfe\" }", 'const y = FISCAL_DOCUMENT_KINDS[1]',
    ]
    for (const s of samples) expect(fenceHits('amostra.ts', s).length).toBeGreaterThan(0)
    expect(fenceHits('amostra.ts', "const n = `${chave}-nfe.xml`; const m = 'nfe-api'")).toEqual([])
  })

  it('cerca: nenhum código de src/ nem de scripts/ fora de src/nfe/fiscal-file.ts escreve o tipo `nfe`/`nfce` à mão', () => {
    const offenders: string[] = []
    let seen = 0
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(full); continue }
        if (!/\.ts$/.test(e.name) || full === path.join(SRC, 'nfe', 'fiscal-file.ts')) continue
        seen++
        const hits = fenceHits(full, fs.readFileSync(full, 'utf8'))
        if (hits.length) offenders.push(`${path.relative(path.dirname(SRC), full)}: ${hits.join(', ')}`)
      }
    }
    walk(SRC)
    walk(path.join(path.dirname(SRC), 'scripts'))
    expect(seen).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })
})

describe('raiz — o arquivo fiscal pela regra do núcleo (fiscalStorageRootFromEnv, P-DEP-2)', () => {
  const overrides = () => ({
    pool: { query: jest.fn(), getConnection: jest.fn() } as any,
    keyring: MasterKeyRing.of({ 1: randomBytes(32) }),
    verifier: ProductTokenVerifier.of({ k1: PUB_PEM }),
    // NFE.E4.P3.T3: as raízes entram por override — estes casos provam a ordem do STORAGE_PATH
    serverCa: loadServerCa(path.resolve(__dirname, '..', '..', 'acervo', 'icp', 'raizes-icp-brasil.pem'), new Date('2026-11-21T12:00:00Z')),
  })
  const base = { DB_HOST: 'x', DB_USER: 'x', DB_PASSWORD: 'x', FISCAL_DB_NAME: 'fiscal_api' }

  it('em produção: STORAGE_PATH relativo ou ausente = o boot recusa, citando STORAGE_PATH', () => {
    expect(() => contextFromEnv({ ...base, NODE_ENV: 'production', STORAGE_PATH: 'rel/x' }, overrides())).toThrow(/STORAGE_PATH/)
    expect(() => contextFromEnv({ ...base, NODE_ENV: 'production' }, overrides())).toThrow(/STORAGE_PATH/)
  })

  it('em produção com caminho absoluto existente: a gravação cai debaixo dele e o probe responde true', () => {
    const root = tmp('nfe-api-p5-root-')
    const ctx = contextFromEnv({ ...base, NODE_ENV: 'production', STORAGE_PATH: root }, overrides())
    const saved = ctx.storage.save(merchandiseFileKey({ cnpj: CNPJ, model: '55', serie: 1, environment: 'P', zone: 'America/Sao_Paulo' }), `${CHAVE}-nfe.xml`, '<x/>', WHEN)
    expect(saved.startsWith(root + path.sep)).toBe(true)
    expect(ctx.storage.probe()).toBe(true)
  })
})

describe('D-F236 — CORS com o ambiente: em produção só https:// e nada de localhost', () => {
  it('produção recusa a origem do dev e localhost; desenvolvimento aceita as mesmas', () => {
    for (const o of ['http://localhost:5051', 'https://localhost', 'https://127.0.0.1']) {
      expect(() => assertCorsOrigins([o], 'production')).toThrow()
      expect(() => assertCorsOrigins([o], 'development')).not.toThrow()
    }
    expect(() => assertCorsOrigins(['https://app.setes.com.br', 'http://localhost:5051'], 'production')).toThrow()
  })

  it('a origem https pública passa nos dois ambientes', () => {
    expect(() => assertCorsOrigins(['https://app.setes.com.br'], 'production')).not.toThrow()
    expect(() => assertCorsOrigins(['https://app.setes.com.br'], 'development')).not.toThrow()
  })

  it('cerca: o boot (src/server.ts) passa o NODE_ENV ao assertCorsOrigins ANTES das migrations', () => {
    const server = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8')
    const call = server.indexOf('assertCorsOrigins(ctx.corsOrigins, process.env.NODE_ENV)')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(server.indexOf('runMigrations('))
    expect(server.match(/assertCorsOrigins\(/g)).toHaveLength(1)
  })
})
