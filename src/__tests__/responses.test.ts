/// <reference types="jest" />
// nfe-api:NFE.E4.P3.T2 — leitores das respostas conferidas contra a pergunta (`src/authority/responses.ts`; D-NE42, D-NE196, D-NE206 a
// D-NE210, D-NE39/D-NE106, D-NE40, D-NE108, D-NE33; RF-NFE-20 a 26). Ficha `.../ficha-nfe-e4-p3-xsd-respostas-raizes.md`, mudança 4.
// Respostas escritas à mão a partir do leiaute (nenhum XML real).
import { readCancelEvent, readProtocol, readReceipt, readRegistry, readStatus, readVoid } from '../authority/responses'
import { CHAVE, CNPJ, NS } from './xsd-fixtures'

const SOAP = 'http://www.w3.org/2003/05/soap-envelope'
/** A resposta como o `callSoap` a entrega (envelope SOAP em volta). */
const env = (inner: string) => `<soap:Envelope xmlns:soap="${SOAP}"><soap:Body><nfeResultMsg xmlns="urn:x">${inner}</nfeResultMsg></soap:Body></soap:Envelope>`
const SIG = '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/></Signature>'
const OUTRA = CHAVE.slice(0, 43) + (CHAVE[43] === '9' ? '8' : '9')

describe('status do serviço (RF-NFE-20)', () => {
  const ret = (cStat: string, tpAmb = '2', cUF = '41') =>
    env(`<retConsStatServ xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>m</xMotivo><cUF>${cUF}</cUF><dhRecbto>2026-11-21T10:00:00-03:00</dhRecbto></retConsStatServ>`)
  const q = { tpAmb: '2', cUF: '41' } as const
  it('107 → em operação; 108/109 → paralisado', () => {
    expect(readStatus(q, ret('107'))).toEqual({ kind: 'fact', fact: { state: 'operating', cStat: '107' } })
    expect(readStatus(q, ret('109'))).toEqual({ kind: 'fact', fact: { state: 'paused', cStat: '109' } })
  })
  it('eco de ambiente ou UF trocado → ambíguo; rejeição 252 → rejeição', () => {
    expect(readStatus(q, ret('107', '1'))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readStatus(q, ret('107', '2', '35'))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readStatus(q, ret('252'))).toEqual({ kind: 'rejection', cStat: '252', xMotivo: 'm' })
  })
  it('XML ilegível ou sem o retorno → ambíguo', () => {
    expect(readStatus(q, 'ok')).toEqual({ kind: 'ambiguous', cause: 'envelope-ilegivel' })
    expect(readStatus(q, env('<outra/>'))).toEqual({ kind: 'ambiguous', cause: 'envelope-ilegivel' })
  })
})

const prot = (cStat: string, chave = CHAVE, extra = '') =>
  `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>PR</verAplic><chNFe>${chave}</chNFe><dhRecbto>2026-11-21T10:00:00-03:00</dhRecbto>`
  + `${cStat === '110' || cStat === '100' || cStat === '150' || cStat === '301' ? '<nProt>141260000000001</nProt>' : ''}<digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>${cStat}</cStat><xMotivo>m</xMotivo></infProt>${extra}</protNFe>`

