/**
 * SMOKE da nfe-api na SEFAZ-PR em HOMOLOGAÇÃO (nfe-api:NFE.E4.P4.T1 — ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e4-p4-smoke-sefaz-h.md`;
 * D-NE185 com a D-NE191, D-NE186/D-NE197, D-NE182/D-NE192, D-NE199, D-NE187; §16.2-6 e §16.2-10 do prompt da NF-e). Script no nível do
 * ADAPTADOR (a API não sobe); o emitente é o André Piai (institution do dev com o A1 no cofre); IE, UF e CNPJ entram como PARÂMETROS.
 *
 * ⚠️ Fala com o fisco (homologação) SÓ com `--vai`, e todo `--vai` é ato do Valdo. A FASE é explícita (`--fase 1|2`, obrigatória com `--vai`) e
 * argumento desconhecido é RECUSA (gate adversarial 2026-11-22: `--wsdI --vai` digitado errado não pode cair na fase 2). Três modos:
 *   (sem --vai)      só CONFERE: A1 aberto e vigente, habilitação do 55 em H, CNPJ do certificado = --cnpj, as quatro mensagens válidas no XSD
 *                    (o inutNFe assinado de verdade) e as URLs do PR em H. NENHUMA conexão.
 *   --fase 1 --vai   FASE 1: baixa o WSDL de cada serviço usado no PR e na SVRS (mTLS), grava cada um com SHA-256 e a extração (ação SOAP
 *                    1.2, namespace, elemento de saída) num JSON. NÃO chama serviço. A extração vai à constante dos autorizadores DEPOIS de
 *                    conferida (mudança 5 da ficha) — nunca se lê WSDL para chamar (§16.2-10).
 *   --fase 2 --vai   FASE 2: status, consulta de protocolo da --chave e consulta de cadastro do --cnpj, pela ação da CONSTANTE (recusa se ela
 *                    ainda não tem o serviço); respostas lidas pelo `responses.ts`; XML enviado e recebido gravados com SHA-256.
 * O inutNFe NUNCA é enviado (D-NE191). Nada é gravado no banco. O A1 só em memória.
 *
 * Uso: npm run smoke:sefaz-h -- --inst 98 --cnpj <14> --uf PR --ie <IE> --chave <44 de H> [--fase 1|2 --vai] [--saida storage-…]
 *   A evidência vai SEMPRE para uma pasta `storage-…` (fora do git — a resposta do cadastro traz dado do cliente). A IE informada é
 *   conferida contra a do cadastro na fase 2 (registrada no resumo; não recusa).
 *   .env: DB_* / FISCAL_DB_NAME (o `fiscal_api` do dev), FISCAL_MASTER_KEYS, SEFAZ_SERVER_CA_PATH.
 */
import 'dotenv/config'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import {
  HttpError, MasterKeyRing, createFiscalPool, dbConfigFromEnv, openIssuer, transport, type HttpsCall, type HttpsResult,
} from 'fiscal-api'
import { endpointOf, soapBindingOf, ufRoute, UFS, type Endpoint, type NfeService, type SoapBinding, type Uf } from '../src/authority/authorizers'
import { consCad, consSitNFe, consStatServ, inutNFe, signInutNFe, CUF, RESULT_ELEMENT } from '../src/authority/messages'
import { callSoap, type SoapOutcome } from '../src/authority/soap'
import { readProtocol, readRegistry, readStatus } from '../src/authority/responses'
import { loadServerCa } from '../src/authority/server-ca'
import { validateMessage, type MessageKind } from '../src/authority/xsd'
import { readWsdlOperation, type WsdlResult } from '../src/authority/wsdl'

/** Serviços cujo WSDL a fase 1 arquiva (D-NE182) e a operação de cada um (nomes do 4.00, conferidos na fase 1 de 2026-11-22: o PR chama
 *  o evento de `nfeRecepcaoEventoNF` — `WSDL_OPERATION_BY_ENDPOINT`). Nome que não bater = recusa `operacao-ausente` no JSON; o WSDL fica arquivado. */
