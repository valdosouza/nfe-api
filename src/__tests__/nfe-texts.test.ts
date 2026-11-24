/**
 * NFE.E5.P3 (mudança 4 da ficha) — textos de homologação (RF-NFE-29, D-NE216), dizeres do Simples (D-NE271, proposta RF-SN-28) e o grupo do
 * responsável técnico com o hash do CSRT (RF-NFE-30).
 */
import { HOMOLOGATION_FIRST_ITEM_TEXT, HOMOLOGATION_TEXT, productDescriptionFor, recipientNameFor } from '../nfe/homologation'
import { complementaryInfo, SIMPLES_ISSUER_TEXT, simplesTexts } from '../nfe/simples-text'
import { hashCsrt, infRespTecXml } from '../nfe/tech-responsible'
import { isXsdTString } from 'fiscal-api'

describe('homologação = f(tpAmb, modelo, tpImp) — D-NE216', () => {
  it('em homologação o dest/xNome é sempre o texto fixo; em produção, o nome real', () => {
    expect(recipientNameFor('2', 'ONESUBSEA DO BRASIL')).toBe('NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL')
    expect(recipientNameFor('2', null)).toBe(HOMOLOGATION_TEXT)
    expect(recipientNameFor('1', 'ONESUBSEA DO BRASIL')).toBe('ONESUBSEA DO BRASIL')
    expect(recipientNameFor('1', null)).toBeNull()
  })
  it('o xProd do item 1 só muda no 65 ou no 55 com tpImp 6; nunca nos outros itens nem em produção', () => {
    expect(productDescriptionFor('2', '55', '1', 1, 'Flange')).toBe('Flange')
    expect(productDescriptionFor('2', '55', '6', 1, 'Flange')).toBe(HOMOLOGATION_FIRST_ITEM_TEXT)
    expect(productDescriptionFor('2', '65', '4', 1, 'Flange')).toBe(HOMOLOGATION_FIRST_ITEM_TEXT)
    expect(productDescriptionFor('2', '55', '6', 2, 'Flange')).toBe('Flange')
    expect(productDescriptionFor('1', '55', '6', 1, 'Flange')).toBe('Flange')
  })
  it('os textos fixos cabem no leiaute (xNome 2-60, xProd 1-120)', () => {
    expect(isXsdTString(HOMOLOGATION_TEXT, 2, 60)).toBe(true)
    expect(isXsdTString(HOMOLOGATION_FIRST_ITEM_TEXT, 1, 120)).toBe(true)
  })
})

describe('dizeres do Simples Nacional — D-NE271 (CGSN 140, arts. 59 § 4º e 60; CGSN 190 em 01/01/2027)', () => {
  const credit = (aliq: string, value: string, csosn = '101') => ({ csosn, creditAliq: aliq, creditValue: value })

  it('CRT 1 até 31/12/2026: as duas frases do art. 59; sem crédito, só elas', () => {
    expect(simplesTexts('1', '2026-11-24', [credit('0.00', '0.000000')])).toEqual([SIMPLES_ISSUER_TEXT])
    expect(simplesTexts('1', '2026-12-31', [])).toEqual([SIMPLES_ISSUER_TEXT])
    expect(SIMPLES_ISSUER_TEXT).toBe('DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. NÃO GERA DIREITO A CRÉDITO FISCAL DE IPI.')
  })
  it('a partir de 01/01/2027 os dizeres do art. 59 deixam de ir; a frase do crédito continua', () => {
    expect(simplesTexts('1', '2027-01-01', [])).toEqual([])
    expect(simplesTexts('1', '2027-01-01', [credit('2.86', '28.600000')])).toEqual([
      'PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R$ 28,60; CORRESPONDENTE À ALÍQUOTA DE 2,86%, NOS TERMOS DO ART. 23 DA LEI COMPLEMENTAR Nº 123, DE 2006.',
    ])
  })
  it('crédito: soma por alíquota (uma frase por alíquota), só CSOSN 101 e valor maior que zero, sem ponto flutuante', () => {
    const out = simplesTexts('1', '2026-11-24', [
      credit('2.86', '1000.070000'), credit('2.8600', '234.490000'), credit('3.05', '0.010000'), credit('2.86', '50.00', '102'), credit('2.86', '0.00'),
    ])
    expect(out).toEqual([
      SIMPLES_ISSUER_TEXT,
      'PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R$ 1.234,56; CORRESPONDENTE À ALÍQUOTA DE 2,86%, NOS TERMOS DO ART. 23 DA LEI COMPLEMENTAR Nº 123, DE 2006.',
      'PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R$ 0,01; CORRESPONDENTE À ALÍQUOTA DE 3,05%, NOS TERMOS DO ART. 23 DA LEI COMPLEMENTAR Nº 123, DE 2006.',
    ])
    for (const s of out) expect(isXsdTString(s, 1, 5000)).toBe(true)                   // com acento e "Nº": dentro do alfabeto do leiaute
  })
  it('outros regimes (CRT 2, 3, 4, nulo): sem dizeres no 1º release', () => {
    for (const crt of ['2', '3', '4', null]) expect(simplesTexts(crt, '2026-11-24', [credit('2.86', '10.00')])).toEqual([])
  })
  it('data malformada é erro de quem chama', () => {
    expect(() => simplesTexts('1', '24/11/2026', [])).toThrow(/emissionDate/)
  })
  it('infCpl: os dizeres primeiro, depois a observação da nota, com " | "; nada → null', () => {
    expect(complementaryInfo([SIMPLES_ISSUER_TEXT], 'Pedido 123')).toBe(`${SIMPLES_ISSUER_TEXT} | Pedido 123`)
    expect(complementaryInfo([], 'Pedido 123')).toBe('Pedido 123')
    expect(complementaryInfo([SIMPLES_ISSUER_TEXT], '   ')).toBe(SIMPLES_ISSUER_TEXT)
    expect(complementaryInfo([], null)).toBeNull()
  })
})

