/**
 * NFE.E5.P3.T1 — a chave de 44 posições e o cDV saem certos para CNPJ numérico e alfanumérico (RF-NFE-33, RF-NFE-34, RF-NFE-44, proposta
 * RF-NFE-53). Os casos são os do vetor proposto `nfe-chave.json` (ficha-nfe-e5-p3-builder-nfe.md §6-2).
 */
import { cnpjCheckDigits, mod11Ascii48 } from 'fiscal-api'
import { assertAccessKey } from '../authority/messages'
import { AccessKeyParts, assertCnf, buildAccessKey, FORBIDDEN_CNF, infNFeId } from '../nfe/access-key'

const SETES = '07742094000113'                                    // CNPJ da própria Setes (o dos fixtures do projeto)
const parts = (over: Partial<AccessKeyParts> = {}): AccessKeyParts => ({
  uf: 'PR', emissionDate: '2026-11-24', cnpj: SETES, model: '55', serie: 1, number: 1, emissionType: 1, cnf: '48213057', ...over,
})

describe('cDV — módulo 11 da chave', () => {
  it('CHA-001: as 43 posições do exemplo do MOC 7.00 (visão geral §5.4) → DV 5', () => {
    expect(mod11Ascii48('5206043300991100250655012000000780026730161')).toBe(5)
  })
  it('CHA-003: resto 0 e resto 1 → DV 0 (nunca 10 nem 11)', () => {
    const dvs = new Set<number>()
    for (let n = 1; n <= 400; n++) dvs.add(Number(buildAccessKey(parts({ number: n }))[43]))
    expect([...dvs].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('buildAccessKey — por partes', () => {
  it('CHA-002: cUF, AAMM, CNPJ, modelo, série com 3 e número com 9 posições, tpEmis, cNF e o DV', () => {
    const key = buildAccessKey(parts())
    expect(key).toHaveLength(44)
    expect([key.slice(0, 2), key.slice(2, 6), key.slice(6, 20), key.slice(20, 22), key.slice(22, 25), key.slice(25, 34), key[34], key.slice(35, 43)])
      .toEqual(['41', '2611', SETES, '55', '001', '000000001', '1', '48213057'])
    expect(Number(key[43])).toBe(mod11Ascii48(key.slice(0, 43)))
    expect(() => assertAccessKey(key, 'PR')).not.toThrow()
    expect(infNFeId(key)).toBe(`NFe${key}`)
  })

  it('o AAMM sai da data da emissão recebida (o fuso é de quem chama)', () => {
    expect(buildAccessKey(parts({ emissionDate: '2027-01-01' })).slice(2, 6)).toBe('2701')
    expect(buildAccessKey(parts({ emissionDate: '2026-12-31' })).slice(2, 6)).toBe('2612')
  })

  it('CHA-004: CNPJ alfanumérico com DV válido → chave que passa na conferência de forma (RF-NFE-33)', () => {
    const base = 'AB12CD34EF56'
    const cnpj = `${base}${cnpjCheckDigits(base)}`
    const key = buildAccessKey(parts({ cnpj, serie: 12, number: 345 }))
    expect(key.slice(6, 20)).toBe(cnpj)
    expect(key.slice(22, 34)).toBe('012000000345')
    expect(Number(key[43])).toBe(mod11Ascii48(key.slice(0, 43)))
    expect(() => assertAccessKey(key, 'PR')).not.toThrow()
  })

  it('a mesma entrada dá sempre a mesma chave; mudar uma parte muda a chave', () => {
    expect(buildAccessKey(parts())).toBe(buildAccessKey(parts()))
    expect(buildAccessKey(parts({ cnf: '48213058' }))).not.toBe(buildAccessKey(parts()))
  })

  it('CHA-006 e partes inválidas → erro com o nome da parte', () => {
    const bad: [Partial<AccessKeyParts>, RegExp][] = [
      [{ uf: 'XX' as any }, /uf/], [{ uf: 'constructor' as any }, /uf/],
      [{ emissionDate: '2026-13-01' }, /emissionDate/], [{ emissionDate: '24/11/2026' }, /emissionDate/], [{ emissionDate: undefined as any }, /emissionDate/],
      [{ cnpj: '0774209400011' }, /cnpj/], [{ cnpj: 'ab12cd34ef5678' }, /cnpj/], [{ cnpj: '07.742.094/0001-13' }, /cnpj/],
      [{ cnpj: '07742094000114' }, /CNPJ/],                                                       // DV errado: a conferência de forma recusa (rej. 617)
      [{ model: '65' as any }, /model/],
      [{ serie: 910 }, /serie/], [{ serie: -1 }, /serie/], [{ serie: 1.5 }, /serie/], [{ serie: '1' as any }, /serie/],
      [{ number: 0 }, /number/], [{ number: 1_000_000_000 }, /number/], [{ number: NaN }, /number/],
      [{ emissionType: 8 as any }, /emissionType/], [{ emissionType: 0 as any }, /emissionType/],
    ]
    for (const [over, re] of bad) expect(() => buildAccessKey(parts(over))).toThrow(re)
  })
})

describe('cNF (rej. 897 — NT 2019.001)', () => {
  it('CHA-005: cada uma das 20 sequências proibidas é recusada', () => {
    expect(FORBIDDEN_CNF).toHaveLength(20)
    expect(new Set(FORBIDDEN_CNF).size).toBe(20)
    expect(FORBIDDEN_CNF).toEqual(expect.arrayContaining(['00000000', '99999999', '12345678', '01234567', '90123456']))
    for (const cnf of FORBIDDEN_CNF) expect(() => assertCnf(cnf, 1)).toThrow(/897/)
  })
  it('cNF igual ao número da nota (com zeros) é recusado; diferente passa', () => {
    expect(() => assertCnf('00000345', 345)).toThrow(/897/)
    expect(() => buildAccessKey(parts({ number: 48213057 }))).toThrow(/897/)
    expect(() => assertCnf('00000346', 345)).not.toThrow()
  })
  it('forma: só 8 dígitos', () => {
    for (const cnf of ['1234567', '123456789', '1234567A', '', ' 2345678', 12345679 as any, null as any]) expect(() => assertCnf(cnf, 1)).toThrow(/cnf/)
  })
})
