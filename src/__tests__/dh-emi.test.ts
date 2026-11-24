/**
 * NFE.E6.P1 mudança 1 (D-NE278, D-NE284; ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-1): o `dhEmi` = a data do `dt_emission` + a hora de parede
 * do `created_at` (UTC) na zona do estabelecimento, com o offset da zona. Nunca o relógio da transmissão.
 */
import fs from 'fs'
import path from 'path'
import { dhEmiOf } from '../nfe/dh-emi'

const SP = 'America/Sao_Paulo'
const fields = (fn: () => unknown): { status?: number; fields: string[] } => {
  try { fn() } catch (e: any) { return { status: e.statusCode, fields: (e.fields ?? []).map((f: { field: string }) => f.field) } }
  return { fields: ['(não recusou)'] }
}

describe('dhEmiOf — data do dt_emission, hora do created_at na zona do estabelecimento', () => {
  it('a hora UTC vira a hora de parede de Brasília, com -03:00', () => {
    expect(dhEmiOf('2026-11-24', '2026-11-24 13:15:30', SP)).toBe('2026-11-24T10:15:30-03:00')
  })

  it('a DATA é a do dt_emission mesmo quando difere da do created_at', () => {
    expect(dhEmiOf('2026-11-20', '2026-11-24 13:15:30', SP)).toBe('2026-11-20T10:15:30-03:00')
  })

  it('a virada de ano: created_at de 01/01 em UTC é 22:30 de 31/12 na parede, e a data é a do dt_emission', () => {
    expect(dhEmiOf('2026-12-31', '2027-01-01 01:30:00', SP)).toBe('2026-12-31T22:30:00-03:00')
  })

  it('outra zona leva o próprio offset (Manaus, -04:00)', () => {
    expect(dhEmiOf('2026-11-24', '2026-11-24 13:15:30', 'America/Manaus')).toBe('2026-11-24T09:15:30-04:00')
  })

  it('aceita o created_at com T entre a data e a hora', () => {
    expect(dhEmiOf('2026-11-24', '2026-11-24T13:15:30', SP)).toBe('2026-11-24T10:15:30-03:00')
  })

  it('sem created_at, sem zona ou com a data da nota fora do formato: 422 com o campo ide.dhEmi, nunca a hora do relógio', () => {
    for (const bad of [null, undefined, '', 'ontem']) expect(fields(() => dhEmiOf('2026-11-24', bad as never, SP))).toEqual({ status: 422, fields: ['ide.dhEmi'] })
    expect(fields(() => dhEmiOf('2026-11-24', '2026-11-24 13:15:30', null))).toEqual({ status: 422, fields: ['ide.dhEmi'] })
    expect(fields(() => dhEmiOf('24/11/2026', '2026-11-24 13:15:30', SP))).toEqual({ status: 422, fields: ['ide.dhEmi'] })
    expect(fields(() => dhEmiOf('2026-11-24', '2026-11-24 13:15:30', 'Marte/Olimpo')).status).toBe(422)
  })

  it('o resultado passa na forma do dhEmi da camada 1 e não depende do relógio', () => {
    const DH = /^(20[0-9]{2})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([-+](0[0-9]|1[01]):00|\+12:00)$/
    expect(DH.test(dhEmiOf('2026-11-24', '2026-11-24 13:15:30', SP))).toBe(true)
    jest.useFakeTimers().setSystemTime(new Date('2030-01-01T00:00:00Z'))
    try { expect(dhEmiOf('2026-11-24', '2026-11-24 13:15:30', SP)).toBe('2026-11-24T10:15:30-03:00') } finally { jest.useRealTimers() }
  })

  it('a peça é pura: não toca relógio, banco, rede nem segredo', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'nfe', 'dh-emi.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
    for (const banned of [/Date\.now/, /new Date\(\)/, /process\.env/, /\.query\(/, /\bfetch\(/, /from 'fs'/]) expect([banned.source, banned.test(src)]).toEqual([banned.source, false])
  })
})
