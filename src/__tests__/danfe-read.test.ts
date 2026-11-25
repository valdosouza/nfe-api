/// <reference types="jest" />
// nfe-api:NFE.E6.P3.T1/T2 — o leitor do DANFE (`src/nfe/danfe/danfe-read.ts`; D-NE100): só o que o XML traz, nulo onde não tem, forma errada = 422.
// Ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e6-p3-danfe.md`, mudança 3.
import { HttpError } from 'fiscal-api'
import { validateMessage } from '../authority/xsd'
import { buildNfeXml } from '../nfe/nfe-builder'
import { readNfeProc } from '../nfe/danfe/danfe-read'
import { NfeErrors } from '../nfe/errors'
import { authorizedProc, emptyOptionalsInput, insertBefore, procOf, TEST_PROTOCOL, TEST_RECEIVED_AT } from './danfe-fixtures'
import { saleInput, saleKey, signNfe, SETES_CNPJ } from './nfe-fixtures'

jest.setTimeout(60_000)

const refusal = (xml: string): HttpError => {
  try { readNfeProc(xml) } catch (e) { return e as HttpError }
  throw new Error('não recusou')
}

describe('NFE.E6.P3.T1 — a NFe de teste do builder assinada passa no XSD local (o fixture é um documento de verdade)', () => {
  it('venda do Simples assinada → válida; o DANFE lê o mesmo documento', async () => {
    expect(await validateMessage('NFe', signNfe(buildNfeXml(saleInput(), saleKey())))).toEqual({ ok: true })
  })
})

describe('NFE.E6.P3.T1 — readNfeProc lê a nota autorizada', () => {
  const data = readNfeProc(authorizedProc().xml)

  it('identificação, chave e protocolo', () => {
    expect(data.accessKey).toBe(saleKey())
    expect(data.ide).toMatchObject({ mod: '55', serie: '1', nNF: '15', tpNF: '1', tpAmb: '2', finNFe: '1', natOp: 'Venda de produção do estabelecimento' })
    expect(data.authorization).toMatchObject({ nProt: TEST_PROTOCOL, dhRecbto: TEST_RECEIVED_AT, cStat: '100', chNFe: saleKey() })
  })

  it('emitente com o CRT 1 e o endereço; destinatário com o CNPJ e a IE', () => {
    expect(data.emit).toMatchObject({ idKind: 'CNPJ', id: SETES_CNPJ, xNome: 'SETES USINAGEM DE TESTE LTDA', xFant: 'SETES', IE: '9053273308', CRT: '1' })
    expect(data.emit.address).toMatchObject({ xLgr: 'Rua Clemente Mendes', nro: '1081', xBairro: 'Sítio Cercado', xMun: 'Curitiba', UF: 'PR', CEP: '81925530' })
    expect(data.dest).toMatchObject({ idKind: 'CNPJ', id: '11222333000181', indIEDest: '1', IE: '1234567890' })
  })

  it('itens: o CSOSN no grupo do ICMS (nunca CST), a unidade, a quantidade e o valor, na ordem do nItem', () => {
    expect(data.items.map(i => i.itemNo)).toEqual(['1', '2'])
    expect(data.items[0].prod).toMatchObject({ cProd: '910', xProd: 'Flange usinada em aço Ø 50 mm', NCM: '73259990', CFOP: '5101', uCom: 'PC', vProd: '3000.00' })
    expect(data.items[0].icmsGroup).toBe('ICMSSN101')
    expect(data.items[0].icms).toMatchObject({ orig: '0', CSOSN: '101' })
    expect(data.items[0].icms.CST).toBeUndefined()
  })

  it('totais, cobrança em duas parcelas e observação da nota', () => {
    expect(data.totals).toMatchObject({ vProd: '4000.00', vNF: '4000.00' })
    expect(data.billing.dups).toHaveLength(2)
    expect(data.billing.dups[0]).toMatchObject({ dVenc: '2026-12-22', vDup: '2000.00' })
    expect(data.infCpl).toContain('Pedido 5001')
  })
})

