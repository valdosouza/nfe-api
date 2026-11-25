import { ELEMENT, elementsOf, isValidCnpj, mod11Ascii48, parseXml, signXml } from 'fiscal-api'
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
 * `retInutNFe`, `retConsReciNFe`, `retEnviNFe` e `retEnvEvento` segue SUPOSIÇÃO até a 1ª chamada real (NE-5/NFE.E6.P5).
 */
export const RESULT_ELEMENT: Readonly<Partial<Record<NfeService, string>>> = Object.freeze({
  NfeStatusServico:     'retConsStatServ',
  NfeConsultaProtocolo: 'retConsSitNFe',
  NfeConsultaCadastro:  'retConsCad',
  NfeInutilizacao:      'retInutNFe',
  NFeAutorizacao:       'retEnviNFe',
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

/** Consulta do recibo do lote (`consReciNFe` 4.00) — o `nRec` de 15 dígitos que o 103 devolveu. */
export function consReciNFe(nRec: string, tpAmb: TpAmb): string {
  assertTpAmb(tpAmb)
  if (!/^[0-9]{15}$/.test(nRec)) throw new Error('consReciNFe: nRec com 15 dígitos')
  return `<consReciNFe xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><nRec>${nRec}</nRec></consReciNFe>`
}

/**
 * O lote da autorização (`enviNFe` 4.00): UMA NF-e, SÍNCRONO (`indSinc` 1 — D-NE33). A NFe tem de vir ASSINADA e entra BYTE A BYTE (a assinatura é
 * sobre a forma canônica: reescrever o documento a invalidaria); o leitor estrito do núcleo confere a raiz (NFe no namespace da NF-e) e a
 * `Signature` antes. A declaração `<?xml ?>` da NFe é tirada da frente. Erro de entrada = exceção (falha de programação do chamador).
 */
export function enviNFe(idLote: string, signedNfe: string): string {
  if (!/^[0-9]{1,15}$/.test(idLote)) throw new Error('enviNFe: idLote com 1 a 15 dígitos')
  const body = String(signedNfe).replace(/^\s*<\?xml[^?]*\?>\s*/, '').trim()
  let doc: ReturnType<typeof parseXml>
  try { doc = parseXml(body) } catch { throw new Error('enviNFe: a NFe é ilegível pelo leitor estrito') }
  const all = elementsOf(doc, true).filter(e => e.nodeType === ELEMENT)
  const top = all[0]
  if (!top || (top.localName ?? top.nodeName) !== 'NFe' || top.namespaceURI !== NS) throw new Error('enviNFe: a raiz tem de ser a NFe no namespace da NF-e')
  if (all.filter(e => (e.localName ?? e.nodeName) === 'NFe' && e.namespaceURI === NS).length !== 1) throw new Error('enviNFe: exatamente uma NFe por lote (D-NE33)')
  if (!all.some(e => (e.localName ?? e.nodeName) === 'Signature' && e.namespaceURI === 'http://www.w3.org/2000/09/xmldsig#')) throw new Error('enviNFe: a NFe tem de estar assinada')
  return `<enviNFe xmlns="${NS}" versao="4.00"><idLote>${idLote}</idLote><indSinc>1</indSinc>${body}</enviNFe>`
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

// ---------------------------------------------------------------------------------------------------------------------------------------
// NFE.E6.P2 — o evento de cancelamento 110111 (D-NE39, D-NE106, D-NE50; RF-NFE-18/24)
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface CancelEventParts {
  readonly tpAmb: TpAmb
  readonly uf: Uf
  readonly cnpj: string
  readonly chNFe: string
  /** `dhEvento` já com o offset da zona do estabelecimento (`AAAA-MM-DDThh:mm:ss±hh:mm`). */
  readonly dhEvento: string
  /** O protocolo de autorização (15 dígitos) — o fisco devolve 222 se divergir do cadastrado. */
  readonly nProt: string
  readonly xJust: string
}

const DH_EVENTO_FORM = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$/

/**
 * O `evento` 110111 SEM assinatura (raiz `evento`, o que se assina e se guarda; o `envEvento` o envolve — `envEvento110111`). `nSeqEvento` é SEMPRE 1 (D-NE106; o
 * MOC rejeita outro com 594 — P15-10). O `Id` do `infEvento` tem 54 posições: "ID" + 110111 + chave de 44 + nSeq de 2 (RF-NFE-80).
 */
export function eventoNFe110111(p: CancelEventParts): { xml: string; id: string } {
  assertTpAmb(p.tpAmb)
  if (!CNPJ_FORM.test(p.cnpj)) throw new Error('evento: CNPJ com 14 posições')
  assertAccessKey(p.chNFe)
  if (!DH_EVENTO_FORM.test(p.dhEvento)) throw new Error('evento: dhEvento fora de AAAA-MM-DDThh:mm:ss±hh:mm')
  if (!/^[0-9]{15}$/.test(p.nProt)) throw new Error('evento: nProt com 15 dígitos')
  if (!SAFE_JUSTIFICATION.test(p.xJust)) throw new Error('evento: xJust fora do conjunto seguro ou do tamanho (15 a 255)')
  const id = `ID110111${p.chNFe}01`
  const xml = `<evento xmlns="${NS}" versao="1.00"><infEvento Id="${id}"><cOrgao>${cufOf(p.uf)}</cOrgao><tpAmb>${p.tpAmb}</tpAmb><CNPJ>${p.cnpj}</CNPJ>`
    + `<chNFe>${p.chNFe}</chNFe><dhEvento>${p.dhEvento}</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>`
    + `<detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${p.nProt}</nProt><xJust>${p.xJust}</xJust></detEvento></infEvento></evento>`
  return { xml, id }
}

/** Assina o `infEvento` (rsa-sha1, C14N inclusiva + enveloped): a `Signature` vira o último filho do `evento`. */
export function signEventoNFe(v: { xml: string; id: string }, cert: Buffer, key: Buffer): string {
  return signXml(v.xml, { referenceId: v.id, cert, key, algorithm: 'sha1' })
}

/** O lote do evento (D-NE39: 1 evento por lote) com o `evento` JÁ ASSINADO entrando byte a byte — nada de recorte de texto (N17). */
export function envEvento110111(signedEvento: string, idLote: number): string {
  if (!Number.isInteger(idLote) || idLote < 1 || idLote > 999_999_999_999_999) throw new Error('envEvento: idLote de 1 a 15 dígitos')
  const evento = String(signedEvento).replace(/^\s*<\?xml[^?]*\?>\s*/, '').trim()
  return `<envEvento xmlns="${NS}" versao="1.00"><idLote>${idLote}</idLote>${evento}</envEvento>`
}
