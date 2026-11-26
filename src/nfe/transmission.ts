import {
  ErrorCodes, HttpError, logger, recordVoiceOnce, signXml, toUtcDb, MERCHANDISE_VOICE_READING, VOICE_READINGS, withInvoiceTx,
  type InvoiceRef, type InvoiceTx, type openIssuer, type Queryable, type FiscalStorage, type HttpsCall, type HttpsResult,
} from 'fiscal-api'
import { endpointOf, resolveAuthorizer, soapBindingOf, type Environment, type Uf } from '../authority/authorizers'
import { checkDigest, voiceOfCStat, type VoiceDecision, type VoiceEvent } from '../authority/cstat-voice'
import { enviNFe } from '../authority/messages'
import { readSend } from '../authority/responses'
import { callSoap, type SoapOutcome } from '../authority/soap'
import { validateMessage } from '../authority/xsd'
import { barrierOf, provenNotRegistered, drawCnf, fillAuthorityData, fillReceipt, generateNumber, getAttempt, insertAttempt, latestAttempt, numberPolicy, voicesOfLife } from './attempt'
import { dhEmiOf } from './dh-emi'
import { documentInvalid, NfeErrors } from './errors'
import { isFileConflict, merchandiseFileKey } from './fiscal-file'
import { buildAccessKey } from './access-key'
import { assertLayer1 } from './layer1'
import { buildNfeXml, type NfeInput } from './nfe-builder'
import { digestValueOf, procNfeXml } from './proc-nfe'
import { hashCsrt, type CsrtProof } from './tech-responsible'
import type { Breaker } from './breaker'
import { notifyAuthorized, type OnAuthorized } from './authorized-hook'
import { MERCHANDISE_VOICE_FAMILY } from './voice-family'

/**
 * A TRANSMISSÃO da NF-e (NFE.E6.P1 — T1 e T3; D-NE7, D-NE33, D-NE34, D-NE35, D-NE37, D-NE41, D-NE43, D-NE158, D-NE218, D-NE257, D-NE278, D-NE282, D-NE284, D-NE296;
 * ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-7). Molde (copiado, nunca importado): `nfse-api/src/nfse/transmission.ts`.
 *
 * TRANSAÇÃO 1 (reserva), sob a trava da nota e NESTA ordem (contrato do núcleo — number-sequence.d.ts): a habilitação travada (`openIssuer` forUpdate) ANTES de qualquer
 * leitura comum; a barreira e a política do número; os fatos do ERP; o número (novo, ou o da tentativa fechada por R/F); a chave com `cNF` sorteado; as credenciais DEPOIS do
 * lock e o `hashCSRT` da chave; o `dhEmi` (data do `dt_emission` + hora do evento E da vida atual na zona — D-NE284, D-NE296); o candidato, a CAMADA 1 (recusa com a lista inteira, sem abrir
 * tentativa), a assinatura, o XSD da NFe assinada e o `digVal`; o INSERT da tentativa com o digest e o `-nfe.xml` no arquivo fiscal ANTES do envio (gravação única do núcleo 5.2.0: conflito = 409
 * `FISCAL_FILE_CONFLICT`, nada vai ao fisco). O fisco é chamado FORA de qualquer transação. TRANSAÇÃO 2: a voz (A, D, R, P ou F) — nunca em Fault/500/timeout (D-NE34) —, com o protocolo e o
 * `dhRecbto` write-once; 204/539/205/206/218/635 só mandam consultar a chave (nenhuma voz — D-NE36). O `-procNFe.xml` (autorizada ou denegada — D-NE35) vai ao arquivo depois (conflito = `incident: file-conflict`).
 * Nenhum envio real acontece em teste: o `request` do `callSoap` é injetado.
 */

export interface NfeActor { readonly institutionId: number; readonly schemaName: string; readonly userId: number | null }

type Opened = Awaited<ReturnType<typeof openIssuer>>
type ConnLike = InvoiceTx['conn']

