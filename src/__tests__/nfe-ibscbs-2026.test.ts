/**
 * NFE.E5.P4.T1 — a NF-e do Simples (CRT 1) emitida até 31/12/2026 sai SEM o grupo IBSCBS, sem o total de IBS/CBS e sem vNFTot; de 01/01/2027
 * em diante o builder escreve o grupo do Simples (NFE.E5.P6, nfe-ibscbs-2027.test.ts; D-NE277; RF-CAL-04; NT 2025.002 v1.53 L381-384 e L2743-2767; ficha-nfe-e5-p4-ibscbs-2026.md §6).
 * Cada caso monta a chave e as parcelas da PRÓPRIA data.
 */
import { validateMessage } from '../authority/xsd'
import { buildNfeXml, type NfeInput } from '../nfe/nfe-builder'
import { returnKey, returnSaleInput, saleInput, saleItem, saleKey, signNfe, simplesFor } from './nfe-fixtures'

jest.setTimeout(60_000)

// Ancorado no ELEMENTO (`<tag` seguido de espaço, `>` ou `/`): um texto com a palavra (xProd, observação) não derruba o teste sem defeito do código.
const FORBIDDEN = /<(IBSCBS|IBSCBSTot|vNFTot|cClassTrib|cAtivSN|gTribSN|gIBSCBS|tpRegimeIBSCBS|vIBSSN|vCBSSN)[\s>/]/
/** Venda do Simples na data pedida, com a chave e a parcela daquela data. */
const saleOn = (dhEmi: string, dueDate: string, over: Partial<NfeInput> = {}) =>
  ({ input: saleInput({ dhEmi, installments: [{ dueDate, cents: 400000 }], ...over }), key: saleKey({ emissionDate: dhEmi.slice(0, 10) }) })
const refusedOn = (input: NfeInput, key: string) => {
  try { buildNfeXml(input, key) } catch (e: any) { return { status: e.statusCode as number, code: e.code as string, fields: (e.fields ?? []).map((f: any) => `${f.field}: ${f.message}`) as string[] } }
  return { status: 0, code: '', fields: ['(não recusou)'] }
}

describe('NFE.E5.P4.T1 — 2026: o Simples sai sem o grupo de IBS/CBS', () => {
  it('(a) venda de 24/11/2026 em homologação, assinada, passa no XSD e não leva nada de IBS/CBS', async () => {
    const { input, key } = saleOn('2026-11-24T10:15:30-03:00', '2026-12-22')
    const built = buildNfeXml(input, key)
    expect(built.xml).not.toMatch(FORBIDDEN)
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })

  it('(b) o último segundo de 2026 (31/12/2026T23:59:59-03:00, chave 2612) ainda sai, sem o grupo', async () => {
    const { input, key } = saleOn('2026-12-31T23:59:59-03:00', '2027-01-30')
    expect(key.slice(2, 6)).toBe('2612')
    const built = buildNfeXml(input, key)
    expect(built.xml).not.toMatch(FORBIDDEN)
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })

  it('(d) a devolução de 2026 sai igual: sem o grupo e válida no XSD', async () => {
    const built = buildNfeXml(returnSaleInput(), returnKey())
    expect(built.xml).not.toMatch(FORBIDDEN)
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })
})

// A trava de 01/01/2027 saiu com o NFE.E5.P6: a nota de 2027 leva o grupo do Simples (nfe-ibscbs-2027.test.ts). Fica aqui o que vale para a fronteira de 2026.
describe('NFE.E5.P4.T1 — o dhEmi lido uma vez e o dado do Simples em 2026', () => {
  it('em 2026 o dado do Simples (NfeItemInput.simples) é recusado: o grupo NÃO vai antes de 01/01/2027 (RF-NFE-69; S4 da ficha do P6)', () => {
    const { input, key } = saleOn('2026-11-24T10:15:30-03:00', '2026-12-22', { items: [saleItem(0, { simples: simplesFor(0) }), saleItem(1)] })
    expect(refusedOn(input, key).fields).toEqual(['det[10].simples: IBS/CBS do Simples não vai em nota anterior a 01/01/2027 (RF-NFE-69)'])
  })

  it('[FIXED] o dhEmi é lido UMA vez: um accessor que muda de valor não escreve uma data diferente da conferida', () => {
    let reads = 0
    const input: any = saleInput({ installments: [{ dueDate: '2030-01-01', cents: 400000 }] })
    Object.defineProperty(input, 'dhEmi', { get() { reads++; return reads <= 3 ? '2026-12-31T10:00:00-03:00' : '2027-06-01T10:00:00-03:00' }, enumerable: true })
    const built = buildNfeXml(input, saleKey({ emissionDate: '2026-12-31' }))
    expect(built.xml).toContain('<dhEmi>2026-12-31T10:00:00-03:00</dhEmi>')
    expect(built.xml).not.toContain('2027-06-01')
  })
})

describe('NFE.E5.P4.T1 — (f) a entrada tipada não tem campo de IBS/CBS', () => {
  it('um literal com IBSCBS é erro de COMPILAÇÃO (prova só o tipo; o XML é o caso (a))', () => {
    // @ts-expect-error — `IBSCBS` não existe em `NfeInput`: literal novo com campo extra
    const withExtra: NfeInput = { ...saleInput(), IBSCBS: {} }
    expect(typeof withExtra).toBe('object')
  })
})
