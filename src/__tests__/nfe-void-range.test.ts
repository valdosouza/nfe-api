/// <reference types="jest" />
/**
 * NFE.E6.P2.T2 (ficha-nfe-e6-p2-cancelar-inutilizar-rodizio.md §7-5; D-NE40, D-NE50, D-NE163, D-NE169, D-NE171, D-NE207, D-NE210, D-NE263, D-NE282, D-NE293; RF-NFE-15/23/44/81): a inutilização com o
 * FISCO SIMULADO e a tabela das faixas em memória (`VoidDb`). Nenhuma chamada de rede; o fisco nunca é chamado com transação aberta.
 */
import type { HttpsCall } from 'fiscal-api'
import { VOICE_READINGS } from 'fiscal-api'
import { validateMessage } from '../authority/xsd'
import { voidFileName } from '../nfe/proc-evento'
import { fillVoidAnswer, MIN_VOID_RESEND_AGE_MS, voidRange, type EmitterIdentity, type VoidDeps } from '../nfe/void-range'
import type { NfeActor } from '../nfe/transmission'
import { NS } from './xsd-fixtures'
import { fmt, memStorage, ok, soapEnvelope, type Reply } from './nfe-memdb'
import { testA1 } from './test-a1'

jest.mock('fiscal-api', () => ({ ...jest.requireActual('fiscal-api'), lockNumberSequence: jest.fn() }))
const { lockNumberSequence } = require('fiscal-api') as { lockNumberSequence: jest.Mock }

jest.setTimeout(120_000)

const ACTOR: NfeActor = { institutionId: 98, schemaName: 'setes_x', userId: 7 }
const NOW = new Date('2026-11-25T13:00:00Z')
const DH = '2026-11-25T10:00:00-03:00'
const CNPJ = '07742094000113'
const REASON = 'Inutilizacao de numeracao de teste em homologacao'

interface Row { institution: number; id: number; void_id: string; environment: string; authorizer: string; reason: string; authority_code: string | null; message: string | null; protocol: string | null; dh_recbto: string | null; created_at: string }

/** A tabela das faixas e das tentativas em memória: só o SQL que `void-range.ts` fala. */
class VoidDb {
  rows: Row[] = []
  attempts: { accessKey: string; environment: string }[] = []
  statements: string[] = []
  openTx = 0
  clock = NOW
  private withdrawn = (r: Row): boolean => r.authority_code === null || r.authority_code === '102' || r.authority_code === '563'
  private view = (r: Row) => ({ id: r.id, voidId: r.void_id, authorizer: r.authorizer, reason: r.reason, authorityCode: r.authority_code, message: r.message, protocol: r.protocol, createdAt: r.created_at })
  async query(sql: string, params: any[] = []): Promise<[any, any]> {
    await new Promise(r => setImmediate(r))
    const s = sql.replace(/\s+/g, ' ').trim()
    if (/^(UPDATE|DELETE|INSERT)/.test(s)) this.statements.push(s)
    if (/FROM tb_invoice_number_void WHERE tb_institution_id = \? AND model = '55'/.test(s)) {
      const [inst, serie, env, to, from] = params
      const hit = this.rows.filter(r => r.institution === inst && r.environment === env && Number(r.void_id.slice(22, 25)) === serie && this.withdrawn(r)
        && Number(r.void_id.slice(25, 34)) <= to && Number(r.void_id.slice(34, 43)) >= from).sort((a, b) => a.id - b.id)[0]
      return [hit ? [this.view(hit)] : [], []]
    }
    if (/FROM tb_invoice_number_void WHERE tb_institution_id = \? AND id = \?/.test(s)) {
      const hit = this.rows.find(r => r.institution === params[0] && r.id === params[1])
      return [hit ? [this.view(hit)] : [], []]
    }
    if (/FROM tb_invoice_merchandise_transmission WHERE tb_institution_id/.test(s)) {
      const [, env, serie, from, to] = params
      const hit = this.attempts.map(a => ({ number: Number(a.accessKey.slice(25, 34)), serie: Number(a.accessKey.slice(22, 25)), env: a.environment }))
        .filter(a => a.env === env && a.serie === serie && a.number >= from && a.number <= to).sort((a, b) => a.number - b.number)[0]
      return [hit ? [{ number: hit.number }] : [], []]
    }
    if (/COALESCE\(MAX\(id\), 0\) \+ 1/.test(s)) return [[{ next: Math.max(0, ...this.rows.map(r => r.id)) + 1 }], []]
    if (/^INSERT INTO tb_invoice_number_void/.test(s)) {
      const [institution, id, void_id, environment, authorizer, reason] = params
      this.rows.push({ institution, id, void_id, environment, authorizer, reason, authority_code: null, message: null, protocol: null, dh_recbto: null, created_at: fmt(this.clock) })
      return [{ affectedRows: 1 }, []]
    }
    if (/^UPDATE tb_invoice_number_void SET authority_code/.test(s)) {
      const [code, message, protocol, dh, inst, id] = params
      const row = this.rows.find(r => r.institution === inst && r.id === id && r.authority_code === null)
      if (!row) return [{ affectedRows: 0 }, []]
      Object.assign(row, { authority_code: code, message, protocol, dh_recbto: dh })
      return [{ affectedRows: 1 }, []]
    }
    return [{ affectedRows: 0 }, []]
  }
  connection() {
    return { query: this.query.bind(this), beginTransaction: async () => { this.openTx++ }, commit: async () => { this.openTx-- }, rollback: async () => { this.openTx-- }, release: () => {} }
  }
}

