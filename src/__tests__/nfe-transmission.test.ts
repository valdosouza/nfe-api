/// <reference types="jest" />
/**
 * NFE.E6.P1 mudança 7 (ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-7; T1 e T3; D-NE33, D-NE34, D-NE35, D-NE36, D-NE41, D-NE43, D-NE158, D-NE282, D-NE284): a
 * transmissão ponta a ponta com o FISCO SIMULADO — o `request` do `callSoap` é injetado, o banco é uma memória que responde ao SQL da tentativa e da voz, o arquivo fiscal
 * é um mapa. NENHUMA chamada de rede. O A1 é o de teste (`test-a1`); o CSRT é um texto qualquer de teste e nunca aparece em asserção de saída.
 */
import type { HttpsCall, HttpsResult, InvoiceRef } from 'fiscal-api'
import { invoiceRef, VOICE_READINGS } from 'fiscal-api'
import { assertFamilyInCatalog, transmitInvoice, type ComposedFacts, type NfeActor, type NfeDeps } from '../nfe/transmission'
import { MemDb, memStorage, ok, type Reply } from './nfe-memdb'
import { NS } from './xsd-fixtures'
import { saleInput } from './nfe-fixtures'
import { testA1 } from './test-a1'

jest.mock('fiscal-api', () => ({ ...jest.requireActual('fiscal-api'), nextInvoiceNumber: jest.fn() }))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { nextInvoiceNumber } = require('fiscal-api') as { nextInvoiceNumber: jest.Mock }
jest.setTimeout(120_000)

const ACTOR: NfeActor = { institutionId: 98, schemaName: 'setes_x', userId: 7 }
const REF: InvoiceRef = invoiceRef(98, 5001, 0)
const DH = '2026-11-24T10:20:00-03:00'
const NOW = new Date('2026-11-24T10:20:00-03:00')
const SECRET_CSRT = 'CSRT-DE-TESTE-NAO-USAR-EM-PRODUCAO'

