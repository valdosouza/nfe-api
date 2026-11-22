import { XmlUnreadableError, attrOf, elementsOf, nameIs, parseXml, type XmlNode, type XmlReadOptions } from 'fiscal-api'

/**
 * LEITOR DE WSDL da NF-e (nfe-api:NFE.E4.P4 — ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e4-p4-smoke-sefaz-h.md`, mudança 2; D-NE182,
 * D-NE192, D-NE199). Usado só pela FASE 1 do smoke, sobre o WSDL baixado e arquivado: o resultado vai à constante dos autorizadores (grão
 * (ii)) depois de conferido — CONHECIMENTO NEGATIVO (§16.2-10): nunca ler WSDL em tempo de execução para chamar um serviço.
 *
 * Para a operação PEDIDA PELO NOME (ex.: `nfeStatusServicoNF`, `nfeAutorizacaoLote` — a `…Zip` é outra operação e nunca é escolhida por engano):
 * a ação do binding SOAP **1.2** (o WSDL pode trazer 1.1 e 1.2 juntos), o namespace e o nome do elemento de ENTRADA (`nfeDadosMsg`) e o de
 * SAÍDA (`nfeResultMsg`), resolvidos pelas mensagens do `portType`. Recusa = valor tipado, nunca exceção.
 */

export const WSDL_NS = 'http://schemas.xmlsoap.org/wsdl/'
export const WSDL_SOAP12_NS = 'http://schemas.xmlsoap.org/wsdl/soap12/'
const W: XmlReadOptions = { match: 'local', namespaces: [WSDL_NS] }
const S12: XmlReadOptions = { match: 'local', namespaces: [WSDL_SOAP12_NS] }

export type WsdlRefusal =
  | 'wsdl-ilegivel'          // o leitor estrito recusa (DOCTYPE, mal formado, acima de 1 MB…) ou a raiz não é `definitions`
  | 'sem-binding-soap12'     // nenhum binding SOAP 1.2 no documento
  | 'operacao-ausente'       // a operação pedida não está no binding 1.2 ou no portType
  | 'operacao-repetida'      // a operação aparece mais de uma vez no mesmo binding 1.2 ou no portType
  | 'acao-ausente'           // a operação do binding 1.2 sem `soap12:operation/@soapAction`
  | 'acoes-divergentes'      // bindings 1.2 diferentes dão ações diferentes (ou portTypes diferentes) para a mesma operação
  | 'acao-insegura'          // a ação não é URI absoluta sem aspas, `<`, `&` nem espaço (vai dentro do `Content-Type` — gate adversarial)
  | 'mensagem-ausente'       // a entrada ou a saída do portType não resolve até um `element` com namespace

export interface WsdlOperation {
  readonly operation:     string
  readonly action:        string
  readonly namespace:     string
  readonly inputElement:  string
  readonly outputElement: string
}

export type WsdlResult = { readonly ok: true; readonly op: WsdlOperation } | { readonly ok: false; readonly reason: WsdlRefusal }