const retInut = (cStat: string, o: { from?: string; to?: string; nProt?: string | null; dh?: string | null } = {}) =>
  soapEnvelope(`<retInutNFe xmlns="${NS}" versao="4.00"><infInut><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo><cUF>41</cUF><ano>26</ano>`
    + `<CNPJ>${CNPJ}</CNPJ><mod>55</mod><serie>1</serie><nNFIni>${o.from ?? '10'}</nNFIni><nNFFin>${o.to ?? '12'}</nNFFin>${o.dh === null ? '' : `<dhRecbto>${o.dh ?? DH}</dhRecbto>`}`
    + `${o.nProt === null ? '' : `<nProt>${o.nProt ?? '141260000000003'}</nProt>`}</infInut></retInutNFe>`)

function setup(over: { emitter?: Partial<EmitterIdentity>; last?: number | null } = {}) {
  const db = new VoidDb()
  const storage = memStorage()
  const calls: HttpsCall[] = []
  const txAtCall: number[] = []
  let reply: Reply = () => { throw new Error('nenhuma resposta combinada') }
  const a1 = testA1()
  const conn = db.connection()
  lockNumberSequence.mockReset()
  lockNumberSequence.mockResolvedValue({ environment: 'H', lastNumber: over.last === undefined ? 50 : over.last })
  const deps = {
    pool: { query: conn.query, getConnection: async () => conn } as never,
    storage: storage as never, catalog: VOICE_READINGS as never, now: () => new Date(db.clock),
    openIssuer: async () => ({ issuer: { environment: 'H' }, cert: a1.cert, key: a1.key, info: { cnpj: CNPJ } }) as never,
    zoneOf: async () => 'America/Sao_Paulo', ca: () => undefined,
    emitterOf: async () => ({ cnpj: CNPJ, uf: 'PR', hasStateRegistration: true, ...over.emitter }),
    request: async (c: HttpsCall) => { calls.push(c); txAtCall.push(db.openTx); return reply(c) },
  } as unknown as VoidDeps
  return { db, storage, calls, txAtCall, deps, say: (r: Reply) => { reply = r } }
}
type Env = ReturnType<typeof setup>
const run = (t: Env, o: Partial<{ serie: number; year: number; from: number; to: number; reason: string }> = {}) => voidRange(t.deps, ACTOR, { serie: 1, from: 10, to: 12, reason: REASON, ...o })
const stored = (t: Env, name: string) => [...t.storage.files.entries()].find(([k]) => k.endsWith(name))?.[1]

describe('retira a faixa (102 e 563)', () => {
  it('102: a linha nasce PENDENTE, o fisco é chamado fora da transação, a resposta a preenche UMA vez e o ProcInutNFe é guardado (D-NE50)', async () => {
    const t = setup()
    t.say(() => ok(retInut('102')))
    const r = await run(t)
    expect(r).toMatchObject({ id: 1, serie: 1, from: 10, to: 12, environment: 'H', state: 'homologated', authorityCode: '102', protocol: '141260000000003', incident: null, refusedCStat: null })
    expect(r.voidId).toBe(`ID4126${CNPJ}55001000000010000000012`)
    expect(r.voidId).toHaveLength(43)
    expect(t.db.rows[0]).toMatchObject({ authority_code: '102', protocol: '141260000000003', dh_recbto: '2026-11-25 13:00:00', reason: REASON, authorizer: 'PR', environment: 'H' })
    expect(t.txAtCall).toEqual([0])
    const proc = stored(t, voidFileName(r.voidId)) as string
    expect(await validateMessage('procInutNFe', proc)).toEqual({ ok: true })
    expect(lockNumberSequence).toHaveBeenCalledWith(expect.anything(), { institutionId: 98, model: '55', serie: 1 })
  })

  it('563 (faixa já pedida) retira também — com o nProt do pedido anterior, ou sem (D-NE40)', async () => {
    const a = setup(); a.say(() => ok(retInut('563')))
    expect((await run(a)).authorityCode).toBe('563')
    const b = setup(); b.say(() => ok(retInut('563', { nProt: null })))
    const r = await run(b)
    expect([r.state, r.protocol]).toEqual(['homologated', null])
  })

  it('a mesma faixa já retirada: idempotente, nada ao fisco; outra faixa que a cobre em parte: 409 NUMBER_VOID_ALREADY_WITHDRAWN', async () => {
    const t = setup(); t.say(() => ok(retInut('102')))
    const first = await run(t)
    const again = await run(t)
    expect([again.state, again.id, again.voidId, t.calls.length]).toEqual(['homologated', first.id, first.voidId, 1])
    await expect(run(t, { from: 11, to: 13 })).rejects.toMatchObject({ statusCode: 409, code: 'NUMBER_VOID_ALREADY_WITHDRAWN' })
    expect(t.calls).toHaveLength(1)
  })
})

