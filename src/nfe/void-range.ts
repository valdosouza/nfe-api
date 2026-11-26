import { ErrorCodes, HttpError, erp, lockNumberSequence, logger, nowIsoIn, withTransaction, type Queryable } from 'fiscal-api'
import { endpointOf, soapBindingOf, ufRoute, voidEndpoint, type Environment, type Uf } from '../authority/authorizers'
import { voiceOfVoid } from '../authority/cstat-voice'
import { CUF, inutNFe, SAFE_JUSTIFICATION, signInutNFe } from '../authority/messages'
import { readVoid } from '../authority/responses'
import { callSoap, type SoapOutcome } from '../authority/soap'
import { validateMessage } from '../authority/xsd'
import { documentInvalid, NfeErrors } from './errors'
import { isFileConflict, merchandiseFileKey } from './fiscal-file'
import { NUMBER_VOID_TABLE } from './number-void'
import { procInutXml, voidFileName } from './proc-evento'
import { assertFamilyOf, type NfeActor, type NfeDeps } from './transmission'
import { attemptsInNumberRange } from './attempt'

/**
 * A INUTILIZAÇÃO de faixa (NFE.E6.P2.T2 — ficha-nfe-e6-p2-cancelar-inutilizar-rodizio.md §7-5; D-NE8, D-NE40, D-NE50, D-NE110, D-NE163, D-NE169, D-NE171, D-NE207, D-NE210, D-NE257, D-NE263,
 * D-NE282, D-NE293; RF-NFE-15/23/44/81). SEM NOTA: a ordem das travas é habilitação (`openIssuer` forUpdate) → A1 → sequência (`lockNumberSequence`). Nenhuma rede em teste.
 *
 * - A faixa só vale até o ÚLTIMO número gerado (D-NE263; S4: sem conhecer o número inicial da sequência): acima dele, 422 sem ir ao fisco. Número de que ALGUMA tentativa ainda é dona
 *   (viva, autorizada, denegada, rejeitada ou com o 217 provado — R/F/217 reaproveitam o número, D-NE282) = 409 `FISCAL_VOID_RANGE_IN_USE`: senão a inutilização tira um número que a transmissão
 *   reaproveita e o fisco devolve 206.
 * - A reserva nasce como linha PENDENTE (`authority_code` nulo — o ERP e a numeração pulam a faixa, D-NE110) ANTES do fisco, que é chamado FORA da transação. A resposta preenche a linha UMA vez
 *   (Q2, D-NE293): `UPDATE … WHERE authority_code IS NULL`. Nenhum outro UPDATE, nenhum DELETE, nenhum `deleted` diferente de 'N' nesta tabela (D-NE171 — cerca `void-range-append-only`).
 * - 102/563 retiram a faixa (D-NE40); 256/241 e as demais rejeitam — história, NÃO retiram (D-NE207); o que o serviço recusou (656…), o ambíguo e a resposta sem eco (D-NE210) deixam a linha
 *   pendente; o reenvio da MESMA faixa (S6) reaproveita a linha: antes de 10 minutos = 409 `FISCAL_VOID_IN_FLIGHT`, depois reenvia pelo mesmo Id e remonta o pedido igual.
 * - A prova arquivada é o `ProcInutNFe` em `<Id43>-inut.xml` (D-NE50), por gravação única; conflito = incidente, nunca silêncio.
 */

export interface VoidRequest {
  readonly serie: number
  /** Ano da inutilização (4 dígitos); ausente = o ano corrente na zona do estabelecimento. */
  readonly year?: number
  readonly from: number
  readonly to: number
  readonly reason: string
}

export interface EmitterIdentity { readonly cnpj: string; readonly uf: Uf; readonly hasStateRegistration: boolean }
export interface VoidDeps extends NfeDeps {
  /** O emitente do estabelecimento (CNPJ, UF do endereço principal, presença de IE) — sem nota. */
  readonly emitterOf: (q: Queryable, actor: NfeActor) => Promise<EmitterIdentity>
}

