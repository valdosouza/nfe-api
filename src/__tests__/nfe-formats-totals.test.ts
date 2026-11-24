/**
 * NFE.E5.P3 (mudança 3 da ficha) — formatadores tipados e totais, sem ponto flutuante (RF-NFE-28, RF-NFE-66; D-NE27, D-NE28, D-NE215).
 */
import { merchandiseInvoiceTotal, type MerchandiseTotalsCents } from 'fiscal-api'
import {
  dec0302a04, dec1104v, dec1110v, dec1302, dec1302Opc, decimalText, digits, divideExact, FormatError, multiply, nfeText, parseDecimal,
  roundToCents, subtract, toCents,
} from '../nfe/formats'
import { icmsTotOf, merchandiseTotalsOf, type ItemTotalsCents } from '../nfe/totals'

const reason = (fn: () => unknown): string => {
  try { fn() } catch (e) { return e instanceof FormatError ? e.reason : `outro erro: ${String(e)}` }
  return 'não recusou'
}

describe('decimal exato', () => {
  it('toCents: texto do banco → centavos, sem ponto flutuante', () => {
    expect([toCents('100.00'), toCents('0'), toCents('0.000000'), toCents('12.340000'), toCents('7'), toCents('0.1'), toCents('1234567890123.45')])
      .toEqual([10000, 0, 0, 1234, 700, 10, 123456789012345])
    expect(toCents('0.07') + toCents('0.01')).toBe(8)                         // 0.07 + 0.01 em ponto flutuante não dá 0.08
  })
  it('toCents recusa fração de centavo, negativo, vazio e o que não é decimal — nunca arredonda', () => {
    expect([reason(() => toCents('12.345')), reason(() => toCents('-1.00')), reason(() => toCents('')), reason(() => toCents(null)), reason(() => toCents(undefined))])
      .toEqual(['casas-demais', 'negativo', 'vazio', 'vazio', 'vazio'])
    for (const bad of ['1,50', '1e3', ' 1.00', '1.00 ', '+1.00', 'abc', '.5', '5.', 'NaN', 10 as any, 1.5 as any]) expect(reason(() => toCents(bad))).toBe('nao-decimal')
  })
  it('quantidade × unitário arredondado a 2 casas, meio para cima (S11)', () => {
    const product = (q: string, u: string) => roundToCents(multiply(parseDecimal(q), parseDecimal(u)))
    expect([product('2.0000', '50.000000'), product('3', '0.335'), product('1.5', '0.33'), product('0.3333', '10.000000'), product('1', '1.005'), product('1', '1.004')])
      .toEqual([10000, 101, 50, 333, 101, 100])
    expect(1.005 * 100).not.toBe(100.5)                                       // a conta que o ponto flutuante erra
  })
  it('vDesc = vProd − (quantidade × unitário − desconto, a 2 casas)', () => {
    const q = parseDecimal('3'), u = parseDecimal('33.333333'), d = parseDecimal('0.500000')
    const vProd = roundToCents(multiply(q, u))
    const net = roundToCents(subtract(multiply(q, u), d))
    expect([vProd, net, vProd - net]).toEqual([10000, 9950, 50])
  })
  it('divideExact: só quando fecha nas casas pedidas', () => {
    expect(decimalText(divideExact(parseDecimal('100.00'), parseDecimal('8'), 10)!, 11, 10)).toBe('12.5')
    expect(divideExact(parseDecimal('100.00'), parseDecimal('3'), 10)).toBeNull()
    expect(divideExact(parseDecimal('1'), parseDecimal('0'), 10)).toBeNull()
  })
})

