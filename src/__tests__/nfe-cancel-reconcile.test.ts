/// <reference types="jest" />
/**
 * NFE.E6.P2.T3 (ficha-nfe-e6-p2-cancelar-inutilizar-rodizio.md §7-6; S3, S5; D-NE209, D-NE254; RF-NFE-17/74/84): o cancelamento em voo (K) reconciliado pela CONSULTA da chave, o disjuntor
 * contra o 656 e o rodízio (`refreshAll`). Fisco simulado pelo `request` injetado; banco em memória.
 */
import type { HttpsCall, InvoiceRef } from 'fiscal-api'
import { invoiceRef, VOICE_READINGS } from 'fiscal-api'
import { Breaker, BREAKER_BLOCK_MS, BREAKER_WINDOW_MS } from '../nfe/breaker'
import { MIN_CANCEL_REQUEST_AGE_BEFORE_RELEASE_MS, MIN_KEY_INTERVAL_MS, refreshInvoice, type ReconcileDeps } from '../nfe/reconcile'
import { ROUNDROBIN_AGE_MARGIN_HOURS, refreshAll } from '../nfe/refresh-all'
import { cancelInvoice } from '../nfe/cancellation'
import { eventFileName, eventProcFileName } from '../nfe/proc-evento'
import { eventoNFe110111, signEventoNFe } from '../authority/messages'
import { validateMessage } from '../authority/xsd'
import type { NfeActor, NfeDeps } from '../nfe/transmission'
import { NS } from './xsd-fixtures'
import { saleKey } from './nfe-fixtures'
import { MemDb, fmt, memStorage, ok, soapEnvelope, type Reply } from './nfe-memdb'
import { testA1 } from './test-a1'

jest.setTimeout(120_000)

const ACTOR: NfeActor = { institutionId: 98, schemaName: 'setes_x', userId: 7 }
const REF: InvoiceRef = invoiceRef(98, 5001, 0)
const NOW = new Date('2026-11-25T13:00:00Z')
const DH = '2026-11-25T10:00:00-03:00'
const KEY = saleKey()
const H = 3_600_000
const MIN = 60_000
const ago = (ms: number): string => fmt(new Date(NOW.getTime() - ms))

const procEvento = (cStat = '135') =>
  `<procEventoNFe versao="1.00"><evento versao="1.00"><infEvento Id="ID110111${KEY}01"><tpEvento>110111</tpEvento></infEvento></evento><retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>PR</verAplic><cOrgao>41</cOrgao>`
  + `<cStat>${cStat}</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><chNFe>${KEY}</chNFe><tpEvento>110111</tpEvento><xEvento>Cancelamento registrado</xEvento><nSeqEvento>1</nSeqEvento>`
  + `<dhRegEvento>${DH}</dhRegEvento><nProt>141260000000077</nProt></infEvento></retEvento></procEventoNFe>`
const sit = (cStat: string, inner = '') =>
  soapEnvelope(`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>m</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto><chNFe>${KEY}</chNFe>${inner}</retConsSitNFe>`)
const authorizedProt = `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>PR</verAplic><chNFe>${KEY}</chNFe><dhRecbto>${DH}</dhRecbto><nProt>141260000000001</nProt><digVal>${'A'.repeat(27)}=</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>`

