import { mod11Ascii48, signXml } from 'fiscal-api'
import type { NfeService, Uf } from './authorizers'
import { voidId } from '../nfe/number-void'

/**
 * MONTADORES das mensagens da NE-3 (nfe-api:NFE.E4.P4 — ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e4-p4-smoke-sefaz-h.md`, mudança 1;
 * D-NE185, D-NE191, D-NE211; regras RF-NFE-20 a RF-NFE-23). Funções PURAS: recebem as partes e devolvem a mensagem pronta para o `callSoap`
 * (que valida no XSD antes de enviar — D-NE211). Erro de entrada = exceção (falha de programação do chamador, nunca do fisco).
 *
 * - Texto livre (o `xJust` da inutilização) só de um conjunto SEGURO de caracteres: sem escape improvisado aqui — o escritor de XML vai ao
 *   núcleo (D-NE214). O resto é número, código ou chave, conferidos pela forma.
 * - A inutilização é ASSINADA com rsa-sha1 (o xmldsig da NF-e — o XSD exige a `Signature`); na NE-3 ela só passa no XSD local, nunca vai ao
 *   fisco (D-NE191).
 */

/** cUF (IBGE) por UF — a tabela do leiaute (C02 / tabela de UF do MOC). */
export const CUF: Readonly<Record<Uf, string>> = Object.freeze({
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27',
  SE: '28', BA: '29', MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53',
})

/**
 * SUPOSIÇÃO (ficha §3): o elemento que o `callSoap` procura é o `ret*` do MOC, dentro do invólucro de saída do WSDL (`nfeResultMsg`). O WSDL
 * arquivado (fase 1 do smoke) confere a forma; a constante dos autorizadores guarda o invólucro do WSDL (D-NE199).
 */
export const RESULT_ELEMENT: Readonly<Partial<Record<NfeService, string>>> = Object.freeze({
  NfeStatusServico:     'retConsStatServ',
  NfeConsultaProtocolo: 'retConsSitNFe',
  NfeConsultaCadastro:  'retConsCad',
  NfeInutilizacao:      'retInutNFe',
  NFeRetAutorizacao:    'retConsReciNFe',
  RecepcaoEvento:       'retEnvEvento',
})

const NS = 'http://www.portalfiscal.inf.br/nfe'
export type TpAmb = '1' | '2'

const assertTpAmb = (tpAmb: string): void => { if (tpAmb !== '1' && tpAmb !== '2') throw new Error('tpAmb: 1 ou 2') }
const cufOf = (uf: Uf): string => {
  const c = CUF[uf]
  if (!c) throw new Error(`UF desconhecida: ${uf}`)
  return c
}
const CNPJ_FORM = /^[0-9A-Z]{12}[0-9]{2}$/

/** Status do serviço (`consStatServ` 4.00). */
export function consStatServ(tpAmb: TpAmb, uf: Uf): string {
  assertTpAmb(tpAmb)
  return `<consStatServ xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><cUF>${cufOf(uf)}</cUF><xServ>STATUS</xServ></consStatServ>`
}

/**
 * A chave de 44 posições bem formada: 43 + DV pelo módulo 11 (`mod11Ascii48` do núcleo); a UF da chave tem de ser a pedida (a consulta vai ao
 * autorizador da UF). CNPJ alfanumérico nas 12 primeiras posições do emitente (posições 7-18).
 */
export function assertAccessKey(chNFe: string, uf?: Uf): void {
  if (!/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/.test(chNFe)) throw new Error('chNFe: 44 posições na forma da chave')
  if (mod11Ascii48(chNFe.slice(0, 43)) !== Number(chNFe[43])) throw new Error('chNFe: DV não confere')
  if (uf !== undefined && chNFe.slice(0, 2) !== cufOf(uf)) throw new Error(`chNFe: cUF ${chNFe.slice(0, 2)} ≠ ${cufOf(uf)} (${uf})`)
}

/** Consulta de protocolo da NOSSA chave (`consSitNFe` 4.00). */
export function consSitNFe(chNFe: string, tpAmb: TpAmb, uf?: Uf): string {
  assertTpAmb(tpAmb)
  assertAccessKey(chNFe, uf)
  return `<consSitNFe xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><xServ>CONSULTAR</xServ><chNFe>${chNFe}</chNFe></consSitNFe>`
}

