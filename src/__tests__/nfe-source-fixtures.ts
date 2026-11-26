/** Os fatos de TESTE da ponte fatos → entrada (NFE.E5.P3 e NFE.E6.P1): uma venda de R$ 4.000,00 em duas parcelas, o emitente e o destinatário. */
import type { MerchandiseItemFact, PartyFact } from '../facts/merchandise-facts'
import type { NfeInputSources } from '../nfe/nfe-input'
import { CLIENT_CNPJ, SETES_CNPJ } from './nfe-fixtures'

export const NIL_ICMS = {
  determBase: null, determBaseSt: null, discharge: null, aliqRdBase: null, baseValue: '0.000000', aliq: '0.00', aliqRd: null, value: '0.000000',
  aliqRdBaseSt: null, baseValueSt: null, aliqSt: null, aliqRdSt: null, valueSt: null, mva: null, withheldBaseValue: null, withheldValue: null,
  withheldBaseValueSt: null, withheldValueSt: null, operationValue: null, deferredAliq: null, deferredValue: null,
}
export const unit = (abbr: string, level = 1, factor = '1.000000', gtin: string | null = null) => ({ level, measureAbbreviation: abbr, factor, gtin })
export const contribution = (cst: string) => ({ cst, baseValue: '0.00', aliqValue: '0.00', tagValue: '0.00', qtSaleQtty: null, qtAliqValue: null })

export const item = (itemId: number, over: Partial<MerchandiseItemFact> = {}): MerchandiseItemFact => ({
  itemId, kind: 'Sale', merchandiseId: 900 + itemId, description: `Peça ${itemId}`, ncm: '73259990', cest: null, source: '0', manufScale: 'S', factoryCnpj: null,
  saleUnit: unit('PC'), taxableUnit: unit('PC'), quantity: '2.0000', unitValue: '1500.000000', discountValue: '0.000000', approxTaxAliq: '13.4500',
  icms: { ...NIL_ICMS, cst: '101', origin: '0', cfopId: '5101', credCalcAliq: '2.86', credExplValue: '85.800000', freightValue: '0.00', insuranceValue: '0.00', expensesValue: '0.00', approximateTax: '403.50' },
  fcp: null, ipi: null, pis: contribution('07'), cofins: contribution('07'),
  ...over,
})

export const address = (cityIbge: string, cityName: string, stateCode = 'PR') =>
  ({ kind: 'COMERCIAL', main: 'S', street: 'Rua A', number: '100', complement: null, neighborhood: 'Centro', zipCode: '81925530', cityName, cityIbge, stateCode })
export const emitter: PartyFact = {
  entityId: 98, nameCompany: 'SETES USINAGEM DE TESTE LTDA', nickTrade: 'SETES', cnpj: SETES_CNPJ, cpf: null, stateRegistration: '9053273308',
  addresses: [{ ...address('4199999', 'Outra'), main: 'N' }, address('4106902', 'Curitiba')],
  tax: { taxRegime: '1 - Simples Nacional', crt: '1', indIeDest: null, consumer: 'N' },
}
export const recipient: PartyFact = {
  entityId: 321, nameCompany: 'CLIENTE DE TESTE S.A.', nickTrade: null, cnpj: CLIENT_CNPJ, cpf: null, stateRegistration: '1234567890',
  addresses: [address('4125506', 'São José dos Pinhais')], tax: { taxRegime: null, crt: null, indIeDest: '1', consumer: 'N' },
}

export const sources = (over: Partial<NfeInputSources> = {}): NfeInputSources => ({
  environment: '2', dhEmi: '2026-11-24T10:15:30-03:00',
  header: { invoiceId: 5001, number: null, serie: '1', model: '55', dtEmission: '2026-11-24', createdAt: '2026-11-24 13:15:30', lifeEvent: 1, entityId: 321, status: '0', note: 'Pedido 5001', totalValue: '4000.00', indPres: 3 },
  items: [item(30, { quantity: '3', unitValue: '333.333333', icms: { ...item(30).icms, credExplValue: '28.600000', approximateTax: '134.50' } }), item(10)],
  operationNature: 'Venda de produção do estabelecimento', emitter, recipient,
  payments: {
    billing: { paymentTypeId: 4, nfePaymentCode: '15', plots: '2', deadline: '028/056' },
    installments: [
      { parcel: 1, dueDate: '2026-12-22', value: '2000.00', paymentTypeId: 4, nfePaymentCode: '15' },
      { parcel: 2, dueDate: '2027-01-19', value: '2000.00', paymentTypeId: 4, nfePaymentCode: '15' },
    ],
  },
  shipping: { freightMode: '0', carrierId: null, carrier: null }, returnOrigins: [],
  techResponsible: { cnpj: SETES_CNPJ, contactName: 'Suporte Setes', email: 'suporte@setes.example', phone: '4133334444' },
  ...over,
})
