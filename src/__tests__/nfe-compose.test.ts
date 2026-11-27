/// <reference types="jest" />
/**
 * NFE.E6.P1 mudança 9 (ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-9; D-NE103, D-NE219, D-NE248): a composição dos fatos da nota — a venda e, na DEVOLUÇÃO, a conferência
 * de cada item contra o `-procNFe.xml` ARQUIVADO da origem, antes de qualquer tentativa. Os leitores entram por `ComposeReaders` (sem banco do ERP); o arquivo de tentativas é o
 * banco em memória; o arquivo fiscal é um mapa.
 */
import fs from 'fs'
import path from 'path'
import { invoiceRef } from 'fiscal-api'
import type { ComposeReaders } from '../nfe/compose'
import { DEFAULT_READERS, readComposedFacts } from '../nfe/compose'
import * as facts from '../facts/merchandise-facts'
import type { ItemSimplesFact } from '../facts/merchandise-facts'
import * as rr from '../nfe/return-reference'
import { merchandiseFileKey } from '../nfe/fiscal-file'
import { buildNfeXml } from '../nfe/nfe-builder'
import { procNfeXml } from '../nfe/proc-nfe'
import { NS } from './xsd-fixtures'
import { sale2027, saleInput, saleKey, signNfe, simplesFor } from './nfe-fixtures'
import { MemDb, memStorage, soapEnvelope } from './nfe-memdb'
import { emitter, item, recipient, sources } from './nfe-source-fixtures'

jest.setTimeout(120_000)

const ACTOR = { institutionId: 98, schemaName: 'setes_x', userId: 7 }
const REF = invoiceRef(98, 5001, 0)
const ORIGIN_KEY = saleKey()
const SIGNED = signNfe(buildNfeXml(saleInput(), ORIGIN_KEY))
const PROT = `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>PR</verAplic><chNFe>${ORIGIN_KEY}</chNFe><dhRecbto>2026-11-24T10:20:00-03:00</dhRecbto><nProt>141260000000001</nProt><digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>100</cStat><xMotivo>ok</xMotivo></infProt></protNFe>`
const PROC = procNfeXml(SIGNED, soapEnvelope(`<retEnviNFe xmlns="${NS}" versao="4.00"><cStat>104</cStat>${PROT}</retEnviNFe>`), ORIGIN_KEY) as string
const TECH = sources().techResponsible

/** NFE.E5.P7 — a origem de 2027 do Simples: a venda `sale2027` (com `cAtivSN` e `gTribSN`) assinada e protocolada, arquivada sob a chave dela. */
const procOf = (signed: string, key: string) => procNfeXml(signed, soapEnvelope(`<retEnviNFe xmlns="${NS}" versao="4.00"><cStat>104</cStat>${PROT.split(ORIGIN_KEY).join(key)}</retEnviNFe>`), key) as string
const KEY_2027 = sale2027().key
const PROC_2027 = procOf(signNfe(buildNfeXml(sale2027().input, KEY_2027)), KEY_2027)
/** O IBS/CBS do Simples que o faturamento congelou (molde do `fact()` de nfe-input.test.ts), para os itens 10 e 30 da venda de `sources()`. */
const simplesFact = (itemId: number, over: Partial<ItemSimplesFact> = {}): ItemSimplesFact => ({
  itemId, activityCode: '01', competence: '2027-01', ibsRate: '0.1000', cbsRate: '0.9000', baseValue: '3000.00', ibsValue: '3.00', cbsValue: '27.00', classificationCode: '000001', ...over,
})
const SIMPLES_FACTS = [simplesFact(10), simplesFact(30, { baseValue: '1000.00', ibsValue: '1.00', cbsValue: '9.00' })]
const PAYMENTS_2027 = { billing: sources().payments.billing, installments: [{ parcel: 1, dueDate: '2027-03-20', value: '4000.00', paymentTypeId: 4, nfePaymentCode: '15' }] }

/** Os itens da origem (4000): ids 10 e 30, como o `procNFe` do builder (cProd 910 e 930; 2 × 1500 e 3 × 333,333333). */
const originItems = [item(10, { merchandiseId: 910, quantity: '2.0000', unitValue: '1500.000000' }), item(30, { merchandiseId: 930, quantity: '3.0000', unitValue: '333.333333' })]
const returned = (itemId: number, merchandiseId: number, q: string, u: string) =>
  item(itemId, { kind: 'Adjust', merchandiseId, quantity: q, unitValue: u, icms: { ...item(itemId).icms, cfopId: '1201' } })
