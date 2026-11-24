/**
 * NFE.E5.P4.T1 — a NF-e do Simples (CRT 1) emitida até 31/12/2026 sai SEM o grupo IBSCBS, sem o total de IBS/CBS e sem vNFTot; de 01/01/2027
 * em diante o builder RECUSA até o NFE.E5.P6 existir (D-NE277; RF-CAL-04; NT 2025.002 v1.53 L381-384 e L2743-2767; ficha-nfe-e5-p4-ibscbs-2026.md §6).
 * Cada caso monta a chave e as parcelas da PRÓPRIA data.
 */
import { validateMessage } from '../authority/xsd'
import { buildAccessKey } from '../nfe/access-key'
import { numberItems } from '../nfe/item-numbering'
import { buildNfeXml, IBSCBS_SIMPLES_FROM, type NfeInput } from '../nfe/nfe-builder'
import { returnKey, returnSaleInput, saleInput, saleItem, saleKey, SETES_CNPJ, signNfe } from './nfe-fixtures'

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
const TRAVA = 'ide.dhEmi: Emissão a partir de 01/01/2027 — IBS/CBS do Simples — fora-do-primeiro-release'

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

describe('NFE.E5.P4.T1 — 2027: a trava recusa enquanto o NFE.E5.P6 não existir (S1)', () => {
  it('(c) 01/01/2027 00:00:00 (chave 2701) e 15/06/2027 (chave 2706) → 422 FISCAL_DOCUMENT_INVALID com o campo e o motivo', () => {
    expect(IBSCBS_SIMPLES_FROM).toBe('2027-01-01')
    for (const [dhEmi, due, yymm] of [['2027-01-01T00:00:00-03:00', '2027-02-01', '2701'], ['2027-06-15T10:00:00-03:00', '2027-07-15', '2706']]) {
      const { input, key } = saleOn(dhEmi, due)
      expect(key.slice(2, 6)).toBe(yymm)
      expect(refusedOn(input, key)).toEqual({ status: 422, code: 'FISCAL_DOCUMENT_INVALID', fields: [TRAVA] })
    }
  })

  it('a recusa traz a trava E os outros campos ruins (lista inteira): natOp vazio na mesma resposta', () => {
    const { input, key } = saleOn('2027-03-10T08:00:00-03:00', '2027-04-10', { natOp: '' })
    expect(refusedOn(input, key).fields.sort()).toEqual(['ide.natOp: Campo obrigatório vazio', TRAVA].sort())
  })

  it('(d) a devolução de 2027 também é recusada — a trava vale para toda nota', () => {
    const input = returnSaleInput({ dhEmi: '2027-01-05T09:00:00-03:00' })
    const key = returnKey({ emissionDate: '2027-01-05' })
    expect(refusedOn(input, key).fields).toContain(TRAVA)
  })

  it('a fronteira: um dia antes passa, no dia recusa (a mutação >= → > derruba o caso do dia 01/01)', () => {
    const before = saleOn('2026-12-31T00:00:00-03:00', '2027-01-10')
    expect(() => buildNfeXml(before.input, before.key)).not.toThrow()
    const day = saleOn('2027-01-01T00:00:00-03:00', '2027-02-01')
    expect(refusedOn(day.input, day.key).fields).toEqual([TRAVA])
  })
})

describe('NFE.E5.P4.T1 — a trava não depende da data de outro ano, da quantidade de itens, da ordem das recusas nem do fuso', () => {
  it('[RESISTED] 2028 também recusa (a trava é "a partir de", sem fim)', () => {
    const { input, key } = saleOn('2028-02-29T10:00:00-03:00', '2028-03-30')
    expect(refusedOn(input, key).fields).toEqual([TRAVA])
  })

  it('[RESISTED] com 1 item e com 3 itens a trava também vale (as fixtures de 2027 tinham sempre 2)', () => {
    const one = saleInput({ dhEmi: '2027-03-10T08:00:00-03:00', items: [saleItem(0)], erpTotalCents: 300000, installments: [{ dueDate: '2027-04-10', cents: 300000 }], payments: [{ tPag: '15', cents: 300000 }] })
    expect(refusedOn(one, saleKey({ emissionDate: '2027-03-10' })).fields).toContain(TRAVA)
    const numbered = numberItems([10, 20, 30]).items
    const three = saleInput({
      dhEmi: '2027-03-10T08:00:00-03:00', items: [saleItem(0, { numbered: numbered[0] }), saleItem(1, { numbered: numbered[1] }), saleItem(0, { numbered: numbered[2] })],
      erpTotalCents: 700000, installments: [{ dueDate: '2027-04-10', cents: 700000 }], payments: [{ tPag: '15', cents: 700000 }],
    })
    expect(refusedOn(three, saleKey({ emissionDate: '2027-03-10' })).fields).toContain(TRAVA)
  })

  it('[RESISTED] a trava aparece na lista mesmo com outro erro ANTES dela (contingência na chave)', () => {
    const { input } = saleOn('2027-03-10T08:00:00-03:00', '2027-04-10')
    const contingency = buildAccessKey({ uf: 'PR', emissionDate: '2027-03-10', cnpj: SETES_CNPJ, model: '55', serie: 1, number: 15, emissionType: 6, cnf: '48213057' })
    const fields = refusedOn(input, contingency).fields
    expect(fields).toContain(TRAVA)
    expect(fields).toContain('ide.tpEmis: Emissão em contingência — fora-do-primeiro-release')
  })

  it('[RESISTED] vale a data LOCAL do texto, nos dois sentidos: 23:59:59-03:00 de 2026 passa; 00:30+02:00 de 2027 (ainda 2026 em UTC) recusa', () => {
    const late = saleOn('2026-12-31T23:59:59-03:00', '2027-01-30')
    expect(() => buildNfeXml(late.input, late.key)).not.toThrow()
    const early = saleOn('2027-01-01T00:30:00+02:00', '2027-02-01')
    expect(refusedOn(early.input, early.key).fields).toEqual([TRAVA])
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
