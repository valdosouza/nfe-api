import { HttpError, isValidCnpj, isValidCpf, xmlElement, xmlGroup, xmlOptionalElement, XmlUnwritableError, type TechnicalResponsible } from 'fiscal-api'
import { assertAccessKey } from '../authority/messages'
import { infNFeId } from './access-key'
import { documentInvalid, OUT_OF_FIRST_RELEASE } from './errors'
import { dec0302a04, dec1104v, dec1110v, dec1302, dec1302Opc, digits, FormatError, nfeText, toCents } from './formats'
import { productDescriptionFor, recipientNameFor, type TpAmbCode } from './homologation'
import { NFE_MAX_ITEMS, nItemAttribute, type NumberedItem } from './item-numbering'
import { complementaryInfo, simplesTexts } from './simples-text'
import { infRespTecXml, type CsrtProof } from './tech-responsible'
import { icmsTotOf, type ItemTotalsCents } from './totals'

/**
 * BUILDER DA NF-e 4.00 — PURO (NFE.E5.P3.T2 e T3; prompt_onda_nfe_sefaz.md §22.2; leiaute PL_010f — RF-NFE-66). Os mesmos fatos dão sempre
 * o mesmo XML; o que não fecha vira RECUSA, nunca XML incompleto. Devolve a `NFe` SEM assinatura (quem assina é o `signXml` do núcleo, pelo
 * `Id` do `infNFe`); o `TNFe` exige a `Signature`, então só a NF-e assinada passa no XSD.
 *
 * O builder NÃO: sorteia o cNF, gera o número, monta a chave (recebe-a pronta e tira DELA cUF, cNF, série, número, tpEmis e cDV — uma fonte
 * só), assina, calcula imposto, corrige o vNF, lê banco. A entrada é tipada pelo LEIAUTE; quem a monta a partir dos fatos do ERP é a ponte
 * (`nfe-input.ts`).
 *
 * PERFIL DO 1º RELEASE (S1 da ficha): modelo 55, emissão normal, `finNFe` 1 (venda, nota de saída) e 4 (devolução de venda própria, nota
 * de ENTRADA do mesmo emitente — S6), destinatário no Brasil; ICMS do Simples em `ICMSSN101` e `ICMSSN102` (CSOSN 102, 103, 300, 400); PIS
 * e COFINS em `…NT` (CST 04 a 09) e `…Outr` (49 a 99). O que sai disso é recusado com o motivo `fora-do-primeiro-release`.
 *
 * A recusa é `HttpError` 422 `FISCAL_DOCUMENT_INVALID` com a lista INTEIRA em `fields[]` (D-NE43); o vNF divergente é
 * `FISCAL_TOTALS_MOTOR_DEFECT` (`totals.ts`).
 */

const NS = 'http://www.portalfiscal.inf.br/nfe'
/** DANFE normal, retrato. */
export const TP_IMP = '1'
/** Emissão com aplicativo do contribuinte. */
export const PROC_EMI = '0'
/** Versão do aplicativo emissor (1 a 20 caracteres). */
export const VER_PROC = 'SETES-NFE-API-1.0'

const SN101 = '101'
const SN102_GROUP = ['102', '103', '300', '400']
const NT_CST = ['04', '05', '06', '07', '08', '09']
/** Os CST do grupo `PISOutr`/`COFINSOutr`, como o XSD os enumera (49 a 56, 60 a 67, 70 a 75, 98 e 99) — não é a faixa corrida 49 a 99. */
const OUTR_CST = ['49', '50', '51', '52', '53', '54', '55', '56', '60', '61', '62', '63', '64', '65', '66', '67', '70', '71', '72', '73', '74', '75', '98', '99']
const isOutrCst = (cst: string): boolean => OUTR_CST.includes(cst)
/** Tetos de ocorrência do leiaute. */
const MAX_PAYMENTS = 100
/** `AAAA-MM-DD` que existe no calendário. */
const isRealDate = (date: string): boolean => {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(date)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}
/** A partir desta data o Simples Nacional declara IBS/CBS em todo documento (RF-CAL-04 — Ato Conjunto 4/2026): o builder escreve o grupo do Simples (NFE.E5.P6); antes dela NÃO escreve (RF-NFE-69). */
export const IBSCBS_SIMPLES_FROM = '2027-01-01'
/** `cAtivSN` aceito pelo 1º release: 01 a 04 (a 90 — não tributável — é recusada: D-NE290, RF-SN-16). */
const SIMPLES_ACTIVITIES = ['01', '02', '03', '04']
/** `indPres` que obriga o `indIntermed` (rej. 434); nos demais ele não vai (rej. 435). */
const PRES_WITH_INTERMED = ['2', '3', '4', '9']
const UF_CODES = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO']
const DH_EMI = /^(20[0-9]{2})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([-+](0[0-9]|1[01]):00|\+12:00)$/

export interface NfeAddressInput {
  xLgr: string | null; nro: string | null; xCpl?: string | null; xBairro: string | null
  /** Código IBGE de 7 dígitos. */
  cMun: string | null
  xMun: string | null; UF: string | null; CEP: string | null
}

export interface NfePisCofinsInput {
  CST: string | null
  /** Só nos CST 49 a 99 (`…Outr`): base, alíquota e valor como texto decimal; ausentes = zero. */
  vBC?: string | null; pAliq?: string | null; value?: string | null
}

/**
 * IBS/CBS do Simples no DAS (NFE.E5.P6; NT 2026.005; D-NE286): o que o faturamento congelou para o item — o builder só ESCREVE, nunca calcula
 * (D-F10/D-F11). `classification` = `cClassTrib` (6 dígitos; o CST é o prefixo de 3 — S1). Percentuais em % como texto decimal; valores e base em centavos.
 */