function setup(events: Record<string, unknown>[]) {
  const db = new MemDb()
  db.clock = NOW
  const storage = memStorage()
  const calls: HttpsCall[] = []
  let reply: Reply = () => { throw new Error('nenhuma resposta combinada') }
  const a1 = testA1()
  const conn = db.connection()
  const breaker = new Breaker(() => new Date(db.clock))
  const baseQuery = conn.query
  // o rodízio lista as tentativas ABERTAS: o banco em memória é de UMA nota (5001) — devolve-a no formato da consulta de candidatas
  const query = async (sql: string, params: unknown[] = []): Promise<[any, any]> => {
    if (/AS invoiceId/.test(sql)) {
      const open = db.attempts.map(a => {
        const evs = db.events.filter(e => e.attempt === a.attempt)
        const last = evs[evs.length - 1]
        return { invoiceId: 5001, terminal: 0, attempt: a.attempt, accessKey: a.accessKey, environment: a.environment, lastKind: last?.kind ?? null, since: last?.createdAt ?? a.createdAt }
      }).filter(r => r.lastKind === null || r.lastKind === 'P' || r.lastKind === 'K')
      return [open, []]
    }
    return baseQuery(sql, params)
  }
  const deps = {
    pool: { query, getConnection: async () => ({ ...conn, query }) } as never,
    storage: storage as never, catalog: VOICE_READINGS as never, now: () => new Date(db.clock), breaker,
    openIssuer: async () => ({ issuer: { environment: 'H' }, cert: a1.cert, key: a1.key, info: { cnpj: '07742094000113' } }) as never,
    zoneOf: async () => 'America/Sao_Paulo', ca: () => undefined,
    request: async (c: HttpsCall) => { calls.push(c); return reply(c) },
  } as unknown as NfeDeps & ReconcileDeps
  db.attempts.push({ attempt: 1, lifeEvent: 1, environment: 'H', authorizer: 'PR', accessKey: KEY, dhEmission: '2026-11-24 13:15:30', digestValue: 'A'.repeat(27) + '=',
    receipt: null, protocol: '141260000000001', dhRecbto: ago(2 * H), lastQueriedAt: null, nfeNotRegisteredAt: null, createdAt: ago(3 * H) })
  events.forEach((e, i) => db.events.push({ attempt: 1, event: i + 1, authority_code: e.kind === 'A' ? '100' : null, message: null, dh: null, source: 'P', createdAt: ago(2 * H), ...e }))
  return { db, storage, calls, deps, breaker, say: (r: Reply) => { reply = r } }
}
type Env = ReturnType<typeof setup>
const kinds = (t: Env) => t.db.events.map(e => e.kind)
const refresh = (t: Env) => refreshInvoice(t.deps, ACTOR, REF)

describe('o K (cancelamento em voo) reconciliado pela consulta da chave (S5)', () => {
  it('a consulta diz cancelada COM o retEvento 135: a voz C com o 110111, o dh e o motivo do fisco', async () => {
    const t = setup([{ kind: 'A' }, { kind: 'K' }])
    t.say(() => ok(sit('101', procEvento())))
    const r = await refresh(t)
    expect(r.outcome).toEqual({ kind: 'cancelled', authorityCode: '110111' })
    expect(kinds(t)).toEqual(['A', 'K', 'C'])
    const c = t.db.events[2]
    expect([c.authority_code, c.dh, c.source, c.message]).toEqual(['110111', '2026-11-25 13:00:00', 'Q', 'Cancelada no fisco: Evento registrado e vinculado a NF-e — protocolo 141260000000077'])
  })

  it('gate adversarial H1: a C pela consulta guarda a PROVA — o procEventoNFe montado com o NOSSO evento guardado (o mais recente, -r<n>) e o retEvento da consulta', async () => {
    const t = setup([{ kind: 'A' }, { kind: 'K' }, { kind: 'N' }, { kind: 'K' }])
    const ev = (dh: string) => signEventoNFe(eventoNFe110111({ tpAmb: '2', uf: 'PR', cnpj: KEY.slice(6, 20), chNFe: KEY, dhEvento: dh, nProt: '141260000000001', xJust: 'Cancelamento de teste em homologacao' }), testA1().cert, testA1().key)
    const dir = `${KEY.slice(6, 20)}/H/${Number(KEY.slice(22, 25))}`
    t.storage.files.set(`${dir}/${eventFileName(KEY)}`, ev('2026-11-25T08:00:00-03:00'))
    const latest = ev('2026-11-25T09:00:00-03:00')
    t.storage.files.set(`${dir}/${eventFileName(KEY, '110111', 1, 1)}`, latest)
    t.say(() => ok(sit('101', procEvento())))
    const r = await refresh(t)
    expect([r.outcome.kind, r.incident]).toEqual(['cancelled', null])
    const proc = t.storage.files.get(`${dir}/${eventProcFileName(KEY, '110111', 1, 1)}`) as string
    expect(proc).toContain(latest.replace(/^<\?xml[^?]*\?>/, ''))
    expect(await validateMessage('procEventoNFe', proc)).toEqual({ ok: true })
    expect(t.db.events[4].message).toMatch(/protocolo 141260000000077$/)                                  // o nProt do evento também no rastro
  })

  it('cancelada SEM o retEvento: C com dh nulo e o texto da consulta; 151 também; um C só (a 2ª consulta não duplica)', async () => {
    const t = setup([{ kind: 'A' }, { kind: 'K' }])
    t.say(() => ok(sit('151')))
    await refresh(t)
    expect(t.db.events[2]).toMatchObject({ kind: 'C', authority_code: '110111', dh: null, message: 'Cancelada no fisco (confirmada pela consulta)' })
  })

  it('MESMO depois do N (a reserva liberada), o 101 da consulta grava o C: a nota está cancelada no fisco', async () => {
    const t = setup([{ kind: 'A' }, { kind: 'K' }, { kind: 'N' }])
    t.say(() => ok(sit('101', procEvento('155'))))
    const r = await refresh(t)
    expect(r.outcome.kind).toBe('cancelled')
    expect(kinds(t)).toEqual(['A', 'K', 'N', 'C'])
  })

  it('autorizada (100) com o K ainda dentro da carência de 10 min: nada muda; depois dela, a reserva é liberada com N e a nota segue autorizada', async () => {
    const young = setup([{ kind: 'A' }, { kind: 'K', createdAt: ago(MIN_CANCEL_REQUEST_AGE_BEFORE_RELEASE_MS - 1000) }])
    young.say(() => ok(sit('100', authorizedProt)))
    expect((await refresh(young)).outcome).toEqual({ kind: 'none', reason: 'cancelamento-em-voo' })
    expect(kinds(young)).toEqual(['A', 'K'])
    const old = setup([{ kind: 'A' }, { kind: 'K', createdAt: ago(MIN_CANCEL_REQUEST_AGE_BEFORE_RELEASE_MS) }])
    old.say(() => ok(sit('100', authorizedProt)))
    expect((await refresh(old)).outcome).toEqual({ kind: 'none', reason: 'cancelamento-nao-confirmado' })
    expect(kinds(old)).toEqual(['A', 'K', 'N'])
    expect(old.db.events[2].message).toMatch(/segue autorizada/)
  })

  it('ambíguo (timeout, HTTP 500, 217, recusa da pergunta): o K FICA, nada é gravado', async () => {
    for (const scripted of [
      () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
      () => ({ status: 500, headers: {}, text: 'erro interno' }),
      () => ok(sit('217')),
      () => ok(sit('656')),
    ] as Reply[]) {
      const t = setup([{ kind: 'A' }, { kind: 'K', createdAt: ago(H) }])
      t.say(scripted)
      await refresh(t)
      expect(kinds(t)).toEqual(['A', 'K'])
    }
  })

  it('a voz mudou durante a pergunta (outra rota gravou): nada se grava', async () => {
    const t = setup([{ kind: 'A' }, { kind: 'K' }])
    t.say(() => { t.db.events.push({ attempt: 1, event: 3, kind: 'C', authority_code: '110111', message: 'x', dh: null, source: 'P', createdAt: fmt(NOW) }); return ok(sit('101')) })
    const r = await refresh(t)
    expect([r.outcome, kinds(t)]).toEqual([{ kind: 'none', reason: 'voz-mudou-depois-da-pergunta' }, ['A', 'K', 'C']])
  })
})

