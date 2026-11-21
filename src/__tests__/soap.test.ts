/// <reference types="jest" />
// nfe-api:NFE.E4.P2.T1 — envelope SOAP 1.2 e classificação da resposta (`src/authority/soap.ts`) com transporte FALSO: nada vai à rede.
// Ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e4-p2-soap-e-autorizadores.md`, mudança 4 (D-NE34, D-NE38, D-NE182, D-NE184,
// D-NE199, D-NE203, D-NE204). Namespace, ação e elemento de retorno abaixo são dado de TESTE (os oficiais chegam com o WSDL — D-NE199).
import type { HttpsCall, HttpsResult } from 'fiscal-api'
import { SERVICE_TIMEOUT_MS, SOAP12_NS, XsdRefusedError, callSoap, soapEnvelope, type SoapCall } from '../authority/soap'

const NS = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4'
const ACTION = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF'
const BODY = '<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><cUF>41</cUF><xServ>STATUS</xServ></consStatServ>'

const CALL: SoapCall = {
  url: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeStatusServico4', service: 'NfeStatusServico', action: ACTION, namespace: NS,
  resultElement: 'retConsStatServ', body: BODY, message: 'consStatServ',
}

jest.setTimeout(60_000)

const envelope = (inner: string) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${SOAP12_NS}"><soap:Body>`
  + `<nfeResultMsg xmlns="${NS}">${inner}</nfeResultMsg></soap:Body></soap:Envelope>`
const ret = (cStat: string, xMotivo = 'motivo') =>
  envelope(`<retConsStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo><cUF>41</cUF></retConsStatServ>`)
const FAULT = `<?xml version="1.0"?><soap12:Envelope xmlns:soap12="${SOAP12_NS}"><soap12:Body><soap12:Fault><soap12:Code>`
  + '<soap12:Value>soap12:Receiver</soap12:Value></soap12:Code></soap12:Fault></soap12:Body></soap12:Envelope>'

/** Transporte falso: grava o pedido e responde [res] (ou lança [err]). */
function fake(res: Partial<HttpsResult> | null, err?: unknown) {
  const calls: HttpsCall[] = []
  const request = async (c: HttpsCall): Promise<HttpsResult> => {
    calls.push(c)
    if (err) throw err
    return { status: 200, headers: {}, text: '', ...res }
  }
  return { calls, request }
}
const errWith = (fields: Record<string, unknown>) => Object.assign(new Error('falha'), fields)

describe('pedido — envelope SOAP 1.2 sem Header e ação no Content-Type (D-NE182, D-NE184)', () => {
  it('Envelope + Body + nfeDadosMsg no namespace do serviço, sem Header, sem SOAPAction, POST com o timeout do serviço', async () => {
    const t = fake({ text: ret('107', 'Servico em Operacao') })
    await callSoap(CALL, t.request)
    expect(t.calls).toHaveLength(1)
    const c = t.calls[0]
    expect(c.method).toBe('POST')
    expect(c.url).toBe(CALL.url)
    expect(c.body).toBe(`<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="${SOAP12_NS}"><soap12:Body><nfeDadosMsg xmlns="${NS}">${BODY}</nfeDadosMsg></soap12:Body></soap12:Envelope>`)
    expect(c.body).not.toMatch(/Header/)
    expect(c.headers?.['Content-Type']).toBe(`application/soap+xml; charset=utf-8; action="${ACTION}"`)
    expect(Object.keys(c.headers ?? {}).map(k => k.toLowerCase())).not.toContain('soapaction')
    expect(c.headers?.['Content-Length']).toBe(String(Buffer.byteLength(c.body ?? '', 'utf8')))
    expect(c.timeoutMs).toBe(30_000)
  })
  it('timeout por serviço (D-NE203): 60 s na autorização, 30 s nos outros sete', async () => {
    expect(SERVICE_TIMEOUT_MS).toEqual({
      NFeAutorizacao: 60_000, NFeRetAutorizacao: 30_000, NfeStatusServico: 30_000, NfeConsultaProtocolo: 30_000,
      NfeInutilizacao: 30_000, RecepcaoEvento: 30_000, NfeConsultaCadastro: 30_000, NFeDistribuicaoDFe: 30_000,
    })
    const t = fake({ text: ret('104') })
    await callSoap({ ...CALL, service: 'NFeAutorizacao' }, t.request)
    expect(t.calls[0].timeoutMs).toBe(60_000)
  })
  it('a declaração <?xml da mensagem sai; ação, namespace e corpo inválidos são erro de programação (nada é enviado)', async () => {
    expect(soapEnvelope(NS, `<?xml version="1.0" encoding="UTF-8"?>\n${BODY}`)).toContain(`<nfeDadosMsg xmlns="${NS}">${BODY}</nfeDadosMsg>`)
    const t = fake({ text: ret('107') })
    await expect(callSoap({ ...CALL, action: 'x"; evil="y' }, t.request)).rejects.toThrow(/ação inválida/)
    await expect(callSoap({ ...CALL, namespace: 'a b' }, t.request)).rejects.toThrow(/namespace inválido/)
    await expect(callSoap({ ...CALL, body: 'texto' }, t.request)).rejects.toThrow(/não é XML/)
    expect(t.calls).toHaveLength(0)
  })
})