const links = [
  { itemId: 1, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 0, originItemId: 10, originKind: 'Sale' },
  { itemId: 2, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 0, originItemId: 30, originKind: 'Sale' },
]

function setup(opts: { isReturn?: boolean; items?: ReturnType<typeof item>[]; authorized?: boolean; lastKind?: string; withProc?: boolean;
  dtEmission?: string; originKey?: string; originProc?: string; totalValue?: string; itemSimples?: ComposeReaders['readItemSimples']; crt?: string } = {}) {
  const originKey = opts.originKey ?? ORIGIN_KEY
  const y2027 = (opts.dtEmission ?? '') >= '2027-01-01'
  const db = new MemDb()
  const storage = memStorage()
  if (opts.authorized !== false) {
    db.attempts.push({ attempt: 1, lifeEvent: 1, environment: 'H', authorizer: 'PR', accessKey: originKey, dhEmission: '2026-11-24 13:15:30', digestValue: 'A'.repeat(27) + '=',
      receipt: null, protocol: '141260000000001', dhRecbto: '2026-11-24 13:20:00', lastQueriedAt: null, nfeNotRegisteredAt: null })
    db.events.push({ attempt: 1, event: 1, kind: opts.lastKind ?? 'A', authority_code: '100', message: 'ok', dh: null, source: 'P', createdAt: '2026-11-24 13:20:00' })
  }
  if (opts.withProc !== false) {
    storage.save(merchandiseFileKey({ cnpj: originKey.slice(6, 20), model: '55', serie: 1, environment: 'H', zone: 'America/Sao_Paulo' }), `${originKey}-procNFe.xml`, opts.originProc ?? PROC)
  }
  const isReturn = opts.isReturn ?? false
  const readers: ComposeReaders = {
    readInvoice: async () => ({ ...sources().header, invoiceId: isReturn ? 5002 : 5001, totalValue: opts.totalValue ?? (isReturn ? '2500.00' : '4000.00'), note: null,
      ...(opts.dtEmission ? { dtEmission: opts.dtEmission } : {}) }),
    listItems: async (_q, _s, ref) => [...(ref.invoiceId === 4000 ? originItems : opts.items ?? (isReturn ? [returned(1, 910, '1.0000', '1500.000000'), returned(2, 930, '3.0000', '333.333333')] : sources().items))],
    readNature: async () => ({ cfopId: isReturn ? '1201' : '5101', operationNature: isReturn ? 'Devolução de venda de produção do estabelecimento' : 'Venda de produção do estabelecimento' }),
    readEmitter: async () => (opts.crt ? { ...emitter, tax: { ...(emitter.tax as NonNullable<typeof emitter.tax>), crt: opts.crt } } : emitter), readRecipient: async () => recipient,
    readPayments: async () => (y2027 ? PAYMENTS_2027 : sources().payments), readShipping: async () => sources().shipping,
    readReturnOrigins: async () => (isReturn ? links : []),
    invoiceLife: async () => ({ lifeEvent: 1 }), institutionZone: async () => 'America/Sao_Paulo',
    readItemSimples: opts.itemSimples ?? (async () => SIMPLES_FACTS),
  }
  const compose = () => readComposedFacts(db as never, { storage: storage as never, techResponsible: TECH, readers }, ACTOR, REF, 'H')
  return { db, storage, compose, readers }
}
const refused = async (p: Promise<unknown>) => p.then(() => ({ status: 0, code: '', fields: [] as string[] }), (e: any) => ({ status: e.statusCode as number, code: e.code as string, fields: (e.fields ?? []).map((f: any) => `${f.field}: ${f.message}`) }))