/** O que a camada que conhece o ERP entrega à composição (a leitura dos fatos é só SELECT e mora em `src/facts`). */
export interface ComposedFacts {
  /** A série da nota, do ERP (D-NE11) — 0 a 909. */
  readonly serie: number
  readonly cnpj: string
  readonly uf: Uf
  readonly hasStateRegistration: boolean
  readonly dtEmission: string
  readonly createdAt: string | null
  /** A vida da nota de onde veio a hora do `dhEmi` (D-NE296); tem de ser a vida travada pela reserva. */
  readonly lifeEvent: number | null
  /** A data do evento E da vida (S-B: tem de ser a do `dt_emission`). */
  readonly lifeDate: string | null
  /** O candidato com o `dhEmi` e a prova do CSRT dados (ou nenhuma). */
  readonly buildInput: (p: { dhEmi: string; csrt: CsrtProof | null }) => NfeInput
}

export interface NfeDeps {
  readonly pool: Parameters<typeof withInvoiceTx>[0]
  readonly storage: FiscalStorage
  /** O catálogo de leituras de família do núcleo (`VOICE_READINGS`) — T3. */
  readonly catalog?: Readonly<Record<string, { readonly transmissionView: string }>>
  readonly now: () => Date
  /** Abre o emissor (A1) travando a habilitação: a implementação real é `openIssuer(…, { conn, forUpdate: true, schemaName })`. */
  readonly openIssuer: (conn: ConnLike, actor: NfeActor) => Promise<Opened>
  readonly readFacts: (q: Queryable, actor: NfeActor, ref: InvoiceRef, environment: Environment) => Promise<ComposedFacts>
  readonly zoneOf: (q: Queryable, actor: NfeActor) => Promise<string>
  /** O CNPJ do ESTABELECIMENTO (`establishmentCnpj` do núcleo) — a camada 1 confere o emitente contra ele. */
  readonly establishmentCnpj: (q: Queryable, actor: NfeActor) => Promise<string | null>
  /** O CSRT exigido para UF × modelo × ambiente — `null` quando a UF não exige; falta = `FiscalCodeMissingError` (D-NE218). O VALOR nunca sai daqui para log. */
  readonly credentialsFor: (q: Queryable, actor: NfeActor, scope: { uf: Uf; environment: Environment; at: Date }) => Promise<{ codeId: string; codeValue: string } | null>
  /** O `ca` do servidor do fisco (D-NE57/D-NE187). */
  readonly ca: () => HttpsCall['ca']
  /** O disjuntor contra o 656 (NFE.E6.P2.T3): opcional — sem ele não há freio por serviço (o freio por nota da autorização segue). */
  readonly breaker?: Breaker
  /** Injetável: o sorteador do `cNF` (os testes forçam o conflito do arquivo fiscal com uma chave conhecida). */
  readonly random?: (max: number) => number
  /** Injetável: nos testes nada vai à rede. */
  readonly request?: (c: HttpsCall) => Promise<HttpsResult>
  /** O gancho pós-autorização (e-mail automático — D-NE261): disparado só por quem GRAVOU a voz A, depois do `-procNFe.xml`; nunca desfaz o A (`authorized-hook.ts`). */
  readonly onAuthorized?: OnAuthorized
}

/** A T3 de qualquer operação que fala com o fisco sobre a família: o catálogo injetado (testes) ou o do núcleo — o ÚNICO ponto do `src/` que nomeia `VOICE_READINGS` (cerca do P9). */
export const assertFamilyOf = (deps: Pick<NfeDeps, 'catalog'>): void => assertFamilyInCatalog(deps.catalog ?? VOICE_READINGS)

/** T3 — a nfe-api NÃO monta a reserva enquanto a família não estiver no catálogo de leituras do núcleo (D-NE158). */
export function assertFamilyInCatalog(catalog: Readonly<Record<string, { readonly transmissionView: string }>>): void {
  const ok = Object.values(catalog).some(r => r.transmissionView === MERCHANDISE_VOICE_READING.transmissionView)
  if (!ok) {
    throw new HttpError(503, 'A família da NF-e não está no catálogo de leituras do núcleo — nada foi montado nem enviado',
      [{ field: 'family', message: 'Catálogo VOICE_READINGS sem a leitura da NF-e (D-NE158)' }], NfeErrors.FAMILY_NOT_IN_CATALOG)
  }
}