describe('validação XSD antes de enviar (D-NE211, NFE.E4.P3.T1)', () => {
  it('mensagem inválida → XsdRefusedError com a lista, e NADA vai ao transporte', async () => {
    const t = fake({ text: ret('107') })
    const bad = BODY.replace('<tpAmb>2</tpAmb>', '<tpAmb>3</tpAmb>')
    const err = await callSoap({ ...CALL, body: bad }, t.request).catch(e => e)
    expect(err).toBeInstanceOf(XsdRefusedError)
    expect((err as XsdRefusedError).errors.join(' | ')).toMatch(/tpAmb/)
    expect(t.calls).toHaveLength(0)
  })
  it('mensagem com a declaração <?xml é validada sem ela e enviada', async () => {
    const t = fake({ text: ret('107') })
    expect(await callSoap({ ...CALL, body: `<?xml version="1.0" encoding="UTF-8"?>${BODY}` }, t.request)).toMatchObject({ kind: 'answered' })
    expect(t.calls).toHaveLength(1)
  })
})

describe('resposta — classificação (D-NE34, D-NE204)', () => {
  const cases: [string, Partial<HttpsResult>, unknown][] = [
    ['cStat 107 → answered', { text: ret('107', 'Servico em Operacao') }, { kind: 'answered', cStat: '107', xMotivo: 'Servico em Operacao', xml: ret('107', 'Servico em Operacao') }],
    ['cStat 225 → rejected', { text: ret('225', 'Rejeicao: Falha no Schema XML') }, { kind: 'rejected', cStat: '225', xMotivo: 'Rejeicao: Falha no Schema XML', xml: ret('225', 'Rejeicao: Falha no Schema XML') }],
    ['cStat 998 → deactivated', { text: ret('998', 'Rejeicao: Servico Desativado') }, { kind: 'deactivated' }],
    ['HTTP 404 → deactivated', { status: 404, text: '<html><body>Not Found</body></html>' }, { kind: 'deactivated' }],
    ['Fault com 200 → ambíguo', { status: 200, text: FAULT }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['Fault com 500 → ambíguo', { status: 500, text: FAULT }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['Fault com 404 → ambíguo (o Fault vence)', { status: 404, text: FAULT }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['HTTP 500 sem Fault → ambíguo', { status: 500, text: 'erro' }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['HTML do gateway com 502 → ambíguo', { status: 502, text: '<html><body>502 Bad Gateway</body></html>' }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['HTTP 415 → ambíguo (rota não atendida)', { status: 415, text: '' }, { kind: 'ambiguous', cause: 'rota-nao-atendida' }],
    ['200 sem o elemento de retorno → ambíguo', { text: envelope('<outra xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>107</cStat></outra>') }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['200 com o retorno em OUTRO namespace → ambíguo', { text: envelope('<retConsStatServ xmlns="urn:x"><cStat>107</cStat></retConsStatServ>') }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['200 sem cStat → ambíguo', { text: envelope('<retConsStatServ xmlns="http://www.portalfiscal.inf.br/nfe"><xMotivo>x</xMotivo></retConsStatServ>') }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['200 com cStat fora da forma → ambíguo', { text: ret('1O7') }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['200 com corpo não-XML → ambíguo', { text: 'ok' }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['200 com corpo vazio → ambíguo', { text: '' }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['200 com DOCTYPE → ambíguo (leitor estrito recusa)', { text: `<!DOCTYPE x>${ret('107')}` }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
  ]
  it.each(cases)('%s', async (_label, res, expected) => {
    expect(await callSoap(CALL, fake(res).request)).toEqual(expected)
  })
})

describe('erro de transporte — mesma ordem do núcleo 4.0.0 (Q-ADV1a)', () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ['corpo acima do teto (código do núcleo) → ambíguo', { code: 'FISCAL_RESPONSE_TOO_LARGE', afterHandshake: true }, { kind: 'ambiguous', cause: 'envelope-ilegivel' }],
    ['timeout DEPOIS do aperto de mão → ambíguo (D-NE38)', { code: 'ETIMEDOUT', afterHandshake: true }, { kind: 'ambiguous', cause: 'nao-classificada' }],
    ['queda DEPOIS do aperto de mão → ambíguo', { code: 'ECONNRESET', afterHandshake: true }, { kind: 'ambiguous', cause: 'nao-classificada' }],
    ['timeout ANTES do aperto de mão → unavailable', { code: 'ETIMEDOUT', afterHandshake: false }, { kind: 'unavailable' }],
    ['conexão recusada → unavailable', { code: 'ECONNREFUSED', afterHandshake: false }, { kind: 'unavailable' }],
    ['par PEM local → local-credential', { code: 'ERR_OSSL_PEM_NO_START_LINE' }, { kind: 'local-credential' }],
    ['cadeia do servidor antes do aperto de mão → chain (vence a credencial)', { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', afterHandshake: false }, { kind: 'chain' }],
    ['A1 recusado antes do aperto de mão → credential', { code: 'EPROTO', afterHandshake: false }, { kind: 'credential' }],
    ['erro "TLS" DEPOIS do aperto de mão → ambíguo, nunca credencial', { code: 'EPROTO', afterHandshake: true }, { kind: 'ambiguous', cause: 'nao-classificada' }],
  ]
  it.each(cases)('%s', async (_label, fields, expected) => {
    expect(await callSoap(CALL, fake(null, errWith(fields)).request)).toEqual(expected)
  })
})
