/// <reference types="jest" />
// nfe-api:NFE.E4.P4 — script do smoke na SEFAZ-PR em H (`scripts/smoke-sefaz-h.ts`). Ficha
// `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e4-p4-smoke-sefaz-h.md`, mudança 3. Transporte e A1 FALSOS: nada vai à rede.
import { mod11Ascii48, type HttpsCall, type HttpsResult } from 'fiscal-api'
import {
  runSmoke, parseArgs, wsdlUrlOf, SmokeRefused, WSDL_OPERATIONS, WSDL_OPERATION_BY_ENDPOINT, WSDL_ENDPOINTS, type SmokeArgs, type SmokeDeps,
} from '../../scripts/smoke-sefaz-h'
import { testA1 } from './test-a1'
import { soapBindingOf, type NfeService } from '../authority/authorizers'

jest.setTimeout(60_000)

const CNPJ = '12519458000130'
const BASE43 = `412611${CNPJ}55001000000001112345678`
const CHAVE = BASE43 + String(mod11Ascii48(BASE43))
const NS = 'http://www.portalfiscal.inf.br/nfe'
const ARGS: SmokeArgs = { inst: 98, cnpj: CNPJ, uf: 'PR', ie: '9012345678', chave: CHAVE, saida: 'storage-evid', wsdl: false, vai: false }

/** Um WSDL falso com TODAS as operações do smoke (a ação de cada uma = `<tns>/<operação>`). */
function fakeWsdl(): string {
  const tns = 'http://www.portalfiscal.inf.br/nfe/wsdl/Falso'
  const ops = [...Object.values(WSDL_OPERATIONS), ...Object.values(WSDL_OPERATION_BY_ENDPOINT).flatMap(o => Object.values(o ?? {}))] as string[]
  return `<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:tns="${tns}" targetNamespace="${tns}">`
    + ops.map(op => `<wsdl:message name="${op}In"><wsdl:part name="nfeDadosMsg" element="tns:nfeDadosMsg"/></wsdl:message>`
      + `<wsdl:message name="${op}Out"><wsdl:part name="nfeResultMsg" element="tns:nfeResultMsg"/></wsdl:message>`).join('')
    + `<wsdl:portType name="P">` + ops.map(op => `<wsdl:operation name="${op}"><wsdl:input message="tns:${op}In"/><wsdl:output message="tns:${op}Out"/></wsdl:operation>`).join('') + `</wsdl:portType>`
    + `<wsdl:binding name="B" type="tns:P"><soap12:binding transport="http://schemas.xmlsoap.org/soap/http"/>`
    + ops.map(op => `<wsdl:operation name="${op}"><soap12:operation soapAction="${tns}/${op}"/></wsdl:operation>`).join('') + `</wsdl:binding></wsdl:definitions>`
}

const soapReply = (inner: string) =>
  `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg xmlns="x">${inner}</nfeResultMsg></soap:Body></soap:Envelope>`
const REPLIES: Record<string, string> = {
  NFeStatusServico4: soapReply(`<retConsStatServ xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo><cUF>41</cUF><dhRecbto>2026-11-22T10:00:00-03:00</dhRecbto></retConsStatServ>`),
  NFeConsultaProtocolo4: soapReply(`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>217</cStat><xMotivo>NF-e nao consta na base de dados da SEFAZ</xMotivo><cUF>41</cUF><dhRecbto>2026-11-22T10:00:00-03:00</dhRecbto><chNFe>${CHAVE}</chNFe></retConsSitNFe>`),
  CadConsultaCadastro4: soapReply(`<retConsCad xmlns="${NS}" versao="2.00"><infCons><verAplic>PR</verAplic><cStat>111</cStat><xMotivo>Consulta cadastro com uma ocorrencia</xMotivo><UF>PR</UF><CNPJ>${CNPJ}</CNPJ><dhCons>2026-11-22T10:00:00-03:00</dhCons><cUF>41</cUF><infCad><IE>9012345678</IE><CNPJ>${CNPJ}</CNPJ><UF>PR</UF><cSit>1</cSit><indCredNFe>1</indCredNFe><indCredCTe>4</indCredCTe><xNome>TESTE</xNome></infCad></infCons></retConsCad>`),
}

