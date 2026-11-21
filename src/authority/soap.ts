import {
  XmlUnreadableError, firstElement, firstText, isLocalCredentialError, isResponseTooLarge, isServerChainError, isTlsCredentialError,
  parseXml, transport, type AmbiguousCause, type HttpsCall, type HttpsResult, type XmlNode, type XmlReadOptions,
} from 'fiscal-api'
import type { NfeService } from './authorizers'

/**
 * ENVELOPE SOAP 1.2 da NF-e (NE-3, nfe-api:NFE.E4.P2.T1 — D-NE5/D-NE184: o envelope, o Fault/500 e o cStat moram na FAMÍLIA, sobre o
 * `httpsRequest` cru do núcleo; regras RF-NFE-16, RF-NFE-17, RF-CAL-08). Recebe a mensagem pronta (consStatServ, consSitNFe…) e devolve o
 * FATO cru classificado — a leitura por serviço, o elo pergunta × resposta e a voz são da NFE.E4.P3.T2.
 *
 * - Pedido: `soap12:Envelope` + `soap12:Body` + `nfeDadosMsg` no namespace do serviço, SEM `Header` (a 4.00 eliminou o `nfeCabecMsg`);
 *   `Content-Type: application/soap+xml; charset=utf-8; action="<ação>"` e NUNCA o header `SOAPAction` (D-NE182). Ação, namespace e
 *   elemento de retorno chegam como PARÂMETRO até o WSDL do PR e da SVRS ser arquivado (NFE.E4.P4.T1 — D-NE199): nenhum valor não oficial.
 * - Timeout CONSTANTE por serviço (D-NE203; o MOC não fixa timeout HTTP — RF-NFE-17): 60 s na autorização síncrona, 30 s nos demais.
 * - Classificação, na MESMA ordem do `authorityJson` do núcleo 4.0.0 (Q-ADV1a: só o que acontece DEPOIS do aperto de mão TLS pode ter
 *   chegado ao fisco):
 *     erro de transporte → ambíguo se o corpo passou do teto de 2 MB (D-NE93/D-NE164) · `local-credential` se o par PEM não abre (nada saiu)
 *     · `chain` se a cadeia do SERVIDOR não fecha antes do aperto de mão (D-NE57 — conferida ANTES da credencial: códigos em comum) ·
 *     `credential` se o fisco recusa o A1 antes do aperto de mão · ambíguo se a falha veio DEPOIS do aperto de mão (timeout = ambíguo —
 *     D-NE38) · `unavailable` no resto (nada chegou);
 *     resposta → `soap12:Fault` em qualquer status = ambíguo (D-NE34) · HTTP 404 = `deactivated` (D-NE204: serviço desativado — RF-CAL-08
 *     item 2.5) · HTTP ≠ 2xx demais = ambíguo · 2xx ilegível ou sem o elemento de retorno ou sem `cStat` = ambíguo · `cStat` 998 =
 *     `deactivated` · `cStat` 1xx = `answered` · outro `cStat` = `rejected` (rejeição só com retorno legível E `cStat` — D-NE34).
 * - A causa do ambíguo é da lista FECHADA do núcleo (D-F98). CONHECIMENTO NEGATIVO: a lista não tem causa para "caiu depois do aperto de
 *   mão" — vai `nao-classificada` (o alarme continua, sem texto); uma causa própria da NF-e é mudança do núcleo, não desta peça.
 */

export const SOAP12_NS = 'http://www.w3.org/2003/05/soap-envelope'
const SOAP11_NS = 'http://schemas.xmlsoap.org/soap/envelope/'
/** Namespace das mensagens da NF-e (o elemento de retorno e o `cStat` só casam nele — D-NE86). */
export const NFE_NS = 'http://www.portalfiscal.inf.br/nfe'
const NFE_READ: XmlReadOptions = { match: 'local', namespaces: [NFE_NS] }

/** D-NE203: timeout por serviço, em ms. Mudar = decisão (não variável de ambiente). */
export const SERVICE_TIMEOUT_MS: Readonly<Record<NfeService, number>> = {
  NFeAutorizacao:       60_000,
  NFeRetAutorizacao:    30_000,
  NfeStatusServico:     30_000,
  NfeConsultaProtocolo: 30_000,
  NfeInutilizacao:      30_000,
  RecepcaoEvento:       30_000,
  NfeConsultaCadastro:  30_000,
  NFeDistribuicaoDFe:   30_000,
}

export interface SoapCall {
  /** URL do autorizador (authorizers.ts — `endpointOf`/`voidEndpoint`/`registryEndpoint`). */
  readonly url:           string
  readonly service:       NfeService
  /** Ação SOAP 1.2 do serviço (WSDL — D-NE182/D-NE199). */
  readonly action:        string
  /** Namespace do `nfeDadosMsg` (WSDL). */
  readonly namespace:     string
  /** Elemento de retorno esperado no namespace da NF-e (ex.: `retConsStatServ`). */
  readonly resultElement: string
  /** A mensagem do serviço, já montada (e validada no XSD — NFE.E4.P3.T1). Sem declaração `<?xml`. */
  readonly body:          string
  readonly cert?:         Buffer
  readonly key?:          Buffer
  /** Raízes ICP do servidor (D-NE57/D-NE187 — NFE.E4.P3.T3). */
  readonly ca?:           HttpsCall['ca']
}

