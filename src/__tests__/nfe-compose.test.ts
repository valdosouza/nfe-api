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
import { readComposedFacts } from '../nfe/compose'
import { merchandiseFileKey } from '../nfe/fiscal-file'
import { buildNfeXml } from '../nfe/nfe-builder'
import { procNfeXml } from '../nfe/proc-nfe'
import { NS } from './xsd-fixtures'
import { saleInput, saleKey, signNfe } from './nfe-fixtures'
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

/** Os itens da origem (4000): ids 10 e 30, como o `procNFe` do builder (cProd 910 e 930; 2 × 1500 e 3 × 333,333333). */
const originItems = [item(10, { merchandiseId: 910, quantity: '2.0000', unitValue: '1500.000000' }), item(30, { merchandiseId: 930, quantity: '3.0000', unitValue: '333.333333' })]
const returned = (itemId: number, merchandiseId: number, q: string, u: string) =>
  item(itemId, { kind: 'Adjust', merchandiseId, quantity: q, unitValue: u, icms: { ...item(itemId).icms, cfopId: '1201' } })
const links = [
  { itemId: 1, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 0, originItemId: 10, originKind: 'Sale' },
  { itemId: 2, kind: 'Adjust', originInvoiceId: 4000, originTerminal: 0, originItemId: 30, originKind: 'Sale' },
]

function setup(opts: { isReturn?: boolean; items?: ReturnType<typeof item>[]; authorized?: boolean; lastKind?: string; withProc?: boolean } = {}) {
  const db = new MemDb()
  const storage = memStorage()
  if (opts.authorized !== false) {
    db.attempts.push({ attempt: 1, lifeEvent: 1, environment: 'H', authorizer: 'PR', accessKey: ORIGIN_KEY, dhEmission: '2026-11-24 13:15:30', digestValue: 'A'.repeat(27) + '=',
      receipt: null, protocol: '141260000000001', dhRecbto: '2026-11-24 13:20:00', lastQueriedAt: null, nfeNotRegisteredAt: null })
    db.events.push({ attempt: 1, event: 1, kind: opts.lastKind ?? 'A', authority_code: '100', message: 'ok', dh: null, source: 'P', createdAt: '2026-11-24 13:20:00' })
  }
  if (opts.withProc !== false) {
    storage.save(merchandiseFileKey({ cnpj: ORIGIN_KEY.slice(6, 20), model: '55', serie: 1, environment: 'H', zone: 'America/Sao_Paulo' }), `${ORIGIN_KEY}-procNFe.xml`, PROC)
  }
  const isReturn = opts.isReturn ?? false
  const readers: ComposeReaders = {
    readInvoice: async () => ({ ...sources().header, invoiceId: isReturn ? 5002 : 5001, totalValue: isReturn ? '2500.00' : '4000.00', note: null }),
    listItems: async (_q, _s, ref) => [...(ref.invoiceId === 4000 ? originItems : opts.items ?? (isReturn ? [returned(1, 910, '1.0000', '1500.000000'), returned(2, 930, '3.0000', '333.333333')] : sources().items))],
    readNature: async () => ({ cfopId: isReturn ? '1201' : '5101', operationNature: isReturn ? 'Devolução de venda de produção do estabelecimento' : 'Venda de produção do estabelecimento' }),
    readEmitter: async () => emitter, readRecipient: async () => recipient,
    readPayments: async () => sources().payments, readShipping: async () => sources().shipping,
    readReturnOrigins: async () => (isReturn ? links : []),
    invoiceLife: async () => ({ lifeEvent: 1 }), institutionZone: async () => 'America/Sao_Paulo',
  }
  const compose = () => readComposedFacts(db as never, { storage: storage as never, techResponsible: TECH, readers }, ACTOR, REF, 'H')
  return { db, storage, compose }
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

describe('o fonte', () => {
  it('só lê: nenhum INSERT, UPDATE ou DELETE, e nenhum relógio nem rede', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'nfe', 'compose.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
    for (const banned of [/\bINSERT\b/, /\bUPDATE\b/, /\bDELETE\b/, /Date\.now/, /new Date\(\)/, /\bfetch\(/, /process\.env/]) expect([banned.source, banned.test(src)]).toEqual([banned.source, false])
  })
})