function deps(over: Partial<SmokeDeps> = {}) {
  const a1 = testA1(CNPJ)
  const calls: HttpsCall[] = []
  const files: Record<string, string> = {}
  const d: SmokeDeps = {
    openA1:    async () => ({ environment: 'H', cert: a1.cert, key: a1.key, cnpj: CNPJ }),
    ca:        () => 'PEM-DAS-RAIZES',
    request:   async (c: HttpsCall): Promise<HttpsResult> => {
      calls.push(c)
      if (c.method === 'GET') return { status: 200, headers: {}, text: fakeWsdl() }
      const key = Object.keys(REPLIES).find(k => c.url.includes(k))!
      return { status: 200, headers: {}, text: REPLIES[key] }
    },
    bindingOf: () => null,
    write:     (f, content) => { files[f] = content },
    now:       () => new Date('2026-11-22T13:00:00Z'),
    log:       () => undefined,
    ...over,
  }
  return { d, calls, files }
}

describe('(a) sem --vai: só confere, nenhuma conexão', () => {
  it('transporte chamado ZERO vezes; quatro mensagens válidas; URLs do PR em H', async () => {
    const { d, calls, files } = deps()
    const r = await runSmoke(ARGS, d)
    expect(calls).toHaveLength(0)
    expect(Object.keys(files)).toHaveLength(0)
    expect(r.mode).toBe('conferir')
    expect(r.messages).toEqual(['consStatServ', 'consSitNFe', 'consCad', 'inutNFe'])
    expect(Object.values(r.urls).every(u => u.startsWith('https://homologacao.nfe.sefa.pr.gov.br/'))).toBe(true)
  })
})

describe('(b)(c) recusas antes de qualquer conexão', () => {
  it('habilitação ausente → a recusa do núcleo sobe (FISCAL_ISSUER_MISSING)', async () => {
    const err = Object.assign(new Error('sem habilitação'), { code: 'FISCAL_ISSUER_MISSING' })
    const { d, calls } = deps({ openA1: async () => { throw err } })
    await expect(runSmoke(ARGS, d)).rejects.toMatchObject({ code: 'FISCAL_ISSUER_MISSING' })
    expect(calls).toHaveLength(0)
  })
  it('habilitação em PRODUÇÃO → recusa do script', async () => {
    const a1 = testA1(CNPJ)
    const { d, calls } = deps({ openA1: async () => ({ environment: 'P', cert: a1.cert, key: a1.key, cnpj: CNPJ }) })
    await expect(runSmoke({ ...ARGS, vai: true }, d)).rejects.toThrow(/PRODUÇÃO/)
    expect(calls).toHaveLength(0)
  })
  it('CNPJ do certificado ≠ --cnpj → recusa', async () => {
    const a1 = testA1(CNPJ)
    const { d } = deps({ openA1: async () => ({ environment: 'H', cert: a1.cert, key: a1.key, cnpj: '07742094000113' }) })
    await expect(runSmoke(ARGS, d)).rejects.toThrow(SmokeRefused)
  })
  it('UF fora do autorizador do PR → recusa (D-NE197)', async () => {
    const { d } = deps()
    await expect(runSmoke({ ...ARGS, uf: 'SC' }, d)).rejects.toThrow(/PR/)
  })
  it('chave de outra UF → recusa na montagem', async () => {
    const other = `422611${CNPJ}55001000000001112345678`
    const { d } = deps()
    await expect(runSmoke({ ...ARGS, chave: other + String(mod11Ascii48(other)) }, d)).rejects.toThrow(/cUF/)
  })
  const BASE_ARGV = ['--inst', '98', '--cnpj', CNPJ, '--uf', 'PR', '--ie', '1234', '--chave', CHAVE]
  it('parseArgs exige os parâmetros (IE e UF são parâmetro — §16.2-6)', () => {
    expect(() => parseArgs(['--inst', '98', '--cnpj', CNPJ, '--uf', 'PR', '--chave', CHAVE])).toThrow(/--ie/)
    expect(parseArgs([...BASE_ARGV, '--fase', '1', '--vai'])).toMatchObject({ inst: 98, wsdl: true, vai: true })
    expect(parseArgs([...BASE_ARGV, '--fase', '2', '--vai'])).toMatchObject({ wsdl: false, vai: true })
    expect(parseArgs(BASE_ARGV)).toMatchObject({ wsdl: false, vai: false })
  })
  it.each([
    ['flag desconhecida (wsdI digitado errado)', ['--wsdI', '--vai'], /desconhecido/],
    ['--vai sem --fase', ['--vai'], /--fase/],
    ['--fase sem --vai', ['--fase', '1'], /só com --vai/],
    ['--fase 3', ['--fase', '3', '--vai'], /1 ou 2/],
    ['--saida sem valor (engoliria o --vai)', ['--fase', '1', '--saida', '--vai'], /sem valor/],
    ['--saida fora de storage-', ['--saida', 'evid'], /storage-/],
    ['--saida com ..', ['--saida', 'storage-x/../../etc'], /storage-/],
    ['flag repetida', ['--uf', 'SC'], /repetido/],
  ])('parseArgs recusa: %s (gate adversarial)', (_l, extra, msg) => {
    expect(() => parseArgs([...BASE_ARGV, ...(extra as string[])])).toThrow(msg as RegExp)
  })
  it('os nomes de operação do script são os da constante (uma fonte — gate socrático)', () => {
    for (const e of WSDL_ENDPOINTS) {
      for (const [s, op] of Object.entries(WSDL_OPERATIONS) as [NfeService, string][]) {
        expect([e, s, WSDL_OPERATION_BY_ENDPOINT[e]?.[s] ?? op]).toEqual([e, s, soapBindingOf(e, 'H', s)!.operation])
      }
    }
  })
})

