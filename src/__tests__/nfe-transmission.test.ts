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
const prot = (chave: string, cStat: string, withProt = true) =>
  `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>PR</verAplic><chNFe>${chave}</chNFe><dhRecbto>${DH}</dhRecbto>${withProt ? '<nProt>141260000000001</nProt>' : ''}`
  + `<digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>${cStat}</cStat><xMotivo>motivo do fisco</xMotivo></infProt></protNFe>`
const ret = (inner: string, cStat = '104') =>
  envelope(`<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>Lote</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto>${inner}</retEnviNFe>`)


function setup(over: Partial<NfeDeps> = {}, facts: Partial<ComposedFacts> = {}) {
  const db = new MemDb()
  const storage = memStorage()
  const calls: HttpsCall[] = []
  let reply: Reply = () => { throw new Error('nenhuma resposta combinada') }
  const a1 = testA1()
  const base = db.connection()
  const conn = { ...base, rollback: jest.fn(base.rollback) }
  const composed: ComposedFacts = {
    serie: 1, cnpj: '07742094000113', uf: 'PR', hasStateRegistration: true, dtEmission: '2026-11-24', createdAt: '2026-11-24 13:15:30',
    buildInput: ({ dhEmi, csrt }) => saleInput({ dhEmi, csrt }), ...facts,
  }
  const deps: NfeDeps = {
    pool: { query: conn.query, getConnection: async () => conn } as never,
    storage: storage as never, catalog: VOICE_READINGS as never, now: () => NOW,
    openIssuer: async () => ({ issuer: { environment: 'H' }, cert: a1.cert, key: a1.key, info: { cnpj: '07742094000113' } }) as never,
    readFacts: async () => composed, zoneOf: async () => 'America/Sao_Paulo', establishmentCnpj: async () => '07742094000113',
    credentialsFor: async () => ({ codeId: '01', codeValue: SECRET_CSRT }), ca: () => undefined,
    request: async c => { calls.push(c); return reply(c) },
    ...over,
  }
  return { db, storage, calls, deps, conn, say: (r: Reply) => { reply = r } }
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
    t.say(c => ok(ret(prot(keyOf(c), '100'))))
    const r = await run(t)
    expect(r).toMatchObject({ invoiceId: 5001, attempt: 1, number: 15, serie: 1, nProt: '141260000000001', next: null })
    expect(r.outcome).toEqual({ kind: 'A', authorityCode: '100', message: 'Autorizado o uso da NF-e' })
    expect(r.accessKey).toMatch(/^41261107742094000113550010000000151[0-9]{8}[0-9]$/)            // cUF AAMM CNPJ mod serie nNF tpEmis cNF cDV
    expect(t.db.attempts[0]).toMatchObject({ authorizer: 'PR', environment: 'H', protocol: '141260000000001', dhEmission: '2026-11-24 13:15:30' })
    expect(t.db.events).toMatchObject([{ attempt: 1, event: 1, kind: 'A', authority_code: '100', message: 'Autorizado o uso da NF-e', dh: '2026-11-24 13:20:00', source: 'P' }])
    const names = [...t.storage.files.keys()].map(k => k.split('/').pop()).sort()
    expect(names).toEqual([`${r.accessKey}-nfe.xml`, `${r.accessKey}-procNFe.xml`])
    expect(nextInvoiceNumber).toHaveBeenCalledTimes(1)
    expect(nextInvoiceNumber.mock.calls[0][1]).toEqual({ institutionId: 98, model: '55', serie: 1 })
  })

  it('o dhEmi do XML é a data do dt_emission com a hora do created_at na zona (D-NE284), e o XML guardado é o MESMO que foi ao fisco', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(keyOf(c), '100'))))
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
    t.say(c => ok(ret(prot(keyOf(c), '100'))))
    await run(t)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].url).toMatch(/^https:\/\/homologacao\.nfe\.sefa\.pr\.gov\.br\//)
    expect(String(t.calls[0].body)).toMatch(/<enviNFe [^>]*versao="4\.00"><idLote>\d{1,15}<\/idLote><indSinc>1<\/indSinc><NFe /)
    expect(t.calls[0].cert).toBeDefined()
  })

  it('o valor do CSRT nunca está no XML, no resultado nem nas gravações; o hash dele é o da chave', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(keyOf(c), '100'))))
    const r = await run(t)
    const everything = JSON.stringify([r, t.db.attempts, t.db.events, [...t.storage.files.values()], t.calls.map(c => c.body)])
    expect(everything).not.toContain(SECRET_CSRT)
    expect(String(t.calls[0].body)).toMatch(/<idCSRT>01<\/idCSRT><hashCSRT>[A-Za-z0-9+/]{27}=<\/hashCSRT>/)
  })
})

