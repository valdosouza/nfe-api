/**
 * AUTORIZADORES DA NF-e como DADO DATADO (NE-3, nfe-api:NFE.E4.P2.T2 — D-NE3, D-NE37, D-NE96, D-NE162; regras RF-NFE-13, RF-NFE-14,
 * RF-NFE-15, RF-CAL-08, RF-NFE-03). Constante versionada do adaptador — nunca tabela no banco (veto de `fiscal-api/src/establishment/
 * issuer-models.ts:9`), nunca variável de ambiente. Mudou a relação do Portal? Nova leitura do acervo + diff + novo arquivo em `acervo/`.
 *
 * Fonte: "Relação de Serviços Web" do Portal Nacional da NF-e (P e H), lida em 15/10/2026 — `acervo/autorizadores-2026-10-15.json`, cópia
 * BYTE A BYTE do acervo (`projetos/nfe-api/SUBJECT/NFE_SEFAZ/integracoes/nfe-sefaz/` no Vault; AUTORIZADORES.md). O teste confere o SHA-256
 * da cópia contra `AUTHORIZERS_SOURCE`, cada URL contra o JSON e as listas contra os CHECKs de `authorizer` da migration 001.
 *
 * Dois grãos (§16.2-1 do prompt da NF-e; D-NE205):
 *  (i)  UF × ambiente (o modelo é entrada: só o 55 tem linhas — D-NE2): autorizador normal, SVC da UF, autorizador da consulta cadastro e
 *       a oferta DATADA da inutilização. A IE do emitente é ENTRADA da derivação, nunca dado (D-NE96).
 *  (ii) autorizador × ambiente × serviço: URL e versão; e a parte SOAP (operação, ação, namespace do `nfeDadosMsg`, elemento de saída) lida
 *       dos WSDL do PR e da SVRS arquivados com o A1 (NFE.E4.P4.T1 — D-NE182, D-NE199; `SOAP_BINDINGS`, só H por ora).
 *  Fora, com quem os lê (D-NE205): prazo do 110111 e parâmetros do 656 (rodízio da NE-5), CSRT por UF (builder da NE-4).
 *
 * A tentativa congela o CÓDIGO do autorizador (D-NE162); a URL se resolve na chamada. Recusa = valor tipado, nunca exceção.
 */

/** As 27 UF. */
export type Uf =
  | 'AC' | 'AL' | 'AP' | 'AM' | 'BA' | 'CE' | 'DF' | 'ES' | 'GO' | 'MA' | 'MT' | 'MS' | 'MG' | 'PA' | 'PB' | 'PR' | 'PE' | 'PI' | 'RJ'
  | 'RN' | 'RS' | 'RO' | 'RR' | 'SC' | 'SP' | 'SE' | 'TO'

/** Autorizador de TRANSMISSÃO — o domínio dos CHECKs `ck_invoice_merchandise_transmission_authorizer` da 001 (o teste compara). */
export type OwnAuthorizer = 'AM' | 'BA' | 'GO' | 'MG' | 'MS' | 'MT' | 'PE' | 'PR' | 'RS' | 'SP'
export type Svc = 'SVC-AN' | 'SVC-RS'
export type Authorizer = OwnAuthorizer | 'SVAN' | 'SVRS' | Svc
/** O Ambiente Nacional: só eventos do AN e DF-e (fora da F4) — está no grão (ii) porque a tabela é completa (D-NE3), sem derivação. */
export type NationalAuthority = 'AN'
export type Endpoint = Authorizer | NationalAuthority

/** Os 8 serviços da relação (versão 4.00; o DF-e do AN é 1.00). */
export type NfeService =
  | 'NfeStatusServico' | 'NFeAutorizacao' | 'NFeRetAutorizacao' | 'NfeConsultaProtocolo' | 'NfeInutilizacao' | 'RecepcaoEvento'
  | 'NfeConsultaCadastro' | 'NFeDistribuicaoDFe'

