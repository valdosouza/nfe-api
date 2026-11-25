/// <reference types="jest" />
/**
 * NFE.E6.P1 mudança 3 (ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §4 e §6-3; D-NE33, D-NE34, D-NE35, D-NE36, D-NE108, D-NE235): o retorno do envio
 * (`readSend`) e o que cada cStat diz à tentativa (`voiceOfCStat`). Um caso por classe do vetor `nfe-retorno.json` (transcritos aqui; o JSON do Vault é
 * criado na mudança 12). Respostas escritas à mão a partir do leiaute (nenhum XML real).
 */
import fs from 'fs'
import path from 'path'
import { voiceOfCStat } from '../authority/cstat-voice'
import { readProtocol, readReceipt, readSend } from '../authority/responses'
import { CHAVE, NS } from './xsd-fixtures'

const SOAP = 'http://www.w3.org/2003/05/soap-envelope'
const env = (inner: string) => `<soap:Envelope xmlns:soap="${SOAP}"><soap:Body><nfeResultMsg xmlns="urn:x">${inner}</nfeResultMsg></soap:Body></soap:Envelope>`
const Q = { chNFe: CHAVE, tpAmb: '2' } as const
const DIGVAL = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='
const DH = '2026-11-24T10:20:00-03:00'
const OUTRA = CHAVE.slice(0, 43) + (CHAVE[43] === '9' ? '8' : '9')

const prot = (cStat: string, o: { chave?: string; sig?: boolean; nProt?: boolean; xMotivo?: string } = {}) =>
  `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>PR</verAplic><chNFe>${o.chave ?? CHAVE}</chNFe><dhRecbto>${DH}</dhRecbto>`
  + `${o.nProt === false ? '' : '<nProt>141260000000001</nProt>'}<digVal>${DIGVAL}</digVal><cStat>${cStat}</cStat><xMotivo>${o.xMotivo ?? 'motivo'}</xMotivo></infProt>`
  + `${o.sig ? '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/></Signature>' : ''}</protNFe>`
const retEnvi = (cStat: string, inner = '', tpAmb = '2', xMotivo = 'Lote processado') =>
  env(`<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto>${inner}</retEnviNFe>`)
const sent = (cStat: string, protCStat: string, o?: Parameters<typeof prot>[1]) => voiceOfCStat(readSend(Q, retEnvi(cStat, prot(protCStat, o))), 'P')
const voice = (d: ReturnType<typeof voiceOfCStat>) => {
  if (d.action !== 'voice') throw new Error(`esperava voz, veio ${d.action}`)
  return d
}

describe('o vetor de retorno — uma classe por caso (104 com protNFe)', () => {
  it('100 → A com protocolo, digVal e o dhRecbto em UTC', () => {
    expect(sent('104', '100')).toEqual({
      action: 'voice', nProt: '141260000000001', digVal: DIGVAL, dhRecbto: DH, nRec: null,
      event: { kind: 'A', authorityCode: '100', message: 'Autorizado o uso da NF-e', dh: '2026-11-24 13:20:00', source: 'P' },
    })
  })

  it('150 → A fora de prazo', () => {
    const d = voice(sent('104', '150'))
    expect([d.event.kind, d.event.authorityCode, d.event.message]).toEqual(['A', '150', 'Autorizada fora de prazo'])
  })

  it.each(['110', '301', '302', '303'])('%s no protNFe → D, final, com o protocolo', cStat => {
    const d = voice(sent('104', cStat))
    expect([d.event.kind, d.event.authorityCode, d.nProt, d.digVal]).toEqual(['D', cStat, '141260000000001', DIGVAL])
  })

  it('rejeição da nota (703) → R com o cStat inteiro e o xMotivo, sem protocolo', () => {
    const d = voice(sent('104', '703', { nProt: false, xMotivo: 'Rejeicao: Data de emissao posterior' }))
    expect([d.event.kind, d.event.authorityCode, d.event.message, d.nProt, d.digVal]).toEqual(['R', '703', 'Rejeicao: Data de emissao posterior', null, null])
  })

  it('o xMotivo da rejeição vai até 255 caracteres e uma mensagem vazia vira texto fixo', () => {
    expect(voice(sent('104', '703', { nProt: false, xMotivo: 'x'.repeat(400) })).event.message).toHaveLength(255)
    expect(voice(sent('104', '703', { nProt: false, xMotivo: ' ' })).event.message).toBe('Rejeitada pelo fisco')
  })

  it.each(['204', '539', '205', '218', '206', '635'])('%s → consultar a chave: nenhuma voz, nunca R (o número pode já ser de uma nota)', cStat => {
    expect(sent('104', cStat, { nProt: false })).toEqual({ action: 'consult-key', reason: cStat })
  })

  it('o 539 não corta o xMotivo para achar a chave (D-NE36): a decisão não carrega o texto', () => {
    const d = sent('104', '539', { nProt: false, xMotivo: `Rejeicao: Duplicidade de NF-e, com diferenca na Chave de Acesso [chNFe:${OUTRA}][nRec:411000000000001]` })
    expect(JSON.stringify(d)).not.toContain(OUTRA)
  })
})

