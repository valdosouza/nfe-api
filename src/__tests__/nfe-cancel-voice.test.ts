/// <reference types="jest" />
/**
 * NFE.E6.P2 mudança 3 (ficha-nfe-e6-p2-cancelar-inutilizar-rodizio.md §7-3; D-NE208, D-NE40, D-NE207, D-NE210; RF-NFE-18/23/24/74): o que a resposta do evento e da
 * inutilização diz à reserva K e à faixa pendente. PURAS — tabela de cStat do parecer do `fiscal-tributacao`.
 */
import type { CancelFact, ReadResult, VoidFact } from '../authority/responses'
import { voiceOfCancel, voiceOfVoid } from '../authority/cstat-voice'

const cancelled = (cStat: '135' | '155', over: Partial<CancelFact> = {}): ReadResult<CancelFact> =>
  ({ kind: 'fact', fact: { status: 'cancelled', cStat, nProt: '141260000000077', dhRegEvento: '2026-11-25T10:00:00-03:00', xMotivo: 'Evento registrado e vinculado a NF-e', ...over } })

describe('voiceOfCancel — C só com 135/155; N na rejeição do evento; o resto mantém a reserva K', () => {
  it('135 e 155 → voz C com o tpEvento em authority_code, o dhRegEvento em UTC e o xMotivo no texto da NFS-e', () => {
    for (const c of ['135', '155'] as const) {
      expect(voiceOfCancel(cancelled(c))).toEqual({
        action: 'cancelled', authorityCode: '110111', cStat: c, message: 'Cancelada no fisco: Evento registrado e vinculado a NF-e', dh: '2026-11-25 13:00:00', nProt: '141260000000077',
      })
    }
  })

  it('a mensagem é cortada em 255 e o dhRegEvento ilegível mantém K', () => {
    const long = voiceOfCancel(cancelled('135', { xMotivo: 'x'.repeat(400) }))
    expect(long.action === 'cancelled' && long.message.length).toBe(255)
    expect(voiceOfCancel(cancelled('135', { dhRegEvento: 'ontem' }))).toEqual({ action: 'keep', reason: 'dhRegEvento-ilegivel', breaker: null })
  })

  it('rejeição do EVENTO (501 fora do prazo, 222…) libera a reserva com N, levando o xMotivo', () => {
    expect(voiceOfCancel({ kind: 'rejection', cStat: '501', xMotivo: 'Rejeicao: Prazo de Cancelamento superior ao previsto' })).toEqual({ action: 'release', cStat: '501', message: 'Rejeicao: Prazo de Cancelamento superior ao previsto' })
    expect(voiceOfCancel({ kind: 'rejection', cStat: '222', xMotivo: null })).toEqual({ action: 'release', cStat: '222', message: 'Pedido de cancelamento rejeitado (222)' })
  })

  it('o que o serviço RECUSOU (656/108/109/999) nunca libera nem cancela: mantém K e entrega o cStat ao disjuntor', () => {
    for (const c of ['656', '108', '109', '999']) {
      expect(voiceOfCancel({ kind: 'rejection', cStat: c, xMotivo: 'm', refused: true })).toEqual({ action: 'keep', reason: 'servico-recusou', breaker: c })
    }
  })

  it('ambíguo (136/573/580, sem eco, ilegível) mantém K — a saída é consultar a chave; sem voz também', () => {
    for (const cause of ['evento-nao-conferido', 'nao-classificada', 'envelope-ilegivel', 'evento-sem-retorno'] as const) {
      expect(voiceOfCancel({ kind: 'ambiguous', cause })).toEqual({ action: 'keep', reason: cause, breaker: null })
    }
    expect(voiceOfCancel({ kind: 'no-voice', cStat: '106' })).toEqual({ action: 'keep', reason: 'sem-voz', breaker: null })
  })
})

const withdrawn = (cStat: '102' | '563', over: Partial<VoidFact> = {}): ReadResult<VoidFact> =>
  ({ kind: 'fact', fact: { status: 'withdrawn', cStat, nProt: '141260000000003', dhRecbto: '2026-11-25T10:00:00-03:00', xMotivo: 'Inutilizacao de numero homologado', ...over } })

describe('voiceOfVoid — 102 e 563 retiram a faixa; 256/241 são rejeição; o resto fica pendente', () => {
  it('102 e 563 retiram, com o protocolo (se vier) e o dhRecbto em UTC; o 563 sem nProt também retira (D-NE40)', () => {
    expect(voiceOfVoid(withdrawn('102'))).toEqual({ action: 'withdrawn', cStat: '102', nProt: '141260000000003', dhRecbto: '2026-11-25 13:00:00', message: 'Inutilizacao de numero homologado' })
    expect(voiceOfVoid(withdrawn('563', { nProt: null, dhRecbto: null, xMotivo: null }))).toEqual({ action: 'withdrawn', cStat: '563', nProt: null, dhRecbto: null, message: 'Faixa já inutilizada' })
  })

  it('256 e 241 (e as demais rejeições) são REJEIÇÃO — história, nunca retiram a faixa (D-NE207)', () => {
    for (const c of ['256', '241', '201', '266', '453', '454']) {
      expect(voiceOfVoid({ kind: 'rejection', cStat: c, xMotivo: 'm' })).toEqual({ action: 'rejected', cStat: c, message: 'm' })
    }
  })

  it('656/108/109/999 e o ambíguo deixam a linha PENDENTE (o reenvio da mesma faixa reconcilia); o 656 vai ao disjuntor', () => {
    expect(voiceOfVoid({ kind: 'rejection', cStat: '656', xMotivo: 'm', refused: true })).toEqual({ action: 'pending', reason: 'servico-recusou', breaker: '656' })
    expect(voiceOfVoid({ kind: 'ambiguous', cause: 'nao-classificada' })).toEqual({ action: 'pending', reason: 'nao-classificada', breaker: null })
    expect(voiceOfVoid({ kind: 'no-voice', cStat: '106' })).toEqual({ action: 'pending', reason: 'sem-voz', breaker: null })
  })

  it('o 206 NÃO é resposta da inutilização (é rejeição da autorização): vira rejeição comum, nunca retira', () => {
    expect(voiceOfVoid({ kind: 'rejection', cStat: '206', xMotivo: 'm' })).toEqual({ action: 'rejected', cStat: '206', message: 'm' })
  })
})