export const WSDL_OPERATIONS: Readonly<Partial<Record<NfeService, string>>> = Object.freeze({
  NfeStatusServico:     'nfeStatusServicoNF',
  NFeAutorizacao:       'nfeAutorizacaoLote',
  NFeRetAutorizacao:    'nfeRetAutorizacaoLote',
  NfeConsultaProtocolo: 'nfeConsultaNF',
  NfeConsultaCadastro:  'consultaCadastro',
  NfeInutilizacao:      'nfeInutilizacaoNF',
  RecepcaoEvento:       'nfeRecepcaoEvento',
})
/** Operação com nome próprio num autorizador (fato da fase 1 de 2026-11-22). */
export const WSDL_OPERATION_BY_ENDPOINT: Readonly<Partial<Record<Endpoint, Partial<Record<NfeService, string>>>>> = Object.freeze({
  PR: { RecepcaoEvento: 'nfeRecepcaoEventoNF' },
})
/** D-NE192 + D-NE197: os autorizadores do smoke. */
export const WSDL_ENDPOINTS: readonly Endpoint[] = ['PR', 'SVRS']
/** Justificativa fixa da inutilização que SÓ passa no XSD (nunca enviada — D-NE191). */
export const DRY_VOID_JUSTIFICATION = 'SMOKE DE HOMOLOGACAO SEM ENVIO'

export interface SmokeArgs {
  readonly inst:  number
  readonly cnpj:  string
  readonly uf:    Uf
  readonly ie:    string
  readonly chave: string
  readonly saida: string
  readonly wsdl:  boolean
  readonly vai:   boolean
}

/** O que a fase 2 usa da parte SOAP da constante (D-NE199). */
export type SmokeBinding = Pick<SoapBinding, 'action' | 'namespace'>

export interface SmokeDeps {
  /** O emitente aberto (`openIssuer(…, '55')`): ambiente da habilitação, par PEM, CNPJ do titular do certificado. */
  readonly openA1:    () => Promise<{ environment: 'H' | 'P'; cert: Buffer; key: Buffer; cnpj: string | null }>
  readonly ca:        () => string
  readonly request:   (c: HttpsCall) => Promise<HttpsResult>
  /** Ação e namespace da CONSTANTE dos autorizadores (D-NE199); null = ainda não registrado (mudança 5). */
  readonly bindingOf: (endpoint: Endpoint, service: NfeService) => SmokeBinding | null
  readonly write:     (file: string, content: string) => void
  readonly now:       () => Date
  readonly log:       (line: string) => void
}