export type Environment = 'H' | 'P'
/** Modelo como na chave de acesso (texto). Só o 55 na F4 (D-NE2). */
export type Model = '55' | '65'
/** tpEmis: 1 normal · 6 SVC-AN · 7 SVC-RS (a 001 só aceita estes; contingência fora da F4 — D-NE6 —, o dado existe). */
export type EmissionType = 1 | 6 | 7

export type RefusalReason =
  /** modelo 65: a relação lida é a da NF-e; NFC-e é onda própria (D-NE2) */
  | 'model-not-supported'
  /** emitente sem IE antes da vigência da NT 2026.007 no ambiente */
  | 'no-ie-not-yet'
  /** emitente sem IE em contingência ou inutilização — a NT não trata; recusa até prova em H (D-NE200) */
  | 'no-ie-unsupported'
  /** tpEmis 6/7 que não é a SVC da UF naquele ambiente */
  | 'svc-not-of-uf'
  /** o autorizador não oferece o serviço (ex.: SVC × inutilização — MOC 586; UF sem consulta cadastro) */
  | 'service-not-offered'
  /** o serviço existiu e foi desativado para a UF (inutilização de AC, BA e SP — RF-CAL-08) */
  | 'service-deactivated'

export type Refusal = { readonly ok: false; readonly reason: RefusalReason }
export type AuthorizerResult = { readonly ok: true; readonly authorizer: Authorizer } | Refusal
export type EndpointResult = { readonly ok: true; readonly endpoint: Endpoint; readonly url: string; readonly version: string } | Refusal

export interface ServiceUrl { readonly url: string; readonly version: string }
type ServiceUrls = Readonly<Partial<Record<NfeService, ServiceUrl>>>
interface UfRoute { readonly normal: Authorizer; readonly svc: Svc; readonly registry: Authorizer | null }

/** Proveniência (D-NE162): o teste confere o SHA-256 da cópia em `acervo/`. */
export const AUTHORIZERS_SOURCE = {
  readAt: '2026-10-15',
  file:   'autorizadores-2026-10-15.json',
  sha256: 'd2bf84a64035f201c92485c526b982e2786df1cff41a97e5f05f4b503fea8c52',
} as const

/**
 * Entradas DATADAS (instante UTC canônico). SUPOSIÇÃO marcada: as normas dão só a DATA; a virada é tomada às 00:00 de Brasília (UTC−3).
 * - `noIeFrom`: emitente sem IE pela SVRS — NT 2026.007 / aviso ENCAT: H 26/10/2026, P 16/11/2026 (RF-NFE-03; AUTORIZADORES.md §1-1).
 * - `voidDeactivated`: fim do pedido de inutilização em AC, BA e SP — NT 2023.002 v1.02, cronograma p. 4 (Teste "Até 11/11/2026", Produção
 *   11/11/2026) e item 2.5 (RF-CAL-08). Em H a NT diz "até": SUPOSIÇÃO — a mesma data.
 */
export interface DatedEntry { readonly key: string; readonly environment: Environment; readonly validFrom: string }

const NO_IE_FROM: readonly DatedEntry[] = [
  { key: 'no-ie-svrs', environment: 'H', validFrom: '2026-10-26T03:00:00Z' },
  { key: 'no-ie-svrs', environment: 'P', validFrom: '2026-11-16T03:00:00Z' },
]
const VOID_DEACTIVATED_UFS: readonly Uf[] = ['AC', 'BA', 'SP']
const VOID_DEACTIVATED: readonly DatedEntry[] = [
  { key: 'void-deactivated-ac-ba-sp', environment: 'H', validFrom: '2026-11-11T03:00:00Z' },
  { key: 'void-deactivated-ac-ba-sp', environment: 'P', validFrom: '2026-11-11T03:00:00Z' },
]