export interface NfeItemSimples {
  /** `cAtivSN`: 01 a 04. */
  activity: string | null
  classification: string | null
  ibsRate: string | null
  cbsRate: string | null
  /** `true` = o item de ORIGEM não tinha o `gIBSSN` (opcional na NT): a devolução o espelha e não escreve `ibsRate`/`ibsCents`. */
  withoutIbs?: boolean
  ibsCents: number
  cbsCents: number
  /** Base do item (a soma é o `vBCIBSCBS` do total — D-NE287); não vai ao item do XML. */
  baseCents: number
}

export interface NfeItemInput {
  /** O item JÁ numerado pela peça única do nItem. */
  numbered: NumberedItem
  cProd: string | null
  /** GTIN da unidade comercial; `null` = "SEM GTIN". */
  cEAN: string | null
  xProd: string | null
  NCM: string | null
  CEST?: string | null; indEscala?: string | null; CNPJFab?: string | null
  CFOP: string | null
  uCom: string | null; qCom: string | null; vUnCom: string | null
  /** `vProd` em centavos (quantidade × unitário, a 2 casas — quem monta a entrada calcula; S11). */
  vProdCents: number
  cEANTrib: string | null
  uTrib: string | null; qTrib: string | null; vUnTrib: string | null
  vFreteCents: number; vSegCents: number; vDescCents: number; vOutroCents: number
  /** Valor aproximado dos tributos do item, em centavos; 0 = não vai. */
  vTotTribCents: number
  icms: { orig: string | null; CSOSN: string | null; pCredSN: string | null; vCredICMSSN: string | null }
  pis: NfePisCofinsInput
  cofins: NfePisCofinsInput
  /** Devolução (finNFe 4): a nota e o item de ORIGEM referenciados por este item (D-NE103/D-NE219). */
  origin?: { accessKey: string; numbered: NumberedItem } | null
  /**
   * Nota de 01/01/2027 em diante (CRT 1): o grupo do Simples do item — obrigatório na VENDA; na devolução, o grupo copiado do item da origem
   * (D-NE288) ou `null` quando a origem não o tinha (D-NE289). Em nota anterior a 2027 o dado do Simples é recusado (RF-NFE-69).
   */
  simples?: NfeItemSimples | null
}

export interface NfeInput {
  /** tpAmb: 1 = produção, 2 = homologação. */
  environment: TpAmbCode
  natOp: string | null
  /** `AAAA-MM-DDThh:mm:ss±hh:00`, na zona do estabelecimento. */
  dhEmi: string | null
  /** 0 = entrada, 1 = saída. */
  tpNF: '0' | '1'
  /** 1 = interna, 2 = interestadual. */
  idDest: '1' | '2' | '3'
  finNFe: '1' | '4'
  indFinal: '0' | '1'
  indPres: string
  emit: { CNPJ: string | null; xNome: string | null; xFant?: string | null; ender: NfeAddressInput; IE: string | null; CRT: string | null }
  dest: { CNPJ?: string | null; CPF?: string | null; xNome: string | null; ender: NfeAddressInput; indIEDest: string | null; IE?: string | null }
  items: readonly NfeItemInput[]
  /** O vNF do ERP (`tb_invoice_merchandise.total_value`) em centavos — conferido contra a fórmula oficial. */
  erpTotalCents: number
  transp: { modFrete: string | null; carrier?: { CNPJ?: string | null; CPF?: string | null; xNome: string | null; IE?: string | null; xEnder?: string | null; xMun?: string | null; UF?: string | null } | null }
  /** Parcelas da cobrança (D-NE272), na ordem; vazio = sem `cobr`. Nunca na devolução (D-NE48). */
  installments: readonly { dueDate: string | null; cents: number }[]
  /** `detPag`: forma (tPag, 2 dígitos) e valor em centavos. Na devolução: `[{ tPag: '90', cents: 0 }]`. */
  payments: readonly { tPag: string | null; cents: number }[]
  /** A observação da nota vinda do ERP; os dizeres do Simples são somados aqui. */
  note?: string | null
  techResponsible: TechnicalResponsible
  csrt?: CsrtProof | null
}

/** Coletor: cada campo é escrito por uma função; a falha vira uma linha da recusa e o XML daquele campo fica vazio. */
class Writer {
  readonly fields: { field: string; message: string }[] = []
  fail(field: string, message: string): '' { this.fields.push({ field, message }); return '' }
  /** Roda o formatador do campo; `FormatError`/`XmlUnwritableError` viram recusa com o motivo. */
  try(field: string, fn: () => string): string {
    try { return fn() } catch (e) {
      if (e instanceof FormatError) return this.fail(field, e.reason === 'vazio' ? 'Campo obrigatório vazio' : `Valor inválido (${e.message})`)
      if (e instanceof XmlUnwritableError) return this.fail(field, e.reason === 'obrigatorio-vazio' ? 'Campo obrigatório vazio' : `Valor não pode ser escrito (${e.reason})`)
      throw e
    }
  }
  /** Elemento obrigatório com formatador. */
  req(field: string, tag: string, fn: () => string | null | undefined): string { return this.try(field, () => xmlElement(tag, fn())) }
  /** Elemento opcional: `null`/vazio na entrada = não vai; preenchido passa pelo formatador. */
  opt(field: string, tag: string, value: unknown, fn: () => string | null): string {
    // Opcional em branco (nulo, vazio ou só espaços) = ausente: complemento em branco não bloqueia a nota.
    return value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ? '' : this.try(field, () => xmlOptionalElement(tag, fn()))
  }
  oneOf(field: string, value: string | null | undefined, allowed: readonly string[], tag: string): string {
    if (value === null || value === undefined || value === '') return this.fail(field, 'Campo obrigatório vazio')
    if (!allowed.includes(value)) return this.fail(field, `Valor fora do domínio do leiaute`)
    return xmlElement(tag, value)
  }
}

