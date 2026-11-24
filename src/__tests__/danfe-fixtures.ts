// NFE.E6.P3 — fixtures do DANFE (sem `.test.ts`: fora do `testMatch`). Envolvem a `NFe` ASSINADA do builder (`nfe-fixtures.ts`, A1 de TESTE) num
// `nfeProc` com o `protNFe` de autorização de teste: valores inventados, o CNPJ da própria Setes, nenhum protocolo real.
import { buildNfeXml, type NfeInput } from '../nfe/nfe-builder'
import { numberItems } from '../nfe/item-numbering'
import { saleInput, saleItem, saleKey, signNfe } from './nfe-fixtures'

export const NFE_NS = 'http://www.portalfiscal.inf.br/nfe'
export const TEST_PROTOCOL = '141260000012345'
export const TEST_RECEIVED_AT = '2026-11-24T10:16:02-03:00'

export interface ProcOptions {
  readonly key?: string
  readonly cStat?: string
  readonly nProt?: string | null
  /** A chave que o `protNFe` declara (padrão: a da nota) — para provar a recusa de protocolo de outra chave. */
  readonly protKey?: string
}

/** `protNFe` de teste (o `digVal` é um exemplo de 28 caracteres, sem valor). */
export const protNFe = (key: string, o: ProcOptions = {}): string =>
  `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>PR-v4_0_0</verAplic><chNFe>${o.protKey ?? key}</chNFe>`
  + `<dhRecbto>${TEST_RECEIVED_AT}</dhRecbto>${o.nProt === null ? '' : `<nProt>${o.nProt ?? TEST_PROTOCOL}</nProt>`}`
  + `<digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>${o.cStat ?? '100'}</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>`

const withoutDeclaration = (xml: string): string => xml.replace(/^<\?xml[^>]*\?>\s*/, '')

/** A `NFe` já assinada + o `protNFe` dentro do `nfeProc`. */
export function procOf(signedNfe: string, key: string, o: ProcOptions = {}): string {
  return `<nfeProc xmlns="${NFE_NS}" versao="4.00">${withoutDeclaration(signedNfe)}${protNFe(key, o)}</nfeProc>`
}

/** O `nfeProc` de uma venda do builder (padrão: `saleInput()` em homologação). */
export function authorizedProc(input: NfeInput = saleInput(), o: ProcOptions = {}): { xml: string; key: string; input: NfeInput } {
  const key = o.key ?? saleKey()
  return { xml: procOf(signNfe(buildNfeXml(input, key)), key, o), key, input }
}

/** Insere um trecho de XML logo ANTES da primeira ocorrência de `marker` (grupos que o builder do 1º release não escreve: `vol`, `infAdProd`, `ISSQNtot`). */
export function insertBefore(xml: string, marker: string, snippet: string): string {
  const at = xml.indexOf(marker)
  if (at < 0) throw new Error(`fixture: marcador ausente ${marker}`)
  return xml.slice(0, at) + snippet + xml.slice(at)
}

/** Venda com TODOS os opcionais vazios que o builder aceita: sem fantasia, complemento, IE, EAN, cobrança, observação e transportador. */
export function emptyOptionalsInput(): NfeInput {
  const base = saleInput()
  return {
    ...base,
    emit: { ...base.emit, xFant: null, ender: { ...base.emit.ender, xCpl: null } },
    dest: { ...base.dest, ender: { ...base.dest.ender, xCpl: null }, indIEDest: '9', IE: null },
    items: [saleItem(0, { cEAN: null, cEANTrib: null, icms: { orig: '0', CSOSN: '102', pCredSN: null, vCredICMSSN: null } })], indFinal: '1',
    erpTotalCents: 300000, installments: [], payments: [{ tPag: '01', cents: 300000 }], note: null,
    transp: { modFrete: '9' },
  }
}

/** Venda longa: `count` itens de uma linha cada (para o transbordo de folha). */
export function longInput(count: number): NfeInput {
  const numbered = numberItems(Array.from({ length: count }, (_, i) => i + 1)).items
  const items = numbered.map((n, i) => saleItem(0, {
    numbered: n, cProd: String(1000 + i), xProd: `Item de teste número ${i + 1}`, qCom: '1', qTrib: '1', vUnCom: '10.000000', vUnTrib: '10.000000',
    vProdCents: 1000, vTotTribCents: 0, icms: { orig: '0', CSOSN: '102', pCredSN: null, vCredICMSSN: null },
  }))
  return { ...saleInput(), items, erpTotalCents: 1000 * count, installments: [], payments: [{ tPag: '01', cents: 1000 * count }], note: null }
}