describe('o disjuntor contra o 656 (D-NE254, RF-NFE-84)', () => {
  const scope = { cnpj: '07742094000113', environment: 'H', service: 'evento' } as const
  const make = () => { const clock = { t: NOW.getTime() }; return { clock, b: new Breaker(() => new Date(clock.t)) } }

  it('até 20 rejeições IGUAIS passam; a 21ª é barrada (evento e inutilização); a autorização tem 30', () => {
    for (const [service, limit] of [['evento', 20], ['inutilizacao', 20], ['autorizacao', 30]] as const) {
      const { b } = make()
      const s = { ...scope, service }
      for (let i = 0; i < limit; i++) { expect(() => b.check(s)).not.toThrow(); b.recordRejection(s, '501') }
      expect(() => b.check(s)).toThrow(expect.objectContaining({ statusCode: 429, code: 'RESOURCE_BUSY' }))
    }
  })

  it('cStat diferentes não se somam; o serviço, o ambiente e o CNPJ são independentes; a hora passa e libera', () => {
    const { clock, b } = make()
    for (let i = 0; i < 19; i++) { b.recordRejection(scope, '501'); b.recordRejection(scope, '222') }
    expect(() => b.check(scope)).not.toThrow()
    b.recordRejection(scope, '501')
    expect(() => b.check(scope)).toThrow(/20 rejeições iguais/)
    expect(() => b.check({ ...scope, service: 'inutilizacao' })).not.toThrow()
    expect(() => b.check({ ...scope, environment: 'P' })).not.toThrow()
    expect(() => b.check({ ...scope, cnpj: '11111111000191' })).not.toThrow()
    clock.t += BREAKER_WINDOW_MS
    expect(() => b.check(scope)).not.toThrow()
  })

  it('108, 109 e 999 abrem só a CONSULTA (o rodízio para de perguntar), nunca o evento nem a inutilização; o 656 abre qualquer um', () => {
    const { b } = make()
    for (const c of ['108', '109', '999']) { b.recordRefused(scope, c); b.recordRefused({ ...scope, service: 'inutilizacao' }, c) }
    expect(b.isOpen(scope)).toBe(false)
    expect(b.isOpen({ ...scope, service: 'inutilizacao' })).toBe(false)
    b.recordRefused({ ...scope, service: 'consulta' }, '108')
    expect(b.isOpen({ ...scope, service: 'consulta' })).toBe(true)
    b.recordRefused({ ...scope, service: 'inutilizacao' }, '656')
    expect(b.isOpen({ ...scope, service: 'inutilizacao' })).toBe(true)
  })

  it('o 656 devolvido abre o serviço por 1 hora e só ele; depois da hora fecha', () => {
    const { clock, b } = make()
    b.recordRefused(scope, '656')
    expect(b.isOpen(scope)).toBe(true)
    expect(() => b.check(scope)).toThrow(expect.objectContaining({ statusCode: 429 }))
    expect(() => b.check({ ...scope, service: 'consulta' })).not.toThrow()
    clock.t += BREAKER_BLOCK_MS - 1
    expect(() => b.check(scope)).toThrow()
    clock.t += 1
    expect(() => b.check(scope)).not.toThrow()
    expect(b.isOpen(scope)).toBe(false)
  })

  it('no cancelamento: o 656 devolvido mantém o K e abre o disjuntor; o pedido seguinte é 429 sem ir ao fisco e sem reservar', async () => {
    const t = setup([{ kind: 'A' }])
    t.say(() => ok(soapEnvelope(`<retEnvEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb><verAplic>PR</verAplic><cOrgao>41</cOrgao><cStat>656</cStat><xMotivo>Consumo Indevido</xMotivo></retEnvEvento>`)))
    const r = await cancelInvoice(t.deps, ACTOR, REF, 'Cancelamento de teste em homologacao')
    expect([r.state, r.refusedCStat, kinds(t)]).toEqual(['in-flight', '656', ['A', 'K']])
    t.db.events.push({ attempt: 1, event: 3, kind: 'N', authority_code: null, message: 'x', dh: null, source: 'P', createdAt: fmt(NOW) })   // o usuário liberou o K, quer tentar de novo
    const before = t.calls.length
    await expect(cancelInvoice(t.deps, ACTOR, REF, 'Cancelamento de teste em homologacao')).rejects.toMatchObject({ statusCode: 429, code: 'RESOURCE_BUSY' })
    expect([t.calls.length, kinds(t)]).toEqual([before, ['A', 'K', 'N']])
  })

  it('no cancelamento: 20 rejeições iguais (501) na hora passam; a 21ª tentativa é barrada antes de reservar', async () => {
    const t = setup([{ kind: 'A' }])
    t.say(() => ok(soapEnvelope(`<retEnvEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb><verAplic>PR</verAplic><cOrgao>41</cOrgao><cStat>128</cStat><xMotivo>Lote</xMotivo>`
      + `<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>PR</verAplic><cOrgao>41</cOrgao><cStat>501</cStat><xMotivo>Rejeicao: prazo</xMotivo><chNFe>${KEY}</chNFe><tpEvento>110111</tpEvento><xEvento>x</xEvento><nSeqEvento>1</nSeqEvento><dhRegEvento>${DH}</dhRegEvento></infEvento></retEvento></retEnvEvento>`)))
    for (let i = 0; i < 20; i++) await expect(cancelInvoice(t.deps, ACTOR, REF, 'Cancelamento de teste em homologacao')).rejects.toMatchObject({ code: 'FISCAL_CANCEL_REFUSED' })
    const before = t.calls.length
    await expect(cancelInvoice(t.deps, ACTOR, REF, 'Cancelamento de teste em homologacao')).rejects.toMatchObject({ statusCode: 429 })
    expect(t.calls.length).toBe(before)
  })
})