function addressXml(w: Writer, path: string, tag: string, a: NfeAddressInput, cepRequired: boolean): string {
  return xmlGroup(tag,
    w.req(`${path}.xLgr`, 'xLgr', () => nfeText(a.xLgr, 2, 60))
    + w.req(`${path}.nro`, 'nro', () => nfeText(a.nro, 1, 60))
    + w.opt(`${path}.xCpl`, 'xCpl', a.xCpl, () => nfeText(a.xCpl, 1, 60))
    + w.req(`${path}.xBairro`, 'xBairro', () => nfeText(a.xBairro, 2, 60))
    + w.req(`${path}.cMun`, 'cMun', () => digits(a.cMun, 7))
    + w.req(`${path}.xMun`, 'xMun', () => nfeText(a.xMun, 2, 60))
    + w.oneOf(`${path}.UF`, a.UF, UF_CODES, 'UF')
    + (cepRequired ? w.req(`${path}.CEP`, 'CEP', () => digits(a.CEP, 8)) : w.opt(`${path}.CEP`, 'CEP', a.CEP, () => digits(a.CEP, 8))))
}

function personIdXml(w: Writer, path: string, p: { CNPJ?: string | null; CPF?: string | null }): string {
  const hasCnpj = p.CNPJ != null && p.CNPJ !== '', hasCpf = p.CPF != null && p.CPF !== ''
  if (hasCnpj === hasCpf) return w.fail(`${path}.documento`, hasCnpj ? 'Informe CNPJ ou CPF, não os dois' : 'Campo obrigatório vazio')
  if (hasCnpj) return isValidCnpj(p.CNPJ as string) ? xmlElement('CNPJ', p.CNPJ as string) : w.fail(`${path}.CNPJ`, 'CNPJ inválido')
  return isValidCpf(p.CPF as string) ? xmlElement('CPF', p.CPF as string) : w.fail(`${path}.CPF`, 'CPF inválido')
}

function pisCofinsXml(w: Writer, path: string, kind: 'PIS' | 'COFINS', v: NfePisCofinsInput): { xml: string; cents: number } {
  const cst = v.CST
  if (cst === null || cst === undefined || cst === '') return { xml: w.fail(`${path}.CST`, 'Campo obrigatório vazio'), cents: 0 }
  if (NT_CST.includes(cst)) return { xml: xmlGroup(kind, xmlGroup(`${kind}NT`, xmlElement('CST', cst))), cents: 0 }
  if (!isOutrCst(cst)) return { xml: w.fail(`${path}.CST`, `CST ${cst.slice(0, 2)} — ${OUT_OF_FIRST_RELEASE}`), cents: 0 }
  let cents = 0
  const inner = xmlElement('CST', cst)
    + w.try(`${path}.vBC`, () => xmlElement('vBC', dec1302(toCents(v.vBC ?? '0'))))
    + w.try(`${path}.pAliq`, () => xmlElement(kind === 'PIS' ? 'pPIS' : 'pCOFINS', dec0302a04(v.pAliq ?? '0')))
    + w.try(`${path}.value`, () => { cents = toCents(v.value ?? '0'); return xmlElement(kind === 'PIS' ? 'vPIS' : 'vCOFINS', dec1302(cents)) })
  return { xml: xmlGroup(kind, xmlGroup(`${kind}Outr`, inner)), cents }
}

interface SimplesCents { base: number; ibs: number; cbs: number }

/**
 * Valida o grupo do Simples do item e devolve o que escreve; recusas viram linhas da lista (nunca XML incompleto). Compra governamental (RF-SN-18: com a União, `pIBSSN` = 0
 * e `pCBSSN` = a soma) NÃO é detectável hoje — nenhum fato de ente governamental no ERP web (S7 da ficha do P6, `it.todo` em nfe-ibscbs-2027.test.ts).
 */
function simplesOf(w: Writer, input: NfeInput, it: NfeItemInput, p: string, from2027: boolean): { activityXml: string; group: string; cents: SimplesCents } | null {
  const s0 = it.simples                                                      // lido UMA vez: um accessor que muda de valor não driblava a recusa (gate adversarial)
  const isReturn = input.finNFe === '4'
  if (!from2027) {
    if (s0 !== undefined && s0 !== null) w.fail(`${p}.simples`, 'IBS/CBS do Simples não vai em nota anterior a 01/01/2027 (RF-NFE-69)')
    return null
  }
  if (s0 === null && isReturn) return null                                   // D-NE289: a origem de 2026 não tinha o grupo
  if (s0 === undefined || s0 === null) {
    w.fail(`${p}.simples`, isReturn
      ? `Devolução sem a decisão do grupo do Simples da origem — ${OUT_OF_FIRST_RELEASE}`
      : `Item sem o IBS/CBS do Simples guardado pelo faturamento (ou regime regular) — ${OUT_OF_FIRST_RELEASE}`)
    return null
  }
  if (!isObject(s0)) { w.fail(`${p}.simples`, 'Entrada malformada'); return null }
  // Cópia ÚNICA dos campos: validar e escrever leem a mesma coisa.
  const s = { activity: s0.activity, classification: s0.classification, ibsRate: s0.ibsRate, cbsRate: s0.cbsRate, ibsCents: s0.ibsCents, cbsCents: s0.cbsCents, baseCents: s0.baseCents, withoutIbs: s0.withoutIbs === true }
  const before = w.fields.length
  if (s.activity === '90') w.fail(`${p}.cAtivSN`, `Atividade 90 (não tributável) — ${OUT_OF_FIRST_RELEASE}`)
  else if (s.activity === null || s.activity === undefined || s.activity === '') w.fail(`${p}.cAtivSN`, 'Campo obrigatório vazio')
  else if (typeof s.activity !== 'string' || !SIMPLES_ACTIVITIES.includes(s.activity)) w.fail(`${p}.cAtivSN`, 'Valor fora do domínio do leiaute')
  const cls = s.classification
  if (cls === null || cls === undefined || cls === '') w.fail(`${p}.cClassTrib`, 'Campo obrigatório vazio')
  else if (typeof cls !== 'string' || !/^[0-9]{6}$/.test(cls)) w.fail(`${p}.cClassTrib`, 'Valor inválido (6 dígitos)')
  const rate = (field: string, value: string | null): string => w.try(`${p}.${field}`, () => {
    const text = dec0302a04(value)
    if (Number(text) > 100) throw new FormatError('texto-invalido', 'percentual acima de 100')
    return text
  })
  const cents = (field: string, value: number): string => w.try(`${p}.${field}`, () => dec1302(value))
  const ibsRate = s.withoutIbs ? '' : rate('pIBSSN', s.ibsRate), cbsRate = rate('pCBSSN', s.cbsRate)
  const vIBS = s.withoutIbs ? '' : cents('vIBSSN', s.ibsCents), vCBS = cents('vCBSSN', s.cbsCents)
  if (!Number.isSafeInteger(s.baseCents) || s.baseCents < 0) w.fail(`${p}.vBCIBSCBS`, 'Base do item inválida')
  if (w.fields.length > before) return null
  const activityXml = w.try(`${p}.cAtivSN`, () => xmlElement('cAtivSN', s.activity))                 // só com o domínio já conferido: sem recusa em dobro
  if (w.fields.length > before) return null
  const group = xmlGroup('IBSCBS',
    xmlElement('CST', (cls as string).slice(0, 3)) + xmlElement('cClassTrib', cls as string)
    + xmlGroup('gTribSN',
      (s.withoutIbs ? '' : xmlGroup('gIBSSN', xmlElement('pIBSSN', ibsRate) + xmlElement('vIBSSN', vIBS)))
      + xmlGroup('gCBSSN', xmlElement('pCBSSN', cbsRate) + xmlElement('vCBSSN', vCBS))))
  return { activityXml, group, cents: { base: s.baseCents, ibs: s.withoutIbs ? 0 : s.ibsCents, cbs: s.cbsCents } }
}