describe('o vetor de retorno — cabeçalho do lote', () => {
  it('lote rejeitado sem protNFe (764, 776, 215, 214) → R com o cStat do lote; 656 e 999 NÃO são rejeição da nota: ambíguo', () => {
    for (const cStat of ['656', '999']) expect([cStat, voiceOfCStat(readSend(Q, retEnvi(cStat)), 'P').action]).toEqual([cStat, 'ambiguous'])
    for (const cStat of ['764', '776', '215', '214']) {
      const d = voice(voiceOfCStat(readSend(Q, retEnvi(cStat, '', '2', 'Rejeicao do lote')), 'P'))
      expect([d.event.kind, d.event.authorityCode, d.event.message]).toEqual(['R', cStat, 'Rejeicao do lote'])
    }
  })

  it('103 → P com o nRec (a saída é a consulta do recibo — D-NE33)', () => {
    const d = voiceOfCStat(readSend(Q, retEnvi('103', '<infRec><nRec>411000000000001</nRec><tMed>1</tMed></infRec>')), 'P')
    expect(d).toEqual({ action: 'voice', nProt: null, digVal: null, dhRecbto: null, nRec: '411000000000001', event: { kind: 'P', authorityCode: '103', message: 'Lote recebido, aguardando processamento', dh: null, source: 'P' } })
  })

  it('105 → P em processamento', () => {
    const d = voice(voiceOfCStat(readSend(Q, retEnvi('105')), 'P'))
    expect([d.event.kind, d.event.authorityCode, d.nRec]).toEqual(['P', '105', null])
  })

  it('204 e 539 no TOPO também só mandam consultar a chave', () => {
    for (const cStat of ['204', '539']) expect(voiceOfCStat(readSend(Q, retEnvi(cStat)), 'P')).toEqual({ action: 'consult-key', reason: cStat })
  })

  it('106 no recibo → nenhuma voz (D-NE108); 217 e cancelada na consulta → nenhuma voz', () => {
    const rec = env(`<retConsReciNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><nRec>411000000000001</nRec><cStat>106</cStat><xMotivo>m</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto></retConsReciNFe>`)
    expect(voiceOfCStat(readReceipt({ nRec: '411000000000001', chNFe: CHAVE, tpAmb: '2' }, rec), 'Q')).toEqual({ action: 'none', reason: '106' })
    const sit = (cStat: string, inner = '') => env(`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>m</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto><chNFe>${CHAVE}</chNFe>${inner}</retConsSitNFe>`)
    expect(voiceOfCStat(readProtocol(Q, sit('217')), 'Q')).toEqual({ action: 'none', reason: '217' })
    expect(voiceOfCStat(readProtocol(Q, sit('101')), 'Q')).toEqual({ action: 'none', reason: 'cancelled' })
  })

  it('a consulta que autoriza grava A com source Q', () => {
    const sit = env(`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>100</cStat><xMotivo>m</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto><chNFe>${CHAVE}</chNFe>${prot('100')}</retConsSitNFe>`)
    expect(voice(voiceOfCStat(readProtocol(Q, sit), 'Q')).event.source).toBe('Q')
  })
})

describe('ambíguo: nada se grava (D-NE34)', () => {
  it('protNFe assinado, chave diferente, tpAmb diferente, 104 sem protNFe, 103 sem nRec, ilegível e sem cStat → ambíguo', () => {
    const cases = [
      retEnvi('104', prot('100', { sig: true })), retEnvi('104', prot('100', { chave: OUTRA })), retEnvi('104', prot('100'), '1'), retEnvi('104'),
      retEnvi('103', '<infRec><nRec>41100000000000A</nRec><tMed>1</tMed></infRec>'), retEnvi('103'), 'isto não é xml', env('<outra/>'),
      env(`<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb></retEnviNFe>`),
    ]
    for (const xml of cases) expect(voiceOfCStat(readSend(Q, xml), 'P').action).toBe('ambiguous')
  })

  it('cStat de rejeição que não tem 3 a 4 dígitos nunca vira R', () => {
    for (const cStat of ['1', '12345', 'AB1']) expect(voiceOfCStat({ kind: 'rejection', cStat, xMotivo: 'm' }, 'P').action).toBe('ambiguous')
  })

  it('o 105 confere o tpAmb do eco', () => {
    expect(readSend(Q, retEnvi('105', '', '1')).kind).toBe('ambiguous')
  })
})