const refuse = (reason: WsdlRefusal): WsdlResult => ({ ok: false, reason })
/** Ação SOAP aceitável: URI absoluta (esquema:…) sem aspas, `<`, `>`, `&` nem espaço. */
const SAFE_ACTION = /^[a-z][a-z0-9+.-]*:[^"'<>&\s]+$/i
const childrenNamed = (el: XmlNode, name: string, opts: XmlReadOptions): XmlNode[] =>
  elementsOf(el).filter(c => c.parentNode === el && nameIs(c, name, opts))

/** O namespace de um prefixo, subindo pelos ancestrais (`xmlns:p` / `xmlns`). */
function namespaceOfPrefix(el: XmlNode, prefix: string): string | null {
  const attr = prefix ? `xmlns:${prefix}` : 'xmlns'
  for (let n: XmlNode | null = el; n; n = n.parentNode) {
    const v = n.getAttribute?.(attr)
    if (v !== undefined && v !== null && n.hasAttribute?.(attr)) return v
  }
  return null
}

/** `p:local` → { ns, local } resolvido no escopo de [el]; null se o prefixo não resolve. */
function qname(el: XmlNode, value: string | null): { ns: string; local: string } | null {
  if (!value) return null
  const i = value.indexOf(':')
  const prefix = i >= 0 ? value.slice(0, i) : ''
  const local = i >= 0 ? value.slice(i + 1) : value
  const ns = namespaceOfPrefix(el, prefix)
  return ns ? { ns, local } : null
}

/** O `element` da (única) `part` da mensagem [msgName] (local), com o namespace resolvido. */
function messageElement(defs: XmlNode, msgName: string): { ns: string; local: string } | null {
  const msgs = childrenNamed(defs, 'message', W).filter(m => attrOf(m, 'name') === msgName)
  if (msgs.length !== 1) return null
  const parts = childrenNamed(msgs[0], 'part', W)
  if (parts.length !== 1) return null
  return qname(parts[0], attrOf(parts[0], 'element'))
}

export function readWsdlOperation(wsdl: string, operation: string): WsdlResult {
  let doc: XmlNode
  try { doc = parseXml(wsdl) } catch (e) { if (e instanceof XmlUnreadableError) return refuse('wsdl-ilegivel'); throw e }
  const defs = (doc as any).documentElement as XmlNode | null
  if (!defs || !nameIs(defs, 'definitions', W)) return refuse('wsdl-ilegivel')

  // binding SOAP 1.2 = `wsdl:binding` com um filho `soap12:binding`
  const bindings12 = childrenNamed(defs, 'binding', W).filter(b => childrenNamed(b, 'binding', S12).length > 0)
  if (bindings12.length === 0) return refuse('sem-binding-soap12')
  const actions = new Set<string>()
  const portTypeKeys = new Set<string>()
  for (const b of bindings12) {
    const ops = childrenNamed(b, 'operation', W).filter(o => attrOf(o, 'name') === operation)
    if (ops.length === 0) continue
    if (ops.length > 1) return refuse('operacao-repetida')
    const s12 = childrenNamed(ops[0], 'operation', S12)
    const action = s12.length === 1 ? attrOf(s12[0], 'soapAction') : null
    if (!action) return refuse('acao-ausente')
    if (!SAFE_ACTION.test(action)) return refuse('acao-insegura')
    actions.add(action)
    const pt = qname(b, attrOf(b, 'type'))
    portTypeKeys.add(pt ? `${pt.ns} ${pt.local}` : '')
  }
  if (actions.size === 0) return refuse('operacao-ausente')
  if (actions.size > 1 || portTypeKeys.size > 1) return refuse('acoes-divergentes')

  // o portType do binding pelo QName COMPLETO: namespace do `type` = `targetNamespace` do documento (gate adversarial — `type="evil:P"`)
  const [ptNs, ptLocal] = [...portTypeKeys][0].split(' ')
  if (!ptLocal || ptNs !== attrOf(defs, 'targetNamespace')) return refuse('operacao-ausente')
  const portTypes = childrenNamed(defs, 'portType', W).filter(p => attrOf(p, 'name') === ptLocal)
  if (portTypes.length !== 1) return refuse('operacao-ausente')
  const pops = childrenNamed(portTypes[0], 'operation', W).filter(o => attrOf(o, 'name') === operation)
  if (pops.length === 0) return refuse('operacao-ausente')
  if (pops.length > 1) return refuse('operacao-repetida')
  const input = childrenNamed(pops[0], 'input', W)[0]
  const output = childrenNamed(pops[0], 'output', W)[0]
  const inMsg = input ? qname(input, attrOf(input, 'message')) : null
  const outMsg = output ? qname(output, attrOf(output, 'message')) : null
  const inEl = inMsg ? messageElement(defs, inMsg.local) : null
  const outEl = outMsg ? messageElement(defs, outMsg.local) : null
  if (!inEl || !outEl) return refuse('mensagem-ausente')

  return { ok: true, op: { operation, action: [...actions][0], namespace: inEl.ns, inputElement: inEl.local, outputElement: outEl.local } }
}
