/// <reference types="jest" />
// E3 da NE-2: a família NF-e declara a escrita (D-F108), a lista positiva sem S (D-NE107) e as SONDAS do boot dos domínios da 001 (cada CHECK
// pelo NOME, PK própria, tudo o mais válido — F2A1-05/F2A1-07; regra 16 para os códigos em VARCHAR). Puro: driver simulado que aplica os
// CHECKs da 001 como o MariaDB (ou deixa de aplicar, para provar que o boot FALHA alto).
import fs from 'fs'
import path from 'path'
import { MERCHANDISE_VOICE_READING, TransmissionEventKind } from 'fiscal-api'
import {
  MERCHANDISE_VOICE_WRITE_KINDS, MERCHANDISE_VOICE_FAMILY, MERCHANDISE_TRANSMISSION_TABLE, assertMerchandiseVoiceDomainsEnforced,
  assertMerchandiseStrictSession, MERCHANDISE_KEY_LENGTH_PROBE_KEY,
} from '../nfe/voice-family'
import { NUMBER_VOID_TABLE, NUMBER_VOID_UNIQUE_KEYS, assertNumberVoidDomainsEnforced, assertNumberVoidUniqueKeys, voidId } from '../nfe/number-void'

const checkErr = (name: string) => Object.assign(new Error(`CONSTRAINT \`${name}\` failed for \`fiscal_api\`.\`t\``), { errno: 4025 })
const AUTH = ['AM', 'BA', 'GO', 'MG', 'MS', 'MT', 'PE', 'PR', 'RS', 'SP', 'SVAN', 'SVRS']
const cols = (sql: string) => sql.match(/\(([^)]*)\) VALUES/)![1].split(',').map(s => s.trim())
/** Liga coluna → valor do INSERT (as colunas com literal no SQL não vêm nos params). */
function rowOf(sql: string, p: unknown[]): Record<string, unknown> {
  const values = sql.match(/VALUES \((.*)\)\s*$/)![1].split(',').map(s => s.trim())   // guloso: `NOW()` tem parênteses
  const out: Record<string, unknown> = {}
  let i = 0
  cols(sql).forEach((c, k) => { out[c] = values[k] === '?' ? p[i++] : values[k].replace(/^'|'$/g, '') })
  return out
}
/** O MOTOR simulado com os CHECKs da 001 — `off` desliga constraints (por nome) e `ci` as avalia sem caixa/sem PAD (como um CHECK _ci faria). */
/** As linhas do `information_schema.STATISTICS` das UNIQUE da faixa — as da 001, ou as do RASCUNHO v1.1 (mesmo nome, sem o ambiente, sem a chave da faixa). */
function statisticsRows(draft = false): { name: string; col: string; nonUnique: number }[] {
  if (draft) return [{ name: 'uk_invoice_number_void_withdrawn', col: 'withdrawn_void_id', nonUnique: 0 }]
  return Object.entries(NUMBER_VOID_UNIQUE_KEYS).flatMap(([name, cols]) => cols.map(col => ({ name, col, nonUnique: 0 })))
}
function engine(opts: { off?: string[]; ci?: boolean; draftKeys?: boolean; strict?: boolean } = {}) {
  const bin = (v: unknown, allowed: string[]) => opts.ci ? allowed.map(a => a.toLowerCase()).includes(String(v).trim().toLowerCase()) : allowed.includes(String(v))
  const rx = (v: unknown, re: RegExp) => opts.ci ? new RegExp(re.source, 'i').test(String(v)) : re.test(String(v))
  const refuse = (name: string, ok: boolean) => { if (!ok && !opts.off?.includes(name)) throw checkErr(name) }
  return async (sql: string, p?: unknown[]): Promise<any> => {
    if (/information_schema\.STATISTICS/.test(sql)) return [statisticsRows(opts.draftKeys)]
    if (!/^INSERT/.test(sql)) return [{}]
    const r = rowOf(sql, p ?? [])
    if (sql.startsWith(`INSERT INTO ${MERCHANDISE_VOICE_FAMILY.eventTable} `)) {
      refuse('ck_invoice_merchandise_transmission_event_kind', bin(r.kind, [...MERCHANDISE_VOICE_WRITE_KINDS]))
      refuse('ck_invoice_merchandise_transmission_event_source', bin(r.source, ['P', 'Q']))
      refuse('ck_invoice_merchandise_transmission_event_status_code', !['A', 'R', 'D', 'P'].includes(String(r.kind)) || (r.authority_code != null && rx(r.authority_code, /^[0-9]{3,4}$/)))
      refuse('ck_invoice_merchandise_transmission_event_cancel_code', r.kind !== 'C' || (r.authority_code != null && (opts.ci ? String(r.authority_code).trim() === '110111' : String(r.authority_code).length === 6 && r.authority_code === '110111')))
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith(`INSERT INTO ${MERCHANDISE_TRANSMISSION_TABLE} `)) {
      // D-NE172: a sessão ESTRITA (padrão do motor simulado) recusa o texto maior que a coluna — 1406; sem ela o MariaDB CORTA calado nas 44
      // posições do VARCHAR(44) ANTES do CHECK (o achado MEDIUM 1 do gate adversarial da NE-2)
      if (String(r.access_key).length > 44) {
        if (opts.strict !== false) throw Object.assign(new Error("Data too long for column 'access_key' at row 1"), { errno: 1406, code: 'ER_DATA_TOO_LONG' })
        r.access_key = String(r.access_key).slice(0, 44)
      }
      refuse('ck_invoice_merchandise_transmission_environment', bin(r.environment, ['H', 'P']))
      refuse('ck_invoice_merchandise_transmission_key', rx(r.access_key, /^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/) && bin(String(r.access_key).slice(20, 22), ['55', '65']) && bin(String(r.access_key).slice(34, 35), ['1', '6', '7']))
      refuse('ck_invoice_merchandise_transmission_authorizer', opts.ci ? AUTH.concat('SVC-AN', 'SVC-RS').map(a => a.toLowerCase()).includes(String(r.authorizer).trim().toLowerCase()) : AUTH.concat('SVC-AN', 'SVC-RS').includes(String(r.authorizer)))
      refuse('ck_invoice_merchandise_transmission_digest', rx(r.digest_value, /^[A-Za-z0-9+/]{27}=$/))
      refuse('ck_invoice_merchandise_transmission_receipt', r.receipt == null || rx(r.receipt, /^[0-9]{15}$/))
      refuse('ck_invoice_merchandise_transmission_protocol', r.protocol == null || rx(r.protocol, /^([0-9]{15}|[0-9]{17})$/))
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith(`INSERT INTO ${NUMBER_VOID_TABLE} `)) {
      const id = String(r.void_id)
      refuse('ck_invoice_number_void_environment', bin(r.environment, ['H', 'P']))
      refuse('ck_invoice_number_void_id', rx(id, /^ID[0-9]{4}[0-9A-Z]{12}[0-9]{2}(55|65)[0-9]{21}$/) && Number(id.slice(25, 34)) >= 1 && Number(id.slice(25, 34)) <= Number(id.slice(34, 43)))
      refuse('ck_invoice_number_void_authorizer', opts.ci ? AUTH.map(a => a.toLowerCase()).includes(String(r.authorizer).trim().toLowerCase()) : AUTH.includes(String(r.authorizer)))
      refuse('ck_invoice_number_void_status_code', r.authority_code == null || rx(r.authority_code, /^[0-9]{3,4}$/))
      refuse('ck_invoice_number_void_protocol', r.protocol == null || (rx(r.protocol, /^([0-9]{15}|[0-9]{17})$/) && r.authority_code != null && ['102', '563'].includes(String(r.authority_code))))
      return [{ affectedRows: 1 }]
    }
    throw new Error(`INSERT inesperado: ${sql.slice(0, 60)}`)
  }
}
function poolWith(onQuery: (sql: string, params?: unknown[]) => Promise<any>) {
  const conn = { beginTransaction: jest.fn(), rollback: jest.fn(), release: jest.fn(), destroy: jest.fn(), query: jest.fn(onQuery) }
  return { conn, pool: { getConnection: jest.fn(async () => conn), query: jest.fn(onQuery) } as any }
}

