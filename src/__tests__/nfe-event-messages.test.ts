/// <reference types="jest" />
/**
 * NFE.E6.P2 mudança 2 (ficha-nfe-e6-p2-cancelar-inutilizar-rodizio.md §7-2; D-NE39, D-NE50, D-NE106, D-NE210; RF-NFE-18/23/24): os montadores PUROS do evento 110111
 * e dos arquivos que guardam o evento e a inutilização. Nada de rede; o XSD é o do acervo.
 */
import { envEvento110111, eventoNFe110111, inutNFe, signEventoNFe, signInutNFe } from '../authority/messages'
import { validateMessage } from '../authority/xsd'
import { eventFileName, procEventoXml, procInutXml, voidFileName } from '../nfe/proc-evento'
import { saleKey } from './nfe-fixtures'
import { testA1 } from './test-a1'

const NS = 'http://www.portalfiscal.inf.br/nfe'
const KEY = saleKey()
const A1 = testA1()
const DH = '2026-11-25T10:00:00-03:00'
const PARTS = { tpAmb: '2' as const, uf: 'PR' as const, cnpj: '07742094000113', chNFe: KEY, dhEvento: DH, nProt: '141260000000001', xJust: 'Cancelamento de teste em homologacao' }
const signed = (over: Partial<typeof PARTS> = {}) => signEventoNFe(eventoNFe110111({ ...PARTS, ...over }), A1.cert, A1.key)

const retEvento = (chave = KEY, cStat = '135', nSeq = '1') =>
  `<retEnvEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb><verAplic>PR</verAplic><cOrgao>41</cOrgao><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>`
  + `<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>PR</verAplic><cOrgao>41</cOrgao><cStat>${cStat}</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>`
  + `<chNFe>${chave}</chNFe><tpEvento>110111</tpEvento><xEvento>Cancelamento registrado</xEvento><nSeqEvento>${nSeq}</nSeqEvento><dhRegEvento>${DH}</dhRegEvento><nProt>141260000000002</nProt></infEvento></retEvento></retEnvEvento>`

describe('o evento 110111 e o lote', () => {
  it('o evento assinado, no lote, passa no XSD do envEvento (Id de 54, nSeq 1, Signature no evento)', async () => {
    const ev = signed()
    expect(ev).toContain(`Id="ID110111${KEY}01"`)
    expect(`ID110111${KEY}01`).toHaveLength(54)
    expect(ev).toContain('<nSeqEvento>1</nSeqEvento>')
    expect(ev).toMatch(/<\/infEvento><Signature/)
    expect(await validateMessage('envEvento110111', envEvento110111(ev, 1))).toEqual({ ok: true })
  })

  it('xJust de 14 e 256 caracteres recusa; 15 e 255 passam; fora do conjunto seguro recusa', () => {
    const j = (n: number) => 'a'.repeat(n)
    for (const bad of [j(14), j(256), ' ' + j(20), j(20) + ' ', 'texto com <tag> aqui', 'texto com & aqui!!']) expect(() => eventoNFe110111({ ...PARTS, xJust: bad })).toThrow(/xJust/)
    for (const ok of [j(15), j(255)]) expect(() => eventoNFe110111({ ...PARTS, xJust: ok })).not.toThrow()
  })

  it('entradas fora da forma recusam: nProt, dhEvento, chave, CNPJ, tpAmb, idLote', () => {
    expect(() => eventoNFe110111({ ...PARTS, nProt: '12345' })).toThrow(/nProt/)
    expect(() => eventoNFe110111({ ...PARTS, dhEvento: '2026-11-25 10:00:00' })).toThrow(/dhEvento/)
    expect(() => eventoNFe110111({ ...PARTS, chNFe: KEY.slice(0, 43) + '0' })).toThrow()
    expect(() => eventoNFe110111({ ...PARTS, cnpj: '123' })).toThrow(/CNPJ/)
    expect(() => eventoNFe110111({ ...PARTS, tpAmb: '3' as never })).toThrow(/tpAmb/)
    expect(() => envEvento110111(signed(), 0)).toThrow(/idLote/)
  })
})

