/// <reference types="jest" />
// nfe-api:NFE.E4.P4 — leitor de WSDL (`src/authority/wsdl.ts`). Ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e4-p4-smoke-sefaz-h.md`,
// mudança 2. WSDL SINTÉTICOS na forma do 4.00 (SUPOSIÇÃO: não há WSDL no acervo antes da fase 1 do smoke — a forma real se confere nela).
import { readWsdlOperation } from '../authority/wsdl'

const TNS = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4'

interface Op { name: string; action?: string | null }
function wsdl(opts: { ops?: Op[]; soap11?: boolean; soap12?: boolean; extra12?: Op[]; noMessages?: boolean; prefixDefs?: boolean } = {}): string {
  const ops = opts.ops ?? [{ name: 'nfeStatusServicoNF', action: `${TNS}/nfeStatusServicoNF` }]
  const w = opts.prefixDefs === false ? '' : 'wsdl:'
  const msgs = opts.noMessages ? '' : ops.map(o =>
    `<${w}message name="${o.name}SoapIn"><${w}part name="nfeDadosMsg" element="tns:nfeDadosMsg"/></${w}message>`
    + `<${w}message name="${o.name}SoapOut"><${w}part name="nfeResultMsg" element="tns:nfeResultMsg"/></${w}message>`).join('')
  const portOps = ops.map(o =>
    `<${w}operation name="${o.name}"><${w}input message="tns:${o.name}SoapIn"/><${w}output message="tns:${o.name}SoapOut"/></${w}operation>`).join('')
  const bind = (soapNs: string, list: Op[], suffix: string) =>
    `<${w}binding name="Svc${suffix}" type="tns:SvcSoap"><${soapNs}:binding transport="http://schemas.xmlsoap.org/soap/http"/>`
    + list.map(o => `<${w}operation name="${o.name}">`
      + (o.action === null ? '' : `<${soapNs}:operation soapAction="${o.action ?? ''}" style="document"/>`)
      + `<${w}input><${soapNs}:body use="literal"/></${w}input><${w}output><${soapNs}:body use="literal"/></${w}output></${w}operation>`).join('')
    + `</${w}binding>`
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<${w}definitions ${w ? 'xmlns:wsdl' : 'xmlns'}="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"`
    + ` xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:tns="${TNS}" targetNamespace="${TNS}">`
    + `<${w}types/>${msgs}<${w}portType name="SvcSoap">${portOps}</${w}portType>`
    + (opts.soap11 ? bind('soap', ops.map(o => ({ name: o.name, action: `${o.action}-11` })), 'Soap') : '')
    + (opts.soap12 === false ? '' : bind('soap12', ops, 'Soap12'))
    + (opts.extra12 ? bind('soap12', opts.extra12, 'Soap12b') : '')
    + `</${w}definitions>`
}

describe('extração da operação pedida (D-NE182/D-NE199)', () => {
  it('serviço simples: ação 1.2, namespace e elementos de entrada e saída', () => {
    expect(readWsdlOperation(wsdl(), 'nfeStatusServicoNF')).toEqual({
      ok: true,
      op: { operation: 'nfeStatusServicoNF', action: `${TNS}/nfeStatusServicoNF`, namespace: TNS, inputElement: 'nfeDadosMsg', outputElement: 'nfeResultMsg' },
    })
  })
  it('autorização com a operação Zip ao lado: escolhe a pedida pelo nome, nunca a Zip', () => {
    const x = wsdl({ ops: [{ name: 'nfeAutorizacaoLote', action: `${TNS}/nfeAutorizacaoLote` }, { name: 'nfeAutorizacaoLoteZip', action: `${TNS}/nfeAutorizacaoLoteZip` }] })
    const r = readWsdlOperation(x, 'nfeAutorizacaoLote')
    expect(r.ok && r.op.action).toBe(`${TNS}/nfeAutorizacaoLote`)
  })
  it('bindings SOAP 1.1 e 1.2 juntos: a ação é a do 1.2', () => {
    const r = readWsdlOperation(wsdl({ soap11: true }), 'nfeStatusServicoNF')
    expect(r.ok && r.op.action).toBe(`${TNS}/nfeStatusServicoNF`)
  })
  it('definitions sem prefixo (namespace padrão) também lê', () => {
    expect(readWsdlOperation(wsdl({ prefixDefs: false }), 'nfeStatusServicoNF').ok).toBe(true)
  })
  it('dois bindings 1.2 com a MESMA ação: aceita', () => {
    expect(readWsdlOperation(wsdl({ extra12: [{ name: 'nfeStatusServicoNF', action: `${TNS}/nfeStatusServicoNF` }] }), 'nfeStatusServicoNF').ok).toBe(true)
  })
})

describe('recusas tipadas', () => {
  it.each([
    ['sem binding SOAP 1.2', wsdl({ soap11: true, soap12: false }), 'nfeStatusServicoNF', 'sem-binding-soap12'],
    ['operação ausente', wsdl(), 'nfeConsultaNF', 'operacao-ausente'],
    ['sem soapAction', wsdl({ ops: [{ name: 'nfeStatusServicoNF', action: null }] }), 'nfeStatusServicoNF', 'acao-ausente'],
    ['soapAction vazia', wsdl({ ops: [{ name: 'nfeStatusServicoNF', action: '' }] }), 'nfeStatusServicoNF', 'acao-ausente'],
    ['operação repetida no binding', wsdl({ ops: [{ name: 'nfeStatusServicoNF', action: 'a' }, { name: 'nfeStatusServicoNF', action: 'a' }] }), 'nfeStatusServicoNF', 'operacao-repetida'],
    ['bindings 1.2 com ações diferentes', wsdl({ extra12: [{ name: 'nfeStatusServicoNF', action: 'outra' }] }), 'nfeStatusServicoNF', 'acoes-divergentes'],
    ['mensagens ausentes', wsdl({ noMessages: true }), 'nfeStatusServicoNF', 'mensagem-ausente'],
    ['não é WSDL', '<html><body>erro</body></html>', 'nfeStatusServicoNF', 'wsdl-ilegivel'],
    ['DOCTYPE', '<!DOCTYPE x><x/>', 'nfeStatusServicoNF', 'wsdl-ilegivel'],
  ])('%s', (_l, xml, op, reason) => {
    expect(readWsdlOperation(xml, op)).toEqual({ ok: false, reason })
  })
})
