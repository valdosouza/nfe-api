import { isValidCnpj, mod11Ascii48, signXml } from 'fiscal-api'
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

/** O inverso de `CUF`: código IBGE (2 dígitos) → sigla da UF; `null` se não é uma UF do leiaute (NFE.E5.P5, regra R3). */
export function ufOfCode(code: string): Uf | null {
  for (const uf of Object.keys(CUF) as Uf[]) if (CUF[uf] === code) return uf
  return null
}

/**
 * O elemento que o `callSoap` procura é o `ret*` do MOC, dentro do invólucro de saída do WSDL (`nfeResultMsg`, que a constante dos autorizadores
 * guarda — D-NE199). PROVADO na fase 2 do smoke (SEFAZ-PR em H, 2026-11-22) para `retConsStatServ`, `retConsSitNFe` e `retConsCad`; para
 * `retInutNFe`, `retConsReciNFe` e `retEnvEvento` segue SUPOSIÇÃO até a 1ª chamada real (NE-5).
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
  // own property: `CUF['constructor']` não é UF (gate adversarial 2026-11-22)
  if (!Object.prototype.hasOwnProperty.call(CUF, uf)) throw new Error(`UF desconhecida: ${String(uf).slice(0, 4)}`)
  return CUF[uf]
}
const CNPJ_FORM = /^[0-9A-Z]{12}[0-9]{2}$/

/** Status do serviço (`consStatServ` 4.00). */
export function consStatServ(tpAmb: TpAmb, uf: Uf): string {
  assertTpAmb(tpAmb)
  return `<consStatServ xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><cUF>${cufOf(uf)}</cUF><xServ>STATUS</xServ></consStatServ>`
}

/** tpEmis do leiaute (B22): 1 a 7 e 9. */
const EMISSION_TYPES = ['1', '2', '3', '4', '5', '6', '7', '9']

/**
 * A chave de 44 posições conferida pelas regras de forma da consulta (MOC 7.00, J02a–J02g — RF-NFE-34) ANTES de ir à SEFAZ: DV pelo módulo 11
 * (`mod11Ascii48` do núcleo); mês 01–12 (616); modelo 55 — o único desta API (618; D-NE2); número > 0 (619); tpEmis do leiaute; série 0–909 com
 * CNPJ válido (617; `isValidCnpj` do núcleo, alfanumérico incluso). Série 910–969 (emitente pessoa física, CPF) é RECUSADA aqui: o emitente PF
 * é futuro (F-NFE-5); acima de 969, a SEFAZ recusa (617 — fato do smoke de 2026-11-22, série 999). A UF da chave tem de ser a pedida.
 * SUPOSIÇÃO marcada: o ano (615 — menor que 06 ou maior que o corrente) não é conferido aqui (precisaria do relógio); a SEFAZ responde.
 */
export function assertAccessKey(chNFe: string, uf?: Uf): void {
  if (!/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/.test(chNFe)) throw new Error('chNFe: 44 posições na forma da chave')
  if (mod11Ascii48(chNFe.slice(0, 43)) !== Number(chNFe[43])) throw new Error('chNFe: DV não confere')
  const month = Number(chNFe.slice(4, 6))
  if (month < 1 || month > 12) throw new Error(`chNFe: mês ${chNFe.slice(4, 6)} fora de 01 a 12 (MOC J02d, rej. 616)`)
  if (chNFe.slice(20, 22) !== '55') throw new Error(`chNFe: modelo ${chNFe.slice(20, 22)} — esta API consulta só o 55 (MOC J02f, rej. 618; D-NE2)`)
  const serie = Number(chNFe.slice(22, 25))
  if (serie > 969) throw new Error(`chNFe: série ${chNFe.slice(22, 25)} fora de 0 a 969 (MOC J02e, rej. 617)`)
  if (serie > 909) throw new Error(`chNFe: série ${chNFe.slice(22, 25)} é de emitente pessoa física (CPF) — fora desta API (F-NFE-5)`)
  if (!isValidCnpj(chNFe.slice(6, 20))) throw new Error('chNFe: CNPJ do emitente zerado ou com DV inválido (MOC J02e, rej. 617)')
  if (Number(chNFe.slice(25, 34)) === 0) throw new Error('chNFe: número = 0 (MOC J02g, rej. 619)')
  if (!EMISSION_TYPES.includes(chNFe[34])) throw new Error(`chNFe: tpEmis ${chNFe[34]} fora do leiaute`)
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
  // cada valor é LIDO UMA VEZ para uma variável e só ela é conferida e escrita (gate adversarial: getter que muda entre leituras)
  if (keys[0] === 'CNPJ') {
    const cnpj = String((who as { CNPJ: string }).CNPJ)
    if (!CNPJ_FORM.test(cnpj)) throw new Error('consCad: CNPJ com 14 posições')
    tag = `<CNPJ>${cnpj}</CNPJ>`
  } else if (keys[0] === 'IE') {
    const ie = String((who as { IE: string }).IE)
    if (!/^[0-9]{2,14}$/.test(ie)) throw new Error('consCad: IE só com dígitos (2 a 14)')
    tag = `<IE>${ie}</IE>`
  } else {
    throw new Error('consCad: exatamente um de CNPJ ou IE')
  }
  return `<ConsCad xmlns="${NS}" versao="2.00"><infCons><xServ>CONS-CAD</xServ><UF>${uf}</UF>${tag}</infCons></ConsCad>`
}

/** Texto da justificativa: só este conjunto (sem escape — D-NE214), 15 a 255 caracteres, sem espaço no início nem no fim (TJust). */
export const SAFE_JUSTIFICATION = /^(?=.{15,255}$)[A-Za-z0-9.,;:()\-/](?:[A-Za-z0-9 .,;:()\-/]*[A-Za-z0-9.,;:()\-/])$/

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
  // série de emitente CNPJ (0–909 — MOC J02e); a 910–969 é de pessoa física (F-NFE-5)
  if (!Number.isInteger(p.serie) || p.serie < 0 || p.serie > 909) throw new Error('inutNFe: série 0 a 909')
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