describe('tipos do leiaute (tiposBasico_v4.00.xsd)', () => {
  const P1302 = /^(0|0\.[0-9]{2}|[1-9]{1}[0-9]{0,12}(\.[0-9]{2})?)$/
  const P1302OPC = /^(0\.[0-9]{1}[1-9]{1}|0\.[1-9]{1}[0-9]{1}|[1-9]{1}[0-9]{0,12}(\.[0-9]{2})?)$/
  const P1104V = /^(0|0\.[0-9]{1,4}|[1-9]{1}[0-9]{0,10}|[1-9]{1}[0-9]{0,10}(\.[0-9]{1,4})?)$/
  const P1110V = /^(0|0\.[0-9]{1,10}|[1-9]{1}[0-9]{0,10}|[1-9]{1}[0-9]{0,10}(\.[0-9]{1,10})?)$/
  const P0302A04 = /^(0|0\.[0-9]{2,4}|[1-9]{1}[0-9]{0,2}(\.[0-9]{2,4})?)$/

  it('TDec_1302: sempre 2 casas; cada saída casa com o padrão do XSD', () => {
    const out = [0, 1, 10, 100, 10000, 123456, 999999999999999].map(dec1302)
    expect(out).toEqual(['0.00', '0.01', '0.10', '1.00', '100.00', '1234.56', '9999999999999.99'])
    for (const s of out) expect(s).toMatch(P1302)
    expect([reason(() => dec1302(-1)), reason(() => dec1302(1.5)), reason(() => dec1302(NaN)), reason(() => dec1302('100' as any)), reason(() => dec1302(1_000_000_000_000_000))])
      .toEqual(['negativo', 'nao-decimal', 'nao-decimal', 'nao-decimal', 'grande-demais'])
  })
  it('TDec_1302Opc: zero é OMITIDO (null); o resto casa com o padrão', () => {
    expect(dec1302Opc(0)).toBeNull()
    for (const c of [1, 10, 99, 100, 123456]) expect(dec1302Opc(c)).toMatch(P1302OPC)
  })
  it('TDec_1104v e TDec_1110v: forma canônica, limite de casas e de inteiros', () => {
    expect(['2.0000', '2', '0.5000', '1.2345', '0', '12345678901'].map(dec1104v)).toEqual(['2', '2', '0.5', '1.2345', '0', '12345678901'])
    expect(['50.000000', '0.123456', '33.3333333333', '10'].map(dec1110v)).toEqual(['50', '0.123456', '33.3333333333', '10'])
    for (const s of ['2.0000', '0.5000', '1.2345'].map(dec1104v)) expect(s).toMatch(P1104V)
    for (const s of ['50.000000', '0.123456', '33.3333333333'].map(dec1110v)) expect(s).toMatch(P1110V)
    expect([reason(() => dec1104v('1.23456')), reason(() => dec1104v('123456789012')), reason(() => dec1104v('-1')), reason(() => dec1110v('0.12345678901'))])
      .toEqual(['casas-demais', 'grande-demais', 'negativo', 'casas-demais'])
  })
  it('TDec_0302a04 (pCredSN): de 2 a 4 casas', () => {
    const out = ['0.00', '0', '2.86', '2.8600', '12.3456', '100'].map(dec0302a04)
    expect(out).toEqual(['0.00', '0.00', '2.86', '2.86', '12.3456', '100.00'])
    for (const s of out) expect(s).toMatch(P0302A04)
    expect([reason(() => dec0302a04('1000')), reason(() => dec0302a04('1.23456'))]).toEqual(['grande-demais', 'casas-demais'])
  })
})

describe('texto (D-NE28) e dígitos', () => {
  it('mantém acento, colapsa espaços, tira controle e apara', () => {
    expect(nfeText('  Flange   usinada\tØ 50mm\r\n- não, "Ação" & Cia  ', 1, 120)).toBe('Flange usinada Ø 50mm - não, "Ação" & Cia')
    expect(reason(() => nfeText('travessão — não é do leiaute', 1, 120))).toBe('texto-invalido')
  })
  it('recusa vazio, tamanho e caractere fora de U+0020 a U+00FF — nunca corta nem troca', () => {
    expect([reason(() => nfeText('', 1, 60)), reason(() => nfeText('   \t ', 1, 60)), reason(() => nfeText(null, 1, 60)), reason(() => nfeText('A', 2, 60)),
      reason(() => nfeText('x'.repeat(61), 1, 60)), reason(() => nfeText('Peça “especial”', 1, 60)), reason(() => nfeText('emoji 😀', 1, 60)), reason(() => nfeText(5 as any, 1, 60))])
      .toEqual(['vazio', 'vazio', 'vazio', 'tamanho', 'tamanho', 'texto-invalido', 'texto-invalido', 'texto-invalido'])
  })
  it('digits: só dígitos, no tamanho', () => {
    expect([digits('83005000', 8), digits('41', 2), digits('4106902', 7), digits('123456', 6, 14)]).toEqual(['83005000', '41', '4106902', '123456'])
    expect([reason(() => digits('83005-000', 8)), reason(() => digits('8300500', 8)), reason(() => digits('', 8)), reason(() => digits(null, 8)), reason(() => digits(83005000 as any, 8))])
      .toEqual(['texto-invalido', 'tamanho', 'vazio', 'vazio', 'texto-invalido'])
  })
})