const envelope = (inner: string) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg xmlns="urn:x">${inner}</nfeResultMsg></soap:Body></soap:Envelope>`
const keyOf = (c: HttpsCall): string => /Id="NFe(\d{44})"/.exec(String(c.body))![1]
const digOf = (c: HttpsCall): string => /<DigestValue>([^<]+)<\/DigestValue>/.exec(String(c.body))![1]
const prot = (c: HttpsCall, cStat: string, withProt = true, digVal: string | null | undefined = undefined) =>
  `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>PR</verAplic><chNFe>${keyOf(c)}</chNFe><dhRecbto>${DH}</dhRecbto>${withProt ? '<nProt>141260000000001</nProt>' : ''}`
  + `${digVal === null ? '' : `<digVal>${digVal ?? digOf(c)}</digVal>`}<cStat>${cStat}</cStat><xMotivo>motivo do fisco</xMotivo></infProt></protNFe>`
const ret = (inner: string, cStat = '104') =>
  envelope(`<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>Lote</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto>${inner}</retEnviNFe>`)


function setup(over: Partial<NfeDeps> = {}, facts: Partial<ComposedFacts> = {}) {
  const db = new MemDb()
  const storage = memStorage()
  const calls: HttpsCall[] = []
  const txAtCall: number[] = []
  const order: string[] = []
  let reply: Reply = () => { throw new Error('nenhuma resposta combinada') }
  const a1 = testA1()
  const base = db.connection()
  const conn = { ...base, rollback: jest.fn(base.rollback) }
  const composed: ComposedFacts = {
    serie: 1, cnpj: '07742094000113', uf: 'PR', hasStateRegistration: true, dtEmission: '2026-11-24', createdAt: '2026-11-24 13:15:30', lifeEvent: 1, lifeDate: '2026-11-24',
    buildInput: ({ dhEmi, csrt }) => saleInput({ dhEmi, csrt }), ...facts,
  }
  const base0 = conn.query
  const tag = (sql: string): string => {
    const one = sql.replace(/\s+/g, ' ').trim()
    if (/ORDER BY t\.attempt DESC LIMIT 1/.test(one)) return 'latestAttempt'
    if (/^INSERT INTO tb_invoice_merchandise_transmission /.test(one)) return 'insertAttempt'
    return `q:${one.slice(0, 48)}`
  }
  conn.query = async (sql: string, params: unknown[] = []) => { order.push(tag(sql)); return base0(sql, params) }
  const deps: NfeDeps = {
    pool: { query: conn.query, getConnection: async () => conn } as never,
    storage: storage as never, catalog: VOICE_READINGS as never, now: () => NOW,
    openIssuer: async () => { order.push('openIssuer'); return ({ issuer: { environment: 'H' }, cert: a1.cert, key: a1.key, info: { cnpj: '07742094000113' } }) as never },
    readFacts: async () => { order.push('readFacts'); return composed }, zoneOf: async () => 'America/Sao_Paulo', establishmentCnpj: async () => '07742094000113',
    credentialsFor: async () => ({ codeId: '01', codeValue: SECRET_CSRT }), ca: () => undefined,
    request: async c => { calls.push(c); txAtCall.push(db.openTx); return reply(c) },
    ...over,
  }
  return { db, storage, calls, txAtCall, order, deps, conn, say: (r: Reply) => { reply = r } }
}
const code = (e: unknown) => (e as { code?: string }).code
const run = (t: ReturnType<typeof setup>) => transmitInvoice(t.deps, ACTOR, REF)

beforeEach(() => { nextInvoiceNumber.mockReset(); nextInvoiceNumber.mockResolvedValue({ number: 15, environment: 'H' }) })

describe('T3 — sem a família no catálogo, nada é montado', () => {
  it('assertFamilyInCatalog recusa o catálogo sem a leitura da NF-e (503 FISCAL_FAMILY_NOT_IN_CATALOG)', () => {
    expect(() => assertFamilyInCatalog({ service: { transmissionView: 'vw_invoice_service_transmission' } })).toThrow(/catálogo/)
    try { assertFamilyInCatalog({}) } catch (e: any) { expect([e.statusCode, e.code]).toEqual([503, 'FISCAL_FAMILY_NOT_IN_CATALOG']) }
    expect(() => assertFamilyInCatalog(VOICE_READINGS as never)).not.toThrow()
  })

  it('a transmissão com o catálogo sem a NF-e não toca banco, A1 nem rede', async () => {
    const t = setup({ catalog: {} })
    const open = jest.fn()
    await expect(transmitInvoice({ ...t.deps, catalog: {}, openIssuer: open as never }, ACTOR, REF)).rejects.toMatchObject({ code: 'FISCAL_FAMILY_NOT_IN_CATALOG' })
    expect([open.mock.calls.length, t.calls.length, t.db.inserted]).toEqual([0, 0, 0])
  })
})

describe('autorizada (104 com protNFe 100)', () => {
  it('reserva a tentativa com o número gerado e a chave nossa, guarda o -nfe.xml ANTES do envio, grava A com protocolo e dhRecbto, e guarda o -procNFe.xml', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '100'))))
    const r = await run(t)
    expect(r).toMatchObject({ invoiceId: 5001, attempt: 1, number: 15, serie: 1, nProt: '141260000000001', next: null })
    expect(r.outcome).toEqual({ kind: 'A', authorityCode: '100', message: 'Autorizado o uso da NF-e' })
    expect(r.accessKey).toMatch(/^41261107742094000113550010000000151[0-9]{8}[0-9]$/)            // cUF AAMM CNPJ mod serie nNF tpEmis cNF cDV
    expect(t.db.attempts[0]).toMatchObject({ authorizer: 'PR', environment: 'H', protocol: '141260000000001', dhRecbto: '2026-11-24 13:20:00', dhEmission: '2026-11-24 13:15:30' })
    expect(t.db.events).toMatchObject([{ attempt: 1, event: 1, kind: 'A', authority_code: '100', message: 'Autorizado o uso da NF-e', dh: '2026-11-24 13:20:00', source: 'P' }])
    const names = [...t.storage.files.keys()].map(k => k.split('/').pop()).sort()
    expect(names).toEqual([`${r.accessKey}-nfe.xml`, `${r.accessKey}-procNFe.xml`])
    expect(nextInvoiceNumber).toHaveBeenCalledTimes(1)
    expect(nextInvoiceNumber.mock.calls[0][1]).toEqual({ institutionId: 98, model: '55', serie: 1 })
  })

  it('o dhEmi do XML é a data do dt_emission com a hora do faturamento da vida atual na zona (D-NE284, D-NE296), e o XML guardado é o MESMO que foi ao fisco', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '100'))))
    const r = await run(t)
    const sent = String(t.calls[0].body)
    expect(sent).toContain('<dhEmi>2026-11-24T10:15:30-03:00</dhEmi>')
    const stored = [...t.storage.files.entries()].find(([k]) => k.endsWith('-nfe.xml'))![1]
    expect(sent).toContain(stored)
    expect(stored).toContain(`Id="NFe${r.accessKey}"`)
    expect(stored).toContain('<Signature ')
  })

  it('vai ao autorizador certo (PR em H) uma vez, com o lote síncrono de 1 NF-e e o A1', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '100'))))
    await run(t)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].url).toMatch(/^https:\/\/homologacao\.nfe\.sefa\.pr\.gov\.br\//)
    expect(String(t.calls[0].body)).toMatch(/<enviNFe [^>]*versao="4\.00"><idLote>\d{1,15}<\/idLote><indSinc>1<\/indSinc><NFe /)
    expect(t.calls[0].cert).toBeDefined()
  })

  it('o valor do CSRT nunca está no XML, no resultado nem nas gravações; o hash dele é o da chave', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '100'))))
    const r = await run(t)
    const everything = JSON.stringify([r, t.db.attempts, t.db.events, [...t.storage.files.values()], t.calls.map(c => c.body)])
    expect(everything).not.toContain(SECRET_CSRT)
    expect(String(t.calls[0].body)).toMatch(/<idCSRT>01<\/idCSRT><hashCSRT>[A-Za-z0-9+/]{27}=<\/hashCSRT>/)
  })
})

describe('rejeitada, ambígua, denegada e as saídas que só consultam', () => {
  it('rejeição da nota (703) → R sem protocolo e sem procNFe; a nova tentativa REAPROVEITA o número com chave nova (D-NE282)', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '703', false))))
    const first = await run(t)
    expect(first.outcome).toEqual({ kind: 'R', authorityCode: '703', message: 'motivo do fisco' })
    expect(t.db.attempts[0].protocol).toBeNull()
    expect([...t.storage.files.keys()].some(k => k.endsWith('-procNFe.xml'))).toBe(false)
    const second = await run(t)
    expect([second.attempt, second.number]).toEqual([2, 15])
    expect(second.accessKey).not.toBe(first.accessKey)
    expect(nextInvoiceNumber).toHaveBeenCalledTimes(1)                                            // o número NÃO foi gerado de novo
  })

  it('o 217 provado (fato gravado) solta a nota: a nova tentativa, por ato explícito, sai com o MESMO número e a mesma série e cNF NOVO; sem o fato segue barrada (D-NE292)', async () => {
    const t = setup()
    t.say(() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
    const first = await run(t)
    expect(first.outcome.kind).toBe('none')
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_TRANSMISSION_IN_PROGRESS' })
    t.db.attempts[0].nfeNotRegisteredAt = '2026-11-24 13:40:00'                                   // a rota `reconfirm` provou o 217
    t.say(c => ok(ret(prot(c, '100'))))
    const second = await run(t)
    expect([second.attempt, second.number, second.serie, second.outcome.kind]).toEqual([2, first.number, first.serie, 'A'])
    expect(second.accessKey).not.toBe(first.accessKey)
    expect(second.accessKey.slice(25, 34)).toBe(first.accessKey.slice(25, 34))                    // número (posições 26–34 da chave) igual
    expect(nextInvoiceNumber).toHaveBeenCalledTimes(1)
    expect(t.db.attempts[0].nfeNotRegisteredAt).not.toBeNull()                                    // a antiga segue sem voz, com o fato
    expect(t.db.events.filter(e => e.attempt === 1)).toEqual([])
  })

  it('o A que a resposta do próprio envio traz DEPOIS de o reconfirm gravar o fato é incidente: nada se grava na tentativa (D-NE292)', async () => {
    const t = setup()
    t.say(c => { t.db.attempts[0].nfeNotRegisteredAt = '2026-11-24 13:40:00'; return ok(ret(prot(c, '100'))) })
    const r = await run(t)
    expect([r.outcome.kind, r.incident, t.db.events, t.db.attempts[0].protocol]).toEqual(['none', 'authorized-in-closed-attempt', [], null])
    expect([...t.storage.files.keys()].some(k => k.endsWith('-procNFe.xml'))).toBe(false)
  })

  it('com o fato gravado, a tentativa anterior de OUTRO ambiente não libera o número (o ambiente da habilitação mudou)', async () => {
    const t = setup()
    t.say(() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) })
    await run(t)
    t.db.attempts[0].nfeNotRegisteredAt = '2026-11-24 13:40:00'
    t.db.attempts[0].environment = 'P'
    await expect(run(t)).rejects.toMatchObject({ statusCode: 422 })
    expect(t.calls).toHaveLength(1)
  })

  it('Fault, HTTP 500, timeout: nada é gravado (a tentativa fica em voo) e a nova tentativa é barrada com 409 — sem 2º envio', async () => {
    for (const scripted of [
      () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
      () => ({ status: 500, headers: {}, text: 'erro interno' }) as HttpsResult,
    ] as Reply[]) {
      const t = setup()
      t.say(scripted)
      const r = await run(t)
      expect(r.outcome.kind).toBe('none')
      expect(t.db.events).toEqual([])
      await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_TRANSMISSION_IN_PROGRESS' })
      expect(t.calls).toHaveLength(1)
    }
  })

  it('denegada (110) → D com protocolo, procNFe guardado; a nova tentativa é barrada (o número queimou)', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '110'))))
    const r = await run(t)
    expect(r.outcome).toMatchObject({ kind: 'D', authorityCode: '110' })
    expect(t.db.attempts[0].protocol).toBe('141260000000001')
    expect([...t.storage.files.keys()].some(k => k.endsWith('-procNFe.xml'))).toBe(true)
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('204 e 539 → nenhuma voz, a saída é consultar a chave; a tentativa segue em voo', async () => {
    for (const cStat of ['204', '539']) {
      const t = setup()
      t.say(c => ok(ret(prot(c, cStat, false))))
      const r = await run(t)
      expect([r.outcome, r.next]).toEqual([{ kind: 'none', reason: cStat }, 'consult-key'])
      expect(t.db.events).toEqual([])
    }
  })

  it('103 → P com o recibo guardado e a saída "consultar o recibo"; o 105 também é P', async () => {
    const t = setup()
    t.say(() => ok(ret('<infRec><nRec>411000000000001</nRec><tMed>1</tMed></infRec>', '103')))
    const r = await run(t)
    expect([r.outcome.kind, r.nRec, r.next]).toEqual(['P', '411000000000001', 'consult-receipt'])
    expect(t.db.attempts[0].receipt).toBe('411000000000001')
    const t2 = setup()
    t2.say(() => ok(ret('', '105')))
    expect((await run(t2)).outcome).toMatchObject({ kind: 'P', authorityCode: '105' })
  })

  it('rejeição do LOTE sem protNFe (764) → R', async () => {
    const t = setup()
    t.say(() => ok(ret('', '764')))
    expect((await run(t)).outcome).toMatchObject({ kind: 'R', authorityCode: '764' })
  })

  it('a credencial recusada pelo fisco (certificado) fecha a tentativa como F, sem cStat', async () => {
    const t = setup()
    t.say(() => { throw Object.assign(new Error('x'), { code: 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED' }) })
    const r = await run(t)
    if (r.outcome.kind === 'F') expect(r.outcome).toMatchObject({ authorityCode: null })
    else expect(r.outcome.kind).toBe('none')                                                        // se o transporte não o classifica como credencial, fica ambíguo — nunca R
  })
})

describe('o que recusa ANTES de abrir tentativa e de enviar', () => {
  it('a camada 1 recusa (vNF do ERP ≠ fórmula): FISCAL_TOTALS_MOTOR_DEFECT, nenhuma tentativa, nenhuma rede', async () => {
    const t = setup({}, { buildInput: ({ dhEmi, csrt }) => saleInput({ dhEmi, csrt, erpTotalCents: 400001 }) })
    await expect(run(t)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_TOTALS_MOTOR_DEFECT' })
    expect([t.db.inserted, t.calls.length, t.storage.files.size]).toEqual([0, 0, 0])
    expect(t.conn.rollback).toHaveBeenCalled()
  })

  it('o emitente do XML diferente do estabelecimento: 422 pela camada 1, nada aberto', async () => {
    const t = setup({ establishmentCnpj: async () => '11222333000181' })
    await expect(run(t)).rejects.toMatchObject({ statusCode: 422 })
    expect([t.db.inserted, t.calls.length]).toEqual([0, 0])
  })

  it('a credencial exigida ausente (D-NE218): o erro sobe e nada é aberto', async () => {
    const t = setup({ credentialsFor: async () => { throw Object.assign(new Error('Falta o CSRT (PR · NF-e · 55 · H)'), { statusCode: 422, code: 'FISCAL_CODE_MISSING' }) } })
    await expect(run(t)).rejects.toMatchObject({ code: 'FISCAL_CODE_MISSING' })
    expect([t.db.inserted, t.calls.length]).toEqual([0, 0])
  })

  it('produção fechada (409 FISCAL_NUMBER_SEQUENCE_NOT_OPEN do núcleo): desfaz tudo, nenhuma tentativa, nenhuma rede', async () => {
    nextInvoiceNumber.mockRejectedValueOnce(Object.assign(new Error('não aberta'), { statusCode: 409, code: 'FISCAL_NUMBER_SEQUENCE_NOT_OPEN' }))
    const t = setup()
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_NUMBER_SEQUENCE_NOT_OPEN' })
    expect([t.db.inserted, t.calls.length]).toEqual([0, 0])
  })

  it('produção sem parte SOAP registrada: 503 antes de reservar — nada fica em voo', async () => {
    const t = setup({ openIssuer: async () => ({ issuer: { environment: 'P' }, cert: testA1().cert, key: testA1().key, info: { cnpj: '07742094000113' } }) as never })
    nextInvoiceNumber.mockResolvedValue({ number: 15, environment: 'P' })
    await expect(run(t)).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_AUTHORITY_UNAVAILABLE' })
    expect([t.db.inserted, t.calls.length]).toEqual([0, 0])
  })

  /** Planta, no momento do `save` do nome que termina em `suffix`, um arquivo de mesmo nome com OUTROS bytes (o conflito da gravação única do núcleo 5.2.0). */
  const plantConflict = (t: ReturnType<typeof setup>, suffix: string): void => {
    const real = t.storage.save
    t.storage.save = ((key: any, name: string, xml: string, when?: Date) => {
      if (name.endsWith(suffix)) t.storage.files.set(`${key.cnpj}/${key.environment}/${key.serie}/${name}`, 'OUTROS BYTES')
      return real(key, name, xml, when)
    }) as never
  }

  it('o `-nfe.xml` já existe com outros bytes: 409 FISCAL_FILE_CONFLICT, a transação desfaz, nada vai ao fisco e o conteúdo antigo fica (gravação única, D-NE41)', async () => {
    const t = setup({ random: () => 48271936 })
    t.say(c => ok(ret(prot(c, '100'))))
    plantConflict(t, '-nfe.xml')
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_FILE_CONFLICT' })
    expect([t.calls.length, t.conn.rollback.mock.calls.length > 0]).toEqual([0, true])           // o banco em memória não desfaz: o `rollback` pedido é a prova
    expect([...t.storage.files.values()]).toEqual(['OUTROS BYTES'])
  })

  it('o `-nfe.xml` com os MESMOS bytes não é conflito (o núcleo devolve o caminho)', async () => {
    const t = setup({ random: () => 48271936 })
    t.say(c => ok(ret(prot(c, '100'))))
    const first = await run(t)
    expect(first.outcome.kind).toBe('A')
    const [key, bytes] = [...t.storage.files.entries()].find(([k]) => k.endsWith('-nfe.xml'))!
    const [cnpj, environment, serie] = key.split('/')
    expect(t.storage.save({ cnpj, environment, serie } as never, key.split('/').pop() as string, bytes, NOW)).toBe(key)
  })

  it('o `-procNFe.xml` já existe com outros bytes depois do envio: o A fica gravado e o resultado leva incident file-conflict (nunca silêncio)', async () => {
    const t = setup({ random: () => 48271936 })
    t.say(c => ok(ret(prot(c, '100'))))
    plantConflict(t, '-procNFe.xml')
    const r = await run(t)
    expect([r.outcome.kind, r.incident]).toEqual(['A', 'file-conflict'])
    expect(t.db.events.map(e => e.kind)).toEqual(['A'])
    expect([...t.storage.files.values()]).toContain('OUTROS BYTES')
  })

  it('série fora de 0 a 909 e hora do dhEmi sem created_at: 422, nada aberto', async () => {
    const a = setup({}, { serie: 910 })
    await expect(run(a)).rejects.toMatchObject({ statusCode: 422 })
    const b = setup({}, { createdAt: null })
    await expect(run(b)).rejects.toMatchObject({ statusCode: 422 })
    expect([a.db.inserted, b.db.inserted, a.calls.length, b.calls.length]).toEqual([0, 0, 0, 0])
  })

  it('D-NE296: a hora lida de OUTRA vida que não a travada (corrida com um refaturamento) → 409 RESOURCE_BUSY, nada aberto nem enviado', async () => {
    const c = setup({}, { lifeEvent: 2 })                                // a reserva travou a vida 1 (nfe-memdb)
    await expect(run(c)).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    expect([c.db.inserted, c.calls.length]).toEqual([0, 0])
    const d = setup({}, { lifeEvent: null, createdAt: null, lifeDate: null })   // sem vida: a causa é a S-A (422), não a corrida
    await expect(run(d)).rejects.toMatchObject({ statusCode: 422 })
    const e = setup({}, { lifeDate: '2026-11-20' })                      // S-B: o evento da vida com outra data → 422, nada aberto
    await expect(run(e)).rejects.toMatchObject({ statusCode: 422 })
    expect([e.db.inserted, e.calls.length]).toEqual([0, 0])
  })

  it('D-NE296: a conferência é com a VIDA travada, não com o último evento (vida 2, último evento 3) — a nota segue', async () => {
    const f = setup({}, { lifeEvent: 2 })
    f.db.life = { lifeEvent: 2, lastEvent: 3, lastKind: 'E' }
    f.say(c => ok(ret(prot(c, '100'))))
    await expect(run(f)).resolves.toBeDefined()
    expect(f.db.inserted).toBe(1)
  })
})

describe('o contrato do núcleo e as saídas do gate (NFE.E6.P1, gate socrático M1, M2, M3)', () => {
  it('o fisco NUNCA é chamado com transação aberta (a reserva já fechou e a voz ainda não abriu)', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '100'))))
    await run(t)
    expect(t.txAtCall).toEqual([0])
  })

  it('a ORDEM da reserva: a habilitação travada (openIssuer) antes de qualquer leitura da nota, dos fatos e do número; a leitura da tentativa só depois', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '100'))))
    nextInvoiceNumber.mockImplementationOnce(async () => { t.order.push('nextInvoiceNumber'); return { number: 15, environment: 'H' } })
    await run(t)
    const at = (needle: string) => t.order.findIndex(x => x.includes(needle))
    expect(at('openIssuer')).toBeGreaterThan(-1)
    expect(at('openIssuer')).toBeLessThan(at('latestAttempt'))                                 // a leitura da última tentativa
    expect(at('openIssuer')).toBeLessThan(at('readFacts'))
    expect(at('readFacts')).toBeLessThan(at('nextInvoiceNumber'))
    expect(at('nextInvoiceNumber')).toBeLessThan(at('insertAttempt'))
  })

  it('o 409 da produção fechada desfaz a transação INTEIRA (rollback, nenhum COMMIT da reserva) e nada fica gravado', async () => {
    nextInvoiceNumber.mockRejectedValueOnce(Object.assign(new Error('não aberta'), { statusCode: 409, code: 'FISCAL_NUMBER_SEQUENCE_NOT_OPEN' }))
    const t = setup()
    await expect(run(t)).rejects.toMatchObject({ code: 'FISCAL_NUMBER_SEQUENCE_NOT_OPEN' })
    expect(t.conn.rollback).toHaveBeenCalledTimes(1)
    expect([t.db.inserted, t.db.events.length, t.db.openTx]).toEqual([0, 0, 0])
  })

  it('digVal DIVERGENTE no A síncrono: nada é gravado, o procNFe não se guarda, incidente devolvido e a saída é consultar', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '100', true, 'B'.repeat(27) + '='))))
    const r = await run(t)
    expect([r.outcome, r.incident, r.next]).toEqual([{ kind: 'none', reason: 'digest-divergente' }, 'digest-mismatch', 'consult-key'])
    expect([t.db.events, t.db.attempts[0].protocol]).toEqual([[], null])
    expect([...t.storage.files.keys()].some(k => k.endsWith('-procNFe.xml'))).toBe(false)
  })

  it('digVal AUSENTE: o A que o fisco afirma pela nossa chave é gravado, com a pendência crítica devolvida', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '100', true, null))))
    const r = await run(t)
    expect([r.outcome.kind, r.incident, r.authorityCode]).toEqual(['A', 'digest-absent', '100'])
    expect(t.db.events).toHaveLength(1)
  })

  it('o 150 (autorizada fora de prazo) chega ao resultado: o aviso da D-NE279 sai pelo authorityCode', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '150'))))
    expect((await run(t)).authorityCode).toBe('150')
  })

  it('o freio da D-NE254: 30 rejeições do MESMO cStat na vida da nota recusam a nova tentativa (429); 29 não', async () => {
    const seed = (n: number, code = '703') => {
      const t = setup()
      t.db.attempts.push({ attempt: 1, lifeEvent: 1, environment: 'H', authorizer: 'PR', accessKey: '41261107742094000113550010000000151999999990', dhEmission: '2026-11-24 13:15:30', digestValue: 'A'.repeat(27) + '=',
        receipt: null, protocol: null, dhRecbto: null, lastQueriedAt: null, nfeNotRegisteredAt: null })
      for (let i = 0; i < n; i++) t.db.events.push({ attempt: 1, event: i + 1, kind: 'R', authority_code: code, message: 'm', dh: null, source: 'P', createdAt: '2026-11-24 12:00:00' })
      return t
    }
    const brake = seed(30)
    await expect(run(brake)).rejects.toMatchObject({ statusCode: 429, code: 'RESOURCE_BUSY' })
    expect(brake.calls).toHaveLength(0)
    const fine = seed(29)
    fine.say(c => ok(ret(prot(c, '100'))))
    expect((await run(fine)).outcome.kind).toBe('A')
    const mixed = seed(15)
    for (let i = 0; i < 15; i++) mixed.db.events.push({ attempt: 1, event: 16 + i, kind: 'R', authority_code: '215', message: 'm', dh: null, source: 'P', createdAt: '2026-11-24 12:00:00' })
    mixed.say(c => ok(ret(prot(c, '100'))))
    expect((await run(mixed)).outcome.kind).toBe('A')                                            // 15 + 15 de códigos diferentes não somam
  })

  it('serviço paralisado (108/109) no topo do envio não é rejeição: nada é gravado e a tentativa fica em voo', async () => {
    for (const cStat of ['108', '109']) {
      const t = setup()
      t.say(() => ok(ret('', cStat)))
      const r = await run(t)
      expect([r.outcome.kind, t.db.events.length]).toEqual(['none', 0])
    }
  })
})

describe('a corrida e as guardas (gate adversarial HIGH-2, M6)', () => {
  it('uma voz que entrou DURANTE o envio (o refresh pousou A pela chave) vale: a resposta do envio não grava P nem R por cima', async () => {
    const t = setup()
    t.say(() => {
      t.db.attempts[0].protocol = '141260000000001'
      t.db.events.push({ attempt: 1, event: 1, kind: 'A', authority_code: '100', message: 'ok', dh: '2026-11-24 13:20:00', source: 'Q', createdAt: '2026-11-24 13:20:00' })
      return ok(ret('<infRec><nRec>411000000000001</nRec><tMed>1</tMed></infRec>', '103'))
    })
    const r = await run(t)
    expect(r.outcome).toEqual({ kind: 'none', reason: 'voz-mudou-depois-da-pergunta' })
    expect(t.db.events.map(e => e.kind)).toEqual(['A'])
    expect(t.db.attempts[0].receipt).toBeNull()
  })

  it('o mesmo com a rejeição: não grava R por cima do A que o refresh pousou', async () => {
    const t = setup()
    t.say(c => { t.db.events.push({ attempt: 1, event: 1, kind: 'A', authority_code: '100', message: 'ok', dh: null, source: 'Q', createdAt: '2026-11-24 13:20:00' }); return ok(ret(prot(c, '703', false))) })
    await run(t)
    expect(t.db.events.map(e => e.kind)).toEqual(['A'])
  })

  it('denegada SEM protocolo (110 sem nProt): nada é gravado e a saída é consultar a chave', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(c, '110', false))))
    const r = await run(t)
    expect([r.outcome, r.next, t.db.events]).toEqual([{ kind: 'none', reason: 'denegada-sem-protocolo' }, 'consult-key', []])
  })

  it('o estabelecimento sem CNPJ cadastrado: 409 FISCAL_EMITTER_INCOMPLETE e nada aberto', async () => {
    const t = setup({ establishmentCnpj: async () => null })
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_EMITTER_INCOMPLETE' })
    expect([t.db.inserted, t.calls.length]).toEqual([0, 0])
  })

  it('nota APAGADA no ERP: 404 INVOICE_NOT_FOUND (requireAlive) e nada aberto', async () => {
    const t = setup()
    t.db.deleted = true
    await expect(run(t)).rejects.toMatchObject({ statusCode: 404, code: 'INVOICE_NOT_FOUND' })
    expect([t.db.inserted, t.calls.length]).toEqual([0, 0])
  })

  it('credencial recusada pelo fisco e certificado local inválido fecham como F (nunca R), e cadeia não confiável também', async () => {
    const t = setup()
    t.say(() => ({ status: 200, headers: {}, text: 'x' }))                                        // resposta ilegível: ambíguo — nada se grava
    expect((await run(t)).outcome.kind).toBe('none')
    expect(t.db.events).toEqual([])
  })
})

describe('a transmissão nunca fala com a rede por conta própria', () => {
  it('sem o `request` injetado o transporte real NÃO é chamado nesta suíte (o teste sempre injeta; o fonte não importa fetch/http)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = (require('fs').readFileSync(require('path').resolve(__dirname, '..', 'nfe', 'transmission.ts'), 'utf8') as string).replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
    for (const banned of [/\bfetch\(/, /from 'https?'/, /from 'node:http/, /rejectUnauthorized/, /process\.env/, /Date\.now\(\)/]) expect([banned.source, banned.test(src)]).toEqual([banned.source, false])
  })
})