describe('a venda', () => {
  it('compõe série, CNPJ, UF, IE, data e hora, e o construtor do candidato com o dhEmi e o CSRT dados', async () => {
    const f = await setup().compose()
    expect(f).toMatchObject({ serie: 1, cnpj: '07742094000113', uf: 'PR', hasStateRegistration: true, dtEmission: '2026-11-24', createdAt: '2026-11-24 13:15:30' })
    const input = f.buildInput({ dhEmi: '2026-11-24T10:15:30-03:00', csrt: { idCSRT: '01', hashCSRT: 'aWv6LeEM4X6u4+qBI2OYZ8grigw=' } })
    expect(input).toMatchObject({ finNFe: '1', dhEmi: '2026-11-24T10:15:30-03:00', csrt: { idCSRT: '01' } })
    expect(() => buildNfeXml(input, saleKey({ number: 15 }))).not.toThrow()
  })

  it('não lê a origem nem o arquivo fiscal quando a nota não é devolução', async () => {
    const t = setup({ authorized: false, withProc: false })
    await expect(t.compose()).resolves.toBeDefined()
    expect(t.storage.files.size).toBe(0)
  })
})

describe('a devolução — cada item contra o procNFe arquivado da origem', () => {
  it('itens que batem com a origem (cProd, vUnCom, qCom ≤): a entrada sai com a chave e o nItem da ORIGEM', async () => {
    const f = await setup({ isReturn: true }).compose()
    const input = f.buildInput({ dhEmi: '2026-11-25T09:00:00-03:00', csrt: null })
    expect(input).toMatchObject({ finNFe: '4', tpNF: '0', payments: [{ tPag: '90', cents: 0 }] })
    expect(input.items.map(i => [i.origin?.accessKey, i.origin?.numbered.nItem])).toEqual([[ORIGIN_KEY, 1], [ORIGIN_KEY, 2]])
  })

  it('devolve MAIS do que a origem vendeu → 422 FISCAL_RETURN_REFERENCE_MISMATCH com o item', async () => {
    const r = await refused(setup({ isReturn: true, items: [returned(1, 910, '3.0000', '1500.000000'), returned(2, 930, '3.0000', '333.333333')] }).compose())
    expect([r.status, r.code]).toEqual([422, 'FISCAL_RETURN_REFERENCE_MISMATCH'])
    expect(r.fields.join(' ')).toMatch(/1/)
  })

  it('produto ou valor unitário diferente do da origem → 422 FISCAL_RETURN_REFERENCE_MISMATCH', async () => {
    expect((await refused(setup({ isReturn: true, items: [returned(1, 999, '1.0000', '1500.000000'), returned(2, 930, '3.0000', '333.333333')] }).compose())).code).toBe('FISCAL_RETURN_REFERENCE_MISMATCH')
    expect((await refused(setup({ isReturn: true, items: [returned(1, 910, '1.0000', '1400.000000'), returned(2, 930, '3.0000', '333.333333')] }).compose())).code).toBe('FISCAL_RETURN_REFERENCE_MISMATCH')
  })

  it('origem sem NF-e autorizada (nenhuma tentativa, ou a última voz é R): 422 da ponte, citando o item — nunca se chuta a chave', async () => {
    for (const t of [setup({ isReturn: true, authorized: false }), setup({ isReturn: true, lastKind: 'R' })]) {
      const r = await refused(t.compose())
      expect([r.status, r.code]).toEqual([422, 'FISCAL_DOCUMENT_INVALID'])
      expect(r.fields).toEqual(['det[1].origin: A nota de origem do item não tem NF-e autorizada conhecida', 'det[2].origin: A nota de origem do item não tem NF-e autorizada conhecida'])
    }
  })

  it('origem autorizada mas o procNFe não está no arquivo fiscal: 422, nada de chute', async () => {
    const r = await refused(setup({ isReturn: true, withProc: false }).compose())
    expect([r.status, r.code]).toEqual([422, 'FISCAL_DOCUMENT_INVALID'])
    expect(r.fields[0]).toMatch(/procNFe.*ausente do arquivo fiscal/)
  })
})

