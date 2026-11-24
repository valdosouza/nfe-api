import type { TransmissionEventKind } from 'fiscal-api'
import { documentInvalid } from '../errors'
import type { TpAmbCode } from '../homologation'

/**
 * AS MARCAS DO DANFE pela voz do fisco e pelo ambiente (NFE.E6.P3 — D-NE52, D-NE45, D-NE100; ficha `ficha-nfe-e6-p3-danfe.md` §6, S-1/S-2).
 *  - `homologation`: a nota foi autorizada em homologação (`tpAmb` 2) → "SEM VALOR FISCAL" (Anexo II do MOC 7.00, 3.x: no quadro de
 *    Informações Complementares OU em marca d'água destacada — a família usa a marca d'água). Em produção nada se imprime.
 *  - `cancelled`: a voz é C (cancelamento 110111 homologado) → carimbo CANCELADA (D-NE52; o acervo oficial NÃO tem essa palavra: é decisão
 *    de produto, RF-NFE-42 proposta, grau N).
 * A voz decide se há DANFE: só a nota AUTORIZADA o tem. A (autorizada) e as vozes que não tiram a autorização — K (cancelamento em voo, fato
 * nosso) e N (o pedido de cancelamento não vigora, D-NE83) — saem sem carimbo; C sai com o carimbo. R, P, F, D, S e a ausência de voz são
 * recusa 422 (`FISCAL_DOCUMENT_INVALID`, campo `voice`): não há DANFE de nota que o fisco não autorizou (a leitura do leiaute da denegada e da
 * cancelada é N no acervo — suposição S-1 da ficha, a decidir pelo Valdo). PURA: sem relógio, sem banco.
 */
export interface DanfeMarks {
  readonly homologation: boolean
  readonly cancelled: boolean
}

/** A última voz da tentativa (o `kind` lido pela view da família) ou `null` quando a tentativa não tem voz. */
export type DanfeVoice = TransmissionEventKind | null

const WITH_AUTHORIZATION: readonly string[] = ['A', 'K', 'N', 'C']

export function danfeMarksOf(voice: DanfeVoice, tpAmb: TpAmbCode): DanfeMarks {
  if (tpAmb !== '1' && tpAmb !== '2') throw documentInvalid('Ambiente do DANFE fora do domínio', [{ field: 'tpAmb', message: 'O ambiente do DANFE é 1 (produção) ou 2 (homologação)' }])
  if (voice === null || !WITH_AUTHORIZATION.includes(voice)) {
    throw documentInvalid('Só a nota autorizada tem DANFE', [{ field: 'voice', message: voice === null
      ? 'A tentativa não tem voz do fisco: sem autorização não há DANFE'
      : `A voz ${String(voice)} não é de nota autorizada: sem autorização não há DANFE` }])
  }
  return Object.freeze({ homologation: tpAmb === '2', cancelled: voice === 'C' })
}
