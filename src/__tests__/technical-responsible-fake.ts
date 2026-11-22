// DEPLOY.E1.P8 (D-NE217): responsável técnico FICTÍCIO para os testes que montam o contexto — nunca os dados reais (D-NE229: o valor só
// no `.env` do Valdo). CNPJ de exemplo com DV certo (o mesmo `12345678000195` das outras suítes); e-mail num domínio reservado de exemplo.
import type { TechnicalResponsible } from 'fiscal-api'

export const FAKE_TECH_ENV = Object.freeze({
  FISCAL_TECH_RESPONSIBLE_CNPJ:    '12345678000195',
  FISCAL_TECH_RESPONSIBLE_CONTACT: 'Contato de Teste',
  FISCAL_TECH_RESPONSIBLE_EMAIL:   'suporte@example.com',
  FISCAL_TECH_RESPONSIBLE_PHONE:   '4130000000',
})

export const FAKE_TECH: TechnicalResponsible = Object.freeze({
  cnpj: FAKE_TECH_ENV.FISCAL_TECH_RESPONSIBLE_CNPJ,
  contactName: FAKE_TECH_ENV.FISCAL_TECH_RESPONSIBLE_CONTACT,
  email: FAKE_TECH_ENV.FISCAL_TECH_RESPONSIBLE_EMAIL,
  phone: FAKE_TECH_ENV.FISCAL_TECH_RESPONSIBLE_PHONE,
})