describe('responsável técnico — infRespTec e hashCSRT (RF-NFE-30)', () => {
  // O ÚNICO valor de CSRT em teste: o exemplo PÚBLICO da NT 2018.005 §2.2.10.3 (MOC 7.00, visão geral).
  const EXAMPLE_CSRT = 'G8063VRTNDMO886SFNK5LDUDEI24XJ22YIPO'
  const EXAMPLE_KEY = '41180678393592000146558900000006041028190697'
  const resp = { cnpj: '07742094000113', contactName: 'Suporte Setes', email: 'suporte@setes.example', phone: '4133334444' }

  it('o exemplo da norma: Base64 do SHA-1 de CSRT + chave', () => {
    expect(hashCsrt(EXAMPLE_CSRT, EXAMPLE_KEY)).toBe('aWv6LeEM4X6u4+qBI2OYZ8grigw=')
  })
  it('entrada ruim → erro que NÃO cita o valor do CSRT', () => {
    for (const fn of [() => hashCsrt('', EXAMPLE_KEY), () => hashCsrt(EXAMPLE_CSRT, '123'), () => hashCsrt(null as any, EXAMPLE_KEY), () => hashCsrt(EXAMPLE_CSRT, null as any)]) {
      try { fn(); throw new Error('não recusou') } catch (e: any) {
        expect(e.message).toMatch(/^hashCsrt:/)
        expect(e.message).not.toContain(EXAMPLE_CSRT)
      }
    }
  })
  it('o grupo na ordem do leiaute; com o CSRT, idCSRT + hashCSRT no fim', () => {
    expect(infRespTecXml(resp)).toBe('<infRespTec><CNPJ>07742094000113</CNPJ><xContato>Suporte Setes</xContato><email>suporte@setes.example</email><fone>4133334444</fone></infRespTec>')
    expect(infRespTecXml(resp, { idCSRT: '01', hashCSRT: hashCsrt(EXAMPLE_CSRT, EXAMPLE_KEY) }))
      .toBe('<infRespTec><CNPJ>07742094000113</CNPJ><xContato>Suporte Setes</xContato><email>suporte@setes.example</email><fone>4133334444</fone>'
        + '<idCSRT>01</idCSRT><hashCSRT>aWv6LeEM4X6u4+qBI2OYZ8grigw=</hashCSRT></infRespTec>')
  })
  it('recusa dado público inválido e prova malformada', () => {
    expect(() => infRespTecXml({ ...resp, cnpj: '07742094000114' })).toThrow(/CNPJ/)
    expect(() => infRespTecXml({ ...resp, phone: '(41) 3333-4444' })).toThrow()
    expect(() => infRespTecXml({ ...resp, contactName: ' ' })).toThrow()
    expect(() => infRespTecXml(resp, { idCSRT: '1', hashCSRT: 'aWv6LeEM4X6u4+qBI2OYZ8grigw=' })).toThrow()
    expect(() => infRespTecXml(resp, { idCSRT: '01', hashCSRT: EXAMPLE_CSRT })).toThrow(/hashCSRT fora da forma/)
  })
})