describe('só a rejeição de FATO vira R, e a forma dos campos é conferida (gate adversarial HIGH-1 e M4)', () => {
  const sitOf = (cStat: string, inner = '') => env(`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>m</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto><chNFe>${CHAVE}</chNFe>${inner}</retConsSitNFe>`)
  const recOf = (cStat: string, inner = '') => env(`<retConsReciNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>PR</verAplic><nRec>411000000000001</nRec><cStat>${cStat}</cStat><xMotivo>m</xMotivo><cUF>41</cUF><dhRecbto>${DH}</dhRecbto>${inner}</retConsReciNFe>`)
  const protWith = (over: { cStat?: string; nProt?: string | null; digVal?: string | null; dh?: string }) =>
    `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>PR</verAplic><chNFe>${CHAVE}</chNFe><dhRecbto>${over.dh ?? DH}</dhRecbto>${over.nProt === null ? '' : `<nProt>${over.nProt ?? '141260000000001'}</nProt>`}`
    + `${over.digVal === null ? '' : `<digVal>${over.digVal ?? DIGVAL}</digVal>`}<cStat>${over.cStat ?? '100'}</cStat><xMotivo>m</xMotivo></infProt></protNFe>`
  const action = (d: ReturnType<typeof voiceOfCStat>) => d.action

  it('100 sem protocolo e cStat 1xx fora das classes conhecidas no protNFe: ambíguo, nunca R', () => {
    for (const cStat of ['100', '101', '108', '109', '104', '999', '1', '12345']) {
      const withProt = cStat === '100' ? protWith({ cStat, nProt: null }) : protWith({ cStat })
      expect([cStat, action(voiceOfCStat(readSend(Q, retEnvi('104', withProt)), 'P'))]).toEqual([cStat, cStat === '999' ? 'voice' : 'ambiguous'])
    }
  })

  it('cStat de topo do envio que não é rejeição (100, 101, 1xx) é ambíguo; 2xx a 9xx é rejeição do lote', () => {
    for (const cStat of ['100', '101', '150', '110']) expect([cStat, action(voiceOfCStat(readSend(Q, retEnvi(cStat)), 'P'))]).toEqual([cStat, 'ambiguous'])
    expect(action(voiceOfCStat(readSend(Q, retEnvi('764')), 'P'))).toBe('voice')
  })

  it('108/109, 104, 656 e 999 no topo da CONSULTA (pela chave e pelo recibo): nunca voz — a consulta recusada recusa a pergunta', () => {
    for (const cStat of ['108', '109', '104', '656', '999']) {
      const byKey = action(voiceOfCStat(readProtocol(Q, sitOf(cStat)), 'Q'))
      const byReceipt = action(voiceOfCStat(readReceipt({ nRec: '411000000000001', ...Q }, recOf(cStat)), 'Q'))
      expect([cStat, byKey === 'voice', byReceipt === 'voice']).toEqual([cStat, false, false])
    }
  })

  it('a nota LOCALIZADA no topo da consulta pela chave com rejeição ou cancelamento no protNFe é inconsistente: ambíguo', () => {
    for (const cStat of ['703', '101']) expect([cStat, action(voiceOfCStat(readProtocol(Q, sitOf('100', protWith({ cStat }))), 'Q'))]).toEqual([cStat, 'ambiguous'])
  })

  it('nProt, digVal e dhRecbto fora da forma: ambíguo (nunca quebram a transação da voz)', () => {
    for (const bad of [{ nProt: 'abc' }, { nProt: '1234567890123456' }, { digVal: 'curto' }, { digVal: 'A'.repeat(28) }, { dh: 'ontem' }, { dh: '2026-13-45T99:99:99-03:00' }, { dh: '2026-11-24T10:20:00' }]) {
      expect([JSON.stringify(bad), action(voiceOfCStat(readSend(Q, retEnvi('104', protWith(bad))), 'P'))]).toEqual([JSON.stringify(bad), 'ambiguous'])
    }
    expect(action(voiceOfCStat(readSend(Q, retEnvi('104', protWith({ nProt: '14126000000000123' }))), 'P'))).toBe('voice')        // 17 dígitos vale
  })
})

describe('a peça é pura e escreve o kind como constante', () => {
  it('o fonte não toca relógio, banco, rede nem segredo, e não usa cast nem spread no kind (voice-kind-fence)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'authority', 'cstat-voice.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
    for (const banned of [/Date\.now/, /new Date\(\)/, /process\.env/, /\.query\(/, /\bfetch\(/, /from 'fs'/, /\bkind\s+as\b/, /\.\.\.\s*\w*event/i]) expect([banned.source, banned.test(src)]).toEqual([banned.source, false])
    expect([...src.matchAll(/kind: '([A-Z])'/g)].map(m => m[1]).sort()).toEqual(['A', 'D', 'P', 'P', 'R'])
  })
})