function itemXml(w: Writer, input: NfeInput, it: NfeItemInput, from2027: boolean): { xml: string; totals: ItemTotalsCents; simples: SimplesCents | null } {
  const p = `det[${it.numbered.itemId}]`
  const simples = simplesOf(w, input, it, p, from2027)
  const cents = (field: string, value: number, optional: boolean, tag: string): string => w.try(`${p}.${field}`, () => {
    const text = optional ? dec1302Opc(value) : dec1302(value)
    return text === null ? '' : xmlElement(tag, text)
  })
  const gtin = (field: string, tag: string, value: string | null): string =>
    value === null || value === '' ? xmlElement(tag, 'SEM GTIN') : w.req(`${p}.${field}`, tag, () => { const d = digits(value, 8, 14); if (![8, 12, 13, 14].includes(d.length)) throw new FormatError('tamanho', 'GTIN de 8, 12, 13 ou 14 dígitos'); return d })
  const withCest = it.CEST != null && it.CEST !== ''
  const prod = xmlGroup('prod',
    w.req(`${p}.cProd`, 'cProd', () => nfeText(it.cProd, 1, 60))
    + gtin('cEAN', 'cEAN', it.cEAN)
    + w.req(`${p}.xProd`, 'xProd', () => nfeText(productDescriptionFor(input.environment, '55', TP_IMP, it.numbered.nItem, it.xProd), 1, 120))
    + w.req(`${p}.NCM`, 'NCM', () => digits(it.NCM, 8))
    + (withCest ? w.req(`${p}.CEST`, 'CEST', () => digits(it.CEST, 7))
      + w.opt(`${p}.indEscala`, 'indEscala', it.indEscala, () => (it.indEscala === 'S' || it.indEscala === 'N' ? it.indEscala : (() => { throw new FormatError('texto-invalido', 'indEscala S ou N') })()))
      + w.opt(`${p}.CNPJFab`, 'CNPJFab', it.CNPJFab, () => (isValidCnpj(it.CNPJFab as string) ? it.CNPJFab as string : (() => { throw new FormatError('texto-invalido', 'CNPJ do fabricante inválido') })())) : '')
    + w.req(`${p}.CFOP`, 'CFOP', () => { const c = digits(it.CFOP, 4); if (!/^[123567]/.test(c)) throw new FormatError('texto-invalido', 'CFOP começa por 1, 2, 3, 5, 6 ou 7'); return c })
    + w.req(`${p}.uCom`, 'uCom', () => nfeText(it.uCom, 1, 6))
    + w.req(`${p}.qCom`, 'qCom', () => dec1104v(it.qCom))
    + w.req(`${p}.vUnCom`, 'vUnCom', () => dec1110v(it.vUnCom))
    + cents('vProd', it.vProdCents, false, 'vProd')
    + gtin('cEANTrib', 'cEANTrib', it.cEANTrib)
    + w.req(`${p}.uTrib`, 'uTrib', () => nfeText(it.uTrib, 1, 6))
    + w.req(`${p}.qTrib`, 'qTrib', () => dec1104v(it.qTrib))
    + w.req(`${p}.vUnTrib`, 'vUnTrib', () => dec1110v(it.vUnTrib))
    + cents('vFrete', it.vFreteCents, true, 'vFrete')
    + cents('vSeg', it.vSegCents, true, 'vSeg')
    + cents('vDesc', it.vDescCents, true, 'vDesc')
    + cents('vOutro', it.vOutroCents, true, 'vOutro')
    + xmlElement('indTot', '1')
    + (simples ? simples.activityXml : ''))

  // ICMS do Simples Nacional — só os grupos do perfil (S1).
  const csosn = it.icms.CSOSN
  let icms: string
  if (csosn === null || csosn === undefined || csosn === '') icms = w.fail(`${p}.CSOSN`, 'Campo obrigatório vazio')
  else if (csosn === SN101) {
    icms = xmlGroup('ICMSSN101',
      w.oneOf(`${p}.orig`, it.icms.orig, ['0', '1', '2', '3', '4', '5', '6', '7', '8'], 'orig') + xmlElement('CSOSN', csosn)
      + w.req(`${p}.pCredSN`, 'pCredSN', () => dec0302a04(it.icms.pCredSN))
      + w.req(`${p}.vCredICMSSN`, 'vCredICMSSN', () => dec1302(toCents(it.icms.vCredICMSSN))))
  } else if (SN102_GROUP.includes(csosn)) {
    icms = xmlGroup('ICMSSN102', w.oneOf(`${p}.orig`, it.icms.orig, ['0', '1', '2', '3', '4', '5', '6', '7', '8'], 'orig') + xmlElement('CSOSN', csosn))
  } else icms = w.fail(`${p}.CSOSN`, `CSOSN/CST ${String(csosn).slice(0, 3)} — ${OUT_OF_FIRST_RELEASE}`)

  const pis = pisCofinsXml(w, `${p}.pis`, 'PIS', it.pis)
  const cofins = pisCofinsXml(w, `${p}.cofins`, 'COFINS', it.cofins)
  const imposto = xmlGroup('imposto',
    (it.vTotTribCents === 0 ? '' : cents('vTotTrib', it.vTotTribCents, false, 'vTotTrib')) + xmlGroup('ICMS', icms) + pis.xml + cofins.xml + (simples ? simples.group : ''))

  // Devolução: a referência POR ITEM (chave + nItem da origem) é o último filho do `det`.
  let reference = ''
  if (input.finNFe === '4') {
    if (!it.origin) reference = w.fail(`${p}.origin`, 'Devolução sem a nota de origem do item')
    else {
      const origin = it.origin
      reference = w.try(`${p}.origin`, () => {
        try { assertAccessKey(origin.accessKey) } catch { throw new FormatError('texto-invalido', 'chave da nota de origem fora da forma') }
        const n = origin.numbered?.nItem
        if (!Number.isInteger(n) || n < 1 || n > NFE_MAX_ITEMS) throw new FormatError('texto-invalido', 'item da nota de origem fora de 1 a 990')
        return xmlGroup('DFeReferenciado', xmlElement('chaveAcesso', origin.accessKey) + xmlElement('nItem', String(origin.numbered.nItem)))
      })
    }
  } else if (it.origin) reference = w.fail(`${p}.origin`, 'Nota de origem informada numa nota que não é devolução')

  const safe = (n: number): number => (Number.isSafeInteger(n) && n >= 0 ? n : 0)
  return {
    xml: xmlGroup('det', prod + imposto + reference, nItemAttribute(it.numbered)),
    totals: {
      vProd: safe(it.vProdCents), vDesc: safe(it.vDescCents), vFrete: safe(it.vFreteCents), vSeg: safe(it.vSegCents), vOutro: safe(it.vOutroCents),
      vBC: 0, vICMS: 0, vPIS: pis.cents, vCOFINS: cofins.cents, vTotTrib: safe(it.vTotTribCents),
    },
    simples: simples ? simples.cents : null,
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): boolean => v === null || v === undefined || typeof v === 'string'

/**
 * A FORMA da entrada (gate adversarial: `emit: null`, `items: null`, CST numérico… estouravam como `TypeError`): quem chama por engano com a
 * forma errada recebe a recusa tipada com o caminho, nunca um erro interno. Não confere conteúdo — isso é dos campos.
 */
function assertShape(input: NfeInput): void {
  const bad: { field: string; message: string }[] = []
  const need = (ok: boolean, field: string): boolean => { if (!ok) bad.push({ field, message: 'Entrada malformada' }); return ok }
  const texts = (o: Record<string, unknown>, path: string, keys: readonly string[]): void => { for (const k of keys) need(isText(o[k]), `${path}.${k}`) }
  if (!need(isObject(input), 'entrada')) throw documentInvalid('A entrada do builder está malformada', bad)
  const i = input as unknown as Record<string, any>
  texts(i, 'ide', ['natOp', 'dhEmi', 'indPres', 'note'])
  for (const side of ['emit', 'dest'] as const) {
    if (need(isObject(i[side]), side)) {
      texts(i[side], side, ['CNPJ', 'CPF', 'xNome', 'xFant', 'IE', 'CRT', 'indIEDest'])
      if (need(isObject(i[side].ender), `${side}.ender`)) texts(i[side].ender, `${side}.ender`, ['xLgr', 'nro', 'xCpl', 'xBairro', 'cMun', 'xMun', 'UF', 'CEP'])
    }
  }
  if (need(Array.isArray(i.items), 'det')) {
    (i.items as any[]).slice(0, NFE_MAX_ITEMS + 1).forEach((it, n) => {
      const p = `det[#${n + 1}]`
      if (!need(isObject(it), p)) return
      need(isObject(it.numbered) && Number.isInteger(it.numbered.itemId) && Number.isInteger(it.numbered.nItem), `${p}.numbered`)
      texts(it, p, ['cProd', 'cEAN', 'xProd', 'NCM', 'CEST', 'indEscala', 'CNPJFab', 'CFOP', 'uCom', 'qCom', 'vUnCom', 'cEANTrib', 'uTrib', 'qTrib', 'vUnTrib'])
      if (need(isObject(it.icms), `${p}.icms`)) texts(it.icms, `${p}.icms`, ['orig', 'CSOSN', 'pCredSN', 'vCredICMSSN'])
      if (it.simples !== null && it.simples !== undefined && need(isObject(it.simples), `${p}.simples`)) texts(it.simples, `${p}.simples`, ['activity', 'classification', 'ibsRate', 'cbsRate'])
      for (const tax of ['pis', 'cofins'] as const) if (need(isObject(it[tax]), `${p}.${tax}`)) texts(it[tax], `${p}.${tax}`, ['CST', 'vBC', 'pAliq', 'value'])
      if (it.origin !== null && it.origin !== undefined && need(isObject(it.origin), `${p}.origin`)) need(typeof it.origin.accessKey === 'string' && isObject(it.origin.numbered), `${p}.origin`)
    })
  }
  if (need(isObject(i.transp), 'transp')) {
    texts(i.transp, 'transp', ['modFrete'])
    if (i.transp.carrier !== null && i.transp.carrier !== undefined && need(isObject(i.transp.carrier), 'transp.carrier')) texts(i.transp.carrier, 'transp.carrier', ['CNPJ', 'CPF', 'xNome', 'IE', 'xEnder', 'xMun', 'UF'])
  }
  if (need(Array.isArray(i.installments), 'cobr')) (i.installments as any[]).slice(0, 121).forEach((d, n) => { if (need(isObject(d), `cobr.dup[${n + 1}]`)) texts(d, `cobr.dup[${n + 1}]`, ['dueDate']) })
  if (need(Array.isArray(i.payments), 'pag')) (i.payments as any[]).slice(0, MAX_PAYMENTS + 1).forEach((d, n) => { if (need(isObject(d), `pag.detPag[${n + 1}]`)) texts(d, `pag.detPag[${n + 1}]`, ['tPag']) })
  need(isObject(i.techResponsible), 'infRespTec')
  if (i.csrt !== null && i.csrt !== undefined) need(isObject(i.csrt) && typeof i.csrt.idCSRT === 'string' && typeof i.csrt.hashCSRT === 'string', 'infRespTec.csrt')
  if (bad.length) throw documentInvalid('A entrada do builder está malformada', bad)
}

/** A `NFe` sem assinatura, com o `Id` do `infNFe` para o `signXml`. Recusa: `HttpError` 422 com a lista inteira. */
export function buildNfeXml(input: NfeInput, accessKey: string): { xml: string; id: string } {
  assertAccessKey(accessKey)                                              // erro de quem chama, não recusa de nota
  assertShape(input)
  const w = new Writer()
  const key = {
    cUF: accessKey.slice(0, 2), yymm: accessKey.slice(2, 6), cnpj: accessKey.slice(6, 20), serie: String(Number(accessKey.slice(22, 25))),
    nNF: String(Number(accessKey.slice(25, 34))), tpEmis: accessKey[34], cNF: accessKey.slice(35, 43), cDV: accessKey[43],
  }
  if (key.tpEmis !== '1') w.fail('ide.tpEmis', `Emissão em contingência — ${OUT_OF_FIRST_RELEASE}`)
  if (input.environment !== '1' && input.environment !== '2') w.fail('ide.tpAmb', 'Valor fora do domínio do leiaute')

  // ---- perfil e coerência (o que impede ESCREVER uma nota certa) --------------------------------------------------------------------
  // O `dhEmi` é lido UMA vez (gate adversarial: um accessor que devolve valores diferentes entre a conferência e a escrita driblava a trava).
  const dhEmiText: unknown = input.dhEmi
  const dh = typeof dhEmiText === 'string' ? DH_EMI.exec(dhEmiText) : null
  if (dhEmiText === null || dhEmiText === undefined || dhEmiText === '') w.fail('ide.dhEmi', 'Campo obrigatório vazio')
  else if (!dh) w.fail('ide.dhEmi', 'Data e hora fora da forma do leiaute (AAAA-MM-DDThh:mm:ss±hh:00)')
  else if (`${dh[1].slice(2)}${dh[2]}` !== key.yymm) w.fail('ide.dhEmi', 'Ano e mês da emissão diferentes dos da chave de acesso')
  if (dh && !isRealDate(`${dh[1]}-${dh[2]}-${dh[3]}`)) w.fail('ide.dhEmi', 'Data da emissão inexistente no calendário')
  const emissionDate = dh && isRealDate(`${dh[1]}-${dh[2]}-${dh[3]}`) ? `${dh[1]}-${dh[2]}-${dh[3]}` : ''
  // D-NE277/D-NE286 (NFE.E5.P6): de 01/01/2027 em diante o Simples declara IBS/CBS em todo documento — `cAtivSN` por item, `gTribSN` e os totais (NT 2026.005),
  // escritos a partir do que o faturamento congelou (`NfeItemInput.simples`); item sem o grupo é RECUSADO (D-NE290), nunca autorizado sem o que a norma exige.
  // Até 31/12/2026 o grupo NÃO vai para o CRT 1 (RF-NFE-69). A data é a do `dhEmi` (D-NE278).
  const from2027 = emissionDate !== '' && emissionDate >= IBSCBS_SIMPLES_FROM
  if (input.emit.CNPJ !== key.cnpj) w.fail('emit.CNPJ', input.emit.CNPJ ? 'CNPJ do emitente diferente do da chave de acesso' : 'Campo obrigatório vazio')
  if (input.finNFe !== '1' && input.finNFe !== '4') w.fail('ide.finNFe', `Finalidade ${String(input.finNFe).slice(0, 1)} — ${OUT_OF_FIRST_RELEASE}`)
  if (input.idDest === '3') w.fail('ide.idDest', `Operação com o exterior — ${OUT_OF_FIRST_RELEASE}`)
  else if (input.idDest !== '1' && input.idDest !== '2') w.fail('ide.idDest', 'Valor fora do domínio do leiaute')
  if (input.finNFe === '1' && input.tpNF !== '1') w.fail('ide.tpNF', `Nota de entrada que não é devolução — ${OUT_OF_FIRST_RELEASE}`)
  if (input.finNFe === '4' && input.tpNF !== '0') w.fail('ide.tpNF', `Devolução de saída (a fornecedor) — ${OUT_OF_FIRST_RELEASE}`)
  if (input.items.length === 0) w.fail('det', 'Nota sem item')
  if (input.items.length > NFE_MAX_ITEMS) w.fail('det', `Mais de ${NFE_MAX_ITEMS} itens (rej. 927)`)
  const positions = input.items.map(it => it.numbered.nItem)
  if (positions.some((n, i) => n !== i + 1)) w.fail('det', 'Itens fora da ordem do nItem (1, 2, 3…)')
  if (input.emit.ender.UF && key.cUF && input.emit.ender.cMun && !String(input.emit.ender.cMun).startsWith(key.cUF)) {
    w.fail('emit.ender.cMun', 'Município do emitente de UF diferente da chave de acesso')
  }

  // ---- ide ------------------------------------------------------------------------------------------------------------------------
  const ide = xmlGroup('ide',
    xmlElement('cUF', key.cUF) + xmlElement('cNF', key.cNF)
    + w.req('ide.natOp', 'natOp', () => nfeText(input.natOp, 1, 60))
    + xmlElement('mod', '55') + xmlElement('serie', key.serie) + xmlElement('nNF', key.nNF)
    + (dh ? xmlElement('dhEmi', dhEmiText as string) : '')
    + w.oneOf('ide.tpNF', input.tpNF, ['0', '1'], 'tpNF')
    + (input.idDest === '1' || input.idDest === '2' ? xmlElement('idDest', input.idDest) : '')
    + w.req('ide.cMunFG', 'cMunFG', () => digits(input.emit.ender.cMun, 7))
    + xmlElement('tpImp', TP_IMP) + xmlElement('tpEmis', key.tpEmis) + xmlElement('cDV', key.cDV)
    + (input.environment === '1' || input.environment === '2' ? xmlElement('tpAmb', input.environment) : '')
    + (input.finNFe === '1' || input.finNFe === '4' ? xmlElement('finNFe', input.finNFe) : '')
    + w.oneOf('ide.indFinal', input.indFinal, ['0', '1'], 'indFinal')
    + w.oneOf('ide.indPres', input.indPres, ['0', '1', '2', '3', '4', '5', '9'], 'indPres')
    + (PRES_WITH_INTERMED.includes(input.indPres) ? xmlElement('indIntermed', '0') : '')
    + xmlElement('procEmi', PROC_EMI) + xmlElement('verProc', VER_PROC))

  // ---- emit e dest ------------------------------------------------------------------------------------------------------------------
  const emit = xmlGroup('emit',
    (isValidCnpj(key.cnpj) ? xmlElement('CNPJ', key.cnpj) : '')
    + w.req('emit.xNome', 'xNome', () => nfeText(input.emit.xNome, 2, 60))
    + w.opt('emit.xFant', 'xFant', input.emit.xFant, () => nfeText(input.emit.xFant, 1, 60))
    + addressXml(w, 'emit.ender', 'enderEmit', input.emit.ender, true)
    + w.req('emit.IE', 'IE', () => digits(input.emit.IE, 2, 14))
    + w.oneOf('emit.CRT', input.emit.CRT, ['1', '2', '3', '4'], 'CRT'))
  if (input.emit.CRT && input.emit.CRT !== '1') w.fail('emit.CRT', `Regime ${String(input.emit.CRT).slice(0, 1)} — ${OUT_OF_FIRST_RELEASE}`)

  const ieDest = input.dest.indIEDest
  let destIe = ''
  if (ieDest === '1') destIe = w.req('dest.IE', 'IE', () => digits(input.dest.IE, 2, 14))                      // contribuinte: IE obrigatória (rej. 728)
  const dest = xmlGroup('dest',
    personIdXml(w, 'dest', input.dest)
    + w.req('dest.xNome', 'xNome', () => nfeText(recipientNameFor(input.environment, input.dest.xNome), 2, 60))
    + addressXml(w, 'dest.ender', 'enderDest', input.dest.ender, false)
    + w.oneOf('dest.indIEDest', ieDest, ['1', '2', '9'], 'indIEDest')
    + destIe)
  if (ieDest === '9' && input.tpNF === '1' && input.indFinal !== '1') w.fail('ide.indFinal', 'Destinatário não contribuinte exige consumidor final (rej. 696)')

  // ---- det --------------------------------------------------------------------------------------------------------------------------
  const built = input.items.map(it => itemXml(w, input, it, from2027))
  if (ieDest === '9' && input.tpNF === '1' && input.items.some(it => it.icms.CSOSN === SN101)) w.fail('dest.indIEDest', 'CSOSN 101 não é aceito para destinatário não contribuinte (rej. 600)')

  // ---- pagamento e cobrança ---------------------------------------------------------------------------------------------------------
  const isReturn = input.finNFe === '4'
  let cobr = ''
  if (input.installments.length) {
    if (isReturn) w.fail('cobr', 'Devolução não leva cobrança (D-NE48)')
    else {
      let total = 0
      const dups = input.installments.map((d, i) => {
        const dp = `cobr.dup[${i + 1}]`
        if (!Number.isSafeInteger(d.cents) || d.cents <= 0) { w.fail(`${dp}.vDup`, 'Parcela com valor zero ou inválido'); return '' }
        total += d.cents
        const due = typeof d.dueDate === 'string' && isRealDate(d.dueDate) ? d.dueDate : null
        if (!due) { w.fail(`${dp}.dVenc`, d.dueDate ? 'Vencimento fora da forma AAAA-MM-DD ou inexistente no calendário' : 'Campo obrigatório vazio'); return '' }
        if (emissionDate && due < emissionDate) w.fail(`${dp}.dVenc`, 'Vencimento anterior à emissão (rej. 900)')
        if (i > 0 && typeof input.installments[i - 1].dueDate === 'string' && due < (input.installments[i - 1].dueDate as string)) w.fail(`${dp}.dVenc`, 'Vencimentos fora de ordem (rej. 850)')
        return xmlGroup('dup', xmlElement('nDup', String(i + 1).padStart(3, '0')) + xmlElement('dVenc', due) + xmlElement('vDup', dec1302(d.cents)))
      })
      if (input.installments.length > 120) w.fail('cobr', 'Mais de 120 duplicatas')
      const amount = w.try('cobr.fat', () => dec1302(total))
      cobr = xmlGroup('cobr', xmlGroup('fat', xmlElement('nFat', key.nNF) + (amount ? xmlElement('vOrig', amount) + xmlElement('vLiq', amount) : '')) + dups.join(''))
    }
  }
  let paid = 0
  if (input.payments.length === 0) w.fail('pag', 'Nota sem forma de pagamento')
  if (input.payments.length > MAX_PAYMENTS) w.fail('pag', `Mais de ${MAX_PAYMENTS} formas de pagamento`)
  const detPag = input.payments.map((pg, i) => {
    const pp = `pag.detPag[${i + 1}]`
    paid += Number.isSafeInteger(pg.cents) && pg.cents >= 0 ? pg.cents : 0
    return xmlGroup('detPag', w.req(`${pp}.tPag`, 'tPag', () => digits(pg.tPag, 2)) + w.try(`${pp}.vPag`, () => xmlElement('vPag', dec1302(pg.cents))))
  }).join('')
  const noPayment = input.payments.length === 1 && input.payments[0].tPag === '90' && input.payments[0].cents === 0
  if (!isReturn && !noPayment && input.payments.some(pg => pg.tPag === '90')) w.fail('pag', 'A forma 90 (sem pagamento) só vai sozinha e com valor zero')
  if (noPayment && input.installments.length) w.fail('cobr', 'Nota sem pagamento não leva cobrança')
  if (isReturn && !noPayment) {
    w.fail('pag', 'Devolução: forma de pagamento 90 (sem pagamento) com valor zero (rej. 871, 904)')
  }

  // ---- totais (a conferência do vNF lança FISCAL_TOTALS_MOTOR_DEFECT — defeito do motor, não desta lista) ---------------------------------
  // Só com os dados da nota já escritos sem recusa: com campo inválido os valores não são confiáveis e a lista de campos vem primeiro.
  let total = ''
  if (input.items.length && w.fields.length === 0) {
    let t: ReturnType<typeof icmsTotOf>
    try { t = icmsTotOf(built.map(b => b.totals), input.erpTotalCents, emissionDate) } catch (e) {
      if (e instanceof HttpError) throw e                                // vNF que não confere: defeito do motor, com o código próprio
      throw documentInvalid('A NF-e não pode ser montada: os totais da nota não puderam ser somados', [{ field: 'total', message: 'Soma dos itens fora do limite' }])
    }
    // "90 - sem pagamento" sozinha e com valor zero dispensa a conferência da soma (a rej. 865 não se aplica à forma 90 — D-NE275).
    if (!isReturn && !noPayment && paid !== t.vNF) w.fail('pag', 'A soma das formas de pagamento é diferente do total da nota (sem troco no 1º release)')
    const ORDER = ['vBC', 'vICMS', 'vICMSDeson', 'vFCP', 'vBCST', 'vST', 'vFCPST', 'vFCPSTRet', 'vProd', 'vFrete', 'vSeg', 'vDesc', 'vII', 'vIPI', 'vIPIDevol', 'vPIS', 'vCOFINS', 'vOutro', 'vNF'] as const
    // IBS/CBS do Simples (D-NE287): vBCIBSCBS = soma das bases; vIBSSN/vCBSSN = soma EXATA dos itens (rej. 1275, 1276, 1277, 1284 morrem por construção); sem vNFTot.
    const groups = built.map(b => b.simples).filter((x): x is SimplesCents => x !== null)
    const simplesTot = groups.length === 0 ? '' : w.try('total.IBSCBSTot', () => {
      const sum = (f: keyof SimplesCents): number => { const n = groups.reduce((a, g) => a + g[f], 0); if (!Number.isSafeInteger(n)) throw new FormatError('texto-invalido', 'soma fora do limite'); return n }
      return xmlGroup('IBSCBSTot', xmlElement('vBCIBSCBS', dec1302(sum('base'))) + xmlGroup('gTribSN', xmlElement('vIBSSN', dec1302(sum('ibs'))) + xmlElement('vCBSSN', dec1302(sum('cbs')))))
    })
    total = xmlGroup('total', xmlGroup('ICMSTot', ORDER.map(f => w.try(`total.${f}`, () => xmlElement(f, dec1302(t[f])))).join('')
      + (t.vTotTrib === 0 ? '' : xmlElement('vTotTrib', dec1302(t.vTotTrib)))) + simplesTot)
  }

  // ---- transp -----------------------------------------------------------------------------------------------------------------------
  const c = input.transp.carrier
  const transp = xmlGroup('transp',
    w.oneOf('transp.modFrete', input.transp.modFrete, ['0', '1', '2', '3', '4', '9'], 'modFrete')
    + (c ? xmlGroup('transporta',
      personIdXml(w, 'transp.carrier', c)
      + w.req('transp.carrier.xNome', 'xNome', () => nfeText(c.xNome, 2, 60))
      + w.opt('transp.carrier.IE', 'IE', c.IE, () => digits(c.IE, 2, 14))
      + w.opt('transp.carrier.xEnder', 'xEnder', c.xEnder, () => nfeText(c.xEnder, 1, 60))
      + w.opt('transp.carrier.xMun', 'xMun', c.xMun, () => nfeText(c.xMun, 1, 60))
      + (c.UF ? w.oneOf('transp.carrier.UF', c.UF, UF_CODES, 'UF') : (c.IE && c.IE.trim() !== '' ? w.fail('transp.carrier.UF', 'Transportadora com IE exige a UF (rej. 559)') : ''))) : ''))

  // ---- infAdic e responsável técnico ------------------------------------------------------------------------------------------------
  let infAdic = ''
  if (emissionDate) {
    const text = w.try('infAdic.infCpl', () => {
      const info = complementaryInfo(simplesTexts(input.emit.CRT, emissionDate), input.note ?? null)
      return info === null ? '' : nfeText(info, 1, 5000)
    })
    if (text) infAdic = xmlGroup('infAdic', xmlElement('infCpl', text))
  }
  const respTec = w.try('infRespTec', () => {
    try { return infRespTecXml(input.techResponsible, input.csrt ?? null) } catch (e) {
      if (e instanceof FormatError || e instanceof XmlUnwritableError) throw e
      throw new FormatError('texto-invalido', 'dados do responsável técnico inválidos')
    }
  })

  if (w.fields.length) throw documentInvalid(`A NF-e não pode ser montada: ${w.fields.length} problema(s) nos dados da nota`, w.fields)

  const id = infNFeId(accessKey)
  const inf = ide + emit + dest + built.map(b => b.xml).join('') + total + transp + cobr + xmlGroup('pag', detPag) + infAdic + respTec
  return { id, xml: xmlGroup('NFe', xmlGroup('infNFe', inf, { versao: '4.00', Id: id }), { xmlns: NS }) }
}