export interface TransmitResult {
  readonly invoiceId: number
  readonly attempt: number
  readonly accessKey: string
  readonly number: number
  readonly serie: number
  /** O que o fisco disse e foi gravado (A, D, R, P ou F), ou por que nada foi gravado (a tentativa segue em voo). */
  readonly outcome: { readonly kind: 'A' | 'D' | 'R' | 'P' | 'F'; readonly authorityCode: string | null; readonly message: string } | { readonly kind: 'none'; readonly reason: string }
  readonly nProt: string | null
  readonly nRec: string | null
  /** A saída que quem chama segue quando nada concluiu: consultar a chave (204/539/…) ou o recibo (103/105). */
  readonly next: 'consult-key' | 'consult-receipt' | null
  /** O cStat da voz gravada (150 = autorizada fora de prazo: o aviso da D-NE279 sai por aqui). */
  readonly authorityCode: string | null
  /** Pendência crítica do `digVal` do `protNFe` (D-NE41): divergente NÃO grava; ausente grava o A que o fisco afirma. */
  readonly incident: 'digest-mismatch' | 'digest-absent' | 'file-conflict' | 'authorized-in-closed-attempt' | null
}

const fiscalEnvironment = (e: Environment): 'H' | 'P' => e
const utc = (v: string | null): string | null => (v ? toUtcDb(v) : null)

interface Reserved {
  readonly attempt: number
  readonly accessKey: string
  readonly signedXml: string
  readonly number: number
  readonly serie: number
  readonly environment: Environment
  readonly authorizer: string
  readonly url: string
  readonly action: string
  readonly namespace: string
  readonly cnpj: string
  readonly zone: string
  readonly opened: Opened
}