describe('o rodízio (refreshAll — S3, teto de idade, disjuntor)', () => {
  it('consulta a tentativa aberta (K) e a reconcilia; o relatório diz o que fez', async () => {
    const t = setup([{ kind: 'A' }, { kind: 'K', createdAt: ago(H) }])
    t.say(() => ok(sit('101', procEvento())))
    const rep = await refreshAll(t.deps, ACTOR)
    expect(rep).toMatchObject({ scanned: 1, consulted: 1, throttled: 0, tooOld: 0, circuitOpen: false, changed: 1, incidents: [] })
    expect(kinds(t)).toEqual(['A', 'K', 'C'])
  })

  it('sem voz ou em P (o envio que pode ter sido autorizado) o teto é de 7 dias, não o do cancelamento: 6 dias é consultada, 8 dias não', async () => {
    const inside = setup([]); inside.db.attempts[0].protocol = null
    inside.db.attempts[0].createdAt = ago(6 * 24 * H)
    inside.say(() => ok(sit('217')))
    expect((await refreshAll(inside.deps, ACTOR)).consulted).toBe(1)
    const outside = setup([]); outside.db.attempts[0].protocol = null
    outside.db.attempts[0].createdAt = ago(8 * 24 * H)
    outside.say(() => ok(sit('217')))
    const rep = await refreshAll(outside.deps, ACTOR)
    expect([rep.consulted, rep.tooOld, outside.calls.length]).toEqual([0, 1, 0])
  })

  it('o teto de idade: aberta há mais que o prazo da UF (PR 168 h) + a margem não é consultada pelo rodízio', async () => {
    const t = setup([{ kind: 'A' }, { kind: 'K', createdAt: ago((168 + ROUNDROBIN_AGE_MARGIN_HOURS) * H + MIN) }])
    t.say(() => ok(sit('101')))
    const rep = await refreshAll(t.deps, ACTOR)
    expect([rep.scanned, rep.consulted, rep.tooOld, t.calls.length]).toEqual([1, 0, 1, 0])
    const inside = setup([{ kind: 'A' }, { kind: 'K', createdAt: ago((168 + ROUNDROBIN_AGE_MARGIN_HOURS) * H - MIN) }])
    inside.say(() => ok(sit('101')))
    expect((await refreshAll(inside.deps, ACTOR)).consulted).toBe(1)
  })

  it('a cota por chave (6 min) é respeitada: tentativa consultada há pouco conta como throttled, sem ir ao fisco', async () => {
    const t = setup([{ kind: 'A' }, { kind: 'K' }])
    t.db.attempts[0].lastQueriedAt = ago(MIN_KEY_INTERVAL_MS - 1000)
    t.say(() => ok(sit('101')))
    const rep = await refreshAll(t.deps, ACTOR)
    expect([rep.consulted, rep.throttled, t.calls.length]).toEqual([0, 1, 0])
  })

  it('a consulta recusada pelo serviço (656) abre o disjuntor e a passada PARA; a seguinte nem pergunta', async () => {
    const t = setup([{ kind: 'A' }, { kind: 'K', createdAt: ago(H) }])
    t.say(() => ok(sit('656')))
    const first = await refreshAll(t.deps, ACTOR)
    expect([first.consulted, first.circuitOpen, t.calls.length]).toEqual([1, true, 1])
    t.db.attempts[0].lastQueriedAt = null
    const second = await refreshAll(t.deps, ACTOR)
    expect([second.consulted, second.circuitOpen, t.calls.length]).toEqual([0, true, 1])
  })

  it('a consulta da nota recusa com 409 (a nota mudou de vida, foi apagada): pulada, a passada NÃO aborta; a lista pede só a última tentativa de cada nota e o maior teto', async () => {
    const t = setup([{ kind: 'A' }, { kind: 'K', createdAt: ago(H) }])
    const { HttpError } = jest.requireActual('fiscal-api')
    const rep = await refreshAll(t.deps, ACTOR, {}, async () => { throw new HttpError(409, 'A nota não tem tentativa de transmissão', undefined, 'FISCAL_NOT_TRANSMITTED') })
    expect([rep.scanned, rep.consulted, rep.skipped, rep.circuitOpen]).toEqual([1, 0, 1, false])
    await expect(refreshAll(t.deps, ACTOR, {}, async () => { throw new Error('defeito') })).rejects.toThrow('defeito')   // o que não é 409/429 sobe
  })

  it('sem tentativa aberta (autorizada e cancelada): nada a olhar', async () => {
    const t = setup([{ kind: 'A' }, { kind: 'K' }, { kind: 'C', authority_code: '110111' }])
    const rep = await refreshAll(t.deps, ACTOR)
    expect([rep.scanned, rep.consulted, t.calls.length]).toEqual([0, 0, 0])
  })
})