describe('totais: o ICMSTot é a soma dos itens e o vNF do ERP é conferido na tolerância zero', () => {
  const item = (over: Partial<ItemTotalsCents> = {}): ItemTotalsCents =>
    ({ vProd: 0, vDesc: 0, vFrete: 0, vSeg: 0, vOutro: 0, vBC: 0, vICMS: 0, vPIS: 0, vCOFINS: 0, vTotTrib: 0, ...over })
  const items = [item({ vProd: 10000, vDesc: 500, vFrete: 250, vTotTrib: 1345 }), item({ vProd: 3333, vOutro: 17, vTotTrib: 448 }), item({ vProd: 1, vDesc: 1 })]

  it('três itens contra a conta à mão: vNF = vProd − vDesc + vFrete + vOutro', () => {
    const t = icmsTotOf(items, 13334 - 501 + 250 + 17, '2026-11-24')
    expect(t).toEqual({
      vBC: 0, vICMS: 0, vICMSDeson: 0, vFCP: 0, vBCST: 0, vST: 0, vFCPST: 0, vFCPSTRet: 0, vProd: 13334, vFrete: 250, vSeg: 0, vDesc: 501,
      vII: 0, vIPI: 0, vIPIDevol: 0, vPIS: 0, vCOFINS: 0, vOutro: 17, vNF: 13100, vTotTrib: 1793,
    })
    expect(Object.keys(t).filter(k => k !== 'vTotTrib')).toHaveLength(19)                // os 19 campos 1-1 do XSD
  })

  it('1 centavo de diferença contra o vNF do ERP → 422 FISCAL_TOTALS_MOTOR_DEFECT, nos dois sentidos', () => {
    for (const erp of [13099, 13101, NaN]) {
      try { icmsTotOf(items, erp, '2026-11-24'); throw new Error('não recusou') } catch (e: any) {
        expect([e.statusCode, e.code, e.fields?.[0]?.field]).toEqual([422, 'FISCAL_TOTALS_MOTOR_DEFECT', 'total.vNF'])
      }
    }
  })

  it('data anterior à 1ª versão da fórmula → o mesmo código, com o campo', () => {
    try { icmsTotOf(items, 13100, '2020-01-01'); throw new Error('não recusou') } catch (e: any) {
      expect([e.statusCode, e.code]).toEqual([422, 'FISCAL_TOTALS_MOTOR_DEFECT'])
    }
  })

  it('nota sem item e parcela inválida são erro de quem chama', () => {
    expect(() => icmsTotOf([], 0, '2026-11-24')).toThrow(/sem item/)
    expect(() => icmsTotOf([item({ vProd: -1 })], 0, '2026-11-24')).toThrow(/vProd/)
    expect(() => icmsTotOf([item({ vProd: 1.5 })], 0, '2026-11-24')).toThrow(/vProd/)
  })

  it('a fórmula é a do núcleo: os casos do vetor nfe-totais.json (VNF-001 a 007; o VNF-IMP fica fora, como o II)', () => {
    const zero: MerchandiseTotalsCents = {
      vProd: 0, vDesc: 0, vICMSDesonDeducted: 0, vST: 0, vFCPST: 0, vICMSMonoReten: 0, vFrete: 0, vSeg: 0, vOutro: 0, vII: 0, vIPI: 0,
      vIPIDevol: 0, vServ: 0, vPISSTSummed: 0, vCOFINSSTSummed: 0, newVehicleSale: false,
    }
    const cases: [string, Record<string, string | boolean>, string][] = [
      ['VNF-001', { vProd: '100.00', vDesc: '10.00', vST: '5.00', vFCPST: '1.00', vFrete: '2.00', vSeg: '0.50', vOutro: '0.30', vIPI: '4.00' }, '102.80'],
      ['VNF-002', { vProd: '100.00', vICMSDesonDeducted: '12.00' }, '88.00'],
      ['VNF-003', { newVehicleSale: true, vProd: '100.00', vST: '5.00', vFCPST: '1.00', vIPI: '4.00', vIPIDevol: '2.00' }, '104.00'],
      ['VNF-004a', { vProd: '100.00', vPISSTSummed: '1.65', vCOFINSSTSummed: '7.60' }, '109.25'],
      ['VNF-004b', { vProd: '100.00' }, '100.00'],
      ['VNF-005', { vProd: '100.00', vICMSMonoReten: '7.00' }, '107.00'],
      ['VNF-006', { vProd: '100.00', vServ: '30.00' }, '130.00'],
      ['VNF-007', { vProd: '100.00', vII: '12.00', vIPI: '6.00', vOutro: '1.50' }, '119.50'],
    ]
    for (const [id, input, vNF] of cases) {
      const totals = { ...zero, ...Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? toCents(v) : v])) } as MerchandiseTotalsCents
      expect([id, dec1302(merchandiseInvoiceTotal(totals, '2026-11-24').cents)]).toEqual([id, vNF])
    }
  })

  it('as parcelas somadas: o que o 1º release não tem entra zero', () => {
    expect(merchandiseTotalsOf(items)).toEqual({
      vProd: 13334, vDesc: 501, vFrete: 250, vSeg: 0, vOutro: 17, vICMSDesonDeducted: 0, vST: 0, vFCPST: 0, vICMSMonoReten: 0, vII: 0, vIPI: 0,
      vIPIDevol: 0, vServ: 0, vPISSTSummed: 0, vCOFINSSTSummed: 0, newVehicleSale: false,
    })
  })
})