/** Transmite UMA NF-e (venda ou devolução): reserva → fisco → voz. Nada de rede em teste; o fisco só com o `request` real e o "vai" do Valdo. */
export async function transmitInvoice(deps: NfeDeps, actor: NfeActor, ref: InvoiceRef): Promise<TransmitResult> {
  assertFamilyInCatalog(deps.catalog ?? VOICE_READINGS)                                          // T3 — antes de tudo, sem tocar banco

  // TRANSAÇÃO 1 — reserva
  const reserved = await withInvoiceTx(deps.pool, actor, ref, { label: 'reserva da transmissão da NF-e', requireAlive: true }, async (itx): Promise<Reserved> => {
    const { conn, locked } = itx
    const life = locked.lifeEvent as number
    const opened = await deps.openIssuer(conn, actor)                           // a habilitação travada ANTES de qualquer leitura comum
    const latest = await latestAttempt(conn, ref, life)
    const barrier = barrierOf(latest)
    if (barrier) throw barrier
    assertRejectionBrake(await voicesOfLife(conn, ref, life))                    // D-NE254: 30 rejeições iguais da mesma nota
    const policy = numberPolicy(latest)
    const environment = opened.issuer.environment as Environment
    const facts = await readFactsGuarded(deps, conn, actor, ref, environment)
    // D-NE296: a hora do dhEmi é da vida que esta reserva travou — vida diferente (corrida com um refaturamento) é 409, nunca a hora de outra vida.
    // Sem vida (`lifeEvent` nulo) segue: o `dhEmiOf` recusa com 422 pela causa (S-A; e S-B se a data do evento não é a da nota).
    if (facts.lifeEvent !== null && facts.lifeEvent !== life) {
      throw new HttpError(409, 'A nota mudou de vida durante a transmissão (faturada de novo) — tente de novo', [{ field: 'lifeEvent', message: `lida ${facts.lifeEvent}, travada ${life}` }], ErrorCodes.RESOURCE_BUSY)
    }
    const now = deps.now()

    // o número: novo (peça do núcleo) ou o da tentativa fechada por R/F (D-NE282)
    let number: number
    if (policy.action === 'reuse') {
      if (latest && latest.environment !== environment) throw documentInvalid('O ambiente da habilitação mudou desde a tentativa anterior — o número não pode ser reaproveitado', [{ field: 'environment', message: 'Ambiente diferente da tentativa anterior' }])
      if (policy.serie !== facts.serie) throw documentInvalid('A série da nota mudou desde a tentativa anterior — o número não pode ser reaproveitado', [{ field: 'ide.serie', message: 'Série diferente da tentativa anterior' }])
      number = policy.number
    } else {
      const generated = await generateNumber(itx, actor.institutionId, facts.serie)
      if (generated.environment !== environment) throw new Error('o ambiente da sequência de números difere do da habilitação travada')
      number = generated.number
    }

    const zone = await deps.zoneOf(conn, actor)
    const dhEmi = dhEmiOf(facts.dtEmission, facts.createdAt, zone, facts.lifeDate)
    const authorizer = resolveAuthorizer({ uf: facts.uf, model: '55', environment, emissionType: 1, hasStateRegistration: facts.hasStateRegistration, at: now })
    if (!authorizer.ok) throw documentInvalid('Não há autorizador para esta nota', [{ field: 'emit.UF', message: `Autorizador indisponível: ${authorizer.reason}` }])
    // o serviço de autorização tem de existir ANTES de reservar: sem ele (produção não tem parte SOAP registrada — recusa por construção) NADA é reservado nem fica em voo
    const binding = soapBindingOf(authorizer.authorizer, environment, 'NFeAutorizacao')
    const endpoint = endpointOf(authorizer.authorizer, environment, 'NFeAutorizacao')
    if (!binding || !endpoint.ok) {
      throw new HttpError(503, 'O serviço de autorização deste ambiente não está registrado nesta API — nada foi reservado nem enviado',
        [{ field: 'authorizer', message: `${authorizer.authorizer} × ${environment}` }], ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE)
    }
    const cred = await deps.credentialsFor(conn, actor, { uf: facts.uf, environment, at: now })      // DEPOIS do lock (D-NE218)
    const establishmentCnpj = await deps.establishmentCnpj(conn, actor)
    if (!establishmentCnpj) throw new HttpError(409, 'O estabelecimento não tem CNPJ cadastrado', undefined, ErrorCodes.FISCAL_EMITTER_INCOMPLETE)

    let made: { signedXml: string } | null = null
    const attemptRow = await insertAttempt(itx, {
      lifeEvent: life, environment, authorizer: authorizer.authorizer, dhEmissionUtc: utc(dhEmi) as string,
      make: async () => {
        const accessKey = buildAccessKey({ uf: facts.uf, emissionDate: dhEmi.slice(0, 10), cnpj: facts.cnpj, model: '55', serie: facts.serie, number, emissionType: 1, cnf: drawCnf(number, deps.random) })
        const csrt = cred ? { idCSRT: cred.codeId, hashCSRT: hashCsrt(cred.codeValue, accessKey) } : null
        const input = facts.buildInput({ dhEmi, csrt })
        const built = buildNfeXml(input, accessKey)
        await assertLayer1(built.xml, {
          environment, emitterUf: facts.uf, emitterCnpj: establishmentCnpj, authorizerUf: facts.uf, now, erpTotalCents: input.erpTotalCents, csrtRequired: cred !== null,
        })
        const signedXml = signXml(built.xml, { referenceId: built.id, cert: opened.cert, key: opened.key, algorithm: 'sha1' })
        const xsd = await validateMessage('NFe', signedXml)
        if (!xsd.ok) throw documentInvalid('A NF-e assinada não passou no XSD', [{ field: 'NFe', message: 'Estrutura inválida segundo o leiaute (XSD) depois de assinar' }])
        const digestValue = digestValueOf(signedXml)
        if (digestValue === null) throw new Error('DigestValue da NF-e assinada ilegível')
        made = { signedXml }
        return { accessKey, digestValue }
      },
    }, actor.userId)

    // o XML assinado no arquivo fiscal ANTES do envio — gravação única do núcleo 5.2.0 (D-NE41): conflito = 409 e a transação desfaz, nada vai ao fisco
    const signed = (made as { signedXml: string } | null)?.signedXml
    if (!signed) throw new Error('candidato assinado ausente depois do INSERT da tentativa')
    try { saveWriteOnce(deps, { cnpj: facts.cnpj, serie: facts.serie, environment, zone }, `${attemptRow.accessKey}-nfe.xml`, signed, now) } catch (e) {
      if (isFileConflict(e)) throw new HttpError(409, 'O arquivo fiscal da NF-e já existe com outro conteúdo — nada foi enviado ao fisco (D-NE41)', [{ field: 'file', message: `${attemptRow.accessKey}-nfe.xml` }], ErrorCodes.FISCAL_FILE_CONFLICT)
      throw e
    }
    return { attempt: attemptRow.attempt, accessKey: attemptRow.accessKey, signedXml: signed, number, serie: facts.serie, environment, authorizer: authorizer.authorizer, url: endpoint.url, action: binding.action, namespace: binding.namespace, cnpj: facts.cnpj, zone, opened }
  })

  // O FISCO — fora de qualquer transação (D-NE33: 1 NF-e, síncrono)
  const outcome: SoapOutcome = await callSoap({
    url: reserved.url, service: 'NFeAutorizacao', action: reserved.action, namespace: reserved.namespace, resultElement: 'retEnviNFe',
    body: enviNFe(String(deps.now().getTime()), reserved.signedXml), message: 'enviNFe', cert: reserved.opened.cert, key: reserved.opened.key, ca: deps.ca(),
  }, deps.request)

  const decision = decide(outcome, reserved)
  if (decision.action !== 'voice') return finish(ref, reserved, noneOf(decision), null, null, decision.action === 'consult-key' ? 'consult-key' : null)

  // TRANSAÇÃO 2 — a voz
  const d = decision
  const voice = d.event
  if (voice.kind === 'D' && !d.nProt) return finish(ref, reserved, { kind: 'none', reason: 'denegada-sem-protocolo' }, null, null, 'consult-key')
  // o `digVal` do protNFe contra o DigestValue do candidato que assinamos (D-NE41): divergente = pendência crítica, NADA se grava e o procNFe não se guarda
  const digestCheck = voice.kind === 'A' || voice.kind === 'D' ? checkDigest(digestValueOf(reserved.signedXml) as string, d.digVal) : null
  if (digestCheck === 'mismatch') return finish(ref, reserved, { kind: 'none', reason: 'digest-divergente' }, null, null, 'consult-key', 'digest-mismatch')
  const wrote = await withInvoiceTx(deps.pool, actor, ref, { label: 'voz do fisco da NF-e' }, async itx => {
    // a tentativa nasceu SEM voz: se alguma voz entrou durante o envio (o `refresh` pousou A pela chave), a que a pergunta viu não é mais a última e NADA se grava (gate adversarial HIGH-2)
    const current = await getAttempt(itx.conn, ref, reserved.attempt)
    if (!current || current.lastEvent !== null) return 'changed' as const
    // a tentativa com o 217 PROVADO (o fato) está fechada: o A/D que o envio devolve tarde é incidente — nada se grava (D-NE292), como no refresh
    if ((voice.kind === 'A' || voice.kind === 'D') && provenNotRegistered(current)) return 'closed' as const
    if (d.nProt) await fillAuthorityData(itx, reserved.attempt, { protocol: d.nProt, dhRecbtoUtc: utc(d.dhRecbto) })
    if (d.nRec) await fillReceipt(itx, reserved.attempt, d.nRec)
    await writeVoice(itx, reserved.attempt, actor.userId, voice)
    return 'written' as const
  })
  if (wrote === 'closed') return finish(ref, reserved, { kind: 'none', reason: 'autorizada-em-tentativa-fechada' }, null, null, 'consult-key', 'authorized-in-closed-attempt')
  if (wrote === 'changed') return finish(ref, reserved, { kind: 'none', reason: 'voz-mudou-depois-da-pergunta' }, null, null, null)
  // o `-procNFe.xml` da autorizada e da denegada (D-NE35): conflito de gravação única = pendência crítica (nunca silêncio); outra falha do `save` (disco cheio, link físico) só avisa, com log SEM conteúdo — o `-procNFe.xml` perdido NÃO é refeito por rota nenhuma (limite aceito; a reconstrução é da NFE.E6.P4)
  let conflict = false
  let procSaved = false
  if (voice.kind === 'A' || voice.kind === 'D') {
    const xml = outcome.kind === 'answered' || outcome.kind === 'rejected' ? procNfeXml(reserved.signedXml, outcome.xml, reserved.accessKey) : null
    if (xml) {
      try { saveWriteOnce(deps, { cnpj: reserved.cnpj, serie: reserved.serie, environment: reserved.environment, zone: reserved.zone }, `${reserved.accessKey}-procNFe.xml`, xml, deps.now()); procSaved = true } catch (e) { conflict = isFileConflict(e); if (!conflict) logger.warn('Arquivo fiscal: o -procNFe.xml não foi gravado', { accessKey: reserved.accessKey, error: e instanceof Error ? e.name : 'erro' }) }
    }
  }
  // o fato "passou a A" (D-NE261): a voz e o procNFe já estão gravados; o conflito de gravação única (pendência crítica) não manda e-mail de um arquivo duvidoso
  if (voice.kind === 'A' && !conflict && procSaved) await notifyAuthorized(deps, { actor, ref, attempt: reserved.attempt, accessKey: reserved.accessKey })
  return finish(ref, reserved, { kind: voice.kind, authorityCode: voice.authorityCode, message: voice.message }, d.nProt, d.nRec, d.nRec || voice.kind === 'P' ? 'consult-receipt' : null, conflict ? 'file-conflict' : digestCheck === 'absent' ? 'digest-absent' : null)
}

