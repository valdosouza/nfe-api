/// <reference types="jest" />
/**
 * NFE.E6.P1 mudança 2 (ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-2; D-NE33, D-NE211): o lote da autorização (`enviNFe`, 1 NF-e, `indSinc` 1) e
 * a consulta do recibo (`consReciNFe`) passam no XSD; os retornos `retEnviNFe` e `retConsReciNFe` têm XSD no acervo. Nada vai à rede.
 */
import fs from 'fs'
import path from 'path'
import { consReciNFe, enviNFe, RESULT_ELEMENT } from '../authority/messages'
import { DEFAULT_XSD_DIR, validateMessage } from '../authority/xsd'
import { buildNfeXml } from '../nfe/nfe-builder'
import { saleInput, saleKey, signNfe } from './nfe-fixtures'
import { CHAVE, NS, signature } from './xsd-fixtures'

jest.setTimeout(60_000)

const built = () => buildNfeXml(saleInput(), saleKey())
const signed = () => signNfe(built())
const thrown = (fn: () => unknown): string => { try { fn() } catch (e: any) { return String(e.message) } return '(não recusou)' }

describe('enviNFe — o lote síncrono de uma NF-e assinada', () => {
  it('a NFe assinada do builder, no lote, passa no XSD do enviNFe', async () => {
    const lote = enviNFe('1', signed())
    expect(lote.startsWith(`<enviNFe xmlns="${NS}" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc><NFe `)).toBe(true)
    expect(await validateMessage('enviNFe', lote)).toEqual({ ok: true })
  })

  it('a NFe entra BYTE A BYTE (a assinatura é sobre a forma canônica) e a declaração <?xml ?> sai da frente', () => {
    const nfe = signed()
    expect(enviNFe('42', nfe)).toContain(nfe)
    expect(enviNFe('42', `<?xml version="1.0" encoding="UTF-8"?>\n${nfe}\n`)).toBe(enviNFe('42', nfe))
  })

  it('recusa: idLote fora da forma, NFe sem assinatura, raiz que não é a NFe, duas NFe e texto ilegível', () => {
    expect(thrown(() => enviNFe('', signed()))).toMatch(/idLote/)
    expect(thrown(() => enviNFe('1234567890123456', signed()))).toMatch(/idLote/)
    expect(thrown(() => enviNFe('1', 'x'.repeat(5)))).toMatch(/ilegível/)
    expect(thrown(() => enviNFe('1', built().xml))).toMatch(/assinada/)
    expect(thrown(() => enviNFe('1', `<consSitNFe xmlns="${NS}" versao="4.00"/>`))).toMatch(/raiz/)
    expect(thrown(() => enviNFe('1', '<NFe xmlns="urn:outro"><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/></NFe>'))).toMatch(/raiz/)
    const one = signed()
    expect(thrown(() => enviNFe('1', one.replace('</NFe>', `${one}</NFe>`)))).toMatch(/exatamente uma NFe/)
  })

  it('o lote com duas NFe é recusado também pelo XSD (764 do fisco; D-NE33)', async () => {
    const nfe = signed()
    const two = `<enviNFe xmlns="${NS}" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc>${nfe}${nfe}</enviNFe>`
    const r = await validateMessage('enviNFe', two)
    expect(r.ok).toBe(false)
  })
})

describe('consReciNFe — a consulta do recibo', () => {
  it('passa no XSD e recusa nRec fora de 15 dígitos e tpAmb fora de 1 e 2', async () => {
    expect(await validateMessage('consReciNFe', consReciNFe('411000000000001', '2'))).toEqual({ ok: true })
    for (const bad of ['', '41100000000000A', '4110000000000011']) expect(thrown(() => consReciNFe(bad, '2'))).toMatch(/nRec/)
    expect(thrown(() => consReciNFe('411000000000001', '3' as never))).toMatch(/tpAmb/)
  })
})

describe('retornos: o XSD do retEnviNFe e do retConsReciNFe está no acervo e valida as respostas do leiaute', () => {
  const prot = (cStat: string, extra = '') =>
    `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>PR-v4_00</verAplic><chNFe>${CHAVE}</chNFe><dhRecbto>2026-11-24T10:20:00-03:00</dhRecbto>`
    + `<nProt>141260000000001</nProt><digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>${cStat}</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>${extra}</infProt></protNFe>`
  const head = (cStat: string, inner: string) =>
    `<tpAmb>2</tpAmb><verAplic>PR-v4_00</verAplic><cStat>${cStat}</cStat><xMotivo>Lote processado</xMotivo><cUF>41</cUF><dhRecbto>2026-11-24T10:20:00-03:00</dhRecbto>${inner}`

  it('retEnviNFe: 104 com protNFe (síncrono), 103 com recibo e a rejeição do lote sem protNFe', async () => {
    const sync = `<retEnviNFe xmlns="${NS}" versao="4.00">${head('104', prot('100'))}</retEnviNFe>`
    const recibo = `<retEnviNFe xmlns="${NS}" versao="4.00">${head('103', '<infRec><nRec>411000000000001</nRec><tMed>1</tMed></infRec>')}</retEnviNFe>`
    const rej = `<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR-v4_00</verAplic><cStat>764</cStat><xMotivo>Rejeicao</xMotivo><cUF>41</cUF><dhRecbto>2026-11-24T10:20:00-03:00</dhRecbto></retEnviNFe>`
    for (const xml of [sync, recibo, rej]) expect(await validateMessage('retEnviNFe', xml)).toEqual({ ok: true })
  })

  it('retConsReciNFe: 104 com protNFe e 105 em processamento', async () => {
    const a = `<retConsReciNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><nRec>411000000000001</nRec><cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>41</cUF><dhRecbto>2026-11-24T10:20:00-03:00</dhRecbto>${prot('100')}</retConsReciNFe>`
    const b = `<retConsReciNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><nRec>411000000000001</nRec><cStat>105</cStat><xMotivo>Lote em processamento</xMotivo><cUF>41</cUF><dhRecbto>2026-11-24T10:20:00-03:00</dhRecbto></retConsReciNFe>`
    for (const xml of [a, b]) expect(await validateMessage('retConsReciNFe', xml)).toEqual({ ok: true })
  })

  it('o retorno com cStat de 2 dígitos ou protNFe sem chNFe é recusado (a recusa é pelo campo)', async () => {
    const bad = `<retEnviNFe xmlns="${NS}" versao="4.00">${head('10', '')}</retEnviNFe>`
    const r = await validateMessage('retEnviNFe', bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' | ')).toMatch(/cStat/)
  })

  it('o elemento de resultado do NFeAutorizacao é o retEnviNFe (suposição até a 1ª chamada em H)', () => {
    expect(RESULT_ELEMENT.NFeAutorizacao).toBe('retEnviNFe')
    expect(RESULT_ELEMENT.NFeRetAutorizacao).toBe('retConsReciNFe')
  })

  it('os três XSD novos estão no manifesto e são cópia byte a byte do acervo do Vault (hash conferido no carregamento)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(DEFAULT_XSD_DIR, 'MANIFESTO.json'), 'utf8')).files as Record<string, string>
    for (const f of ['enviNFe_v4.00.xsd', 'retEnviNFe_v4.00.xsd', 'retConsReciNFe_v4.00.xsd']) expect(Object.keys(manifest)).toContain(`PL_009_V4_00_NT_2020_006_v1.20/${f}`)
    void signature
  })
})
