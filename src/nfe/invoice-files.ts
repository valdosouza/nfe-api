import type { FiscalStorage } from 'fiscal-api'
import type { AttemptRow } from './attempt'
import { merchandiseFileKey } from './fiscal-file'
import { eventProcFileName } from './proc-evento'
import { MAX_CANCEL_RETRIES } from './reconcile'

/**
 * Os arquivos fiscais da nota guardados pelo ciclo (NFE.E6.P4 mudança 4; D-NE50): o `-procNFe.xml` da tentativa autorizada ou denegada e o `-evt110111-<n>[-r<k>]-proc.xml` do cancelamento
 * confirmado. Só LEITURA: a gravação única é de quem grava (`transmission.ts`, `cancellation.ts`, `reconcile.ts`). O procNFe e o procEvento nunca são montados aqui — o que não está no arquivo
 * é "não achado" (`null`), nunca refeito (N10: o arquivo autorizado não se altera).
 */

const hintsOf = (a: AttemptRow, now: Date): (string | Date | null)[] => [a.dhEmission, a.dhRecbto, a.lastEventAt, now]

const keyOf = (a: AttemptRow, zone: string) => merchandiseFileKey({ cnpj: a.accessKey.slice(6, 20), model: '55', serie: a.serie, environment: a.environment, zone })

/** O `-procNFe.xml` da tentativa (NFe + protNFe), ou `null` se o arquivo não existe. */
export function readProcNfe(storage: FiscalStorage, zone: string, a: AttemptRow, now: Date): string | null {
  const found = storage.find(keyOf(a, zone), `${a.accessKey}-procNFe.xml`, hintsOf(a, now))
  return found === null ? null : storage.read(found)
}

/**
 * O `procEventoNFe` do cancelamento: o evento que o fisco REGISTROU está guardado sob `-r<k>` (k = quantos N a tentativa já teve antes de o pedido que valeu). Procura do pedido original ao
 * último permitido e devolve o primeiro que existe; `null` se nenhum.
 */
export function readCancelProc(storage: FiscalStorage, zone: string, a: AttemptRow, now: Date): string | null {
  const key = keyOf(a, zone)
  for (let retry = 0; retry <= MAX_CANCEL_RETRIES; retry++) {
    const found = storage.find({ ...key }, eventProcFileName(a.accessKey, '110111', 1, retry), hintsOf(a, now))
    if (found !== null) return storage.read(found)
  }
  return null
}