describe('o procEventoNFe (D-NE50: o evento assinado + o retEvento da nossa chave)', () => {
  it('monta o procEventoNFe que passa no XSD, com o nome da D-NE50', async () => {
    const ev = signed()
    const proc = procEventoXml(ev, retEvento(), KEY) as string
    expect(proc).not.toBeNull()
    expect(proc.startsWith(`<procEventoNFe xmlns="${NS}" versao="1.00"><evento `)).toBe(true)
    expect(await validateMessage('procEventoNFe', proc)).toEqual({ ok: true })
    expect(eventFileName(KEY)).toBe(`${KEY}-evt110111-1.xml`)
  })

  it('retorno de outra chave, de outro nSeq, sem retEvento ou ilegível: null (eco da D-NE210)', () => {
    const ev = signed()
    expect(procEventoXml(ev, retEvento(KEY.slice(0, 43) + '0'), KEY)).toBeNull()
    expect(procEventoXml(ev, retEvento(KEY, '135', '2'), KEY)).toBeNull()
    expect(procEventoXml(ev, `<retEnvEvento xmlns="${NS}" versao="1.00"/>`, KEY)).toBeNull()
    expect(procEventoXml(ev, 'não é xml', KEY)).toBeNull()
  })

  it('retEvento com nó fora do namespace da NF-e (Signature, comentário, CDATA): null — o escritor não escreve', () => {
    const ev = signed()
    const withComment = retEvento().replace('<xEvento>', '<!-- x --><xEvento>')
    const withForeign = retEvento().replace('<xEvento>', '<o:x xmlns:o="urn:outro">1</o:x><xEvento>')
    expect(procEventoXml(ev, withComment, KEY)).toBeNull()
    expect(procEventoXml(ev, withForeign, KEY)).toBeNull()
  })
})

describe('o ProcInutNFe (D-NE50: o inutNFe assinado + o retInutNFe do nosso Id)', () => {
  const v = inutNFe({ tpAmb: '2', uf: 'PR', yy: '26', cnpj: '07742094000113', serie: 1, from: 10, to: 12, xJust: 'Inutilizacao de teste em homologacao' })
  const signedInut = signInutNFe(v, A1.cert, A1.key)
  const ret = (over: Partial<Record<'cUF' | 'ano' | 'serie' | 'nNFIni' | 'nNFFin', string>> = {}) =>
    `<retInutNFe xmlns="${NS}" versao="4.00"><infInut><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>102</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo><cUF>${over.cUF ?? '41'}</cUF>`
    + `<ano>${over.ano ?? '26'}</ano><CNPJ>07742094000113</CNPJ><mod>55</mod><serie>${over.serie ?? '1'}</serie><nNFIni>${over.nNFIni ?? '10'}</nNFIni><nNFFin>${over.nNFFin ?? '12'}</nNFFin><dhRecbto>${DH}</dhRecbto><nProt>141260000000003</nProt></infInut></retInutNFe>`
  const P = { cUF: '41', ano: '26', cnpj: '07742094000113', serie: 1, from: 10, to: 12 }

  it('monta o ProcInutNFe que passa no XSD, com o nome da D-NE50', async () => {
    const proc = procInutXml(signedInut, ret(), P) as string
    expect(proc).not.toBeNull()
    expect(await validateMessage('procInutNFe', proc)).toEqual({ ok: true })
    expect(voidFileName(v.id)).toBe(`${v.id}-inut.xml`)
  })

  it('retorno com outra faixa, série, ano ou UF: null (a resposta não é do nosso pedido)', () => {
    for (const over of [{ nNFFin: '13' }, { nNFIni: '9' }, { serie: '2' }, { ano: '25' }, { cUF: '42' }]) expect(procInutXml(signedInut, ret(over), P)).toBeNull()
    expect(procInutXml(signedInut, 'não é xml', P)).toBeNull()
  })
})