describe('NFE.E6.P3.T2 — nulo onde o XML não tem, e nada inventado', () => {
  const data = readNfeProc(authorizedProc(emptyOptionalsInput()).xml)

  it('sem fantasia, complemento, IE do destinatário, EAN, cobrança, volumes, transportador e ISSQN', () => {
    expect(data.emit.xFant).toBeNull()
    expect(data.emit.address.xCpl).toBeUndefined()
    expect(data.dest.IE).toBeNull()
    expect(data.dest.indIEDest).toBe('9')
    expect(data.items[0].prod.cEAN).toBe('SEM GTIN')              // o builder escreve o valor do leiaute quando não há EAN: é dado do XML
    expect(data.billing).toEqual({ fat: null, dups: [] })
    expect(data.transp).toEqual({ modFrete: '9', carrier: null, vehicle: null, volumes: [] })
    expect(data.issqnTotals).toBeNull()
    expect(data.items[0].infAdProd).toBeNull()
  })

  it('o CNPJ alfanumérico do emitente é lido como veio', () => {
    const key = saleKey()
    const xml = authorizedProc().xml.replace(`<CNPJ>${SETES_CNPJ}</CNPJ>`, '<CNPJ>12ABC34501DE35</CNPJ>')
    expect(readNfeProc(xml).emit.id).toBe('12ABC34501DE35')
    expect(key).toHaveLength(44)
  })

  it('grupos que o builder do 1º release não escreve entram quando o XML os traz: volumes, infAdProd e ISSQNtot', () => {
    let xml = authorizedProc().xml
    xml = insertBefore(xml, '</transp>', '<vol><qVol>2</qVol><esp>CAIXA</esp><marca>SETES</marca><nVol>1-2</nVol><pesoL>10.500</pesoL><pesoB>11.000</pesoB></vol>')
    xml = insertBefore(xml, '</det>', '<infAdProd>Lote 7 conforme o pedido</infAdProd>')
    xml = insertBefore(xml, '</total>', '<ISSQNtot><vServ>50.00</vServ><vBC>50.00</vBC><vISS>2.50</vISS></ISSQNtot>')
    const d = readNfeProc(xml)
    expect(d.transp.volumes[0].fields).toMatchObject({ qVol: '2', esp: 'CAIXA', pesoL: '10.500' })
    expect(d.items[0].infAdProd).toBe('Lote 7 conforme o pedido')
    expect(d.issqnTotals).toMatchObject({ vServ: '50.00', vISS: '2.50' })
  })
})

describe('NFE.E6.P3.T1 — a forma errada é 422 FISCAL_DOCUMENT_INVALID no campo procNfeXml, nunca PDF parcial', () => {
  const ok = authorizedProc()
  const signed = signNfe(buildNfeXml(saleInput(), saleKey()))

  it.each([
    ['vazio', ''],
    ['não é XML', 'isto não é xml'],
    ['a NFe sem o nfeProc', signed],
    ['sem protocolo', `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${signed}</nfeProc>`],
    ['protocolo de outra chave', authorizedProc(saleInput(), { protKey: saleKey({ number: 99 }) }).xml],
    ['protocolo de rejeição (cStat 204)', authorizedProc(saleInput(), { cStat: '204' }).xml],
    ['protocolo de denegação (cStat 110)', authorizedProc(saleInput(), { cStat: '110' }).xml],
    ['protocolo sem nProt', authorizedProc(saleInput(), { nProt: null }).xml],
    ['duas NFe', ok.xml.replace('<protNFe', `${signed}<protNFe`)],
    ['modelo 65', ok.xml.replace('<mod>55</mod>', '<mod>65</mod>')],
    ['tpAmb fora do domínio', ok.xml.replace('<tpAmb>2</tpAmb>', '<tpAmb>7</tpAmb>')],
    ['sem item', ok.xml.replace(/<det [\s\S]*<\/det>/, '')],
    ['chave do Id fora da forma', ok.xml.replace(`Id="NFe${saleKey()}"`, 'Id="NFe123"')],
    ['cStat repetido no protocolo (204 e depois 100)', ok.xml.replace('<cStat>100</cStat>', '<cStat>204</cStat><cStat>100</cStat>')],
    ['tpAmb do protocolo diferente do da nota', authorizedProc(saleInput(), { protTpAmb: '1' }).xml],
    ['dois infNFe na NFe', ok.xml.replace(/<infNFe[\s\S]*<\/infNFe>/, m => m + m)],
    ['série do ide diferente da chave', ok.xml.replace('<serie>1</serie>', '<serie>2</serie>')],
    ['número do ide diferente da chave', ok.xml.replace('<nNF>15</nNF>', '<nNF>16</nNF>')],
    ['tpNF fora de 0 e 1', ok.xml.replace('<tpNF>1</tpNF>', '<tpNF>7</tpNF>')],
    ['elemento repetido no ide (dois natOp)', ok.xml.replace('<mod>55</mod>', '<natOp>outra</natOp><mod>55</mod>')],
  ])('%s', (_name, xml) => {
    const e = refusal(xml)
    expect(e).toBeInstanceOf(HttpError)
    expect(e.statusCode).toBe(422)
    expect(e.code).toBe(NfeErrors.DOCUMENT_INVALID)
    expect(e.fields?.[0]?.field).toBe('procNfeXml')
  })

  it('controle em campo de linha única vira espaço no leitor; nos de várias linhas só a quebra é normalizada', () => {
    const xml = authorizedProc().xml.replace('Venda de produção do estabelecimento', 'Venda&#13;&#10;de&#9;produção').replace('Pedido 5001', 'Pedido&#13;&#10;5001')
    const d = readNfeProc(xml)
    expect(d.ide.natOp).toBe('Venda de produção')
    expect(d.infCpl).toContain('Pedido\n5001')
  })

  it('o cStat 150 (autorizada fora de prazo) é autorização e passa', () => {
    expect(readNfeProc(authorizedProc(saleInput(), { cStat: '150' }).xml).authorization.cStat).toBe('150')
  })

  it('DOCTYPE e entidade externa são recusados pelo leitor estrito do núcleo', () => {
    const e = refusal(`<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]>${ok.xml}`)
    expect(e.statusCode).toBe(422)
    expect(procOf(signed, saleKey())).toContain('<nfeProc')
  })
})
