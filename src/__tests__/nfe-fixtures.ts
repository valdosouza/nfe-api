// NFE.E5.P3 — entrada de exemplo do builder, no perfil das notas reais da D-NE242 (venda interna no PR, Simples Nacional, CSOSN 101,
// PIS/COFINS CST 07), com VALORES INVENTADOS e o CNPJ da própria Setes. Sem `.test.ts`: fora do `testMatch`.
import { signXml } from 'fiscal-api'
import { buildAccessKey } from '../nfe/access-key'
import { numberItems } from '../nfe/item-numbering'
import type { NfeInput, NfeItemInput } from '../nfe/nfe-builder'
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
