/// <reference types="jest" />
/**
 * NFE.E6.P2.T1 (ficha-nfe-e6-p2-cancelar-inutilizar-rodizio.md §7-4; D-NE26, D-NE39, D-NE50, D-NE106, D-NE208, D-NE256; RF-NFE-18/24/80/82/83): o cancelamento 110111 com o FISCO SIMULADO
 * (o `request` injetado) e o banco em memória. Nenhuma chamada de rede; o fisco nunca é chamado com transação aberta.
 */
import type { HttpsCall, InvoiceRef } from 'fiscal-api'
import { invoiceRef, VOICE_READINGS } from 'fiscal-api'
import { cancelInvoice } from '../nfe/cancellation'
import { eventFileName, eventProcFileName } from '../nfe/proc-evento'
import { eventoNFe110111, signEventoNFe } from '../authority/messages'
import { merchandiseFileKey } from '../nfe/fiscal-file'
import type { NfeActor, NfeDeps } from '../nfe/transmission'
import { validateMessage } from '../authority/xsd'
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
const REASON = 'Cancelamento de teste em homologacao'
const H = 3_600_000
const ago = (hours: number): string => fmt(new Date(NOW.getTime() - hours * H))

const retEvento = (cStat: string, o: { chave?: string; lote?: string; nProt?: string | null } = {}) =>
  soapEnvelope(`<retEnvEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb><verAplic>PR</verAplic><cOrgao>41</cOrgao><cStat>${o.lote ?? '128'}</cStat><xMotivo>Lote de Evento Processado</xMotivo>`
    + (o.lote && o.lote !== '128' ? '' : `<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>PR</verAplic><cOrgao>41</cOrgao><cStat>${cStat}</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>`
      + `<chNFe>${o.chave ?? KEY}</chNFe><tpEvento>110111</tpEvento><xEvento>Cancelamento registrado</xEvento><nSeqEvento>1</nSeqEvento><dhRegEvento>${DH}</dhRegEvento>`
      + `${o.nProt === null ? '' : `<nProt>${o.nProt ?? '141260000000077'}</nProt>`}</infEvento></retEvento>`)
    + '</retEnvEvento>')

function setup(attempt: Record<string, unknown> | null = {}, events: Record<string, unknown>[] = [{ kind: 'A' }]) {
  const db = new MemDb()
  db.clock = NOW
  const storage = memStorage()
  const calls: HttpsCall[] = []
  const txAtCall: number[] = []
  let reply: Reply = () => { throw new Error('nenhuma resposta combinada') }
  const a1 = testA1()
  const conn = db.connection()
  const deps = {
    pool: { query: conn.query, getConnection: async () => conn } as never,
    storage: storage as never, catalog: VOICE_READINGS as never, now: () => new Date(db.clock),
    openIssuer: async () => ({ issuer: { environment: 'H' }, cert: a1.cert, key: a1.key, info: { cnpj: '07742094000113' } }) as never,
    zoneOf: async () => 'America/Sao_Paulo', ca: () => undefined,
    request: async (c: HttpsCall) => { calls.push(c); txAtCall.push(db.openTx); return reply(c) },
  } as unknown as NfeDeps
  if (attempt) {
    db.attempts.push({ attempt: 1, lifeEvent: 1, environment: 'H', authorizer: 'PR', accessKey: KEY, dhEmission: '2026-11-24 13:15:30', digestValue: 'A'.repeat(27) + '=',
      receipt: null, protocol: '141260000000001', dhRecbto: ago(2), lastQueriedAt: null, nfeNotRegisteredAt: null, createdAt: ago(3), ...attempt })
    events.forEach((e, i) => db.events.push({ attempt: 1, event: i + 1, authority_code: e.kind === 'A' ? '100' : null, message: null, dh: null, source: 'P', createdAt: ago(2), ...e }))
  }
  return { db, storage, calls, txAtCall, deps, say: (r: Reply) => { reply = r } }
}
type Env = ReturnType<typeof setup>
const run = (t: Env, reason = REASON) => cancelInvoice(t.deps, ACTOR, REF, reason)
const kinds = (t: Env) => t.db.events.map(e => e.kind)
const stored = (t: Env, name: string) => [...t.storage.files.entries()].find(([k]) => k.endsWith(name))?.[1]