describe('a família (D-F108/D-NE107)', () => {
  it('lista POSITIVA A/R/D/P/C/K/F/N — sem S; congelada; o descritor é da tabela da voz com a leitura publicada do núcleo', () => {
    expect([...MERCHANDISE_VOICE_WRITE_KINDS]).toEqual(['A', 'R', 'D', 'P', 'C', 'K', 'F', 'N'])
    expect(Object.isFrozen(MERCHANDISE_VOICE_WRITE_KINDS)).toBe(true)
    expect((MERCHANDISE_VOICE_WRITE_KINDS as readonly string[]).includes('S')).toBe(false)
    expect(MERCHANDISE_VOICE_FAMILY.eventTable).toBe('tb_invoice_merchandise_transmission_event')
    expect(MERCHANDISE_VOICE_FAMILY.writeKinds).toEqual([...MERCHANDISE_VOICE_WRITE_KINDS])
    expect(MERCHANDISE_VOICE_FAMILY.reading).toBe(MERCHANDISE_VOICE_READING)
    expect(MERCHANDISE_TRANSMISSION_TABLE).toBe('tb_invoice_merchandise_transmission')
    // testemunha de TIPO (§12.8 item 3): S não entra no tipo da família
    // @ts-expect-error S está fora da lista de escrita da NF-e (D-NE107)
    const s: typeof MERCHANDISE_VOICE_WRITE_KINDS[number] = 'S'
    void s
    const common: readonly TransmissionEventKind[] = MERCHANDISE_VOICE_WRITE_KINDS
    expect(common.length).toBe(8)
  })
  it('`voidId` monta o Id de 43 posições por partes (prefixo/UF/ano/CNPJ/modelo/série/faixa) e recusa CNPJ fora de 14', () => {
    expect(voidId({ serie: 1, from: 1, to: 10 })).toBe('ID4126ABCDEF7800019555001000000001000000010')
    expect(voidId({ serie: 1, from: 1, to: 10 })).toHaveLength(43)
    expect(voidId({ prefix: 'id', model: '65', serie: 900, from: 7, to: 7, yy: '27' }).slice(0, 2)).toBe('id')
    expect(() => voidId({ cnpj: '123', serie: 1, from: 1, to: 1 })).toThrow(/14 posições/)
  })
})