/**
 * A voz do fisco, UMA chamada por `kind` com o `kind` LITERAL e o objeto sem spread (cerca `voice-kind-fence`: o escritor único da família, `recordVoiceOnce` com o
 * literal `{ insertTransmissionEvent, hasTransmissionEvent }`). Idempotente por (kind, dh) — o `recordVoiceOnce` do núcleo.
 */
async function writeVoice(itx: InvoiceTx, attempt: number, userId: number | null, e: VoiceEvent): Promise<void> {
  const insertTransmissionEvent = MERCHANDISE_VOICE_FAMILY.insertTransmissionEvent
  const hasTransmissionEvent = MERCHANDISE_VOICE_FAMILY.hasTransmissionEvent
  switch (e.kind) {
    case 'A': await recordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, attempt, userId, { kind: 'A', source: e.source, authorityCode: e.authorityCode, message: e.message, dh: e.dh }); return
    case 'D': await recordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, attempt, userId, { kind: 'D', source: e.source, authorityCode: e.authorityCode, message: e.message, dh: e.dh }); return
    case 'R': await recordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, attempt, userId, { kind: 'R', source: e.source, authorityCode: e.authorityCode, message: e.message, dh: e.dh }); return
    case 'P': await recordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, attempt, userId, { kind: 'P', source: e.source, authorityCode: e.authorityCode, message: e.message, dh: e.dh }); return
    case 'F': await recordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, attempt, userId, { kind: 'F', source: e.source, authorityCode: e.authorityCode, message: e.message, dh: e.dh }); return
  }
}

