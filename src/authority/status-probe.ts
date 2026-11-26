import { logger, type HttpsCall, type HttpsResult } from 'fiscal-api'
import { endpointOf, resolveAuthorizer, soapBindingOf, type Environment, type Uf } from './authorizers'
import { consStatServ, CUF } from './messages'
import { readStatus } from './responses'
import { callSoap } from './soap'
import { RESULT_ELEMENT } from './messages'
import type { StatusBoard } from './status-board'

/**
 * A SONDAGEM do status do serviço do autorizador do estabelecimento (NFE.E6.P4 mudança 8; D-NE54 c, RF-NFE-20): um `consStatServ` por autorizador × ambiente, com o A1 do estabelecimento que está
 * rodando a passada, no máximo a cada 3 minutos (`StatusBoard.due`). Nunca lança e nunca decide nada além do quadro: 107 = em operação; 108/109 = paralisado (o rodízio e as rotas seguem
 * as regras delas); resposta ilegível, timeout ou serviço sem ação registrada = nenhuma linha nova (o quadro guarda a última RESPOSTA, não a falta dela). Só homologação tem serviço registrado
 * (`SOAP_BINDINGS`): produção é recusada antes de qualquer chamada.
 */
export interface ProbeInput {
  readonly uf: Uf
  readonly hasStateRegistration: boolean
  readonly environment: Environment
  readonly cert: Buffer
  readonly key: Buffer
  readonly ca: HttpsCall['ca']
  readonly now: Date
}

export async function probeAuthorityStatus(board: StatusBoard, input: ProbeInput, request?: (c: HttpsCall) => Promise<HttpsResult>): Promise<'recorded' | 'throttled' | 'unavailable'> {
  try {
    const authorizer = resolveAuthorizer({ uf: input.uf, model: '55', environment: input.environment, emissionType: 1, hasStateRegistration: input.hasStateRegistration, at: input.now })
    if (!authorizer.ok) return 'unavailable'
    const binding = soapBindingOf(authorizer.authorizer, input.environment, 'NfeStatusServico')
    const endpoint = endpointOf(authorizer.authorizer, input.environment, 'NfeStatusServico')
    if (!binding || !endpoint.ok) return 'unavailable'
    if (!board.due(authorizer.authorizer, input.environment)) return 'throttled'
    const tpAmb = input.environment === 'H' ? '2' : '1'
    const outcome = await callSoap({
      url: endpoint.url, service: 'NfeStatusServico', action: binding.action, namespace: binding.namespace, resultElement: RESULT_ELEMENT.NfeStatusServico as string,
      body: consStatServ(tpAmb, input.uf), message: 'consStatServ', cert: input.cert, key: input.key, ca: input.ca,
    }, request)
    if (outcome.kind !== 'answered' && outcome.kind !== 'rejected') return 'unavailable'
    const read = readStatus({ tpAmb, cUF: CUF[input.uf] }, outcome.xml)
    if (read.kind !== 'fact') return 'unavailable'
    board.record(authorizer.authorizer, input.environment, read.fact.cStat)
    return 'recorded'
  } catch (e) {
    logger.warn('Sondagem do status do autorizador falhou', { error: e instanceof Error ? e.name : 'erro' })
    return 'unavailable'
  }
}