/** Consulta de cadastro (`ConsCad` 2.00) — exatamente um de CNPJ ou IE (a UF é a consultada). */
export function consCad(uf: Uf, who: { CNPJ: string } | { IE: string }): string {
  cufOf(uf)
  const keys = Object.keys(who)
  if (keys.length !== 1) throw new Error('consCad: exatamente um de CNPJ ou IE')
  let tag: string
  if ('CNPJ' in who) {
    if (!CNPJ_FORM.test(who.CNPJ)) throw new Error('consCad: CNPJ com 14 posições')
    tag = `<CNPJ>${who.CNPJ}</CNPJ>`
  } else if ('IE' in who) {
    if (!/^[0-9]{2,14}$/.test(who.IE)) throw new Error('consCad: IE só com dígitos (2 a 14)')
    tag = `<IE>${who.IE}</IE>`
  } else {
    throw new Error('consCad: exatamente um de CNPJ ou IE')
  }
  return `<ConsCad xmlns="${NS}" versao="2.00"><infCons><xServ>CONS-CAD</xServ><UF>${uf}</UF>${tag}</infCons></ConsCad>`
}

/** Texto da justificativa: só este conjunto (sem escape — D-NE214) e 15 a 255 caracteres (TJust). */
export const SAFE_JUSTIFICATION = /^[A-Za-z0-9 .,;:()\-/]{15,255}$/

export interface VoidParts {
  readonly tpAmb: TpAmb
  readonly uf:    Uf
  /** Ano da inutilização, 2 dígitos. */
  readonly yy:    string
  readonly cnpj:  string
  readonly serie: number
  readonly from:  number
  readonly to:    number
  readonly xJust: string
}

/** O `inutNFe` 4.00 SEM assinatura e o Id do `infInut` (montado por TODAS as partes — `voidId`). */
export function inutNFe(p: VoidParts): { xml: string; id: string } {
  assertTpAmb(p.tpAmb)
  if (!/^[0-9]{2}$/.test(p.yy)) throw new Error('inutNFe: ano com 2 dígitos')
  if (!CNPJ_FORM.test(p.cnpj)) throw new Error('inutNFe: CNPJ com 14 posições')
  if (!Number.isInteger(p.serie) || p.serie < 0 || p.serie > 999) throw new Error('inutNFe: série 0 a 999')
  if (!Number.isInteger(p.from) || !Number.isInteger(p.to) || p.from < 1 || p.to < p.from || p.to > 999_999_999) {
    throw new Error('inutNFe: faixa 1 ≤ início ≤ fim ≤ 999999999')
  }
  if (!SAFE_JUSTIFICATION.test(p.xJust)) throw new Error('inutNFe: xJust fora do conjunto seguro ou do tamanho (15 a 255)')
  const cUF = cufOf(p.uf)
  const id = voidId({ uf: cUF, yy: p.yy, cnpj: p.cnpj, model: '55', serie: p.serie, from: p.from, to: p.to })
  const xml = `<inutNFe xmlns="${NS}" versao="4.00"><infInut Id="${id}"><tpAmb>${p.tpAmb}</tpAmb><xServ>INUTILIZAR</xServ>`
    + `<cUF>${cUF}</cUF><ano>${p.yy}</ano><CNPJ>${p.cnpj}</CNPJ><mod>55</mod><serie>${p.serie}</serie>`
    + `<nNFIni>${p.from}</nNFIni><nNFFin>${p.to}</nNFFin><xJust>${p.xJust}</xJust></infInut></inutNFe>`
  return { xml, id }
}

/** Assina o `infInut` (rsa-sha1, C14N inclusiva + enveloped — o `signXml` do núcleo); a `Signature` vira o último filho do `inutNFe`. */
export function signInutNFe(v: { xml: string; id: string }, cert: Buffer, key: Buffer): string {
  return signXml(v.xml, { referenceId: v.id, cert, key, algorithm: 'sha1' })
}
