/// <reference types="jest" />
// nfe-api:NFE.E6.P3.T1 — as marcas do DANFE pela voz do fisco e pelo ambiente (`src/nfe/danfe/danfe-marks.ts`; D-NE52, D-NE45). Ficha
// `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e6-p3-danfe.md`, mudança 2.
import { HttpError } from 'fiscal-api'
import { danfeMarksOf, type DanfeVoice } from '../nfe/danfe/danfe-marks'
import { NfeErrors } from '../nfe/errors'

const ALL: readonly DanfeVoice[] = ['S', 'A', 'R', 'C', 'K', 'F', 'N', 'P', 'D', null]

function refusal(voice: DanfeVoice, tpAmb: '1' | '2'): HttpError {
  try { danfeMarksOf(voice, tpAmb) } catch (e) { return e as HttpError }
  throw new Error(`não recusou ${String(voice)}`)
}

describe('NFE.E6.P3.T1 — danfeMarksOf: a voz decide se há DANFE e o carimbo', () => {
  it.each([
    ['A', '2', { homologation: true, cancelled: false }],
    ['A', '1', { homologation: false, cancelled: false }],
    ['C', '2', { homologation: true, cancelled: true }],
    ['C', '1', { homologation: false, cancelled: true }],
    ['K', '2', { homologation: true, cancelled: false }],
    ['K', '1', { homologation: false, cancelled: false }],
    ['N', '2', { homologation: true, cancelled: false }],
    ['N', '1', { homologation: false, cancelled: false }],
  ] as const)('voz %s em tpAmb %s', (voice, tpAmb, marks) => {
    expect(danfeMarksOf(voice, tpAmb)).toEqual(marks)
  })

  it.each(['S', 'R', 'F', 'P', 'D', null] as const)('a voz %s (sem autorização) é recusa 422 FISCAL_DOCUMENT_INVALID no campo `voice`', voice => {
    for (const tpAmb of ['1', '2'] as const) {
      const e = refusal(voice, tpAmb)
      expect(e).toBeInstanceOf(HttpError)
      expect(e.statusCode).toBe(422)
      expect(e.code).toBe(NfeErrors.DOCUMENT_INVALID)
      expect(e.fields).toEqual([{ field: 'voice', message: expect.stringMatching(/sem autorização não há DANFE/) }])
    }
  })

  it('cobre os 9 kinds do vocabulário comum e a ausência de voz: só A, K, N e C geram DANFE', () => {
    const generate = ALL.filter(v => { try { danfeMarksOf(v, '2'); return true } catch { return false } })
    expect(generate).toEqual(['A', 'C', 'K', 'N'])
    expect(ALL).toHaveLength(10)
  })

  it('ambiente fora de 1 e 2 é recusa no campo `tpAmb`', () => {
    for (const bad of ['', '3', 'H', '02'] as const) {
      let e: HttpError | null = null
      try { danfeMarksOf('A', bad as unknown as '1') } catch (x) { e = x as HttpError }
      expect(e?.statusCode).toBe(422)
      expect(e?.fields?.[0]?.field).toBe('tpAmb')
    }
  })

  it('a resposta é imutável e a função é pura (a mesma entrada, o mesmo resultado)', () => {
    const a = danfeMarksOf('C', '2')
    expect(Object.isFrozen(a)).toBe(true)
    expect(danfeMarksOf('C', '2')).toEqual(a)
  })
})
