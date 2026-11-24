/// <reference types="jest" />
/**
 * NFE.E6.P1 mudança 8 (ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-8; T2; D-NE33, D-NE35, D-NE36, D-NE41, D-NE108, D-NE111, D-NE235, D-NE254): a
 * reconciliação com o FISCO SIMULADO — refresh pela chave e pelo recibo, `digVal`, 204/539, 217 e a rota `reconfirm`. Nenhuma chamada de rede; o fisco só
 * responde por um `request` injetado e nunca com uma transação aberta.
 */
import type { HttpsCall, InvoiceRef } from 'fiscal-api'
import { invoiceRef } from 'fiscal-api'
import { MIN_KEY_INTERVAL_MS, MIN_RECEIPT_INTERVAL_MS, MIN_RECEIPT_WAIT_MS, reconfirmNotRegistered, refreshInvoice, type ReconcileDeps } from '../nfe/reconcile'
import type { NfeActor } from '../nfe/transmission'
import { buildNfeXml } from '../nfe/nfe-builder'
import { digestValueOf } from '../nfe/proc-nfe'
import { merchandiseFileKey } from '../nfe/fiscal-file'
import { NS } from './xsd-fixtures'
import { saleInput, saleKey, signNfe } from './nfe-fixtures'
import { MemDb, fmt, memStorage, ok, soapEnvelope, type Reply } from './nfe-memdb'
import { testA1 } from './test-a1'

jest.setTimeout(120_000)

const ACTOR: NfeActor = { institutionId: 98, schemaName: 'setes_x', userId: 7 }
const REF: InvoiceRef = invoiceRef(98, 5001, 0)
const NOW = new Date('2026-11-24T13:30:00Z')
const DH = '2026-11-24T10:20:00-03:00'
const KEY = saleKey()
const SIGNED = signNfe(buildNfeXml(saleInput(), KEY))
const DIGEST = digestValueOf(SIGNED) as string

const prot = (cStat: string, o: { digVal?: string | null; nProt?: boolean } = {}) =>
  `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>PR</verAplic><chNFe>${KEY}</chNFe><dhRecbto>${DH}</dhRecbto>${o.nProt === false ? '' : '<nProt>141260000000001</nProt>'}`
  + `${o.digVal === null ? '' : `<digVal>${o.digVal ?? DIGEST}</digVal>`}<cStat>${cStat}</cStat><xMotivo>motivo</xMotivo></infProt></protNFe>`
const sit = (cStat: string, inner = '', chave = KEY) =>
  soapEnvelope(`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>m</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto><chNFe>${chave}</chNFe>${inner}</retConsSitNFe>`)
const rec = (cStat: string, inner = '') =>
  soapEnvelope(`<retConsReciNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><nRec>411000000000001</nRec><cStat>${cStat}</cStat><xMotivo>m</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto>${inner}</retConsReciNFe>`)

function setup() {
  const db = new MemDb()
  db.clock = NOW
  const storage = memStorage()
  const calls: HttpsCall[] = []
  const txAtCall: number[] = []
  let reply: Reply = () => { throw new Error('nenhuma resposta combinada') }
  const a1 = testA1()
  const conn = db.connection()
  const deps: ReconcileDeps = {
    pool: { query: conn.query, getConnection: async () => conn } as never,
    storage: storage as never, now: () => new Date(db.clock),
    openIssuer: async () => ({ issuer: { environment: 'H' }, cert: a1.cert, key: a1.key, info: { cnpj: '07742094000113' } }) as never,
    zoneOf: async () => 'America/Sao_Paulo', ca: () => undefined,
    request: async c => { calls.push(c); txAtCall.push(db.openTx); return reply(c) },
  }
  // o -nfe.xml guardado na transmissão (para o -procNFe.xml)
  storage.save(merchandiseFileKey({ cnpj: '07742094000113', model: '55', serie: 1, environment: 'H', zone: 'America/Sao_Paulo' }), `${KEY}-nfe.xml`, SIGNED)
  return { db, storage, calls, txAtCall, deps, say: (r: Reply) => { reply = r } }
}
type Env = ReturnType<typeof setup>