export type SoapOutcome =
  | { readonly kind: 'answered'; readonly cStat: string; readonly xMotivo: string | null; readonly xml: string }
  | { readonly kind: 'rejected'; readonly cStat: string; readonly xMotivo: string | null; readonly xml: string }
  | { readonly kind: 'deactivated' }
  | { readonly kind: 'ambiguous'; readonly cause: AmbiguousCause }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'local-credential' }
  | { readonly kind: 'credential' }
  | { readonly kind: 'chain' }

const XML_DECL = /^﻿?\s*<\?xml[^?]*\?>\s*/
/** Valor que vai dentro de aspas no Content-Type ou num atributo: nada de aspas, `<`, `&` nem quebra (falha de programação, não do fisco). */
const SAFE_TOKEN = /^[^"'<>&\s]+$/

/** O envelope SOAP 1.2 do pedido (exportado para o teste). */
export function soapEnvelope(namespace: string, body: string): string {
  if (!SAFE_TOKEN.test(namespace)) throw new Error('SOAP: namespace inválido')
  const message = body.replace(XML_DECL, '')
  if (!message.startsWith('<')) throw new Error('SOAP: corpo da mensagem não é XML')
  return '<?xml version="1.0" encoding="utf-8"?>'
    + `<soap12:Envelope xmlns:soap12="${SOAP12_NS}">`
    + `<soap12:Body><nfeDadosMsg xmlns="${namespace}">${message}</nfeDadosMsg></soap12:Body>`
    + '</soap12:Envelope>'
}

const hasFault = (doc: XmlNode): boolean =>
  firstElement(doc, 'Fault', { match: 'local', namespaces: [SOAP12_NS, SOAP11_NS] }) !== null

/** O documento da resposta, ou null se o leitor estrito do núcleo recusa (corpo não-XML, acima de 1 MB, DOCTYPE…). */
function readDoc(text: string): XmlNode | null {
  try { return parseXml(text) } catch (e) { if (e instanceof XmlUnreadableError) return null; throw e }
}

function classifyTransportError(err: any): SoapOutcome {
  if (isResponseTooLarge(err)) return { kind: 'ambiguous', cause: 'envelope-ilegivel' }
  if (isLocalCredentialError(err)) return { kind: 'local-credential' }
  if (isServerChainError(err) && err?.afterHandshake !== true) return { kind: 'chain' }
  if (isTlsCredentialError(err) && err?.afterHandshake !== true) return { kind: 'credential' }
  if (err?.afterHandshake === true) return { kind: 'ambiguous', cause: 'nao-classificada' }
  return { kind: 'unavailable' }
}

function classifyResponse(res: HttpsResult, resultElement: string): SoapOutcome {
  const doc = readDoc(res.text)
  if (doc && hasFault(doc)) return { kind: 'ambiguous', cause: 'envelope-ilegivel' }
  if (res.status === 404) return { kind: 'deactivated' }
  if (res.status === 405 || res.status === 406 || res.status === 415) return { kind: 'ambiguous', cause: 'rota-nao-atendida' }
  if (res.status < 200 || res.status >= 300) return { kind: 'ambiguous', cause: 'envelope-ilegivel' }
  if (!doc) return { kind: 'ambiguous', cause: 'envelope-ilegivel' }
  let cStat: string | null
  let xMotivo: string | null
  try {
    const result = firstElement(doc, resultElement, NFE_READ)
    if (!result) return { kind: 'ambiguous', cause: 'envelope-ilegivel' }
    cStat = firstText(result, 'cStat', NFE_READ)
    xMotivo = firstText(result, 'xMotivo', NFE_READ)
  } catch (e) {
    if (e instanceof XmlUnreadableError) return { kind: 'ambiguous', cause: 'envelope-ilegivel' }
    throw e
  }
  if (!cStat || !/^[0-9]{3,4}$/.test(cStat)) return { kind: 'ambiguous', cause: 'envelope-ilegivel' }
  if (cStat === '998') return { kind: 'deactivated' }                       // D-NE204 — "Serviço Desativado" (RF-CAL-08 item 2.5)
  if (/^1[0-9]{2}$/.test(cStat)) return { kind: 'answered', cStat, xMotivo, xml: res.text }
  return { kind: 'rejected', cStat, xMotivo, xml: res.text }
}

/** Uma chamada SOAP 1.2 a um serviço da NF-e. Nunca lança por causa do fisco: o resultado é o fato classificado. */
export async function callSoap(call: SoapCall, request: (c: HttpsCall) => Promise<HttpsResult> = c => transport.request(c)): Promise<SoapOutcome> {
  if (!SAFE_TOKEN.test(call.action)) throw new Error('SOAP: ação inválida')
  const envelope = soapEnvelope(call.namespace, call.body)
  let res: HttpsResult
  try {
    res = await request({
      url:       call.url,
      method:    'POST',
      headers:   {
        'Content-Type':   `application/soap+xml; charset=utf-8; action="${call.action}"`,
        'Content-Length': String(Buffer.byteLength(envelope, 'utf8')),
      },
      body:      envelope,
      cert:      call.cert,
      key:       call.key,
      ...(call.ca !== undefined ? { ca: call.ca } : {}),
      timeoutMs: SERVICE_TIMEOUT_MS[call.service],
    })
  } catch (err) {
    return classifyTransportError(err)
  }
  return classifyResponse(res, call.resultElement)
}
