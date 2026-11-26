/// <reference types="jest" />
/**
 * NFE.E6.P1 mudança 8 (ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-8; T2; D-NE33, D-NE35, D-NE36, D-NE41, D-NE108, D-NE111, D-NE235, D-NE254): a
 * reconciliação com o FISCO SIMULADO — refresh pela chave e pelo recibo, `digVal`, 204/539, 217 e a rota `reconfirm`. Nenhuma chamada de rede; o fisco só
 * responde por um `request` injetado e nunca com uma transação aberta.
 */
import type { HttpsCall, InvoiceRef } from 'fiscal-api'
import { invoiceRef } from 'fiscal-api'
import * as core from 'fiscal-api'
import { MIN_ATTEMPT_AGE_BEFORE_217_MS, MIN_KEY_INTERVAL_MS, MIN_RECEIPT_INTERVAL_MS, MIN_RECEIPT_WAIT_MS, reconfirmNotRegistered, refreshInvoice, type ReconcileDeps } from '../nfe/reconcile'
import type { NfeActor } from '../nfe/transmission'
import { buildNfeXml } from '../nfe/nfe-builder'
import { digestValueOf } from '../nfe/proc-nfe'
import { merchandiseFileKey } from '../nfe/fiscal-file'
import { NS } from './xsd-fixtures'
import { saleInput, saleKey, signNfe } from './nfe-fixtures'
import { MemDb, fmt, memStorage, ok, soapEnvelope, type Reply } from './nfe-memdb'
import { testA1 } from './test-a1'