/** Uma tentativa em voo (sem voz), criada ANTES da cota. */
function seed(t: Env, over: Record<string, unknown> = {}, events: Record<string, unknown>[] = []) {
  t.db.attempts.push({ attempt: 1, lifeEvent: 1, environment: 'H', authorizer: 'PR', accessKey: KEY, dhEmission: '2026-11-24 13:15:30', digestValue: DIGEST,
    receipt: null, protocol: null, dhRecbto: null, lastQueriedAt: null, nfeNotRegisteredAt: null, ...over })
  events.forEach((e, i) => t.db.events.push({ attempt: 1, event: i + 1, authority_code: null, message: null, dh: null, source: 'P', createdAt: '2026-11-24 12:00:00', ...e }))
}
const advance = (t: Env, deltaMs: number) => { t.db.clock = new Date(t.db.clock.getTime() + deltaMs) }
const procName = `${KEY}-procNFe.xml`
const hasProc = (t: Env) => [...t.storage.files.keys()].some(k => k.endsWith(procName))

describe('refresh pela chave', () => {
  it('autorizada: grava A com protocolo e dhRecbto, digVal conferido, guarda o procNFe, e o fisco NUNCA é chamado com transação aberta', async () => {
    const t = setup(); seed(t)
    t.say(() => ok(sit('100', prot('100'))))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect(r).toMatchObject({ attempt: 1, via: 'key', digestCheck: 'ok', incident: null, notRegistered: false })
    expect(r.outcome).toEqual({ kind: 'A', authorityCode: '100', message: 'Autorizado o uso da NF-e' })
    expect(t.db.attempts[0]).toMatchObject({ protocol: '141260000000001', lastQueriedAt: '2026-11-24 13:30:00' })
    expect(t.db.events).toHaveLength(1)
    expect(t.db.events[0]).toMatchObject({ kind: 'A', authority_code: '100', source: 'Q', dh: '2026-11-24 13:20:00' })
    expect(hasProc(t)).toBe(true)
    expect(t.calls).toHaveLength(1)
    expect(t.txAtCall).toEqual([0])
    expect(t.calls[0].url).toMatch(/^https:\/\/homologacao\.nfe\.sefa\.pr\.gov\.br\//)
  })

  it('digVal DIVERGENTE: pendência crítica, nada é gravado (o XML guardado não serve como nfeProc), nunca sobrescreve', async () => {
    const t = setup(); seed(t)
    t.say(() => ok(sit('100', prot('100', { digVal: 'B'.repeat(27) + '=' }))))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect([r.digestCheck, r.incident, r.outcome]).toEqual(['mismatch', 'digest-mismatch', { kind: 'none', reason: 'digest-divergente' }])
    expect([t.db.events, t.db.attempts[0].protocol, hasProc(t)]).toEqual([[], null, false])
  })

  it('digVal que difere só na caixa também é divergente (Base64 exato)', async () => {
    const t = setup(); seed(t)
    t.say(() => ok(sit('100', prot('100', { digVal: DIGEST.toLowerCase() }))))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect(DIGEST.toLowerCase()).not.toBe(DIGEST)
    expect(r.incident).toBe('digest-mismatch')
  })

  it('digVal AUSENTE: o A que o fisco afirma pela nossa chave é gravado, com a pendência crítica devolvida', async () => {
    const t = setup(); seed(t)
    t.say(() => ok(sit('100', prot('100', { digVal: null }))))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect([r.outcome.kind, r.digestCheck, r.incident]).toEqual(['A', 'absent', 'digest-absent'])
    expect(t.db.events).toHaveLength(1)
  })

  it('A numa tentativa FECHADA por R (a D-NE7 violada) é incidente crítico: nada se grava', async () => {
    const t = setup(); seed(t, {}, [{ kind: 'R', authority_code: '703' }])
    t.say(() => ok(sit('100', prot('100'))))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect([r.incident, r.outcome]).toEqual(['authorized-in-closed-attempt', { kind: 'none', reason: 'autorizada-em-tentativa-fechada' }])
    expect([t.db.events.length, t.db.attempts[0].protocol]).toEqual([1, null])
  })

  it('217: nenhuma voz e NENHUM fato (a consulta nunca grava nfe_not_registered_at) — só devolve notRegistered', async () => {
    const t = setup(); seed(t)
    t.say(() => ok(sit('217')))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect([r.outcome, r.notRegistered]).toEqual([{ kind: 'none', reason: '217' }, true])
    expect([t.db.events, t.db.attempts[0].nfeNotRegisteredAt]).toEqual([[], null])
  })

  it('denegada (110): D com protocolo; cancelada (101): devolvida como cancelled, sem voz (a voz C é da P2)', async () => {
    const a = setup(); seed(a)
    a.say(() => ok(sit('110', prot('110'))))
    expect((await refreshInvoice(a.deps, ACTOR, REF)).outcome).toMatchObject({ kind: 'D', authorityCode: '110' })
    expect(a.db.attempts[0].protocol).toBe('141260000000001')
    const b = setup(); seed(b)
    b.say(() => ok(sit('101')))
    expect((await refreshInvoice(b.deps, ACTOR, REF)).outcome).toMatchObject({ kind: 'cancelled' })
    expect(b.db.events).toEqual([])
  })

  it('Fault e HTTP 500 → ambíguo: nada se grava', async () => {
    const t = setup(); seed(t)
    t.say(() => ({ status: 500, headers: {}, text: 'erro' }))
    expect((await refreshInvoice(t.deps, ACTOR, REF)).outcome).toMatchObject({ kind: 'none' })
    expect(t.db.events).toEqual([])
  })

  it('a voz que a pergunta viu não é mais a última (outra rota gravou durante a consulta): nada se grava', async () => {
    const t = setup(); seed(t)
    t.say(() => { t.db.events.push({ attempt: 1, event: 1, kind: 'P', authority_code: '105', message: 'x', dh: null, source: 'P', createdAt: '2026-11-24 13:29:00' }); return ok(sit('100', prot('100'))) })
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect(r.outcome).toEqual({ kind: 'none', reason: 'voz-mudou-depois-da-pergunta' })
    expect(t.db.events).toHaveLength(1)
    expect(t.db.attempts[0].protocol).toBeNull()
  })

  it('tentativa já registrada (autorizada) não pergunta nada ao fisco', async () => {
    const t = setup(); seed(t, { protocol: '141260000000001' }, [{ kind: 'A', authority_code: '100' }])
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect(r.outcome.kind).toBe('none')
    expect(t.calls).toHaveLength(0)
  })

  it('sem tentativa: 409 FISCAL_NOT_TRANSMITTED, nada perguntado', async () => {
    const t = setup()
    await expect(refreshInvoice(t.deps, ACTOR, REF)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_NOT_TRANSMITTED' })
    expect(t.calls).toHaveLength(0)
  })
})

describe('a cota: o intervalo mínimo por last_queried_at (D-NE254) e a espera do recibo (RF-NFE-17)', () => {
  it('consultar a mesma chave de novo dentro de 6 min = 429; depois de 6 min passa', async () => {
    const t = setup(); seed(t)
    t.say(() => ok(sit('217')))
    await refreshInvoice(t.deps, ACTOR, REF)
    advance(t, MIN_KEY_INTERVAL_MS - 1000)
    await expect(refreshInvoice(t.deps, ACTOR, REF)).rejects.toMatchObject({ statusCode: 429, code: 'RESOURCE_BUSY' })
    expect(t.calls).toHaveLength(1)
    advance(t, 1000)
    await refreshInvoice(t.deps, ACTOR, REF)
    expect(t.calls).toHaveLength(2)
  })

  it('o recibo só 15 s depois da voz P, e a cada 90 s no máximo', async () => {
    const t = setup(); seed(t, { receipt: '411000000000001' }, [{ kind: 'P', authority_code: '103', createdAt: fmt(new Date(NOW.getTime() - (MIN_RECEIPT_WAIT_MS - 1000))) }])
    t.say(() => ok(rec('104', prot('100'))))
    await expect(refreshInvoice(t.deps, ACTOR, REF)).rejects.toMatchObject({ statusCode: 429 })
    expect(t.calls).toHaveLength(0)
    advance(t, 2000)
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect([r.via, r.outcome.kind]).toEqual(['receipt', 'A'])
    expect(t.calls[0].url).toMatch(/NFeRetAutorizacao/i)
    expect(MIN_RECEIPT_INTERVAL_MS).toBe(90_000)
  })

  it('105 no recibo segue P e manda consultar o recibo de novo', async () => {
    const t = setup(); seed(t, { receipt: '411000000000001' }, [{ kind: 'P', authority_code: '103', createdAt: '2026-11-24 12:00:00' }])
    t.say(() => ok(rec('105')))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect([r.outcome.kind, r.next]).toEqual(['P', 'consult-receipt'])
  })

  it('106 no recibo não grava voz (D-NE108)', async () => {
    const t = setup(); seed(t, { receipt: '411000000000001' }, [{ kind: 'P', authority_code: '103', createdAt: '2026-11-24 12:00:00' }])
    t.say(() => ok(rec('106')))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect(r.outcome).toEqual({ kind: 'none', reason: '106' })
    expect(t.db.events).toHaveLength(1)
  })
})

describe('todas as tentativas (o 539 — D-NE36)', () => {
  it('consulta da mais nova à mais antiga e para na que o fisco registrou', async () => {
    const t = setup(); seed(t, {}, [{ kind: 'R', authority_code: '703' }])
    const key2 = saleKey({ cnf: '70531942' })
    t.db.attempts.push({ attempt: 2, lifeEvent: 1, environment: 'H', authorizer: 'PR', accessKey: key2, dhEmission: '2026-11-24 13:16:30', digestValue: 'C'.repeat(27) + '=',
      receipt: null, protocol: null, dhRecbto: null, lastQueriedAt: null, nfeNotRegisteredAt: null })
    t.say(c => (String(c.body).includes(key2) ? ok(sit('217', '', key2)) : ok(sit('100', prot('100')))))
    const r = await refreshInvoice(t.deps, ACTOR, REF, { all: true })
    expect(t.calls).toHaveLength(2)
    expect(String(t.calls[0].body)).toContain(key2)                                              // a mais nova primeiro
    expect(r.incident).toBe('authorized-in-closed-attempt')                                        // o A caiu na tentativa 1, fechada por R
    expect(t.db.events.filter(e => e.kind === 'A')).toEqual([])
  })
})

describe('reconfirm — o 217 prova "não registrada" só por esta rota (D-NE111, D-NE235)', () => {
  it('217 com a chNFe igual, sem recibo, tentativa em voo: grava o fato UMA vez; a tentativa continua em voo e nenhuma voz entra', async () => {
    const t = setup(); seed(t)
    t.say(() => ok(sit('217')))
    const r = await reconfirmNotRegistered(t.deps, ACTOR, REF)
    expect([r.recorded, r.reason]).toEqual([true, 'registrada-agora'])
    expect(t.db.attempts[0].nfeNotRegisteredAt).toBe('2026-11-24 13:30:00')
    expect(t.db.events).toEqual([])
    expect(t.txAtCall).toEqual([0])
    const again = await reconfirmNotRegistered(t.deps, ACTOR, REF)
    expect([again.recorded, again.reason]).toEqual([false, 'ja-registrada'])
    expect(t.calls).toHaveLength(1)                                                              // a 2ª nem pergunta ao fisco
  })

  it('com recibo 103/105 em aberto: recusa sem perguntar; tentativa fechada por R: recusa sem perguntar', async () => {
    const a = setup(); seed(a, { receipt: '411000000000001' }, [{ kind: 'P', authority_code: '103' }])
    expect((await reconfirmNotRegistered(a.deps, ACTOR, REF)).reason).toBe('recibo-em-aberto')
    const b = setup(); seed(b, {}, [{ kind: 'R', authority_code: '703' }])
    expect((await reconfirmNotRegistered(b.deps, ACTOR, REF)).reason).toBe('tentativa-fechada')
    expect([a.calls.length, b.calls.length]).toEqual([0, 0])
  })

  it('chNFe diferente no 217: o leitor trata como ambíguo e nada é gravado', async () => {
    const t = setup(); seed(t)
    t.say(() => ok(sit('217', '', KEY.slice(0, 43) + (KEY[43] === '9' ? '8' : '9'))))
    const r = await reconfirmNotRegistered(t.deps, ACTOR, REF)
    expect([r.recorded, r.reason]).toEqual([false, 'nao-e-217'])
    expect(t.db.attempts[0].nfeNotRegisteredAt).toBeNull()
  })

  it('a voz mudou durante a pergunta: o fato NÃO é gravado (a mesma instrução confere a última voz)', async () => {
    const t = setup(); seed(t)
    t.say(() => { t.db.events.push({ attempt: 1, event: 1, kind: 'P', authority_code: '105', message: 'x', dh: null, source: 'P', createdAt: '2026-11-24 13:29:00' }); return ok(sit('217')) })
    const r = await reconfirmNotRegistered(t.deps, ACTOR, REF)
    expect([r.recorded, r.reason]).toEqual([false, 'voz-mudou-depois-da-pergunta'])
    expect(t.db.attempts[0].nfeNotRegisteredAt).toBeNull()
  })

  it('o fisco diz outra coisa (autorizada): pousa A como o refresh e NÃO grava o fato', async () => {
    const t = setup(); seed(t)
    t.say(() => ok(sit('100', prot('100'))))
    const r = await reconfirmNotRegistered(t.deps, ACTOR, REF)
    expect([r.recorded, r.reason, r.refresh?.outcome.kind]).toEqual([false, 'nao-e-217', 'A'])
    expect(t.db.attempts[0].nfeNotRegisteredAt).toBeNull()
    expect(t.db.events).toHaveLength(1)
  })

  it('respeita a cota da chave (429) e nunca grava o fato com a chave consultada há pouco', async () => {
    const t = setup(); seed(t, { lastQueriedAt: fmt(new Date(NOW.getTime() - 60_000)) })
    await expect(reconfirmNotRegistered(t.deps, ACTOR, REF)).rejects.toMatchObject({ statusCode: 429 })
    expect(t.calls).toHaveLength(0)
  })

  it('sem tentativa: 409 FISCAL_NOT_TRANSMITTED', async () => {
    const t = setup()
    await expect(reconfirmNotRegistered(t.deps, ACTOR, REF)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_NOT_TRANSMITTED' })
  })
})

describe('o fonte da reconciliação', () => {
  it('nunca nomeia a coluna do fato (só recordNfeNotRegistered), não toca rede nem relógio por conta própria', () => {
    const src = (require('fs').readFileSync(require('path').resolve(__dirname, '..', 'nfe', 'reconcile.ts'), 'utf8') as string).replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
    for (const banned of [/nfe_not_registered_at/, /\bfetch\(/, /from 'https?'/, /Date\.now\(\)/, /new Date\(\)/, /process\.env/, /rejectUnauthorized/]) expect([banned.source, banned.test(src)]).toEqual([banned.source, false])
  })
})