export class SmokeRefused extends Error {
  constructor(message: string) { super(message); this.name = 'SmokeRefused' }
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
/** URL do WSDL: as do PR em H já trazem `?wsdl`; as outras ganham (nunca `?wsdl?wsdl`). */
export const wsdlUrlOf = (url: string): string => (/\?wsdl$/i.test(url) ? url : `${url}?wsdl`)

/** Pasta de evidência: relativa, começa por `storage-` (ignorada pelo `.gitignore`), segmentos simples, nunca `.` ou `..`. */
export function isEvidenceDir(dir: string): boolean {
  const parts = dir.split('/')
  return /^storage-[A-Za-z0-9._-]+$/.test(parts[0]) && parts.every(s => /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..')
}

const VALUE_FLAGS = ['--inst', '--cnpj', '--uf', '--ie', '--chave', '--saida', '--fase'] as const
const BOOL_FLAGS = ['--vai'] as const

/** Argumentos ESTRITOS (sem o `node` e o script): flag desconhecida, valor ausente ou repetida = recusa. */
export function parseArgs(argv: readonly string[]): SmokeArgs {
  const values = new Map<string, string>()
  const bools = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if ((VALUE_FLAGS as readonly string[]).includes(a)) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new SmokeRefused(`${a} sem valor`)
      if (values.has(a)) throw new SmokeRefused(`${a} repetido`)
      values.set(a, v); i++
    } else if ((BOOL_FLAGS as readonly string[]).includes(a)) {
      bools.add(a)
    } else {
      throw new SmokeRefused(`argumento desconhecido: ${String(a).slice(0, 20)}`)
    }
  }
  const inst = Number(values.get('--inst'))
  const cnpj = values.get('--cnpj') ?? ''
  const uf = (values.get('--uf') ?? '') as Uf
  const ie = values.get('--ie') ?? ''
  const chave = values.get('--chave') ?? ''
  const fase = values.get('--fase')
  const vai = bools.has('--vai')
  const saida = values.get('--saida') ?? ''
  if (!Number.isInteger(inst) || inst < 1) throw new SmokeRefused('--inst <institution do dev> obrigatório')
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj)) throw new SmokeRefused('--cnpj com 14 posições obrigatório')
  if (!UFS.includes(uf)) throw new SmokeRefused('--uf obrigatório (sigla)')
  if (!/^[0-9]{2,14}$/.test(ie)) throw new SmokeRefused('--ie só com dígitos obrigatório')
  if (!chave) throw new SmokeRefused('--chave <44 de H> obrigatório')
  if (fase !== undefined && fase !== '1' && fase !== '2') throw new SmokeRefused('--fase 1 ou 2')
  if (vai && fase === undefined) throw new SmokeRefused('--vai exige --fase 1 (WSDL) ou --fase 2 (serviços)')
  if (!vai && fase !== undefined) throw new SmokeRefused('--fase só com --vai (sem --vai o script só confere)')
  if (saida && !isEvidenceDir(saida)) throw new SmokeRefused('--saida tem de ser uma pasta storage-… relativa (fora do git), sem `..`')
  return { inst, cnpj, uf, ie, chave, saida, wsdl: fase === '1', vai }
}

/** As quatro mensagens do smoke, montadas e validadas no XSD; erro de montagem ou de XSD = recusa (nada sai). */
async function buildMessages(a: SmokeArgs, a1: { cert: Buffer; key: Buffer }, now: Date) {
  const yy = String(now.getUTCFullYear()).slice(2)
  const msgs: { kind: MessageKind; xml: string }[] = [
    { kind: 'consStatServ', xml: consStatServ('2', a.uf) },
    { kind: 'consSitNFe', xml: consSitNFe(a.chave, '2', a.uf) },
    { kind: 'consCad', xml: consCad(a.uf, { CNPJ: a.cnpj }) },
    { kind: 'inutNFe', xml: signInutNFe(inutNFe({ tpAmb: '2', uf: a.uf, yy, cnpj: a.cnpj, serie: 1, from: 1, to: 1, xJust: DRY_VOID_JUSTIFICATION }), a1.cert, a1.key) },
  ]
  for (const m of msgs) {
    const r = await validateMessage(m.kind, m.xml)
    if (!r.ok) throw new SmokeRefused(`mensagem ${m.kind} recusada no XSD local: ${r.errors.join(' | ')}`)
  }
  return msgs
}

export interface SmokeReport {
  readonly mode:      'conferir' | 'wsdl' | 'servicos'
  readonly urls:      Readonly<Record<string, string>>
  readonly messages:  readonly MessageKind[]
  readonly wsdl?:     readonly { endpoint: Endpoint; service: NfeService; url: string; status: number | null; sha256: string | null; read: WsdlResult | { ok: false; reason: string } }[]
  /** Fase 2: a IE informada está no cadastro devolvido (null = cadastro sem fato legível). */
  readonly ieMatches?: boolean | null
  readonly services?: readonly { service: NfeService; outcome: SoapOutcome['kind']; cStat: string | null; read: unknown; sentSha256: string; receivedSha256: string | null }[]
}

