/// <reference types="jest" />
// nfe-api:NFE.E4.P4 — montadores das mensagens da NE-3 (`src/authority/messages.ts`). Ficha
// `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e4-p4-smoke-sefaz-h.md`, mudança 1. Nada vai à rede.
import { mod11Ascii48 } from 'fiscal-api'
import { consCad, consSitNFe, consStatServ, inutNFe, signInutNFe, assertAccessKey, CUF } from '../authority/messages'
import { validateMessage } from '../authority/xsd'
import { testA1 } from './test-a1'

jest.setTimeout(60_000)

const CNPJ = '07742094000113'
/** Chave de H bem formada: cUF 41, AAMM 2611, CNPJ, 55, série 1, número 1, tpEmis 1, cNF 12345678 + DV pelo módulo 11. */
const BASE43 = `412611${CNPJ}55001000000001112345678`
const CHAVE = BASE43 + String(mod11Ascii48(BASE43))
const VOID = { tpAmb: '2' as const, uf: 'PR' as const, yy: '26', cnpj: CNPJ, serie: 999, from: 1, to: 1, xJust: 'SMOKE DE HOMOLOGACAO SEM ENVIO' }

describe('cada montador sai válido no XSD local (D-NE211)', () => {
  it('consStatServ', async () => {
    const xml = consStatServ('2', 'PR')
    expect(xml).toContain('<cUF>41</cUF>')
    expect(await validateMessage('consStatServ', xml)).toEqual({ ok: true })
  })
  it('consSitNFe', async () => {
    expect(await validateMessage('consSitNFe', consSitNFe(CHAVE, '2', 'PR'))).toEqual({ ok: true })
  })
  it('consCad por CNPJ e por IE', async () => {
    expect(await validateMessage('consCad', consCad('PR', { CNPJ }))).toEqual({ ok: true })
    expect(await validateMessage('consCad', consCad('PR', { IE: '9012345678' }))).toEqual({ ok: true })
  })
  it('inutNFe ASSINADO de verdade (rsa-sha1) passa; sem assinatura não passa (o XSD a exige)', async () => {
    const a1 = testA1(CNPJ)
    const v = inutNFe(VOID)
    const signed = signInutNFe(v, a1.cert, a1.key)
    expect(signed).toContain('http://www.w3.org/2000/09/xmldsig#rsa-sha1')
    expect(signed).toContain(`URI="#${v.id}"`)
    expect(signed.indexOf('</infInut>')).toBeLessThan(signed.indexOf('<Signature'))
    expect(await validateMessage('inutNFe', signed)).toEqual({ ok: true })
    expect((await validateMessage('inutNFe', v.xml)).ok).toBe(false)
  })
})

describe('consSitNFe confere a chave antes de montar', () => {
  it('tamanho ≠ 44 → recusa', () => { expect(() => consSitNFe(CHAVE.slice(0, 43), '2')).toThrow(/44/) })
  it('DV errado → recusa', () => {
    const wrong = BASE43 + String((Number(CHAVE[43]) + 1) % 10)
    expect(() => consSitNFe(wrong, '2')).toThrow(/DV/)
  })
  it('cUF da chave ≠ UF pedida → recusa', () => { expect(() => consSitNFe(CHAVE, '2', 'SC')).toThrow(/cUF/) })
  it('série 970 a 999 → recusa (MOC J02e, rej. 617 — a SEFAZ-PR respondeu 617 à série 999 no smoke de 2026-11-22)', () => {
    const b999 = `412611${CNPJ}55999000000001112345678`
    expect(() => consSitNFe(b999 + String(mod11Ascii48(b999)), '2')).toThrow(/série 999/)
    const b969 = `412611${CNPJ}55969000000001112345678`
    expect(() => consSitNFe(b969 + String(mod11Ascii48(b969)), '2')).not.toThrow()
  })
  it('tpAmb fora de 1/2 → recusa', () => { expect(() => consSitNFe(CHAVE, '3' as any)).toThrow(/tpAmb/) })
  it('assertAccessKey aceita a chave certa', () => { expect(() => assertAccessKey(CHAVE, 'PR')).not.toThrow() })
})

describe('inutNFe: Id por TODAS as partes e justificativa segura', () => {
  it('Id de 43 posições a partir das partes dadas (nenhum valor padrão do voidId)', () => {
    const { id, xml } = inutNFe({ ...VOID, uf: 'SC', yy: '27', cnpj: '12519458000130', serie: 5, from: 10, to: 20 })
    expect(id).toHaveLength(43)
    expect(id).toBe(`ID${CUF.SC}27` + '12519458000130' + '55' + '005' + '000000010' + '000000020')
    expect(xml).toContain('<cUF>42</cUF><ano>27</ano><CNPJ>12519458000130</CNPJ><mod>55</mod><serie>5</serie>')
  })
  it.each([
    ['curta demais', 'CURTA'],
    ['com <', 'Justificativa com < no meio'],
    ['com &', 'Justificativa com & no meio'],
    ['com acento', 'Justificação de homologação'],
  ])('xJust %s → recusa', (_l, xJust) => { expect(() => inutNFe({ ...VOID, xJust })).toThrow(/xJust/) })
  it('faixa invertida, série fora e ano mal formado → recusa', () => {
    expect(() => inutNFe({ ...VOID, from: 5, to: 4 })).toThrow(/faixa/)
    expect(() => inutNFe({ ...VOID, serie: 1000 })).toThrow(/série/)
    expect(() => inutNFe({ ...VOID, yy: '2026' })).toThrow(/ano/)
  })
})

describe('consCad exige exatamente um de CNPJ ou IE', () => {
  it('nenhum ou os dois → recusa', () => {
    expect(() => consCad('PR', {} as any)).toThrow(/exatamente um/)
    expect(() => consCad('PR', { CNPJ, IE: '123' } as any)).toThrow(/exatamente um/)
  })
  it('CNPJ mal formado e IE com letra → recusa', () => {
    expect(() => consCad('PR', { CNPJ: '123' })).toThrow(/CNPJ/)
    expect(() => consCad('PR', { IE: '12A' })).toThrow(/IE/)
  })
})