export interface VoidResult {
  readonly id: number
  readonly voidId: string
  readonly serie: number
  readonly from: number
  readonly to: number
  readonly environment: Environment
  readonly state: 'homologated' | 'in-flight'
  readonly authorityCode: string | null
  readonly protocol: string | null
  readonly message: string | null
  readonly incident: 'file-conflict' | null
  /** O cStat que o SERVIÇO recusou (656…), para o disjuntor; nunca é rejeição da faixa. */
  readonly refusedCStat: string | null
}

export const MAX_VOID_RANGE = 10_000
export const MIN_VOID_RESEND_AGE_MS = 600_000
const FIRST_VOID_YEAR = 2006
const tpAmbOf = (e: Environment): '1' | '2' => (e === 'H' ? '2' : '1')
const utcMs = (dbUtc: string | null): number | null => {
  const t = dbUtc ? Date.parse(`${dbUtc.replace(' ', 'T')}Z`) : NaN
  return Number.isNaN(t) ? null : t
}

export interface VoidRow {
  readonly id: number
  readonly voidId: string
  readonly authorizer: string
  readonly reason: string
  readonly authorityCode: string | null
  readonly message: string | null
  readonly protocol: string | null
  readonly createdAt: string | null
}
const mapRow = (r: any): VoidRow => ({
  id: Number(r.id), voidId: String(r.voidId), authorizer: String(r.authorizer), reason: String(r.reason), authorityCode: r.authorityCode == null ? null : String(r.authorityCode),
  message: r.message == null ? null : String(r.message), protocol: r.protocol == null ? null : String(r.protocol), createdAt: r.createdAt == null ? null : String(r.createdAt),
})
const SELECT_ROW = `SELECT id, void_id AS voidId, authorizer, reason, authority_code AS authorityCode, message, protocol, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt FROM ${NUMBER_VOID_TABLE}`