/** O freio da D-NE254: 30 rejeições do MESMO cStat na vida da nota recusam a nova tentativa (429) — sem ele, um R de 656 reenviaria sem fim, reaproveitando o número. */
export const MAX_SAME_REJECTIONS = 30
export function assertRejectionBrake(voices: readonly { kind: string; authorityCode: string | null }[]): void {
  const counts = new Map<string, number>()
  for (const v of voices) if (v.kind === 'R' && v.authorityCode) counts.set(v.authorityCode, (counts.get(v.authorityCode) ?? 0) + 1)
  for (const [code, n] of counts) {
    if (n >= MAX_SAME_REJECTIONS) throw new HttpError(429, `A nota já foi rejeitada ${n} vezes com o mesmo motivo (${code}) — corrija antes de transmitir de novo (freio do consumo indevido, D-NE254)`, [{ field: 'authorityCode', message: code }], ErrorCodes.RESOURCE_BUSY)
  }
}

/** A leitura dos fatos: qualquer falha de leitura é do chamador (HttpError já tipado) — nada a traduzir aqui. */
async function readFactsGuarded(deps: NfeDeps, conn: ConnLike, actor: NfeActor, ref: InvoiceRef, environment: Environment): Promise<ComposedFacts> {
  const facts = await deps.readFacts(conn, actor, ref, environment)
  if (!Number.isInteger(facts.serie) || facts.serie < 0 || facts.serie > 909) throw documentInvalid('Série da nota fora do intervalo', [{ field: 'ide.serie', message: 'Série de 0 a 909' }])
  return facts
}