/**
 * Cerca das entradas datadas (molde `assertLayoutCalendar` da nfse-api): instante fora da forma UTC canônica ou data inexistente (o `Date`
 * "rola" 30/02 para 02/03), ou linha repetida (chave × ambiente) = FALHA no carregamento do módulo. Neste passo nada do boot importa o
 * módulo — dispara no import do teste; passa a valer no boot com o 1º chamador (NFE.E4.P3/P4).
 */
export function assertDatedEntries(entries: readonly DatedEntry[]): void {
  const seen = new Set<string>()
  for (const e of entries) {
    const parsed = Date.parse(e.validFrom)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(e.validFrom) || !Number.isFinite(parsed)
      || `${new Date(parsed).toISOString().slice(0, 19)}Z` !== e.validFrom) {
      throw new Error(`Autorizadores: validFrom fora da forma UTC 'AAAA-MM-DDThh:mm:ssZ' ou data inexistente: ${e.validFrom}`)
    }
    const k = `${e.key}|${e.environment}`
    if (seen.has(k)) throw new Error(`Autorizadores: entrada datada repetida ${k}`)
    seen.add(k)
  }
}
assertDatedEntries([...NO_IE_FROM, ...VOID_DEACTIVATED])

const fromOf = (entries: readonly DatedEntry[], environment: Environment): number => {
  const e = entries.find(x => x.environment === environment)
  if (!e) throw new Error(`Autorizadores: sem entrada datada para o ambiente ${environment}`)
  return Date.parse(e.validFrom)
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// DADOS — transcritos da relação de 15/10/2026 (o teste confere cada linha contra a cópia do acervo).
// Grão (i): UF × ambiente. `registry` = autorizador da consulta cadastro (null = a relação não oferece o serviço para a UF).
// Grão (ii): exceção nomeada — a relação lista `NfeInutilizacao` na SVC-AN (sefazvirtual…/NFeInutilizacao4.asmx, P e H), e o MOC diz que
// a SVC NÃO oferece inutilização (regra 586; CONFERENCIAS 23; RF-NFE-14): vale o MOC, a entrada fica FORA.
// ---------------------------------------------------------------------------------------------------------------------------------------
const UF_ROUTES: Readonly<Record<Uf, Readonly<Record<Environment, UfRoute>>>> = {
  AC: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: 'SVRS' }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: 'SVRS' } },
  AL: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: null }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: null } },
  AP: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: null }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: null } },
  AM: { H: { normal: 'AM', svc: 'SVC-RS', registry: 'AM' }, P: { normal: 'AM', svc: 'SVC-RS', registry: 'AM' } },
  BA: { H: { normal: 'BA', svc: 'SVC-RS', registry: 'BA' }, P: { normal: 'BA', svc: 'SVC-RS', registry: 'BA' } },
  CE: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: null }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: null } },
  DF: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: null }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: null } },
  ES: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: 'SVRS' }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: 'SVRS' } },
  GO: { H: { normal: 'GO', svc: 'SVC-RS', registry: 'GO' }, P: { normal: 'GO', svc: 'SVC-RS', registry: 'GO' } },
  MA: { H: { normal: 'SVAN', svc: 'SVC-RS', registry: null }, P: { normal: 'SVAN', svc: 'SVC-RS', registry: null } },
  MT: { H: { normal: 'MT', svc: 'SVC-RS', registry: 'MT' }, P: { normal: 'MT', svc: 'SVC-RS', registry: 'MT' } },
  MS: { H: { normal: 'MS', svc: 'SVC-RS', registry: 'MS' }, P: { normal: 'MS', svc: 'SVC-RS', registry: 'MS' } },
  MG: { H: { normal: 'MG', svc: 'SVC-AN', registry: 'MG' }, P: { normal: 'MG', svc: 'SVC-AN', registry: 'MG' } },
  PA: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: null }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: null } },
  PB: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: 'SVRS' }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: 'SVRS' } },
  PR: { H: { normal: 'PR', svc: 'SVC-RS', registry: 'PR' }, P: { normal: 'PR', svc: 'SVC-RS', registry: 'PR' } },
  PE: { H: { normal: 'PE', svc: 'SVC-RS', registry: 'PE' }, P: { normal: 'PE', svc: 'SVC-RS', registry: 'PE' } },
  PI: { H: { normal: 'SVRS', svc: 'SVC-RS', registry: null }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: null } },
  RJ: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: null }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: null } },
  RN: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: 'SVRS' }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: 'SVRS' } },
  RS: { H: { normal: 'RS', svc: 'SVC-AN', registry: 'RS' }, P: { normal: 'RS', svc: 'SVC-AN', registry: 'RS' } },
  RO: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: null }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: null } },
  RR: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: null }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: null } },
  SC: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: 'SVRS' }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: 'SVRS' } },
  SP: { H: { normal: 'SP', svc: 'SVC-AN', registry: 'SP' }, P: { normal: 'SP', svc: 'SVC-AN', registry: 'SP' } },
  SE: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: null }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: null } },
  TO: { H: { normal: 'SVRS', svc: 'SVC-AN', registry: null }, P: { normal: 'SVRS', svc: 'SVC-AN', registry: null } },
}