/** O emitente sem nota: o estabelecimento é a entidade de mesmo id (`readEmitter`); a UF é a do endereço principal. Para o `nfeDepsOf` (P4). */
export function emitterFromParty(party: { cnpj: string | null; stateRegistration: string | null; addresses: readonly { main: string | null; stateCode: string | null }[] }): EmitterIdentity {
  const main = party.addresses.find(a => a.main === 'S') ?? party.addresses[0] ?? null
  if (!party.cnpj || !main?.stateCode || !(main.stateCode in CUF)) {
    throw new HttpError(422, 'Estabelecimento emitente sem CNPJ ou UF — a inutilização não pode ser montada', [{ field: 'emitter', message: 'CNPJ ou UF do endereço principal ausente' }], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  return { cnpj: party.cnpj, uf: main.stateCode as Uf, hasStateRegistration: !!party.stateRegistration }
}

export async function voidRange(deps: VoidDeps, actor: NfeActor, req: VoidRequest): Promise<VoidResult> {
  assertFamilyOf(deps)
  const fields: { field: string; message: string }[] = []
  if (!Number.isInteger(req.serie) || req.serie < 0 || req.serie > 909) fields.push({ field: 'serie', message: 'Série de 0 a 909' })
  if (!Number.isInteger(req.from) || !Number.isInteger(req.to) || req.from < 1 || req.to < req.from || req.to > 999_999_999) fields.push({ field: 'from', message: 'Faixa: 1 ≤ início ≤ fim ≤ 999999999' })
  else if (req.to - req.from + 1 > MAX_VOID_RANGE) fields.push({ field: 'to', message: `A faixa passa de ${MAX_VOID_RANGE} números (rejeição 201 do fisco)` })
  if (typeof req.reason !== 'string' || !SAFE_JUSTIFICATION.test(req.reason)) fields.push({ field: 'reason', message: 'De 15 a 255 caracteres, só letras, números e . , ; : ( ) - /, sem espaço no início nem no fim' })
  if (fields.length) throw documentInvalid('A inutilização não foi aceita', fields)

  // (1) a RESERVA: habilitação → A1 → sequência, tudo numa transação; o pedido montado e validado ANTES de a linha nascer
  type Reserved = { readonly row: VoidRow; readonly resend: boolean; readonly environment: Environment; readonly uf: Uf; readonly cnpj: string; readonly yy: string; readonly zone: string
    readonly url: string; readonly action: string; readonly namespace: string; readonly opened: Awaited<ReturnType<NfeDeps['openIssuer']>> }
  type Step = { readonly done: VoidRow; readonly environment: Environment } | { readonly reserved: Reserved }
  const step = await withTransaction(deps.pool as never, 'reserva da inutilização da NF-e', { institutionId: actor.institutionId }, async (conn): Promise<Step> => {
    const opened = await deps.openIssuer(conn, actor)                                       // a habilitação TRAVADA e o A1 conferidos ANTES de qualquer leitura comum
    const environment = opened.issuer.environment as Environment
    const emitter = await deps.emitterOf(conn, actor)
    const zone = await deps.zoneOf(conn, actor)
    const now = deps.now()
    deps.breaker?.check({ cnpj: emitter.cnpj, environment, service: 'inutilizacao' })     // o disjuntor (D-NE254): 429 sem reservar e sem ir ao fisco
    const currentYear = Number(nowIsoIn(zone, now).slice(0, 4))
    const year = req.year ?? currentYear
    if (!Number.isInteger(year) || year > currentYear) throw documentInvalid('A inutilização não foi aceita', [{ field: 'year', message: 'Ano superior ao ano corrente (rejeição 453 do fisco)' }])
    if (year < FIRST_VOID_YEAR) throw documentInvalid('A inutilização não foi aceita', [{ field: 'year', message: 'Ano inferior a 2006 (rejeição 454 do fisco)' }])
    const yy = String(year % 100).padStart(2, '0')

    const seq = await lockNumberSequence(conn as never, { institutionId: actor.institutionId, model: '55', serie: req.serie })
    if (seq.environment !== environment) throw new Error('o ambiente da sequência de números difere do da habilitação travada')
    if (seq.lastNumber === null || seq.lastNumber < 1) throw documentInvalid('Nada a inutilizar nesta série: nenhum número foi gerado', [{ field: 'from', message: 'Sequência sem número gerado' }])
    if (req.to > seq.lastNumber) throw documentInvalid('A faixa passa do último número gerado — só se inutiliza número que existe (D-NE263)', [{ field: 'to', message: `Último número gerado: ${seq.lastNumber}` }])

    // o endereço do fisco e o pedido ANTES da linha: serviço desativado/sem IE/sem binding = recusa local, nada reservado
    const endpoint = voidEndpoint({ uf: emitter.uf, model: '55', environment, at: now, hasStateRegistration: emitter.hasStateRegistration })
    if (!endpoint.ok) {
      if (endpoint.reason === 'no-ie-unsupported' || endpoint.reason === 'service-deactivated') {
        throw documentInvalid('Este emitente não pede inutilização ao fisco', [{ field: 'emitter', message: endpoint.reason === 'service-deactivated' ? `A SEFAZ de ${emitter.uf} não oferece mais a inutilização` : 'Emitente sem inscrição estadual: inutilização não suportada' }])
      }
      throw new HttpError(503, 'O serviço de inutilização deste ambiente não está registrado nesta API — nada foi reservado nem enviado', [{ field: 'authorizer', message: emitter.uf }], ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE)
    }
    const authorizer = ufRoute(emitter.uf, environment).normal
    const binding = soapBindingOf(authorizer, environment, 'NfeInutilizacao')
    const bound = endpointOf(authorizer, environment, 'NfeInutilizacao')
    if (!binding || !bound.ok) throw new HttpError(503, 'O serviço de inutilização deste ambiente não está registrado nesta API — nada foi reservado nem enviado', [{ field: 'authorizer', message: `${authorizer} × ${environment}` }], ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE)
    const wanted = inutNFe({ tpAmb: tpAmbOf(environment), uf: emitter.uf, yy, cnpj: emitter.cnpj, serie: req.serie, from: req.from, to: req.to, xJust: req.reason })
    const common = { environment, uf: emitter.uf, cnpj: emitter.cnpj, yy, zone, url: bound.url, action: binding.action, namespace: binding.namespace, opened }

    // a faixa que já tem linha retirada (pendente ou inutilizada) que a cobre em parte ou por inteiro
    const covering = await findCoveringRange(conn, actor.institutionId, environment, req.serie, req.from, req.to)
    if (covering) {
      const row = covering
      if (row.authorityCode !== null) {
        if (row.voidId === wanted.id) return { done: row, environment }                  // a mesma faixa já retirada: idempotente, nada ao fisco
        throw new HttpError(409, 'A faixa cobre número já inutilizado por outro pedido', [{ field: 'voidId', message: row.voidId }], NfeErrors.NUMBER_VOID_ALREADY_WITHDRAWN)
      }
      const age = utcMs(row.createdAt)
      const resendable = row.voidId === wanted.id && age !== null && now.getTime() - age >= MIN_VOID_RESEND_AGE_MS
      if (!resendable) throw new HttpError(409, 'Já há pedido de inutilização pendente para esta faixa — aguarde a resposta do fisco ou o prazo de reenvio', [{ field: 'voidId', message: row.voidId }], NfeErrors.VOID_IN_FLIGHT)
      return { reserved: { ...common, row, resend: true } }                            // o reenvio da MESMA faixa reaproveita a linha (S6)
    }

    // número de que alguma tentativa ainda é dona: viva, autorizada, denegada, rejeitada (R/F reaproveitam — D-NE282) ou com o 217 provado
    const owner = await findNumberOwner(conn, actor.schemaName, actor.institutionId, environment, req.serie, req.from, req.to)
    if (owner !== null) {
      throw new HttpError(409, `O número ${owner} ainda é de uma nota (transmissão viva, autorizada, denegada ou rejeitada que reaproveita o número) — a faixa não pode ser inutilizada`, [{ field: 'from', message: String(owner) }], NfeErrors.VOID_RANGE_IN_USE)
    }
    const signed = signInutNFe(wanted, opened.cert, opened.key)
    const xsd = await validateMessage('inutNFe', signed)
    if (!xsd.ok) throw documentInvalid('O pedido de inutilização assinado não passou no XSD', [{ field: 'inutNFe', message: 'Estrutura inválida segundo o leiaute (XSD) depois de assinar' }])
    let id: number
    try {
      id = await reserveRange(conn, actor.institutionId, actor.userId, { voidId: wanted.id, environment, authorizer, reason: req.reason })
    } catch (e) {
      const err = e as { errno?: number; code?: string }
      if (err?.errno === 1062 || err?.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'A faixa já foi inutilizada por outro pedido ao mesmo tempo', [{ field: 'voidId', message: wanted.id }], NfeErrors.NUMBER_VOID_ALREADY_WITHDRAWN)
      throw e
    }
    return { reserved: { ...common, row: { id, voidId: wanted.id, authorizer, reason: req.reason, authorityCode: null, message: null, protocol: null, createdAt: null }, resend: false } }
  })

  if ('done' in step) return resultOf(step.done, req, step.environment, null, null)
  const r = step.reserved

  // (2) o FISCO — fora de transação; o pedido é remontado IGUAL pela linha (o reenvio do mesmo Id)
  const built = inutNFe({ tpAmb: tpAmbOf(r.environment), uf: r.uf, yy: r.yy, cnpj: r.cnpj, serie: req.serie, from: req.from, to: req.to, xJust: r.row.reason })
  const signed = signInutNFe(built, r.opened.cert, r.opened.key)
  let outcome: SoapOutcome
  outcome = await callSoap({
    url: r.url, service: 'NfeInutilizacao', action: r.action, namespace: r.namespace, resultElement: 'retInutNFe', body: signed, message: 'inutNFe', cert: r.opened.cert, key: r.opened.key, ca: deps.ca(),
  }, deps.request)
  if (outcome.kind === 'local-credential' || outcome.kind === 'credential' || outcome.kind === 'chain') {
    // nada concluiu: a linha fica pendente (append-only) e o reenvio depois do prazo a retoma
    throw new HttpError(502, outcome.kind === 'chain' ? 'Cadeia de certificados do servidor do fisco não confiável' : 'Credencial recusada ou inválida — a inutilização ficou pendente', undefined, ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED)
  }
  if (outcome.kind !== 'answered' && outcome.kind !== 'rejected') return resultOf(r.row, req, r.environment, null, null)

  // (3) a resposta decide: retira (102/563), rejeita (história) ou deixa pendente
  const decided = voiceOfVoid(readVoid({ tpAmb: tpAmbOf(r.environment), cUF: CUF[r.uf], ano: r.yy, CNPJ: r.cnpj, mod: '55', serie: req.serie, nNFIni: req.from, nNFFin: req.to }, outcome.xml))
  const scope = { cnpj: r.cnpj, environment: r.environment, service: 'inutilizacao' } as const
  if (decided.action === 'pending') {
    if (decided.breaker) deps.breaker?.recordRefused(scope, decided.breaker)                       // o serviço RECUSOU (656…): o disjuntor abre por 1 h, a linha fica pendente
    return resultOf(r.row, req, r.environment, decided.breaker, null)
  }
  if (decided.action === 'rejected') deps.breaker?.recordRejection(scope, decided.cStat)           // a rejeição da faixa conta na hora (até 20 iguais)
  const answer = decided.action === 'withdrawn'
    ? { code: decided.cStat, message: decided.message, protocol: decided.nProt, dh: decided.dhRecbto }
    : { code: decided.cStat, message: decided.message, protocol: null, dh: null }
  const filled = await withTransaction(deps.pool as never, 'resposta da inutilização da NF-e', { institutionId: actor.institutionId }, async conn => fillVoidAnswer(conn, actor.institutionId, r.row.id, answer))
  if (!filled) {
    // outro pedido já preencheu a linha (S6): relê e responde com ela
    const [again] = await (deps.pool as never as Queryable).query(`${SELECT_ROW} WHERE tb_institution_id = ? AND id = ?`, [actor.institutionId, r.row.id])
    const row = Array.isArray(again) && again[0] ? mapRow(again[0]) : r.row
    return resultOf(row, req, r.environment, null, null)
  }
  if (decided.action === 'rejected') {
    throw new HttpError(422, `O fisco rejeitou a inutilização (${decided.cStat}): ${decided.message}`, [{ field: 'authorityCode', message: decided.cStat }, { field: 'voidId', message: r.row.voidId }], NfeErrors.VOID_REJECTED)
  }
  // a prova arquivada (D-NE50): o ProcInutNFe, por gravação única — conflito = pendência crítica, outra falha só avisa
  let incident: 'file-conflict' | null = null
  const proc = procInutXml(signed, outcome.xml, { cUF: CUF[r.uf], ano: r.yy, cnpj: r.cnpj, serie: req.serie, from: req.from, to: req.to })
  if (proc !== null) {
    const key = merchandiseFileKey({ cnpj: r.cnpj, model: '55', serie: req.serie, environment: r.environment, zone: r.zone })
    try { deps.storage.save(key, voidFileName(r.row.voidId), proc, deps.now()) } catch (e) {
      if (isFileConflict(e)) incident = 'file-conflict'
      else logger.warn('Arquivo fiscal: o ProcInutNFe não foi gravado', { voidId: r.row.voidId, error: e instanceof Error ? e.name : 'erro' })
    }
  } else {
    logger.warn('Arquivo fiscal: o ProcInutNFe não foi montado (retorno sem o retInutNFe legível)', { voidId: r.row.voidId })
  }
  return resultOf({ ...r.row, authorityCode: answer.code, message: answer.message, protocol: answer.protocol }, req, r.environment, null, incident)
}

/** A linha RETIRADA (pendente ou inutilizada) que cobre, em parte ou por inteiro, a faixa pedida — sob a trava da transação (`FOR UPDATE`). */
export async function findCoveringRange(conn: Queryable, institutionId: number, environment: Environment, serie: number, from: number, to: number): Promise<VoidRow | null> {
  const [rows] = await conn.query(`${SELECT_ROW} WHERE tb_institution_id = ? AND model = '55' AND serie = ? AND environment = ? AND withdrawn = 'S' AND deleted = 'N' AND number_from <= ? AND number_to >= ? ORDER BY id LIMIT 1 FOR UPDATE`,
    [institutionId, serie, environment, to, from])
  return Array.isArray(rows) && rows[0] ? mapRow(rows[0]) : null
}

/**
 * O 1º número da faixa de que ALGUMA tentativa ainda é dona; `null` se nenhum. Dona = (a) a tentativa REGISTRADA no fisco (protocolo: autorizada, denegada, cancelada — o número foi usado), sempre; ou
 * (b) a tentativa sem protocolo (em voo, rejeitada ou com falha — que reaproveitam o número, D-NE282 —, ou com o 217 provado) da VIDA ATUAL de uma nota viva. A tentativa sem protocolo de nota APAGADA
 * ou de vida encerrada deixou o número livre: é o buraco que a inutilização existe para fechar.
 */
export async function findNumberOwner(conn: Queryable, schemaName: string, institutionId: number, environment: Environment, serie: number, from: number, to: number): Promise<number | null> {
  const list = await attemptsInNumberRange(conn, institutionId, environment, serie, from, to)
  const registered = list.find(r => r.protocol != null)
  let first = registered ? Number(registered.number) : null
  const open = list.filter(r => r.protocol == null && (first === null || Number(r.number) < first))        // só interessa o que vem ANTES do 1º registrado
  const terminals = [...new Set(open.map(r => Number(r.terminal)))]
  for (const terminal of terminals) {
    const mine = open.filter(r => Number(r.terminal) === terminal)
    const lives = await erp.invoiceLives(conn, schemaName, { institutionId, terminal }, [...new Set(mine.map(r => Number(r.invoiceId)))])
    for (const r of mine) {
      const life = lives.get(Number(r.invoiceId))
      if (life && !life.invoiceDeleted && life.lifeEvent !== null && life.lifeEvent === Number(r.lifeEvent) && (first === null || Number(r.number) < first)) first = Number(r.number)
    }
  }
  return first
}

/** A RESERVA: a linha PENDENTE (`authority_code` nulo) com o `id` MAX+1 do estabelecimento (sob a trava da habilitação). O 1062 da UNIQUE sobe cru para quem chama traduzir (D-NE169). */
export async function reserveRange(conn: Queryable, institutionId: number, userId: number | null, r: { voidId: string; environment: Environment; authorizer: string; reason: string }): Promise<number> {
  const [nextRows] = await conn.query(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM ${NUMBER_VOID_TABLE} WHERE tb_institution_id = ?`, [institutionId])
  const id = Number((nextRows as any[])[0].next)
  await conn.query(
    `INSERT INTO ${NUMBER_VOID_TABLE} (tb_institution_id, id, void_id, environment, authorizer, reason, tb_user_id, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [institutionId, id, r.voidId, r.environment, r.authorizer, r.reason, userId])
  return id
}

/**
 * O ÚNICO UPDATE da tabela das faixas (Q2/D-NE293): preenche a linha PENDENTE UMA vez com a resposta do fisco. `authority_code IS NULL` é o write-once; 0 linhas = outro pedido já respondeu.
 * Nunca outro UPDATE, nunca DELETE, nunca `deleted` diferente de 'N' (D-NE171 — cerca por AST).
 */
export async function fillVoidAnswer(conn: Queryable, institutionId: number, id: number, a: { code: string; message: string; protocol: string | null; dh: string | null }): Promise<boolean> {
  const [res] = await conn.query(
    'UPDATE tb_invoice_number_void SET authority_code = ?, message = ?, protocol = ?, dh_recbto = ?, updated_at = NOW() WHERE tb_institution_id = ? AND id = ? AND authority_code IS NULL',
    [a.code, a.message, a.protocol, a.dh, institutionId, id])
  return Number((res as { affectedRows?: number }).affectedRows ?? 0) === 1
}

function resultOf(row: VoidRow, req: VoidRequest, environment: Environment, refusedCStat: string | null, incident: 'file-conflict' | null): VoidResult {
  const withdrawn = row.authorityCode === '102' || row.authorityCode === '563'
  return {
    id: row.id, voidId: row.voidId, serie: req.serie, from: req.from, to: req.to, environment, state: withdrawn ? 'homologated' : 'in-flight',
    authorityCode: row.authorityCode, protocol: row.protocol, message: row.message, incident, refusedCStat,
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// A listagem dos pedidos de inutilização (NFE.E6.P4 mudança 2; contrato `NumberVoid`)
// ---------------------------------------------------------------------------------------------------------------------------------------

/** Um pedido de inutilização como o contrato o publica; `state`: sem resposta = em voo; 102/563 retirada = homologada; resposta sem retirada = rejeitada. `dh` em UTC do banco (a rota converte à zona). */
export interface VoidListItem {
  readonly id: number; readonly environment: Environment; readonly serie: number; readonly year: number; readonly from: number; readonly to: number; readonly reason: string; readonly voidId: string
  readonly state: 'in_flight' | 'homologated' | 'rejected'; readonly authorityCode: string | null; readonly protocol: string | null; readonly dh: string | null
}

const voidItemOf = (r: any): VoidListItem => ({
  id: Number(r.id), environment: r.environment as Environment, serie: Number(r.serie), year: Number(r.year), from: Number(r.nFrom), to: Number(r.nTo), reason: String(r.reason), voidId: String(r.voidId),
  state: r.authorityCode == null ? 'in_flight' : r.withdrawn === 'S' ? 'homologated' : 'rejected',
  authorityCode: r.authorityCode == null ? null : String(r.authorityCode), protocol: r.protocol == null ? null : String(r.protocol), dh: r.dh == null ? null : String(r.dh),
})

/** Do mais novo ao mais antigo (id decrescente). `total` ao lado da página; só o estabelecimento e o modelo 55 (a numeração do 55 é a desta API). */
export async function listVoids(q: Queryable, institutionId: number, page: number, pageSize: number): Promise<{ total: number; items: VoidListItem[] }> {
  const [count] = await q.query(`SELECT COUNT(*) AS n FROM ${NUMBER_VOID_TABLE} WHERE tb_institution_id = ? AND model = '55' AND deleted = 'N'`, [institutionId])
  const [rows] = await q.query(
    `SELECT id, environment, serie, 2000 + CAST(SUBSTRING(void_id, 5, 2) AS UNSIGNED) AS year, number_from AS nFrom, number_to AS nTo, reason, void_id AS voidId, authority_code AS authorityCode,
            protocol, withdrawn, DATE_FORMAT(dh_recbto, '%Y-%m-%d %H:%i:%s') AS dh
       FROM ${NUMBER_VOID_TABLE} WHERE tb_institution_id = ? AND model = '55' AND deleted = 'N' ORDER BY id DESC LIMIT ? OFFSET ?`,
    [institutionId, pageSize, (page - 1) * pageSize])
  const items = (Array.isArray(rows) ? rows : []).map(voidItemOf)
  return { total: Number((count as any[])[0]?.n ?? 0), items }
}

/** Um pedido pelo id (a resposta do `POST /v1/nfe/voids` devolve o pedido inteiro, como a listagem). */
export async function findVoidItem(q: Queryable, institutionId: number, id: number): Promise<VoidListItem | null> {
  const [rows] = await q.query(
    `SELECT id, environment, serie, 2000 + CAST(SUBSTRING(void_id, 5, 2) AS UNSIGNED) AS year, number_from AS nFrom, number_to AS nTo, reason, void_id AS voidId, authority_code AS authorityCode,
            protocol, withdrawn, DATE_FORMAT(dh_recbto, '%Y-%m-%d %H:%i:%s') AS dh
       FROM ${NUMBER_VOID_TABLE} WHERE tb_institution_id = ? AND model = '55' AND deleted = 'N' AND id = ?`, [institutionId, id])
  const r = Array.isArray(rows) ? (rows as any[])[0] : null
  return r ? voidItemOf(r) : null
}

/** Os pedidos de UMA série e UM ambiente, do mais novo ao mais antigo, SEM corte (a numeração mostra todas as faixas da série — nunca só as 100 mais novas do estabelecimento). */
export async function voidsOfSerie(q: Queryable, institutionId: number, serie: number, environment: Environment): Promise<VoidListItem[]> {
  const [rows] = await q.query(
    `SELECT id, environment, serie, 2000 + CAST(SUBSTRING(void_id, 5, 2) AS UNSIGNED) AS year, number_from AS nFrom, number_to AS nTo, reason, void_id AS voidId, authority_code AS authorityCode,
            protocol, withdrawn, DATE_FORMAT(dh_recbto, '%Y-%m-%d %H:%i:%s') AS dh
       FROM ${NUMBER_VOID_TABLE} WHERE tb_institution_id = ? AND model = '55' AND deleted = 'N' AND serie = ? AND environment = ? ORDER BY id DESC`, [institutionId, serie, environment])
  return (Array.isArray(rows) ? rows : []).map(voidItemOf)
}