describe('cancelar a NF-e autorizada (135/155)', () => {
  it('135: K antes do fisco, C depois (com o 110111, o xMotivo e o dh do fisco), o evento guardado antes do envio e o procEvento depois; o fisco nunca com transação aberta', async () => {
    const t = setup()
    t.say(() => ok(retEvento('135')))
    const r = await run(t)
    expect(r).toMatchObject({ invoiceId: 5001, attempt: 1, atAuthority: true, state: 'cancelled', protocol: '141260000000077', nextStep: 'apply-local-cancel', incident: null, refusedCStat: null, warnings: [] })
    expect(kinds(t)).toEqual(['A', 'K', 'C'])
    const c = t.db.events[2]
    expect([c.authority_code, c.message, c.dh, c.source]).toEqual(['110111', 'Cancelada no fisco: Evento registrado e vinculado a NF-e — protocolo 141260000000077', '2026-11-25 13:00:00', 'P'])
    expect(t.db.events[1].dh).toBeNull()                                                              // K é fato NOSSO
    expect(t.txAtCall).toEqual([0])
    expect(t.calls).toHaveLength(1)
    const ev = stored(t, eventFileName(KEY)) as string
    expect(ev).toContain(`Id="ID110111${KEY}01"`)
    expect(t.calls[0].body).toContain(ev.replace(/^<\?xml[^?]*\?>/, ''))                              // o que foi ao fisco é o que ficou guardado (byte a byte)
    const proc = stored(t, eventProcFileName(KEY)) as string
    expect(await validateMessage('procEventoNFe', proc)).toEqual({ ok: true })
  })

  it('155 também cancela (D-NE208)', async () => {
    const t = setup()
    t.say(() => ok(retEvento('155')))
    expect((await run(t)).state).toBe('cancelled')
    expect(kinds(t)).toEqual(['A', 'K', 'C'])
  })

  it('segundo pedido com a voz C já gravada: idempotente, nada ao fisco', async () => {
    const t = setup({}, [{ kind: 'A' }, { kind: 'K' }, { kind: 'C', authority_code: '110111' }])
    const r = await run(t)
    expect([r.state, r.atAuthority, r.nextStep, t.calls.length]).toEqual(['already-cancelled', false, 'apply-local-cancel', 0])
    expect(kinds(t)).toEqual(['A', 'K', 'C'])
  })
})

describe('quem NÃO cancela no fisco (409, nada enviado, nenhum K)', () => {
  it.each([
    ['denegada', [{ kind: 'D', authority_code: '110' }], 'FISCAL_DENIED'],
    ['rejeitada', [{ kind: 'R', authority_code: '703' }], 'FISCAL_NOT_AUTHORIZED'],
    ['falha', [{ kind: 'F' }], 'FISCAL_NOT_AUTHORIZED'],
    ['em voo (sem voz)', [], 'FISCAL_TRANSMISSION_IN_PROGRESS'],
    ['em processamento (P)', [{ kind: 'P', authority_code: '103' }], 'FISCAL_TRANSMISSION_IN_PROGRESS'],
    ['cancelamento em voo (K)', [{ kind: 'A' }, { kind: 'K' }], 'FISCAL_CANCEL_IN_FLIGHT'],
  ])('%s', async (_label, events, code) => {
    const t = setup({}, events as never)
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code })
    expect([t.calls.length, kinds(t).includes('K') && !events.some(e => e.kind === 'K')]).toEqual([0, false])
  })

  it('nota nunca transmitida: 409 FISCAL_NOT_AUTHORIZED', async () => {
    const t = setup(null)
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_NOT_AUTHORIZED' })
    expect(t.calls).toHaveLength(0)
  })

  it('autorizada sem protocolo ou sem a hora da autorização (não dá para medir a trava): 409, nada enviado', async () => {
    for (const over of [{ protocol: null }, { dhRecbto: null }]) {
      const t = setup(over)
      await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_TRANSMISSION_IN_PROGRESS' })
      expect([t.calls.length, kinds(t)]).toEqual([0, ['A']])
    }
  })
})