const ENDPOINTS: Readonly<Record<Environment, Readonly<Record<Endpoint, ServiceUrls>>>> = {
  H: {
    'AM': {
      NfeStatusServico: { url: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeStatusServico4', version: '4.00' },
      NFeAutorizacao: { url: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeAutorizacao4', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeRetAutorizacao4', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeConsulta4', version: '4.00' },
      NfeInutilizacao: { url: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeInutilizacao4', version: '4.00' },
      RecepcaoEvento: { url: 'https://homnfe.sefaz.am.gov.br/services2/services/RecepcaoEvento4', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://homnfe.sefaz.am.gov.br/services2/services/CadConsultaCadastro4', version: '4.00' },
    },
    'BA': {
      NfeStatusServico: { url: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx', version: '4.00' },
      NfeInutilizacao: { url: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeInutilizacao4/NFeInutilizacao4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://hnfe.sefaz.ba.gov.br/webservices/CadConsultaCadastro4/CadConsultaCadastro4.asmx', version: '4.00' },
    },
    'GO': {
      NfeStatusServico: { url: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeStatusServico4?wsdl', version: '4.00' },
      NFeAutorizacao: { url: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeAutorizacao4?wsdl', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4?wsdl', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4?wsdl', version: '4.00' },
      NfeInutilizacao: { url: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeInutilizacao4?wsdl', version: '4.00' },
      RecepcaoEvento: { url: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeRecepcaoEvento4?wsdl', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://homolog.sefaz.go.gov.br/nfe/services/CadConsultaCadastro4?wsdl', version: '4.00' },
    },
    'MG': {
      NfeStatusServico: { url: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4', version: '4.00' },
      NFeAutorizacao: { url: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRetAutorizacao4', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4', version: '4.00' },
      NfeInutilizacao: { url: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeInutilizacao4', version: '4.00' },
      RecepcaoEvento: { url: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRecepcaoEvento4', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/CadConsultaCadastro4', version: '4.00' },
    },
    'MS': {
      NfeStatusServico: { url: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeStatusServico4', version: '4.00' },
      NFeAutorizacao: { url: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeAutorizacao4', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeRetAutorizacao4', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4', version: '4.00' },
      NfeInutilizacao: { url: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeInutilizacao4', version: '4.00' },
      RecepcaoEvento: { url: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://hom.nfe.sefaz.ms.gov.br/ws/CadConsultaCadastro4', version: '4.00' },
    },
    'MT': {
      NfeStatusServico: { url: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4?wsdl', version: '4.00' },
      NFeAutorizacao: { url: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4?wsdl', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeRetAutorizacao4?wsdl', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4?wsdl', version: '4.00' },
      NfeInutilizacao: { url: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeInutilizacao4?wsdl', version: '4.00' },
      RecepcaoEvento: { url: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/RecepcaoEvento4?wsdl', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/CadConsultaCadastro4?wsdl', version: '4.00' },
    },
    'PE': {
      NfeStatusServico: { url: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4?wsdl', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeAutorizacao4?wsdl', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeRetAutorizacao4?wsdl', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4?wsdl', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeInutilizacao4?wsdl', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeRecepcaoEvento4?wsdl', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/CadConsultaCadastro4?wsdl', version: '4.00' },
    },
    'PR': {
      NfeStatusServico: { url: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeStatusServico4?wsdl', version: '4.00' },
      NFeAutorizacao: { url: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4?wsdl', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4?wsdl', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4?wsdl', version: '4.00' },
      NfeInutilizacao: { url: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeInutilizacao4?wsdl', version: '4.00' },
      RecepcaoEvento: { url: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4?wsdl', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/CadConsultaCadastro4?wsdl', version: '4.00' },
    },
    'RS': {
      NfeStatusServico: { url: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://cad-homologacao.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx', version: '4.00' },
    },
    'SP': {
      NfeStatusServico: { url: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx', version: '4.00' },
      NfeInutilizacao: { url: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx', version: '4.00' },
    },
    'SVAN': {
      NfeStatusServico: { url: 'https://hom.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://hom.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://hom.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://hom.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx', version: '4.00' },
      NfeInutilizacao: { url: 'https://hom.sefazvirtual.fazenda.gov.br/NFeInutilizacao4/NFeInutilizacao4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://hom.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx', version: '4.00' },
    },
    'SVRS': {
      NfeStatusServico: { url: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://cad-homologacao.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx', version: '4.00' },
    },
    'SVC-AN': {
      NfeStatusServico: { url: 'https://hom.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://hom.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://hom.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://hom.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://hom.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx', version: '4.00' },
    },
    'SVC-RS': {
      NfeStatusServico: { url: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx', version: '4.00' },
    },
    'AN': {
      RecepcaoEvento: { url: 'https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx', version: '4.00' },
      NFeDistribuicaoDFe: { url: 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx', version: '1.00' },
    },
  },
  P: {
    'AM': {
      NfeStatusServico: { url: 'https://nfe.sefaz.am.gov.br/services2/services/NfeStatusServico4', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.sefaz.am.gov.br/services2/services/NfeAutorizacao4', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.sefaz.am.gov.br/services2/services/NfeRetAutorizacao4', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.sefaz.am.gov.br/services2/services/NfeConsulta4', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe.sefaz.am.gov.br/services2/services/NfeInutilizacao4', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.sefaz.am.gov.br/services2/services/RecepcaoEvento4', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://nfe.sefaz.am.gov.br/services2/services/CadConsultaCadastro4', version: '4.00' },
    },
    'BA': {
      NfeStatusServico: { url: 'https://nfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.sefaz.ba.gov.br/webservices/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe.sefaz.ba.gov.br/webservices/NFeInutilizacao4/NFeInutilizacao4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.sefaz.ba.gov.br/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://nfe.sefaz.ba.gov.br/webservices/CadConsultaCadastro4/CadConsultaCadastro4.asmx', version: '4.00' },
    },
    'GO': {
      NfeStatusServico: { url: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeStatusServico4?wsdl', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeAutorizacao4?wsdl', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4?wsdl', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4?wsdl', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeInutilizacao4?wsdl', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeRecepcaoEvento4?wsdl', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://nfe.sefaz.go.gov.br/nfe/services/CadConsultaCadastro4?wsdl', version: '4.00' },
    },
    'MG': {
      NfeStatusServico: { url: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeRetAutorizacao4', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeInutilizacao4', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeRecepcaoEvento4', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://nfe.fazenda.mg.gov.br/nfe2/services/CadConsultaCadastro4', version: '4.00' },
    },
    'MS': {
      NfeStatusServico: { url: 'https://nfe.sefaz.ms.gov.br/ws/NFeStatusServico4', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.sefaz.ms.gov.br/ws/NFeAutorizacao4', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.sefaz.ms.gov.br/ws/NFeRetAutorizacao4', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe.sefaz.ms.gov.br/ws/NFeInutilizacao4', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://nfe.sefaz.ms.gov.br/ws/CadConsultaCadastro4', version: '4.00' },
    },
    'MT': {
      NfeStatusServico: { url: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4?wsdl', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4?wsdl', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeRetAutorizacao4?wsdl', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4?wsdl', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeInutilizacao4?wsdl', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/RecepcaoEvento4?wsdl', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/CadConsultaCadastro4?wsdl', version: '4.00' },
    },
    'PE': {
      NfeStatusServico: { url: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeAutorizacao4', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeRetAutorizacao4', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeInutilizacao4', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeRecepcaoEvento4', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/CadConsultaCadastro4?wsdl', version: '4.00' },
    },
    'PR': {
      NfeStatusServico: { url: 'https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4?wsdl', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4?wsdl', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4?wsdl', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4?wsdl', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe.sefa.pr.gov.br/nfe/NFeInutilizacao4?wsdl', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4?wsdl', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://nfe.sefa.pr.gov.br/nfe/CadConsultaCadastro4?wsdl', version: '4.00' },
    },
    'RS': {
      NfeStatusServico: { url: 'https://nfe.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://cad.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx', version: '4.00' },
    },
    'SP': {
      NfeStatusServico: { url: 'https://nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx', version: '4.00' },
    },
    'SVAN': {
      NfeStatusServico: { url: 'https://www.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://www.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://www.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://www.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx', version: '4.00' },
      NfeInutilizacao: { url: 'https://www.sefazvirtual.fazenda.gov.br/NFeInutilizacao4/NFeInutilizacao4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://www.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx', version: '4.00' },
    },
    'SVRS': {
      NfeStatusServico: { url: 'https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx', version: '4.00' },
      NfeInutilizacao: { url: 'https://nfe.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx', version: '4.00' },
      NfeConsultaCadastro: { url: 'https://cad.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx', version: '4.00' },
    },
    'SVC-AN': {
      NfeStatusServico: { url: 'https://www.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://www.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://www.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://www.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://www.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx', version: '4.00' },
    },
    'SVC-RS': {
      NfeStatusServico: { url: 'https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx', version: '4.00' },
      NFeAutorizacao: { url: 'https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', version: '4.00' },
      NFeRetAutorizacao: { url: 'https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx', version: '4.00' },
      NfeConsultaProtocolo: { url: 'https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx', version: '4.00' },
      RecepcaoEvento: { url: 'https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx', version: '4.00' },
    },
    'AN': {
      RecepcaoEvento: { url: 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx', version: '4.00' },
      NFeDistribuicaoDFe: { url: 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx', version: '1.00' },
    },
  },
}

/**
 * Grão (ii), parte SOAP (D-NE182/D-NE199 — nfe-api:NFE.E4.P4, mudança 5 da ficha do smoke): operação, ação SOAP 1.2, namespace do `nfeDadosMsg`
 * e elemento de saída de cada serviço, LIDOS dos WSDL baixados com o A1 do André Piai na fase 1 do smoke (2026-11-22, `--wsdl --vai`) e
 * arquivados byte a byte em `acervo/wsdl-2026-11-22/` (o teste confere o SHA-256 de cada arquivo e re-extrai cada valor com o `wsdl.ts`).
 * Só HOMOLOGAÇÃO, só PR e SVRS (os do smoke — D-NE192): produção e os demais autorizadores entram com a leitura deles (nenhum valor não oficial).
 * Fato do PR: a operação do evento é `nfeRecepcaoEventoNF` (na SVRS, `nfeRecepcaoEvento`); a ação do retorno da autorização do PR começa com
 * maiúscula (`…/NFeRetAutorizacaoLote`). CONHECIMENTO NEGATIVO (§16.2-10): nunca ler WSDL em tempo de execução para chamar.
 */
export interface SoapBinding { readonly operation: string; readonly action: string; readonly namespace: string; readonly outputElement: string }
export const SOAP_BINDINGS_SOURCE = { readAt: '2026-11-22', dir: 'wsdl-2026-11-22' } as const
const WSDL_NS_BASE = 'http://www.portalfiscal.inf.br/nfe/wsdl/'
const sb = (wsdl: string, operation: string, actionOp: string = operation): SoapBinding =>
  ({ operation, action: `${WSDL_NS_BASE}${wsdl}/${actionOp}`, namespace: `${WSDL_NS_BASE}${wsdl}`, outputElement: 'nfeResultMsg' })
const SOAP_BINDINGS: Readonly<Partial<Record<Environment, Readonly<Partial<Record<Endpoint, Readonly<Partial<Record<NfeService, SoapBinding>>>>>>>>> = {
  H: {
    PR: {
      NfeStatusServico:     sb('NFeStatusServico4', 'nfeStatusServicoNF'),
      NFeAutorizacao:       sb('NFeAutorizacao4', 'nfeAutorizacaoLote'),
      NFeRetAutorizacao:    sb('NFeRetAutorizacao4', 'nfeRetAutorizacaoLote', 'NFeRetAutorizacaoLote'),
      NfeConsultaProtocolo: sb('NFeConsultaProtocolo4', 'nfeConsultaNF'),
      NfeConsultaCadastro:  sb('CadConsultaCadastro4', 'consultaCadastro'),
      NfeInutilizacao:      sb('NFeInutilizacao4', 'nfeInutilizacaoNF'),
      RecepcaoEvento:       sb('NFeRecepcaoEvento4', 'nfeRecepcaoEventoNF'),
    },
    SVRS: {
      NfeStatusServico:     sb('NFeStatusServico4', 'nfeStatusServicoNF'),
      NFeAutorizacao:       sb('NFeAutorizacao4', 'nfeAutorizacaoLote'),
      NFeRetAutorizacao:    sb('NFeRetAutorizacao4', 'nfeRetAutorizacaoLote'),
      NfeConsultaProtocolo: sb('NFeConsultaProtocolo4', 'nfeConsultaNF'),
      NfeConsultaCadastro:  sb('CadConsultaCadastro4', 'consultaCadastro'),
      NfeInutilizacao:      sb('NFeInutilizacao4', 'nfeInutilizacaoNF'),
      RecepcaoEvento:       sb('NFeRecepcaoEvento4', 'nfeRecepcaoEvento'),
    },
  },
}

/** A parte SOAP de um serviço num autorizador × ambiente; null = ainda não lida de WSDL arquivado (quem chama recusa — nada é enviado). */
export function soapBindingOf(endpoint: Endpoint, environment: Environment, service: NfeService): SoapBinding | null {
  return SOAP_BINDINGS[environment]?.[endpoint]?.[service] ?? null
}

/** Os pares autorizador × serviço com parte SOAP registrada (leitura do teste). */
export function soapBindingEntries(environment: Environment): readonly { endpoint: Endpoint; service: NfeService; binding: SoapBinding }[] {
  const env = SOAP_BINDINGS[environment] ?? {}
  return (Object.entries(env) as [Endpoint, Partial<Record<NfeService, SoapBinding>>][])
    .flatMap(([endpoint, svcs]) => (Object.entries(svcs) as [NfeService, SoapBinding][]).map(([service, binding]) => ({ endpoint, service, binding })))
}

/** Exceções nomeadas do grão (ii) em relação à relação de 15/10 (o teste as lê daqui). */
export const EXCLUDED_FROM_SOURCE: readonly { endpoint: Endpoint; service: NfeService; reason: string }[] = [
  { endpoint: 'SVC-AN', service: 'NfeInutilizacao', reason: 'MOC regra 586 — a SVC não oferece inutilização (CONFERENCIAS 23; RF-NFE-14)' },
]

export const UFS = Object.keys(UF_ROUTES) as Uf[]
export const ENDPOINT_CODES = Object.keys(ENDPOINTS.P) as Endpoint[]

const SVC_BY_EMISSION: Readonly<Record<6 | 7, Svc>> = { 6: 'SVC-AN', 7: 'SVC-RS' }

export interface ResolveInput {
  readonly uf:                   Uf
  readonly model:                Model
  readonly environment:          Environment
  readonly emissionType:         EmissionType
  /** O emitente tem IE no ERP (D-NE96 — entrada; a fonte de fatos é da NE-4). */
  readonly hasStateRegistration: boolean
  /** Instante da reserva/transmissão (D-NE162: entradas avaliadas no instante). */
  readonly at:                   Date
}

/** Autorizador da TRANSMISSÃO de uma NF-e (o código que a tentativa congela — D-NE37). */
export function resolveAuthorizer(input: ResolveInput): AuthorizerResult {
  if (input.model !== '55') return { ok: false, reason: 'model-not-supported' }
  if (!input.hasStateRegistration) {
    // SUPOSIÇÃO (D-NE200): sem IE em contingência — a NT 2026.007 não trata; recusa até prova em H
    if (input.emissionType !== 1) return { ok: false, reason: 'no-ie-unsupported' }
    if (input.at.getTime() < fromOf(NO_IE_FROM, input.environment)) return { ok: false, reason: 'no-ie-not-yet' }
    return { ok: true, authorizer: 'SVRS' }                       // C17-11 — qualquer UF (RF-NFE-03)
  }
  const route = UF_ROUTES[input.uf][input.environment]
  if (input.emissionType === 1) return { ok: true, authorizer: route.normal }
  const svc = SVC_BY_EMISSION[input.emissionType]
  if (svc !== route.svc) return { ok: false, reason: 'svc-not-of-uf' }
  return { ok: true, authorizer: svc }
}

/** URL e versão de um serviço num autorizador — grão (ii) cru (não sabe de UF nem de data). */
export function endpointOf(endpoint: Endpoint, environment: Environment, service: NfeService): EndpointResult {
  const e = ENDPOINTS[environment][endpoint][service]
  return e ? { ok: true, endpoint, url: e.url, version: e.version } : { ok: false, reason: 'service-not-offered' }
}

export interface VoidInput {
  readonly uf:                   Uf
  readonly model:                Model
  readonly environment:          Environment
  readonly hasStateRegistration: boolean
  readonly at:                   Date
}

/** Onde pedir a inutilização de uma faixa: grão (i) (UF, IE, data) e só então o grão (ii). */
export function voidEndpoint(input: VoidInput): EndpointResult {
  if (input.model !== '55') return { ok: false, reason: 'model-not-supported' }
  // SUPOSIÇÃO (D-NE200): inutilização sem IE — a NT 2026.007 não trata; recusa até prova em H
  if (!input.hasStateRegistration) return { ok: false, reason: 'no-ie-unsupported' }
  if (VOID_DEACTIVATED_UFS.includes(input.uf) && input.at.getTime() >= fromOf(VOID_DEACTIVATED, input.environment)) {
    return { ok: false, reason: 'service-deactivated' }           // RF-CAL-08
  }
  return endpointOf(UF_ROUTES[input.uf][input.environment].normal, input.environment, 'NfeInutilizacao')
}

/** Onde consultar o cadastro de contribuintes de uma UF (a UF consultada, não a do emitente). */
export function registryEndpoint(uf: Uf, environment: Environment): EndpointResult {
  const registry = UF_ROUTES[uf][environment].registry
  if (!registry) return { ok: false, reason: 'service-not-offered' }
  return endpointOf(registry, environment, 'NfeConsultaCadastro')
}

/** As rotas da UF (grão (i)) — leitura para o teste e para o health futuro. */
export function ufRoute(uf: Uf, environment: Environment): UfRoute {
  return UF_ROUTES[uf][environment]
}