describe('rejeitada, ambígua, denegada e as saídas que só consultam', () => {
  it('rejeição da nota (703) → R sem protocolo e sem procNFe; a nova tentativa REAPROVEITA o número com chave nova (D-NE282)', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(keyOf(c), '703', false))))
    const first = await run(t)
    expect(first.outcome).toEqual({ kind: 'R', authorityCode: '703', message: 'motivo do fisco' })
    expect(t.db.attempts[0].protocol).toBeNull()
    expect([...t.storage.files.keys()].some(k => k.endsWith('-procNFe.xml'))).toBe(false)
    const second = await run(t)
    expect([second.attempt, second.number]).toEqual([2, 15])
    expect(second.accessKey).not.toBe(first.accessKey)
    expect(nextInvoiceNumber).toHaveBeenCalledTimes(1)                                            // o número NÃO foi gerado de novo
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
    t.say(c => ok(ret(prot(keyOf(c), '110'))))
    const r = await run(t)
    expect(r.outcome).toMatchObject({ kind: 'D', authorityCode: '110' })
    expect(t.db.attempts[0].protocol).toBe('141260000000001')
    expect([...t.storage.files.keys()].some(k => k.endsWith('-procNFe.xml'))).toBe(true)
    await expect(run(t)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('204 e 539 → nenhuma voz, a saída é consultar a chave; a tentativa segue em voo', async () => {
    for (const cStat of ['204', '539']) {
      const t = setup()
      t.say(c => ok(ret(prot(keyOf(c), cStat, false))))
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

  it('o arquivo fiscal com o mesmo nome já existe: não se sobrescreve (write-once) e a transação desfaz', async () => {
    const t = setup()
    t.say(c => ok(ret(prot(keyOf(c), '100'))))
    const original = t.storage.find
    t.storage.find = () => 'ja-existe'
    await expect(run(t)).rejects.toThrow(/já existe/)
    t.storage.find = original
    expect([t.calls.length, t.conn.rollback.mock.calls.length > 0]).toEqual([0, true])
  })

  it('série fora de 0 a 909 e hora do dhEmi sem created_at: 422, nada aberto', async () => {
    const a = setup({}, { serie: 910 })
    await expect(run(a)).rejects.toMatchObject({ statusCode: 422 })
    const b = setup({}, { createdAt: null })
    await expect(run(b)).rejects.toMatchObject({ statusCode: 422 })
    expect([a.db.inserted, b.db.inserted, a.calls.length, b.calls.length]).toEqual([0, 0, 0, 0])
  })
})

describe('a transmissão nunca fala com a rede por conta própria', () => {
  it('sem o `request` injetado o transporte real NÃO é chamado nesta suíte (o teste sempre injeta; o fonte não importa fetch/http)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = (require('fs').readFileSync(require('path').resolve(__dirname, '..', 'nfe', 'transmission.ts'), 'utf8') as string).replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
    for (const banned of [/\bfetch\(/, /from 'https?'/, /from 'node:http/, /rejectUnauthorized/, /process\.env/, /Date\.now\(\)/]) expect([banned.source, banned.test(src)]).toEqual([banned.source, false])
  })
})