describe('(d) fase 1 — --wsdl --vai: só GET dos WSDL', () => {
  it('um GET por serviço × autorizador, `?wsdl` sem duplicar, nenhum POST, evidência com SHA-256 e extração', async () => {
    const { d, calls, files } = deps()
    const r = await runSmoke({ ...ARGS, wsdl: true, vai: true }, d)
    const expected = WSDL_ENDPOINTS.length * Object.keys(WSDL_OPERATIONS).length
    expect(calls.every(c => c.method === 'GET')).toBe(true)
    expect(calls).toHaveLength(expected)
    expect(calls.every(c => /\?wsdl$/i.test(c.url) && !/\?wsdl\?wsdl/i.test(c.url))).toBe(true)
    expect(calls.every(c => c.ca === 'PEM-DAS-RAIZES' && c.cert && c.key)).toBe(true)
    expect(r.wsdl!.every(w => w.read.ok && /^[0-9a-f]{64}$/.test(w.sha256!))).toBe(true)
    expect(Object.keys(files).filter(f => f.endsWith('.wsdl'))).toHaveLength(expected)
    expect(JSON.parse(files['wsdl/extracao.json']).itens).toHaveLength(expected)
  })
  it('--vai sem pasta de evidência → recusa', async () => {
    const { d } = deps()
    await expect(runSmoke({ ...ARGS, saida: '', wsdl: true, vai: true }, d)).rejects.toThrow(/--saida/)
  })
  it('wsdlUrlOf não duplica `?wsdl`', () => {
    expect(wsdlUrlOf('https://a/x?wsdl')).toBe('https://a/x?wsdl')
    expect(wsdlUrlOf('https://a/x.asmx')).toBe('https://a/x.asmx?wsdl')
  })
})

describe('(e) fase 2 — --vai: serviços pela CONSTANTE', () => {
  it('sem a ação na constante → recusa antes de qualquer POST', async () => {
    const { d, calls } = deps()
    await expect(runSmoke({ ...ARGS, vai: true }, d)).rejects.toThrow(/constante/)
    expect(calls).toHaveLength(0)
  })
  it('com a constante: POST de status, consulta e cadastro com a ação no Content-Type; nenhum inutNFe; respostas conferidas', async () => {
    const { d, calls, files } = deps({ bindingOf: (_e, s) => ({ action: `urn:acao:${s}`, namespace: `urn:ns:${s}` }) })
    const r = await runSmoke({ ...ARGS, vai: true }, d)
    expect(calls.map(c => c.method)).toEqual(['POST', 'POST', 'POST'])
    expect(calls.map(c => c.headers!['Content-Type'])).toEqual([
      'application/soap+xml; charset=utf-8; action="urn:acao:NfeStatusServico"',
      'application/soap+xml; charset=utf-8; action="urn:acao:NfeConsultaProtocolo"',
      'application/soap+xml; charset=utf-8; action="urn:acao:NfeConsultaCadastro"',
    ])
    expect(calls.some(c => String(c.body).includes('inutNFe'))).toBe(false)
    expect(r.services!.map(s => [s.service, s.outcome, s.cStat])).toEqual([
      ['NfeStatusServico', 'answered', '107'],
      ['NfeConsultaProtocolo', 'rejected', '217'],
      ['NfeConsultaCadastro', 'answered', '111'],
    ])
    expect(r.services![0].read).toEqual({ kind: 'fact', fact: { state: 'operating', cStat: '107' } })
    expect(r.services![1].read).toEqual({ kind: 'fact', fact: { status: 'not-found', cStat: '217' } })
    expect(files['servicos/NfeStatusServico-enviado.xml']).toContain('<consStatServ')
    expect(JSON.parse(files['servicos/resumo.json']).resultados).toHaveLength(3)
    expect(r.ieMatches).toBe(true)                    // a IE do cadastro falso é a do --ie (§16.2-6: só confere)
  })
})