export async function runSmoke(a: SmokeArgs, deps: SmokeDeps): Promise<SmokeReport> {
  // ---- pré-voo: tudo local
  const route = ufRoute(a.uf, 'H')
  if (route.normal !== 'PR') throw new SmokeRefused(`o smoke da NE-3 é no autorizador do PR (D-NE197); ${a.uf} vai a ${route.normal}`)
  const a1 = await deps.openA1()
  if (a1.environment !== 'H') throw new SmokeRefused('a habilitação do 55 está em PRODUÇÃO — o smoke só roda em H')
  if (a1.cnpj !== a.cnpj) throw new SmokeRefused(`o CNPJ do certificado (${a1.cnpj ?? 'não lido'}) não é o --cnpj ${a.cnpj}`)
  const services: NfeService[] = ['NfeStatusServico', 'NfeConsultaProtocolo', 'NfeConsultaCadastro', 'NfeInutilizacao']
  const urls: Record<string, string> = {}
  for (const s of services) {
    const e = endpointOf('PR', 'H', s)
    if (!e.ok) throw new SmokeRefused(`o PR em H não oferece ${s} na constante (${e.reason})`)
    urls[s] = e.url
  }
  const msgs = await buildMessages(a, a1, deps.now())
  deps.log(`pré-voo ok: A1 de ${a.cnpj} em H; mensagens válidas no XSD: ${msgs.map(m => m.kind).join(', ')}`)
  for (const [s, u] of Object.entries(urls)) deps.log(`  ${s}: ${u}`)
  if (!a.vai) {
    deps.log('sem --vai: nada foi enviado.')
    return { mode: 'conferir', urls, messages: msgs.map(m => m.kind) }
  }
  if (!a.saida) throw new SmokeRefused('--vai exige a pasta de evidência (--saida)')
  const base = { cert: a1.cert, key: a1.key, ca: deps.ca() }

  // ---- FASE 1: WSDL (só GET)
  if (a.wsdl) {
    const out: NonNullable<SmokeReport['wsdl']>[number][] = []
    for (const endpoint of WSDL_ENDPOINTS) {
      for (const [service, operation] of Object.entries(WSDL_OPERATIONS) as [NfeService, string][]) {
        const e = endpointOf(endpoint, 'H', service)
        if (!e.ok) { out.push({ endpoint, service, url: '', status: null, sha256: null, read: { ok: false, reason: e.reason } }); continue }
        const url = wsdlUrlOf(e.url)
        let res: HttpsResult
        try {
          res = await deps.request({ url, method: 'GET', headers: {}, ...base, timeoutMs: 30_000 })
        } catch (err: any) {
          out.push({ endpoint, service, url, status: null, sha256: null, read: { ok: false, reason: `transporte: ${err?.code ?? 'erro'}` } })
          continue
        }
        const hash = sha256(res.text)
        deps.write(`wsdl/${endpoint}-${service}.wsdl`, res.text)
        const read = res.status === 200 ? readWsdlOperation(res.text, WSDL_OPERATION_BY_ENDPOINT[endpoint]?.[service] ?? operation) : { ok: false as const, reason: `HTTP ${res.status}` }
        out.push({ endpoint, service, url, status: res.status, sha256: hash, read })
      }
    }
    deps.write('wsdl/extracao.json', JSON.stringify({ lidoEm: deps.now().toISOString(), ambiente: 'H', itens: out }, null, 2))
    deps.log(`fase 1: ${out.filter(o => o.read.ok).length}/${out.length} WSDL lidos; evidência em ${a.saida}`)
    return { mode: 'wsdl', urls, messages: msgs.map(m => m.kind), wsdl: out }
  }

  // ---- FASE 2: serviços, pela CONSTANTE
  const plan: { service: NfeService; kind: MessageKind; xml: string; read: (xml: string) => unknown }[] = [
    { service: 'NfeStatusServico', kind: 'consStatServ', xml: msgs[0].xml, read: x => readStatus({ tpAmb: '2', cUF: CUF[a.uf] }, x) },
    { service: 'NfeConsultaProtocolo', kind: 'consSitNFe', xml: msgs[1].xml, read: x => readProtocol({ chNFe: a.chave, tpAmb: '2' }, x) },
    { service: 'NfeConsultaCadastro', kind: 'consCad', xml: msgs[2].xml, read: x => readRegistry({ UF: a.uf, CNPJ: a.cnpj }, x) },
  ]
  for (const p of plan) {
    if (!deps.bindingOf('PR', p.service)) throw new SmokeRefused(`a constante dos autorizadores ainda não tem a ação de ${p.service} no PR — rode a fase 1 (--wsdl --vai) e registre (mudança 5)`)
  }
  const results: NonNullable<SmokeReport['services']>[number][] = []
  for (const p of plan) {
    const b = deps.bindingOf('PR', p.service)!
    deps.write(`servicos/${p.service}-enviado.xml`, p.xml)
    const outcome = await callSoap({
      url: urls[p.service], service: p.service, action: b.action, namespace: b.namespace,
      resultElement: RESULT_ELEMENT[p.service]!, body: p.xml, message: p.kind, ...base,
    }, deps.request)
    const xml = 'xml' in outcome ? outcome.xml : null
    if (xml !== null) deps.write(`servicos/${p.service}-recebido.xml`, xml)
    results.push({
      service: p.service, outcome: outcome.kind, cStat: 'cStat' in outcome ? outcome.cStat : null,
      read: xml !== null ? p.read(xml) : null, sentSha256: sha256(p.xml), receivedSha256: xml !== null ? sha256(xml) : null,
    })
  }
  // §16.2-6: a IE é PARÂMETRO; aqui só se CONFERE contra a do cadastro (registrado, nunca recusa nem substitui)
  const registry = results.find(r => r.service === 'NfeConsultaCadastro')?.read as { kind?: string; fact?: { entries?: { IE: string | null }[] } } | null
  const ieMatches = registry?.kind === 'fact' ? (registry.fact?.entries ?? []).some(e => e.IE === a.ie) : null
  if (ieMatches === false) deps.log(`  atenção: a IE informada (--ie) não é a do cadastro da SEFAZ`)
  deps.write('servicos/resumo.json', JSON.stringify({ em: deps.now().toISOString(), ambiente: 'H', ieConfere: ieMatches, resultados: results }, null, 2))
  for (const r of results) deps.log(`  ${r.service}: ${r.outcome}${r.cStat ? ` (cStat ${r.cStat})` : ''}`)
  return { mode: 'servicos', urls, messages: msgs.map(m => m.kind), services: results, ieMatches }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const saida = args.vai ? (args.saida || path.join('storage-smoke-nfe', new Date().toISOString().replace(/[:.]/g, '-'))) : ''
  const pool = createFiscalPool(dbConfigFromEnv())
  try {
    const report = await runSmoke({ ...args, saida }, {
      openA1: async () => {
        const o = await openIssuer({ pool, keyring: MasterKeyRing.fromEnv() }, args.inst, '55')
        return { environment: o.issuer.environment, cert: o.cert, key: o.key, cnpj: o.info.cnpj }
      },
      ca:        () => loadServerCa(process.env.SEFAZ_SERVER_CA_PATH, new Date()).pem,
      request:   c => transport.request(c),
      bindingOf: (endpoint, service) => soapBindingOf(endpoint, 'H', service),   // a constante dos autorizadores (D-NE199)
      write:     (file, content) => {
        const abs = path.join(saida, file)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, 'utf8')
      },
      now:       () => new Date(),
      log:       line => console.log(line),
    })
    console.log(JSON.stringify({ modo: report.mode, mensagens: report.messages }, null, 2))
  } finally {
    await pool.end()
  }
}

if (require.main === module) {
  main().catch(err => {
    if (err instanceof SmokeRefused) { console.error(`RECUSA: ${err.message}`); process.exit(2) }
    if (err instanceof HttpError) { console.error(`RECUSA: ${err.code ?? ''} ${err.message}`); process.exit(2) }
    console.error(err)
    process.exit(1)
  })
}