describe('a trava de 480 h e o aviso por UF (D-NE256)', () => {
  it('479 h da autorização envia (com o aviso do PR vencido, 168 h); 481 h recusa SEM enviar e sem K', async () => {
    const ok479 = setup({ dhRecbto: ago(479) })
    ok479.say(() => ok(retEvento('155')))
    const r = await run(ok479)
    expect(r.state).toBe('cancelled')
    expect(r.warnings).toEqual([expect.stringMatching(/^FISCAL_CANCEL_DEADLINE: passaram 479 horas .* o prazo de PR é de 168/)])
    const late = setup({ dhRecbto: ago(481) })
    await expect(run(late)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CANCEL_DEADLINE_EXCEEDED' })
    expect([late.calls.length, kinds(late)]).toEqual([0, ['A']])
  })

  it('167 h no PR não avisa; 169 h avisa', async () => {
    const a = setup({ dhRecbto: ago(167) }); a.say(() => ok(retEvento('135')))
    const b = setup({ dhRecbto: ago(169) }); b.say(() => ok(retEvento('135')))
    expect((await run(a)).warnings).toEqual([])
    expect((await run(b)).warnings).toHaveLength(1)
  })
})

describe('o motivo (xJust, 15 a 255)', () => {
  it('14 e 256 caracteres → 422, nada enviado; 15 e 255 passam', async () => {
    for (const bad of ['a'.repeat(14), 'a'.repeat(256), ' ' + 'a'.repeat(20), 'motivo com <tag> aqui!!']) {
      const t = setup()
      await expect(run(t, bad)).rejects.toMatchObject({ statusCode: 422 })
      expect([t.calls.length, kinds(t)]).toEqual([0, ['A']])
    }
    for (const good of ['a'.repeat(15), 'a'.repeat(255)]) {
      const t = setup(); t.say(() => ok(retEvento('135')))
      expect((await run(t, good)).state).toBe('cancelled')
    }
  })
})

describe('o que NÃO cancela: rejeição libera (N), ambíguo mantém K', () => {
  it('501 (fora do prazo) libera a reserva com N e vira 409 FISCAL_CANCEL_REFUSED; o 2º pedido gera um evento NOVO (outro dhEvento, outro arquivo -r1) e cancela', async () => {
    const t = setup()
    t.say(() => ok(retEvento('501')))
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CANCEL_REFUSED' })
    expect(kinds(t)).toEqual(['A', 'K', 'N'])
    const first = stored(t, eventFileName(KEY)) as string
    t.db.clock = new Date(NOW.getTime() + 60_000)                                                       // outro instante: o evento novo leva outro dhEvento
    t.say(() => ok(retEvento('135')))
    const r = await run(t, 'Motivo novo do cancelamento em homologacao')
    expect(r.state).toBe('cancelled')
    expect(kinds(t)).toEqual(['A', 'K', 'N', 'K', 'C'])
    const second = stored(t, eventFileName(KEY, '110111', 1, 1)) as string
    expect(second).not.toBe(first)                                                                      // evento NOVO: a rejeição causada por ele mesmo não prende a nota
    expect(second).toContain('Motivo novo do cancelamento em homologacao')                              // o motivo de agora vale (não o antigo)
    expect(stored(t, eventFileName(KEY))).toBe(first)                                                   // o primeiro segue guardado, intacto
    expect(t.calls[1].body).toContain(second.replace(/^<\?xml[^?]*\?>/, ''))
    expect(await validateMessage('procEventoNFe', stored(t, eventProcFileName(KEY, '110111', 1, 1)) as string)).toEqual({ ok: true })
  })

  it('sobra de uma reserva desfeita (o evento guardado do nome existe e NUNCA foi ao fisco): o pedido o reaproveita byte a byte', async () => {
    const t = setup()
    const planted = signEventoNFe(eventoNFe110111({ tpAmb: '2', uf: 'PR', cnpj: KEY.slice(6, 20), chNFe: KEY, dhEvento: '2026-11-25T09:00:00-03:00', nProt: '141260000000001', xJust: REASON }), testA1().cert, testA1().key)
    t.storage.files.set(`${KEY.slice(6, 20)}/H/${Number(KEY.slice(22, 25))}/${eventFileName(KEY)}`, planted)
    t.say(() => ok(retEvento('135')))
    expect((await run(t)).state).toBe('cancelled')
    expect(stored(t, eventFileName(KEY))).toBe(planted)
    expect(t.calls[0].body).toContain(planted.replace(/^<\?xml[^?]*\?>/, ''))
  })

  it.each([['136'], ['573'], ['580']])('%s é ambíguo: o K FICA e a saída é consultar a chave (D-NE208)', async cStat => {
    const t = setup()
    t.say(() => ok(retEvento(cStat)))
    const r = await run(t)
    expect([r.state, r.atAuthority, r.nextStep, r.refusedCStat]).toEqual(['in-flight', false, 'consult-key', null])
    expect(kinds(t)).toEqual(['A', 'K'])
  })

  it('656 no lote: o serviço recusou — K mantido e o cStat vai ao disjuntor, nunca N', async () => {
    const t = setup()
    t.say(() => ok(retEvento('656', { lote: '656' })))
    const r = await run(t)
    expect([r.state, r.refusedCStat, kinds(t)]).toEqual(['in-flight', '656', ['A', 'K']])
  })

  it('timeout, HTTP 500 e resposta sem eco mantêm o K', async () => {
    for (const scripted of [
      () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
      () => ({ status: 500, headers: {}, text: 'erro interno' }),
      () => ok(retEvento('135', { chave: KEY.slice(0, 43) + '0' })),
    ] as Reply[]) {
      const t = setup()
      t.say(scripted)
      const r = await run(t)
      expect([r.state, r.nextStep, kinds(t)]).toEqual(['in-flight', 'consult-key', ['A', 'K']])
    }
  })

  it('um 2º pedido com o K mantido é barrado: 409 FISCAL_CANCEL_IN_FLIGHT, sem 2º envio', async () => {
    const t = setup()
    t.say(() => ok(retEvento('136')))
    await run(t)
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CANCEL_IN_FLIGHT' })
    expect(t.calls).toHaveLength(1)
  })
})

describe('a gravação única do arquivo fiscal', () => {
  it('o procEventoNFe já existe com OUTROS bytes: o C fica gravado e o resultado leva incident file-conflict (nunca silêncio)', async () => {
    const t = setup()
    t.say(() => ok(retEvento('135')))
    const real = t.storage.save
    t.storage.save = ((key: any, name: string, xml: string, when?: Date) => {
      if (name.endsWith('-proc.xml')) t.storage.files.set(`${key.cnpj}/${key.environment}/${key.serie}/${name}`, 'OUTROS BYTES')
      return real(key, name, xml, when)
    }) as never
    const r = await run(t)
    expect([r.state, r.incident, kinds(t)]).toEqual(['cancelled', 'file-conflict', ['A', 'K', 'C']])
  })

  it('a chave do arquivo é a da tentativa (CNPJ da chave, série, ambiente H)', async () => {
    const t = setup()
    t.say(() => ok(retEvento('135')))
    await run(t)
    const key = merchandiseFileKey({ cnpj: KEY.slice(6, 20), model: '55', serie: Number(KEY.slice(22, 25)), environment: 'H', zone: 'America/Sao_Paulo' })
    expect([...t.storage.files.keys()].every(k => k.startsWith(`${key.cnpj}/H/`))).toBe(true)
  })
})