describe('as sondas do boot — cada CHECK pelo NOME, PK própria, o resto válido', () => {
  it('voz e tentativa: 9 + 13 sondas passam com o motor que aplica os CHECKs; transações desfeitas; FK só desligada nas sondas da voz', async () => {
    const { conn, pool } = poolWith(engine())
    await expect(assertMerchandiseVoiceDomainsEnforced(pool)).resolves.toBeUndefined()
    const inserts = conn.query.mock.calls.filter(c => /^INSERT/.test(c[0] as string))
    expect(inserts).toHaveLength(22)
    const ev = inserts.filter(c => (c[0] as string).includes(MERCHANDISE_VOICE_FAMILY.eventTable)).map(c => (c[1] as unknown[]).slice(0, 2))
    expect(ev).toEqual([[1, 'S'], [2, 'a'], [3, 'A'], [4, 'A'], [5, 'A'], [6, 'R'], [7, 'D'], [8, 'C'], [9, 'C']])
    const tx = inserts.filter(c => (c[0] as string).startsWith(`INSERT INTO ${MERCHANDISE_TRANSMISSION_TABLE} (`)).map(c => (c[1] as unknown[])[0])
    expect(tx).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    // PK própria por sonda em cada tabela; chave própria por sonda (a UNIQUE da chave nunca mascara uma sonda aceita)
    const keys = inserts.filter(c => (c[0] as string).startsWith(`INSERT INTO ${MERCHANDISE_TRANSMISSION_TABLE} (`)).map(c => (c[1] as unknown[])[3])
    expect(new Set(keys).size).toBe(keys.length)
    const sqls = conn.query.mock.calls.map(c => c[0] as string)
    expect(sqls.filter(s => s === 'SET SESSION foreign_key_checks = 0')).toHaveLength(4)
    expect(conn.rollback.mock.calls.length).toBe(conn.release.mock.calls.length)
    expect(conn.destroy).not.toHaveBeenCalled()
  })
  it('faixa inutilizada: 13 sondas, Id PRÓPRIO por sonda (a UNIQUE da faixa retirada nunca mascara o diagnóstico)', async () => {
    const { conn, pool } = poolWith(engine())
    await expect(assertNumberVoidDomainsEnforced(pool)).resolves.toBeUndefined()
    const inserts = conn.query.mock.calls.filter(c => /^INSERT/.test(c[0] as string))
    expect(inserts).toHaveLength(13)
    expect(inserts.map(c => (c[1] as unknown[])[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    const ids = inserts.map(c => (c[1] as unknown[])[1] as string)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => id.length === 43)).toBe(true)
  })
  it('motor SEM CHECK (aceita tudo) → o boot FALHA alto com o diagnóstico; CHECK _ci (aceita minúscula/PAD SPACE) → "NÃO é o domínio publicado"', async () => {
    await expect(assertMerchandiseVoiceDomainsEnforced(poolWith(engine({ off: ['ck_invoice_merchandise_transmission_event_kind'] })).pool)).rejects.toThrow(/não aplica CHECK ou falta a migration/)
    await expect(assertMerchandiseVoiceDomainsEnforced(poolWith(engine({ ci: true })).pool)).rejects.toThrow(/NÃO é o domínio publicado/)
    await expect(assertNumberVoidDomainsEnforced(poolWith(engine({ off: ['ck_invoice_number_void_id'] })).pool)).rejects.toThrow(/não aplica CHECK ou falta a migration/)
    await expect(assertNumberVoidDomainsEnforced(poolWith(engine({ ci: true })).pool)).rejects.toThrow(/NÃO é o domínio publicado/)
  })
  it('D-NE163 — a sonda das DUAS UNIQUE: passa com a 001; FALHA alto com a tabela nascida do rascunho (mesmo nome de índice, sem o ambiente, sem a chave da faixa), com índice não único e com colunas trocadas', async () => {
    await expect(assertNumberVoidUniqueKeys(poolWith(engine()).pool)).resolves.toBeUndefined()
    await expect(assertNumberVoidUniqueKeys(poolWith(engine({ draftKeys: true })).pool)).rejects.toThrow(/não é a da D-NE163/)
    const notUnique = { query: async () => [statisticsRows().map(r => ({ ...r, nonUnique: 1 }))] } as any
    await expect(assertNumberVoidUniqueKeys(notUnique)).rejects.toThrow(/NÃO única/)
    const swapped = { query: async () => [statisticsRows().map(r => (r.name.endsWith('range') && r.col === 'serie' ? { ...r, col: 'environment' } : r.name.endsWith('range') && r.col === 'environment' ? { ...r, col: 'serie' } : r))] } as any
    await expect(assertNumberVoidUniqueKeys(swapped)).rejects.toThrow(/não é a da D-NE163/)
    expect(Object.keys(NUMBER_VOID_UNIQUE_KEYS)).toEqual(['uk_invoice_number_void_range', 'uk_invoice_number_void_withdrawn'])
  })
  it('a recusa por OUTRO CHECK não prova o domínio (F2A1-05): o motor que recusa a sonda do kind pelo CHECK do status falha com diagnóstico', async () => {
    const wrong = async (sql: string, p?: unknown[]) => {
      if (/^INSERT/.test(sql) && sql.includes(MERCHANDISE_VOICE_FAMILY.eventTable)) throw checkErr('ck_invoice_merchandise_transmission_event_status_code')
      return engine()(sql, p)
    }
    await expect(assertMerchandiseVoiceDomainsEnforced(poolWith(wrong).pool)).rejects.toThrow(/recusada por OUTRO CHECK/)
  })
  it('o boot da nfe-api roda as sondas e confere as DUAS views DEPOIS das migrations — passando a própria leitura (D-NE158)', () => {
    const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.ts'), 'utf8')
    const at = (s: string) => server.indexOf(s)
    expect(at('await runMigrations(')).toBeGreaterThan(0)
    for (const call of ['await assertIssuerModelDomainEnforced(ctx.pool)', 'await assertIssuerEnvironmentDomainEnforced(ctx.pool)',
      'await assertMerchandiseVoiceDomainsEnforced(ctx.pool)', 'await assertMerchandiseStrictSession(ctx.pool)',
      'await assertNumberVoidDomainsEnforced(ctx.pool)', 'await assertNumberVoidUniqueKeys(ctx.pool)',
      'await assertFamilyViewsReadable(ctx.pool, ctx.fiscalDb, [MERCHANDISE_VOICE_READING])', 'await assertWithdrawnRangesViewReadable(ctx.pool, ctx.fiscalDb)']) {
      expect([call, at(call) > at('await runMigrations(')]).toEqual([call, true])
    }
    expect(server).not.toMatch(/assertFamilyViewsReadable\(ctx\.pool, ctx\.fiscalDb\)/)       // nunca sem a lista (o núcleo 5.0.0 nem compila) — e nunca o catálogo inteiro (D-NE76; cerca em deploy-e1-p9)
    // D-NE172: a prova da sessão estrita vem DEPOIS da conferência dos invariantes (que já exige o modo) — as duas, antes de ouvir
    expect(at('await assertMerchandiseStrictSession(ctx.pool)')).toBeGreaterThan(at('await assertSessionInvariants(ctx.pool)'))
    expect(at('await assertMerchandiseStrictSession(ctx.pool)')).toBeLessThan(at('.listen('))
  })
})

describe('D-NE172 — a sonda do boot prova a sessão ESTRITA na chave de acesso da NF-e', () => {
  it('a sonda é a chave VÁLIDA com 1 posição a mais: cortada nas 44, ela passa no CHECK da chave (só a sessão estrita a recusa)', () => {
    expect(MERCHANDISE_KEY_LENGTH_PROBE_KEY).toHaveLength(45)
    const cut = MERCHANDISE_KEY_LENGTH_PROBE_KEY.slice(0, 44)
    expect(cut).toMatch(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/)
    expect(cut.slice(20, 22)).toBe('55')
    expect(cut.slice(34, 35)).toBe('1')
  })
  it('cerca: nenhum código desta API cita sql_mode (o modo é do pool do núcleo — `SET sql_mode` aqui o desligaria sem o boot perceber)', () => {
    const SRC = path.resolve(__dirname, '..')
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(dir, e.name))) : /\.[cm]?ts$/.test(e.name) ? [path.join(dir, e.name)] : [])
    const hits = [SRC, path.resolve(SRC, '..', 'scripts')].flatMap(walk)
      .filter(f => /sql_mode/i.test(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')))
    expect(hits).toEqual([])
  })
  it('cerca dos .sql (gates do delta D-NE173/D-NE174): nenhuma migration desta API cita sql_mode nem usa INSERT IGNORE', () => {
    const dir = path.resolve(__dirname, '..', 'migrations', 'sql')
    const hits = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).filter(f => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '')
      return /sql_mode/i.test(sql) || /INSERT\s+IGNORE/i.test(sql)
    })
    expect(hits).toEqual([])
  })
  it('motor com a sessão estrita (1406): o boot passa', async () => {
    await expect(assertMerchandiseStrictSession(poolWith(engine()).pool)).resolves.toBeUndefined()
  })
  it('motor SEM a sessão estrita (corta nas 44 e o CHECK aceita): o boot FALHA ALTO', async () => {
    await expect(assertMerchandiseStrictSession(poolWith(engine({ strict: false })).pool))
      .rejects.toThrow(/ACEITOU a chave de acesso da tentativa da NF-e maior que a coluna \(tb_invoice_merchandise_transmission\.access_key com 45 posições\) — a sessão NÃO é estrita/)
  })
  it('as sondas dos domínios seguem iguais com o motor SEM a sessão estrita (as chaves delas têm 44 — nada a cortar)', async () => {
    await expect(assertMerchandiseVoiceDomainsEnforced(poolWith(engine({ strict: false })).pool)).resolves.toBeUndefined()
  })
})