describe('rejeição é história, nunca retira (D-NE207)', () => {
  it.each([['256'], ['241'], ['201']])('%s: 422 FISCAL_VOID_REJECTED, a linha é preenchida com a rejeição, nenhum arquivo, e a faixa fica livre para novo pedido', async cStat => {
    const t = setup()
    t.say(() => ok(retInut(cStat, { nProt: null })))
    await expect(run(t)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_VOID_REJECTED' })
    expect(t.db.rows[0].authority_code).toBe(cStat)
    expect([...t.storage.files.keys()]).toEqual([])
    t.say(() => ok(retInut('102')))
    const r = await run(t)                                                                       // a faixa não ficou retirada: novo pedido = NOVA linha
    expect([r.id, r.state, t.db.rows.length]).toEqual([2, 'homologated', 2])
  })
})

describe('o que deixa a linha PENDENTE', () => {
  it.each([
    ['timeout', () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }],
    ['HTTP 500', () => ({ status: 500, headers: {}, text: 'erro interno' })],
    ['sem eco (outra faixa)', () => ok(retInut('102', { from: '9' }))],
    ['dhRecbto torto', () => ok(retInut('102', { dh: 'ontem' }))],
  ] as [string, Reply][])('%s: pendente, sem UPDATE e sem arquivo', async (_l, scripted) => {
    const t = setup()
    t.say(scripted)
    const r = await run(t)
    expect([r.state, r.authorityCode]).toEqual(['in-flight', null])
    expect(t.db.rows[0].authority_code).toBeNull()
    expect(t.db.statements.some(x => x.startsWith('UPDATE'))).toBe(false)
    expect([...t.storage.files.keys()]).toEqual([])
  })

  it('656: o serviço recusou — pendente e o cStat vai ao disjuntor, nunca rejeição', async () => {
    const t = setup()
    t.say(() => ok(retInut('656', { nProt: null })))
    const r = await run(t)
    expect([r.state, r.refusedCStat, t.db.rows[0].authority_code]).toEqual(['in-flight', '656', null])
  })

  it('reenvio da MESMA faixa: antes de 10 min = 409 FISCAL_VOID_IN_FLIGHT; depois, reaproveita a linha, remonta o pedido IGUAL e reenvia pelo mesmo Id (S6)', async () => {
    const t = setup()
    t.say(() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
    await run(t)
    const firstBody = t.calls[0].body
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_VOID_IN_FLIGHT' })
    expect(t.calls).toHaveLength(1)
    t.db.clock = new Date(NOW.getTime() + MIN_VOID_RESEND_AGE_MS)
    t.say(() => ok(retInut('563')))
    const r = await run(t)
    expect([r.id, r.state, t.db.rows.length, t.calls.length]).toEqual([1, 'homologated', 1, 2])
    expect(t.calls[1].body).toBe(firstBody)                                                       // mesmo pedido (a assinatura RSA-SHA1 é determinística)
  })

  it('outra faixa que cobre parte de uma pendente: 409 FISCAL_VOID_IN_FLIGHT', async () => {
    const t = setup()
    t.say(() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
    await run(t)
    await expect(run(t, { from: 12, to: 14 })).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_VOID_IN_FLIGHT' })
  })

  it('o 2º UPDATE afeta 0 linhas (outro pedido já respondeu): relê a linha e responde com ela, sem sobrescrever', async () => {
    const t = setup()
    t.say(() => { t.db.rows[0].authority_code = '102'; t.db.rows[0].protocol = '141260000000099'; return ok(retInut('563')) })
    const r = await run(t)
    expect([r.authorityCode, r.protocol, r.state]).toEqual(['102', '141260000000099', 'homologated'])
    expect(t.db.rows[0].authority_code).toBe('102')
  })
})

describe('a recusa local, sem ir ao fisco e sem linha (D-NE263 e o resto)', () => {
  const none = (t: Env) => expect([t.calls.length, t.db.rows.length]).toEqual([0, 0])

  it('número acima do último gerado (na faixa ou cruzando-o): 422; sequência sem número gerado: 422', async () => {
    for (const [last, over] of [[9, {}], [11, {}], [null, {}], [0, {}]] as [number | null, object][]) {
      const t = setup({ last })
      await expect(run(t, over)).rejects.toMatchObject({ statusCode: 422 })
      none(t)
    }
    const edge = setup({ last: 12 })
    edge.say(() => ok(retInut('102')))
    expect((await run(edge)).state).toBe('homologated')                                           // o último gerado EXATO cabe
  })

  it('número de que alguma tentativa é dona (autorizada, rejeitada que reaproveita, em voo): 409 FISCAL_VOID_RANGE_IN_USE; a série e o ambiente separam', async () => {
    const key = (n: number, serie = 1) => `412611${CNPJ}55${String(serie).padStart(3, '0')}${String(n).padStart(9, '0')}148213057${0}`
    const t = setup()
    t.db.attempts.push({ accessKey: key(11), environment: 'H' })
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_VOID_RANGE_IN_USE' })
    none(t)
    const other = setup()
    other.db.attempts.push({ accessKey: key(11, 2), environment: 'H' }, { accessKey: key(11), environment: 'P' }, { accessKey: key(13), environment: 'H' })
    other.say(() => ok(retInut('102')))
    expect((await run(other)).state).toBe('homologated')
  })

  it('xJust, série, faixa de mais de 10.000 e de/para fora de ordem: 422 com a lista', async () => {
    for (const bad of [{ reason: 'a'.repeat(14) }, { reason: 'a'.repeat(256) }, { serie: 910 }, { serie: -1 }, { from: 0 }, { from: 13 }, { to: 10_010 }, { from: 1, to: 10_001 }]) {
      const t = setup({ last: 99_999 })
      await expect(run(t, bad)).rejects.toMatchObject({ statusCode: 422 })
      none(t)
    }
    const edge = setup({ last: 99_999 }); edge.say(() => ok(retInut('102', { from: '1', to: '10000' })))
    expect((await run(edge, { from: 1, to: 10_000 })).state).toBe('homologated')                  // 10.000 cabe
  })

  it('ano acima do corrente (453) ou abaixo de 2006 (454): 422', async () => {
    for (const year of [2027, 2005]) { const t = setup(); await expect(run(t, { year })).rejects.toMatchObject({ statusCode: 422 }); none(t) }
  })

  it('emitente sem IE e SP/BA/AC depois de 11/11/2026: o emitente não pede inutilização (422); modelo e SVC não entram', async () => {
    const noIe = setup({ emitter: { hasStateRegistration: false } })
    await expect(run(noIe)).rejects.toMatchObject({ statusCode: 422 })
    none(noIe)
    for (const uf of ['SP', 'BA', 'AC'] as const) { const t = setup({ emitter: { uf } }); await expect(run(t)).rejects.toMatchObject({ statusCode: 422 }); none(t) }
  })
})

describe('a tabela das faixas é APPEND-ONLY (D-NE171, Q2/D-NE293)', () => {
  it('de toda a vida do pedido só sai um INSERT e um UPDATE de preenchimento write-once (authority_code IS NULL); nunca DELETE', async () => {
    const t = setup()
    t.say(() => ok(retInut('102')))
    await run(t)
    const writes = t.db.statements.filter(x => /tb_invoice_number_void/.test(x))
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatch(/^INSERT INTO tb_invoice_number_void/)
    expect(writes[1]).toMatch(/^UPDATE tb_invoice_number_void SET authority_code = \?.* WHERE tb_institution_id = \? AND id = \? AND authority_code IS NULL$/)
    expect(t.db.statements.some(x => /^DELETE/.test(x))).toBe(false)
  })

  it('fillVoidAnswer: a 2ª chamada na linha já preenchida devolve false e nada muda', async () => {
    const t = setup()
    t.db.rows.push({ institution: 98, id: 1, void_id: 'x', environment: 'H', authorizer: 'PR', reason: REASON, authority_code: null, message: null, protocol: null, dh_recbto: null, created_at: fmt(NOW) })
    const conn = t.db.connection() as never
    expect(await fillVoidAnswer(conn, 98, 1, { code: '102', message: 'm', protocol: '141260000000003', dh: null })).toBe(true)
    expect(await fillVoidAnswer(conn, 98, 1, { code: '256', message: 'outra', protocol: null, dh: null })).toBe(false)
    expect(t.db.rows[0].authority_code).toBe('102')
  })
})