describe('consulta de protocolo (RF-NFE-21; D-NE42, D-NE209, D-NE210)', () => {
  const ret = (cStat: string, chave = CHAVE, inner = '') =>
    env(`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>m</xMotivo><cUF>41</cUF><dhRecbto>2026-11-21T10:00:00-03:00</dhRecbto><chNFe>${chave}</chNFe>${inner}</retConsSitNFe>`)
  const q = { chNFe: CHAVE, tpAmb: '2' } as const
  it('100 com o protNFe da nossa chave → autorizada', () => {
    expect(readProtocol(q, ret('100', CHAVE, prot('100')))).toEqual({ kind: 'fact', fact: { status: 'authorized', cStat: '100', nProt: '141260000000001', digVal: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=', dhRecbto: '2026-11-21T10:00:00-03:00' } })
  })
  it('chave do topo ou do protNFe diferente da nossa → ambíguo, NUNCA autorizada', () => {
    expect(readProtocol(q, ret('100', OUTRA, prot('100', OUTRA)))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readProtocol(q, ret('100', CHAVE, prot('100', OUTRA)))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
  })
  it('chave ausente no topo → ambíguo (D-NE210); 100 sem protNFe → ambíguo', () => {
    const semChave = ret('100', CHAVE, prot('100')).replace(`<chNFe>${CHAVE}</chNFe><protNFe`, '<protNFe')
    expect(readProtocol(q, semChave)).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readProtocol(q, ret('100'))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
  })
  it('protNFe ASSINADO → ambíguo (D-NE206; F-NFE-8)', () => {
    expect(readProtocol(q, ret('100', CHAVE, prot('100', CHAVE, SIG)))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
  })
  it('denegada 110 (e 301/302/303 no protNFe) com a nossa chave → denegada', () => {
    expect(readProtocol(q, ret('110', CHAVE, prot('110')))).toEqual({ kind: 'fact', fact: { status: 'denied', cStat: '110', nProt: '141260000000001', digVal: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=', dhRecbto: '2026-11-21T10:00:00-03:00' } })
    expect(readProtocol(q, ret('110', CHAVE, prot('301')))).toEqual({ kind: 'fact', fact: { status: 'denied', cStat: '301', nProt: '141260000000001', digVal: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=', dhRecbto: '2026-11-21T10:00:00-03:00' } })
  })
  it('101/151 no topo → cancelada; 155 no topo → ambíguo (D-NE209: o 155 só vale dentro do evento)', () => {
    expect(readProtocol(q, ret('101'))).toEqual({ kind: 'fact', fact: { status: 'cancelled', cStat: '101' } })
    expect(readProtocol(q, ret('151'))).toEqual({ kind: 'fact', fact: { status: 'cancelled', cStat: '151' } })
    expect(readProtocol(q, ret('155'))).toEqual({ kind: 'ambiguous', cause: 'situacao-ilegivel' })
  })
  it('217 → não consta; 613 → rejeição', () => {
    expect(readProtocol(q, ret('217'))).toEqual({ kind: 'fact', fact: { status: 'not-found', cStat: '217', chNFe: q.chNFe } })
    expect(readProtocol(q, ret('613'))).toEqual({ kind: 'rejection', cStat: '613', xMotivo: 'm' })
  })
})

describe('consulta de recibo (D-NE108, D-NE33)', () => {
  const ret = (cStat: string, inner = '', nRec = '411000000000001') =>
    env(`<retConsReciNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><nRec>${nRec}</nRec><cStat>${cStat}</cStat><xMotivo>m</xMotivo><cUF>41</cUF><dhRecbto>2026-11-21T10:00:00-03:00</dhRecbto>${inner}</retConsReciNFe>`)
  const q = { nRec: '411000000000001', chNFe: CHAVE, tpAmb: '2' } as const
  it('106 → não grava voz', () => expect(readReceipt(q, ret('106'))).toEqual({ kind: 'no-voice', cStat: '106' }))
  it('105 → em processamento', () => expect(readReceipt(q, ret('105'))).toEqual({ kind: 'fact', fact: { status: 'processing', cStat: '105' } }))
  it('104 com o protNFe da nossa chave → autorizada; de outra chave → ambíguo; recibo diferente → ambíguo', () => {
    expect(readReceipt(q, ret('104', prot('100')))).toEqual({ kind: 'fact', fact: { status: 'authorized', cStat: '100', nProt: '141260000000001', digVal: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=', dhRecbto: '2026-11-21T10:00:00-03:00' } })
    expect(readReceipt(q, ret('104', prot('100', OUTRA)))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readReceipt(q, ret('104', prot('100'), '411000000000002'))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
  })
})

describe('consulta cadastro (RF-NFE-22)', () => {
  const ret = (cStat: string, cnpj = CNPJ, cad = true) =>
    env(`<retConsCad xmlns="${NS}" versao="2.00"><infCons><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>m</xMotivo><UF>PR</UF><CNPJ>${cnpj}</CNPJ><dhCons>2026-11-21T10:00:00-03:00</dhCons><cUF>41</cUF>`
      + `${cad ? `<infCad><IE>9012345678</IE><CNPJ>${cnpj}</CNPJ><UF>PR</UF><cSit>1</cSit><indCredNFe>1</indCredNFe><indCredCTe>4</indCredCTe><xNome>X</xNome></infCad>` : ''}</infCons></retConsCad>`)
  const q = { UF: 'PR', CNPJ } as const
  it('111 com o eco certo → o cadastro', () => {
    expect(readRegistry(q, ret('111'))).toEqual({ kind: 'fact', fact: { cStat: '111', entries: [{ IE: '9012345678', CNPJ, CPF: null, UF: 'PR', cSit: '1' }] } })
  })
  it('CNPJ do eco diferente → ambíguo; 259 → rejeição', () => {
    expect(readRegistry(q, ret('111', '11111111000191'))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readRegistry(q, ret('259', CNPJ, false))).toEqual({ kind: 'rejection', cStat: '259', xMotivo: 'm' })
  })
})

describe('inutilização (RF-NFE-23; D-NE40, D-NE207, D-NE210)', () => {
  const q = { tpAmb: '2', cUF: '41', ano: '26', CNPJ, mod: '55', serie: 1, nNFIni: 1, nNFFin: 10 } as const
  const ret = (cStat: string, opts: { nProt?: boolean; ini?: string; drop?: string; sig?: boolean } = {}) => {
    const parts: [string, string][] = [['tpAmb', '2'], ['verAplic', 'PR'], ['cStat', cStat], ['xMotivo', 'm'], ['cUF', '41'], ['ano', '26'],
      ['CNPJ', CNPJ], ['mod', '55'], ['serie', '1'], ['nNFIni', opts.ini ?? '1'], ['nNFFin', '10'], ['dhRecbto', '2026-11-21T10:00:00-03:00']]
    if (opts.nProt !== false) parts.push(['nProt', '141260000000009'])
    const body = parts.filter(([k]) => k !== opts.drop).map(([k, v]) => `<${k}>${v}</${k}>`).join('')
    return env(`<retInutNFe xmlns="${NS}" versao="4.00"><infInut>${body}</infInut>${opts.sig ? SIG : ''}</retInutNFe>`)
  }
  it('102 com o eco inteiro → inutilizada com o protocolo', () => {
    expect(readVoid(q, ret('102'))).toEqual({ kind: 'fact', fact: { status: 'withdrawn', cStat: '102', nProt: '141260000000009' } })
  })
  it('563 → inutilizada (prova), com ou sem nProt', () => {
    expect(readVoid(q, ret('563'))).toEqual({ kind: 'fact', fact: { status: 'withdrawn', cStat: '563', nProt: '141260000000009' } })
    expect(readVoid(q, ret('563', { nProt: false }))).toEqual({ kind: 'fact', fact: { status: 'withdrawn', cStat: '563', nProt: null } })
  })
  it('256 e 241 → rejeição (D-NE207)', () => {
    expect(readVoid(q, ret('256', { nProt: false }))).toEqual({ kind: 'rejection', cStat: '256', xMotivo: 'm' })
    expect(readVoid(q, ret('241', { nProt: false }))).toEqual({ kind: 'rejection', cStat: '241', xMotivo: 'm' })
  })
  it('faixa do eco diferente ou parte ausente → ambíguo (D-NE210); resposta assinada → ambíguo (D-NE206)', () => {
    expect(readVoid(q, ret('102', { ini: '2' }))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readVoid(q, ret('563', { drop: 'serie' }))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readVoid(q, ret('102', { sig: true }))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
  })
})

describe('evento 110111 (RF-NFE-24; D-NE39, D-NE106, D-NE208, D-NE210)', () => {
  const q = { chNFe: CHAVE, tpAmb: '2', nSeqEvento: 1 } as const
  const ev = (cStat: string, chave = CHAVE, opts: { tp?: string; drop?: string; sig?: boolean } = {}) => {
    const parts: [string, string][] = [['tpAmb', '2'], ['verAplic', 'PR'], ['cOrgao', '41'], ['cStat', cStat], ['xMotivo', 'm'], ['chNFe', chave],
      ['tpEvento', opts.tp ?? '110111'], ['xEvento', 'Cancelamento'], ['nSeqEvento', '1'], ['dhRegEvento', '2026-11-21T10:00:00-03:00'], ['nProt', '141260000000077']]
    const body = parts.filter(([k]) => k !== opts.drop).map(([k, v]) => `<${k}>${v}</${k}>`).join('')
    return `<retEvento versao="1.00"><infEvento>${body}</infEvento>${opts.sig ? SIG : ''}</retEvento>`
  }
  const ret = (lote: string, ...evs: string[]) =>
    env(`<retEnvEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb><verAplic>PR</verAplic><cOrgao>41</cOrgao><cStat>${lote}</cStat><xMotivo>m</xMotivo>${evs.join('')}</retEnvEvento>`)
  it('135 e 155 com o eco → cancelada (o 128 do lote nunca decide)', () => {
    expect(readCancelEvent(q, ret('128', ev('135')))).toEqual({ kind: 'fact', fact: { status: 'cancelled', cStat: '135', nProt: '141260000000077' } })
    expect(readCancelEvent(q, ret('128', ev('155')))).toEqual({ kind: 'fact', fact: { status: 'cancelled', cStat: '155', nProt: '141260000000077' } })
  })
  it('lote 128 sem retEvento → ambíguo evento-sem-retorno', () => {
    expect(readCancelEvent(q, ret('128'))).toEqual({ kind: 'ambiguous', cause: 'evento-sem-retorno' })
  })
  it('136, 573 e 580 → ambíguo evento-nao-conferido (D-NE208)', () => {
    for (const c of ['136', '573', '580']) expect(readCancelEvent(q, ret('128', ev(c)))).toEqual({ kind: 'ambiguous', cause: 'evento-nao-conferido' })
  })
  it('chave, tpEvento ou nSeq do eco diferente/ausente → ambíguo; dois retEvento → ambíguo; assinado → ambíguo', () => {
    expect(readCancelEvent(q, ret('128', ev('135', OUTRA)))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readCancelEvent(q, ret('128', ev('135', CHAVE, { tp: '110110' })))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readCancelEvent(q, ret('128', ev('135', CHAVE, { drop: 'chNFe' })))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readCancelEvent(q, ret('128', ev('135'), ev('135')))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
    expect(readCancelEvent(q, ret('128', ev('135', CHAVE, { sig: true })))).toEqual({ kind: 'ambiguous', cause: 'nao-classificada' })
  })
  it('rejeição do evento (ex.: 501 fora do prazo) e do lote (ex.: 491) → rejeição', () => {
    expect(readCancelEvent(q, ret('128', ev('501')))).toEqual({ kind: 'rejection', cStat: '501', xMotivo: 'm' })
    expect(readCancelEvent(q, ret('491'))).toEqual({ kind: 'rejection', cStat: '491', xMotivo: 'm' })
  })
})
