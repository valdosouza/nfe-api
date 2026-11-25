// NFE.E5.P3 — entrada de exemplo do builder, no perfil das notas reais da D-NE242 (venda interna no PR, Simples Nacional, CSOSN 101,
// PIS/COFINS CST 07), com VALORES INVENTADOS e o CNPJ da própria Setes. Sem `.test.ts`: fora do `testMatch`.
import { signXml } from 'fiscal-api'
import { buildAccessKey } from '../nfe/access-key'
import { numberItems } from '../nfe/item-numbering'
import type { NfeInput, NfeItemInput, NfeItemSimples } from '../nfe/nfe-builder'
import { testA1 } from './test-a1'

export const SETES_CNPJ = '07742094000113'
export const CLIENT_CNPJ = '11222333000181'

export const saleKey = (over: { number?: number; cnf?: string; emissionDate?: string } = {}): string =>
  buildAccessKey({ uf: 'PR', emissionDate: over.emissionDate ?? '2026-11-24', cnpj: SETES_CNPJ, model: '55', serie: 1, number: over.number ?? 15, emissionType: 1, cnf: over.cnf ?? '48213057' })

const NUMBERED = numberItems([10, 30]).items

export const saleItem = (index: 0 | 1, over: Partial<NfeItemInput> = {}): NfeItemInput => ({
  numbered: NUMBERED[index],
  cProd: index === 0 ? '910' : '930', cEAN: null, xProd: index === 0 ? 'Flange usinada em aço Ø 50 mm' : 'Bucha de bronze',
  NCM: '73259990', CFOP: '5101', uCom: 'PC', qCom: index === 0 ? '2.0000' : '3', vUnCom: index === 0 ? '1500.000000' : '333.333333',
  vProdCents: index === 0 ? 300000 : 100000, cEANTrib: null, uTrib: 'PC', qTrib: index === 0 ? '2.0000' : '3', vUnTrib: index === 0 ? '1500.000000' : '333.333333',
  vFreteCents: 0, vSegCents: 0, vDescCents: 0, vOutroCents: 0, vTotTribCents: index === 0 ? 40350 : 13450,
  icms: { orig: '0', CSOSN: '101', pCredSN: '2.86', vCredICMSSN: index === 0 ? '85.800000' : '28.600000' },
  pis: { CST: '07' }, cofins: { CST: '07' },
  ...over,
})

/** Venda interna de R$ 4.000,00 em duas parcelas, em HOMOLOGAÇÃO. */
export const saleInput = (over: Partial<NfeInput> = {}): NfeInput => ({
  environment: '2', natOp: 'Venda de produção do estabelecimento', dhEmi: '2026-11-24T10:15:30-03:00',
  tpNF: '1', idDest: '1', finNFe: '1', indFinal: '0', indPres: '3',
  emit: {
    CNPJ: SETES_CNPJ, xNome: 'SETES USINAGEM DE TESTE LTDA', xFant: 'SETES',
    ender: { xLgr: 'Rua Clemente Mendes', nro: '1081', xBairro: 'Sítio Cercado', cMun: '4106902', xMun: 'Curitiba', UF: 'PR', CEP: '81925530' },
    IE: '9053273308', CRT: '1',
  },
  dest: {
    CNPJ: CLIENT_CNPJ, xNome: 'CLIENTE DE TESTE S.A.',
    ender: { xLgr: 'Av. das Indústrias', nro: '500', xCpl: 'Galpão 2', xBairro: 'Distrito Industrial', cMun: '4125506', xMun: 'São José dos Pinhais', UF: 'PR', CEP: '83005000' },
    indIEDest: '1', IE: '1234567890',
  },
  items: [saleItem(0), saleItem(1)],
  erpTotalCents: 400000,
  transp: { modFrete: '0' },
  installments: [{ dueDate: '2026-12-22', cents: 200000 }, { dueDate: '2027-01-19', cents: 200000 }],
  payments: [{ tPag: '15', cents: 400000 }],
  note: 'Pedido 5001',
  techResponsible: { cnpj: SETES_CNPJ, contactName: 'Suporte Setes', email: 'suporte@setes.example', phone: '4133334444' },
  csrt: { idCSRT: '01', hashCSRT: 'aWv6LeEM4X6u4+qBI2OYZ8grigw=' },
  ...over,
})

/** Assina a `NFe` do builder com o A1 de TESTE (autoassinado, sem valor fiscal), como a transmissão fará com o A1 do emitente. */
export const signNfe = (built: { xml: string; id: string }): string => {
  const a1 = testA1()
  return signXml(built.xml, { referenceId: built.id, cert: a1.cert, key: a1.key, algorithm: 'sha1' })
}

/** A devolução de 2026 do `nfe-return.test.ts` (nota de ENTRADA do mesmo emitente, referência por item), reusada pelos testes de IBS/CBS. */
export const returnOriginKey = (): string => saleKey()
export const returnKey = (over: { emissionDate?: string; number?: number; cnf?: string } = {}): string =>
  saleKey({ number: over.number ?? 16, cnf: over.cnf ?? '70531942', emissionDate: over.emissionDate })
export const returnSaleInput = (over: Partial<NfeInput> = {}): NfeInput => {
  const numbered = numberItems([1, 2]).items
  const origin = numberItems([10, 30]).items
  const item = (i: 0 | 1): NfeItemInput => saleItem(i, {
    numbered: numbered[i], CFOP: '1201', qCom: i === 0 ? '1' : '3', qTrib: i === 0 ? '1' : '3', vProdCents: i === 0 ? 150000 : 100000, vTotTribCents: 0,
    icms: { orig: '0', CSOSN: '101', pCredSN: '0.00', vCredICMSSN: '0.00' }, origin: { accessKey: returnOriginKey(), numbered: origin[i] },
  })
  return saleInput({
    natOp: 'Devolução de venda de produção do estabelecimento', dhEmi: '2026-11-25T09:00:00-03:00', tpNF: '0', finNFe: '4',
    items: [item(0), item(1)], erpTotalCents: 250000, installments: [], payments: [{ tPag: '90', cents: 0 }], note: null, ...over,
  })
}

/** NFE.E5.P6 — o grupo do Simples que o faturamento congela para os dois itens da venda de exemplo (IBS 0,1000 % e CBS 0,9000 %; atividades 01 e 02). */
export const simplesFor = (index: 0 | 1, over: Partial<NfeItemSimples> = {}): NfeItemSimples => ({
  activity: index === 0 ? '01' : '02', classification: '000001', ibsRate: '0.1000', cbsRate: '0.9000',
  ibsCents: index === 0 ? 300 : 100, cbsCents: index === 0 ? 2700 : 900, baseCents: index === 0 ? 300000 : 100000, ...over,
})

/** Venda do Simples de 2027 (dhEmi e parcela da data pedida), com o grupo do Simples nos dois itens. Totais: base 4.000,00, IBS 4,00, CBS 36,00. */
export const sale2027 = (dhEmi = '2027-01-15T10:15:30-03:00', over: Partial<NfeInput> = {}): { input: NfeInput; key: string } => ({
  input: saleInput({
    dhEmi, installments: [{ dueDate: `${dhEmi.slice(0, 4)}-${String(Number(dhEmi.slice(5, 7)) % 12 + 1).padStart(2, '0')}-20`, cents: 400000 }],
    items: [saleItem(0, { simples: simplesFor(0) }), saleItem(1, { simples: simplesFor(1) })], ...over,
  }),
  key: saleKey({ emissionDate: dhEmi.slice(0, 10) }),
})