jest.setTimeout(120_000)
// a peça do núcleo segue REAL (o `jest.fn` a embrulha); um teste manda ela recusar uma vez para provar que é ela quem decide
jest.mock('fiscal-api', () => { const actual = jest.requireActual('fiscal-api'); return { ...actual, notRegisteredProven: jest.fn(actual.notRegisteredProven) } })

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
    receipt: null, protocol: null, dhRecbto: null, lastQueriedAt: null, nfeNotRegisteredAt: null, createdAt: '2026-11-24 12:00:00', ...over })
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

  it('o `-procNFe.xml` já existe com OUTROS bytes (gravação única do núcleo 5.2.0): o A fica gravado e o incidente é file-conflict — nunca silêncio, nunca sobrescreve', async () => {
    const t = setup(); seed(t)
    const nfeKey = [...t.storage.files.keys()].find(k => k.endsWith('-nfe.xml')) as string
    const planted = nfeKey.replace('-nfe.xml', '-procNFe.xml')
    t.storage.files.set(planted, 'OUTROS BYTES')
    t.say(() => ok(sit('100', prot('100'))))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect([r.outcome.kind, r.incident]).toEqual(['A', 'file-conflict'])
    expect(t.storage.files.get(planted)).toBe('OUTROS BYTES')
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

describe('o A tardio na tentativa com o 217 provado (D-NE292)', () => {
  it('o fisco devolve A para a tentativa que tem o fato: incidente authorized-in-closed-attempt — nada se grava e o procNFe não é guardado', async () => {
    const t = setup(); seed(t, { nfeNotRegisteredAt: '2026-11-24 13:00:00', lastQueriedAt: null })
    t.say(() => ok(sit('100', prot('100'))))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect(r.incident).toBe('authorized-in-closed-attempt')
    expect([t.db.events, t.db.attempts[0].protocol, hasProc(t)]).toEqual([[], null, false])
  })
})

describe('a peça notRegisteredProven é quem decide o fato (RF-NFE-72)', () => {
  it('só a peça recusa (voz-de-registro): nada é gravado, a razão volta em `reason` e `detail`; sem a chamada à peça este teste falharia', async () => {
    const spy = core.notRegisteredProven as unknown as jest.Mock
    const t = setup(); seed(t)
    t.say(() => ok(sit('217')))
    spy.mockReturnValueOnce({ proven: false, reason: 'voz-de-registro' })
    const r = await reconfirmNotRegistered(t.deps, ACTOR, REF)
    expect([r.recorded, r.reason, r.detail, t.db.attempts[0].nfeNotRegisteredAt]).toEqual([false, 'tentativa-fechada', 'voz-de-registro', null])
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ route: 'reconfirm', cStat: 217, queriedAccessKey: KEY, attemptAccessKey: KEY, answeredBy: 'PR', attemptAuthorizer: 'PR', receipt: null, lastKind: null, seenLastEvent: null, currentLastEvent: null }))
    spy.mockReturnValueOnce({ proven: false, reason: 'entrada-invalida' })
    advance(t, MIN_KEY_INTERVAL_MS + 1000)
    const u = await reconfirmNotRegistered(t.deps, ACTOR, REF)
    expect([u.recorded, u.reason, u.detail, t.db.attempts[0].nfeNotRegisteredAt]).toEqual([false, 'nao-e-217', 'entrada-invalida', null])
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

describe('a consulta RECUSADA não fecha a tentativa (gate socrático H1)', () => {
  it.each(['656', '108', '109', '999', '562', '232'])('cStat %s no topo da consulta pela chave: nenhuma voz e a tentativa segue em voo — o número NÃO é liberado', async cStat => {
    const t = setup(); seed(t)
    t.say(() => ok(sit(cStat)))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect(r.outcome).toEqual({ kind: 'none', reason: 'consulta-recusada' })
    expect(t.db.events).toEqual([])
  })

  it('656 e 108 no topo da consulta do RECIBO: o mesmo — nada se grava', async () => {
    for (const cStat of ['656', '108']) {
      const t = setup(); seed(t, { receipt: '411000000000001' }, [{ kind: 'P', authority_code: '103', createdAt: '2026-11-24 12:00:00' }])
      t.say(() => ok(rec(cStat)))
      const r = await refreshInvoice(t.deps, ACTOR, REF)
      expect([r.outcome, t.db.events.length]).toEqual([{ kind: 'none', reason: 'consulta-recusada' }, 1])
    }
  })

  it('a rejeição da NOTA (cStat de rejeição no protNFe da nossa chave, no recibo) fecha com R — esta sim é da nota', async () => {
    const t = setup(); seed(t, { receipt: '411000000000001' }, [{ kind: 'P', authority_code: '103', createdAt: '2026-11-24 12:00:00' }])
    t.say(() => ok(rec('104', prot('703', { nProt: false }))))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect(r.outcome).toMatchObject({ kind: 'R', authorityCode: '703' })
    expect(t.db.events[t.db.events.length - 1]).toMatchObject({ kind: 'R', source: 'Q' })
  })

  it('tentativa fechada por F não vira R pela consulta recusada', async () => {
    const t = setup(); seed(t, {}, [{ kind: 'F', authority_code: null }])
    t.say(() => ok(sit('656')))
    await refreshInvoice(t.deps, ACTOR, REF)
    expect(t.db.events.map(e => e.kind)).toEqual(['F'])
  })

  it('o procNFe só é montado sobre o -nfe.xml guardado que AINDA é o que assinamos (o DigestValue relido bate com o da tentativa)', async () => {
    const t = setup(); seed(t, { digestValue: DIGEST })
    t.storage.files.set([...t.storage.files.keys()][0], SIGNED.replace(DIGEST, 'C'.repeat(27) + '='))   // o arquivo foi adulterado depois
    t.say(() => ok(sit('100', prot('100'))))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect(r.outcome.kind).toBe('A')                                                                  // o A é do fisco e é gravado
    expect(hasProc(t)).toBe(false)                                                                    // mas nenhum procNFe sobre um XML que não é o nosso
  })
})

describe('as cotas pinadas e as saídas que o gate adversarial mostrou sem prova (M6, LOW-7)', () => {
  it('as três cotas são as da D-NE254 e do MOC: 6 minutos por chave, 90 segundos por recibo, 15 segundos de espera', () => {
    expect([MIN_KEY_INTERVAL_MS, MIN_RECEIPT_INTERVAL_MS, MIN_RECEIPT_WAIT_MS]).toEqual([360_000, 90_000, 15_000])
  })

  it('o refresh com o transporte caindo (timeout): nada se grava, a tentativa segue em voo e a resposta diz o motivo', async () => {
    const t = setup(); seed(t)
    t.say(() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect([r.outcome.kind, t.db.events]).toEqual(['none', []])
  })

  it('refresh com all: para na 1ª tentativa que o fisco registrou (a mais nova autorizada não consulta as outras)', async () => {
    const t = setup(); seed(t)
    const key2 = saleKey({ cnf: '70531942' })
    t.db.attempts.push({ attempt: 2, lifeEvent: 1, environment: 'H', authorizer: 'PR', accessKey: key2, dhEmission: '2026-11-24 13:16:30', digestValue: DIGEST, receipt: null, protocol: null, dhRecbto: null, lastQueriedAt: null, nfeNotRegisteredAt: null })
    t.say(c => (String(c.body).includes(key2) ? ok(soapEnvelope(`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>100</cStat><xMotivo>m</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto><chNFe>${key2}</chNFe>${prot('100').replace(KEY, key2)}</retConsSitNFe>`)) : ok(sit('217'))))
    const r = await refreshInvoice(t.deps, ACTOR, REF, { all: true })
    expect([r.attempt, r.outcome.kind, t.calls.length]).toEqual([2, 'A', 1])
  })

  it('reconfirm com a última voz P (sem recibo gravado) ou F: recusa sem perguntar', async () => {
    const a = setup(); seed(a, {}, [{ kind: 'P', authority_code: '105' }])
    expect((await reconfirmNotRegistered(a.deps, ACTOR, REF)).reason).toBe('recibo-em-aberto')
    const b = setup(); seed(b, {}, [{ kind: 'F', authority_code: null }])
    expect((await reconfirmNotRegistered(b.deps, ACTOR, REF)).reason).toBe('tentativa-fechada')
    expect([a.calls.length, b.calls.length]).toEqual([0, 0])
  })

  it('o 217 do reconfirm com a voz D sem protocolo e a voz que entrou depois da pergunta: nenhum fato', async () => {
    const t = setup(); seed(t, {}, [])
    t.say(() => { t.db.events.push({ attempt: 1, event: 1, kind: 'D', authority_code: '110', message: 'x', dh: null, source: 'P', createdAt: '2026-11-24 13:29:00' }); return ok(sit('217')) })
    const r = await reconfirmNotRegistered(t.deps, ACTOR, REF)
    expect([r.recorded, t.db.attempts[0].nfeNotRegisteredAt]).toEqual([false, null])
  })
})

describe('o 217 não vale para a tentativa recém-criada e a denegada sem protocolo não fecha (gate adversarial M2 e M3)', () => {
  it('reconfirm de uma tentativa SEM voz criada há menos do mínimo: 429, sem perguntar ao fisco e sem gravar o fato (o envio pode estar no ar)', async () => {
    const t = setup(); seed(t, { createdAt: fmt(new Date(NOW.getTime() - (MIN_ATTEMPT_AGE_BEFORE_217_MS - 1000))) })
    t.say(() => ok(sit('217')))
    await expect(reconfirmNotRegistered(t.deps, ACTOR, REF)).rejects.toMatchObject({ statusCode: 429, code: 'RESOURCE_BUSY' })
    expect([t.calls.length, t.db.attempts[0].nfeNotRegisteredAt]).toEqual([0, null])
    advance(t, 2000)
    expect((await reconfirmNotRegistered(t.deps, ACTOR, REF)).reason).toBe('registrada-agora')
  })

  it('idade ilegível da tentativa sem voz: recusa (falha fechado) — sem perguntar ao fisco e sem gravar o fato', async () => {
    const t = setup(); seed(t, { createdAt: 'ontem' })
    t.say(() => ok(sit('217')))
    await expect(reconfirmNotRegistered(t.deps, ACTOR, REF)).rejects.toMatchObject({ statusCode: 429 })
    expect([t.calls.length, t.db.attempts[0].nfeNotRegisteredAt]).toEqual([0, null])
  })

  it('o mínimo é de 10 minutos (D-NE291)', () => {
    expect(MIN_ATTEMPT_AGE_BEFORE_217_MS).toBe(600_000)
  })

  it('consulta que diz 110 SEM protocolo: nenhuma voz, a saída é consultar a chave — D sem registro liberaria o número', async () => {
    const t = setup(); seed(t)
    t.say(() => ok(sit('110', prot('110', { nProt: false }))))
    const r = await refreshInvoice(t.deps, ACTOR, REF)
    expect([r.outcome, r.next, t.db.events]).toEqual([{ kind: 'none', reason: 'denegada-sem-protocolo' }, 'consult-key', []])
  })

  it('o refresh que pousa A grava o dhRecbto do fisco na tentativa (write-once)', async () => {
    const t = setup(); seed(t)
    t.say(() => ok(sit('100', prot('100'))))
    await refreshInvoice(t.deps, ACTOR, REF)
    expect(t.db.attempts[0].dhRecbto).toBe('2026-11-24 13:20:00')
  })
})

describe('o fonte da reconciliação', () => {
  it('nunca nomeia a coluna do fato (só recordNfeNotRegistered), não toca rede nem relógio por conta própria', () => {
    const src = (require('fs').readFileSync(require('path').resolve(__dirname, '..', 'nfe', 'reconcile.ts'), 'utf8') as string).replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
    for (const banned of [/nfe_not_registered_at/, /\bfetch\(/, /from 'https?'/, /Date\.now\(\)/, /new Date\(\)/, /process\.env/, /rejectUnauthorized/]) expect([banned.source, banned.test(src)]).toEqual([banned.source, false])
  })
})

describe('o gancho pós-autorização pela consulta (NFE.E6.P4 mudança 7; D-NE261) — só a consulta que GRAVOU o A', () => {
  it('a consulta que pousa o A (e guarda o procNFe) dispara o gancho UMA vez; a falha dele não desfaz o A', async () => {
    const hook = jest.fn(async () => { throw new Error('e-mail caiu') })
    const t = setup(); seed(t)
    t.say(() => ok(sit('100', prot('100'))))
    const r = await refreshInvoice({ ...t.deps, onAuthorized: hook }, ACTOR, REF)
    expect(r.outcome.kind).toBe('A')
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0]).toEqual([{ actor: ACTOR, ref: REF, attempt: 1, accessKey: KEY }])
    expect([t.db.events.map(e => e.kind), hasProc(t)]).toEqual([['A'], true])
  })

  it('consulta que só LÊ o A já registrado (nenhuma voz nova) não dispara: o fisco nem é perguntado', async () => {
    const hook = jest.fn(async () => undefined)
    const t = setup(); seed(t, { protocol: '141260000000001', dhRecbto: '2026-11-24 13:20:00' }, [{ kind: 'A', authority_code: '100' }])
    await refreshInvoice({ ...t.deps, onAuthorized: hook }, ACTOR, REF).catch(() => undefined)
    expect(hook).not.toHaveBeenCalled()
  })

  it('digVal divergente, A em tentativa fechada e conflito de gravação única do procNFe NÃO disparam o gancho', async () => {
    const hook = jest.fn(async () => undefined)
    const mism = setup(); seed(mism)
    mism.say(() => ok(sit('100', prot('100', { digVal: 'B'.repeat(27) + '=' }))))
    expect((await refreshInvoice({ ...mism.deps, onAuthorized: hook }, ACTOR, REF)).incident).toBe('digest-mismatch')
    const closed = setup(); seed(closed, {}, [{ kind: 'R', authority_code: '703' }])
    closed.say(() => ok(sit('100', prot('100'))))
    expect((await refreshInvoice({ ...closed.deps, onAuthorized: hook }, ACTOR, REF)).incident).toBe('authorized-in-closed-attempt')
    const conflict = setup(); seed(conflict)
    const nfeKey = [...conflict.storage.files.keys()].find(k => k.endsWith('-nfe.xml')) as string
    conflict.storage.files.set(nfeKey.replace('-nfe.xml', '-procNFe.xml'), 'OUTROS BYTES')
    conflict.say(() => ok(sit('100', prot('100'))))
    expect((await refreshInvoice({ ...conflict.deps, onAuthorized: hook }, ACTOR, REF)).incident).toBe('file-conflict')
    expect(hook).not.toHaveBeenCalled()
  })
})