/** Gravação única: o `save` do núcleo devolve o caminho se os bytes são iguais e lança `FiscalFileConflictError` se são outros — nunca sobrescreve. */
function saveWriteOnce(deps: NfeDeps, p: { cnpj: string; serie: number; environment: Environment; zone: string }, name: string, xml: string, when: Date): void {
  deps.storage.save(merchandiseFileKey({ cnpj: p.cnpj, model: '55', serie: p.serie, environment: fiscalEnvironment(p.environment), zone: p.zone }), name, xml, when)
}

/** O que o `SoapOutcome` diz à tentativa (D-NE34: só o retorno legível e o cStat decidem; o resto não grava ou fecha como F). */
function decide(outcome: SoapOutcome, r: Reserved): VoiceDecision {
  switch (outcome.kind) {
    case 'answered':
    case 'rejected': return voiceOfCStat(readSend({ chNFe: r.accessKey, tpAmb: r.environment === 'H' ? '2' : '1' }, outcome.xml), 'P')
    case 'credential': return { action: 'voice', nProt: null, digVal: null, dhRecbto: null, nRec: null, event: { kind: 'F', authorityCode: null, message: 'Credencial recusada pelo fisco', dh: null, source: 'P' } }
    case 'local-credential': return { action: 'voice', nProt: null, digVal: null, dhRecbto: null, nRec: null, event: { kind: 'F', authorityCode: null, message: 'Credencial local inválida — nada foi enviado', dh: null, source: 'P' } }
    case 'chain': return { action: 'voice', nProt: null, digVal: null, dhRecbto: null, nRec: null, event: { kind: 'F', authorityCode: null, message: 'Cadeia de certificados do servidor do fisco não confiável', dh: null, source: 'P' } }
    case 'ambiguous': return { action: 'ambiguous', reason: outcome.cause }
    case 'unavailable': return { action: 'ambiguous', reason: 'servico-indisponivel' }
    case 'deactivated': return { action: 'ambiguous', reason: 'servico-desativado' }
  }
}

const noneOf = (d: VoiceDecision): { kind: 'none'; reason: string } =>
  d.action === 'ambiguous' ? { kind: 'none', reason: d.reason } : d.action === 'consult-key' ? { kind: 'none', reason: d.reason } : { kind: 'none', reason: d.action === 'none' ? d.reason : 'sem-voz' }

function finish(ref: InvoiceRef, r: Reserved, outcome: TransmitResult['outcome'], nProt: string | null, nRec: string | null, next: TransmitResult['next'], incident: TransmitResult['incident'] = null): TransmitResult {
  const authorityCode = 'authorityCode' in outcome ? outcome.authorityCode : null
  return { authorityCode, incident, invoiceId: ref.invoiceId, attempt: r.attempt, accessKey: r.accessKey, number: r.number, serie: r.serie, outcome, nProt, nRec, next }
}