describe('NFE.E5.P7 — o Simples de 2027 na composição (D-NE286, D-NE288, D-NE289; ficha S1 e S2)', () => {
  const KEY_RET_2027 = saleKey({ number: 16, cnf: '70531942', emissionDate: '2027-01-20' })

  it('o caminho de produção liga a leitura do faturamento', () => {
    expect(DEFAULT_READERS.readItemSimples).toBe(facts.readItemSimples)
  })

  it('venda de 2027 do CRT 1: lê o IBS/CBS congelado e o builder escreve cAtivSN e gTribSN', async () => {
    const spy = jest.fn(async () => SIMPLES_FACTS)
    const f = await setup({ dtEmission: '2027-01-15', itemSimples: spy }).compose()
    expect(spy).toHaveBeenCalledTimes(1)
    const built = buildNfeXml(f.buildInput({ dhEmi: '2027-01-15T10:15:30-03:00', csrt: null }), saleKey({ emissionDate: '2027-01-15' }))
    expect(built.xml).toMatch(/<cAtivSN>01<\/cAtivSN>/)
    expect(built.xml).toMatch(/<IBSCBS>[\s\S]*<gTribSN>/)
  })

  it('venda de 2027 do CRT 1 sem a linha do faturamento para o item: 422 da ponte, nunca a nota sem o grupo', async () => {
    const r = await refused(setup({ dtEmission: '2027-01-15', itemSimples: async () => [] }).compose())
    expect([r.status, r.code]).toEqual([422, 'FISCAL_DOCUMENT_INVALID'])
    expect(r.fields.join(' ')).toMatch(/simples/)
  })

  it('venda de 2026: nenhuma leitura nova (o espião não é chamado)', async () => {
    const spy = jest.fn(async () => SIMPLES_FACTS)
    await setup({ itemSimples: spy }).compose()
    expect(spy).not.toHaveBeenCalled()
  })

  it('a fronteira: 31/12/2026 não lê; 01/01/2027 lê e o XML leva o grupo (gate adversarial, M1)', async () => {
    const before = jest.fn(async () => SIMPLES_FACTS)
    await setup({ dtEmission: '2026-12-31', itemSimples: before }).compose()
    expect(before).not.toHaveBeenCalled()
    const at = jest.fn(async () => SIMPLES_FACTS.map(f => ({ ...f, competence: '2027-01' })))
    const f = await setup({ dtEmission: '2027-01-01', itemSimples: at }).compose()
    expect(at).toHaveBeenCalledTimes(1)
    expect(buildNfeXml(f.buildInput({ dhEmi: '2027-01-01T10:15:30-03:00', csrt: null }), saleKey({ emissionDate: '2027-01-01' })).xml).toMatch(/<gTribSN>/)
  })

  it('emitente fora do Simples (CRT 3) em 2027: nenhuma leitura do IBS/CBS do Simples (gate adversarial, LOW)', async () => {
    const spy = jest.fn(async () => SIMPLES_FACTS)
    await setup({ dtEmission: '2027-01-15', crt: '3', itemSimples: spy }).compose().catch(() => undefined)
    expect(spy).not.toHaveBeenCalled()
  })

  it('data de emissão fora da forma: nenhuma leitura nova (o texto "null" não passa como 2027)', async () => {
    const spy = jest.fn(async () => SIMPLES_FACTS)
    await setup({ dtEmission: 'null', itemSimples: spy }).compose().catch(() => undefined)
    expect(spy).not.toHaveBeenCalled()
  })

  it('devolução de 2027 de uma origem de 2027: o grupo e a chave saem do MESMO procNFe arquivado (uma leitura do arquivo)', async () => {
    const t = setup({ isReturn: true, dtEmission: '2027-01-20', originKey: KEY_2027, originProc: PROC_2027, totalValue: '4000.00',
      items: [returned(1, 910, '2.0000', '1500.000000'), returned(2, 930, '3.0000', '333.333333')] })
    const read = jest.spyOn(t.storage, 'read')
    const sim = jest.spyOn(rr, 'readOriginSimples')
    const key = jest.spyOn(rr, 'originKeyOf')
    const itemSimples = jest.fn(async () => SIMPLES_FACTS)
    let f: Awaited<ReturnType<typeof t.compose>>
    try {
      f = await readComposedFacts(t.db as never, { storage: t.storage as never, techResponsible: TECH, readers: { ...t.readers, readItemSimples: itemSimples } }, ACTOR, REF, 'H')
      expect([sim.mock.calls.length, key.mock.calls.length]).toEqual([1, 1])                 // o controle positivo dos espiões de 2026
      expect(itemSimples).not.toHaveBeenCalled()                                              // a devolução não lê o faturamento
    } finally { sim.mockRestore(); key.mockRestore() }
    expect(read).toHaveBeenCalledTimes(1)
    const input = f.buildInput({ dhEmi: '2027-01-20T09:00:00-03:00', csrt: null })
    // o grupo copiado da origem: as alíquotas voltam do XML com 2 casas (0.10), o mesmo número que o faturamento congelou (0.1000)
    const norm = (g: any) => g && { ...g, ibsRate: Number(g.ibsRate), cbsRate: Number(g.cbsRate) }
    expect(input.items.map(i => norm(i.simples))).toEqual([norm(simplesFor(0)), norm(simplesFor(1))])
    expect(input.items.map(i => i.origin?.accessKey)).toEqual([KEY_2027, KEY_2027])
    expect(() => buildNfeXml(input, KEY_RET_2027)).not.toThrow()
  })

  it('devolução de 2027 com o procNFe de OUTRA nota arquivado sob a chave da tentativa: 422 FISCAL_RETURN_REFERENCE_MISMATCH, sem chutar a chave', async () => {
    const other = saleKey({ number: 99, emissionDate: '2027-01-15' })
    const wrong = procOf(signNfe(buildNfeXml(sale2027().input, other)), other)
    const r = await refused(setup({ isReturn: true, dtEmission: '2027-01-20', originKey: KEY_2027, originProc: wrong, totalValue: '4000.00',
      items: [returned(1, 910, '2.0000', '1500.000000'), returned(2, 930, '3.0000', '333.333333')] }).compose())
    expect([r.status, r.code]).toEqual([422, 'FISCAL_RETURN_REFERENCE_MISMATCH'])
    expect(r.fields.join(' ')).toMatch(/a chave do procNFe arquivado não é a da tentativa autorizada da origem/)
  })

  it('devolução de 2027: a conferência contra a origem continua rodando (código do produto trocado → 422, gate socrático M1)', async () => {
    const r = await refused(setup({ isReturn: true, dtEmission: '2027-01-20', originKey: KEY_2027, originProc: PROC_2027, totalValue: '4000.00',
      items: [returned(1, 999, '2.0000', '1500.000000'), returned(2, 930, '3.0000', '333.333333')] }).compose())
    expect([r.status, r.code]).toEqual([422, 'FISCAL_RETURN_REFERENCE_MISMATCH'])
  })

  it('devolução de 2026 com o procNFe de OUTRA nota arquivado sob a chave da tentativa: a recusa de hoje, pela conferência (gate adversarial, M2)', async () => {
    const other = saleKey({ number: 99 })
    const wrong = procOf(signNfe(buildNfeXml(saleInput(), other)), other)
    const r = await refused(setup({ isReturn: true, originProc: wrong }).compose())
    expect([r.status, r.code]).toEqual([422, 'FISCAL_RETURN_REFERENCE_MISMATCH'])
    expect(r.fields.join(' ')).toMatch(/O item referencia outra nota de origem/)
  })

  it('devolução de 2027 de uma origem de 2026 (sem o grupo): a nota sai sem o grupo (D-NE289); devolução parcial permitida', async () => {
    const f = await setup({ isReturn: true, dtEmission: '2027-01-20' }).compose()
    const input = f.buildInput({ dhEmi: '2027-01-20T09:00:00-03:00', csrt: null })
    expect(input.items.map(i => i.simples)).toEqual([null, null])
    expect(input.items.map(i => i.origin?.accessKey)).toEqual([ORIGIN_KEY, ORIGIN_KEY])
  })

  it('devolução de 2026: o grupo da origem não é lido e a chave segue a da tentativa', async () => {
    const spy = jest.spyOn(rr, 'readOriginSimples')
    try {
      const f = await setup({ isReturn: true }).compose()
      expect(spy).not.toHaveBeenCalled()
      expect(f.buildInput({ dhEmi: '2026-11-25T09:00:00-03:00', csrt: null }).items.map(i => i.origin?.accessKey)).toEqual([ORIGIN_KEY, ORIGIN_KEY])
    } finally { spy.mockRestore() }
  })
})

describe('o fonte', () => {
  it('só lê: nenhum INSERT, UPDATE ou DELETE, e nenhum relógio nem rede', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'nfe', 'compose.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
    for (const banned of [/\bINSERT\b/, /\bUPDATE\b/, /\bDELETE\b/, /Date\.now/, /new Date\(\)/, /\bfetch\(/, /process\.env/]) expect([banned.source, banned.test(src)]).toEqual([banned.source, false])
  })
})
