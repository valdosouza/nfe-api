import crypto from 'crypto'
import { assertInvoiceTx, blocksNewAttempt, ErrorCodes, HttpError, isAuthorized, isLiveTransmission, nextInvoiceNumber, type InvoiceRef, type InvoiceTx, type TransmissionEventKind } from 'fiscal-api'
import { assertCnf } from './access-key'
import { MERCHANDISE_TRANSMISSION_TABLE, MERCHANDISE_VOICE_FAMILY } from './voice-family'

/**
 * A TENTATIVA da NF-e (NFE.E6.P1 — D-NE7, D-NE37, D-NE56, D-NE61, D-NE257, D-NE282; ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-6). O ÚNICO
 * arquivo que escreve a tabela `tb_invoice_merchandise_transmission` (a coluna `nfe_not_registered_at` é de `not-registered.ts`) e o ÚNICO da nfe-api que chama
 * as peças do último número do núcleo (cerca em `deploy-e1-p11.test.ts`). O núcleo só tem o escritor da VOZ (`defineVoiceFamily`/`recordVoiceOnce`).
 *
 * - INSERT da tentativa: chave NOSSA desde a reserva (`cNF` sorteado, UNIQUE da chave — repete o sorteio no 1062), `digest_value` já conhecido, autorizador
 *   congelado; o nº da tentativa é MAX+1 sob a trava da nota. Imutáveis desde o INSERT: access_key, life_event, environment, authorizer, dh_emission,
 *   digest_value. Write-once (NULL → valor UMA vez): receipt, protocol, dh_recbto.
 * - O NÚMERO (D-NE257/D-NE282): a nota sem tentativa na vida gera pelo `nextInvoiceNumber` do núcleo; depois de R ou F (a rejeição não consome o número) a nova
 *   tentativa REAPROVEITA o mesmo, com `cNF` novo; autorizada, denegada, cancelada ou inutilizada nunca reaproveita; em voo = barreira (409).
 *   O contrato do núcleo (number-sequence.d.ts): dentro da transação, travar a habilitação (`openIssuer` forUpdate) ANTES do A1, nenhuma leitura comum antes,
 *   deadlock 1213/espera 1205 sobem crus (repete a transação inteira), 409 `FISCAL_NUMBER_SEQUENCE_NOT_OPEN` desfaz tudo — nunca abrir a sequência aqui.
 */

type Q = { query(sql: string, params?: unknown): Promise<[any, any]> }

export interface AttemptRow {
  readonly attempt: number
  readonly lifeEvent: number
  readonly environment: 'H' | 'P'
  readonly authorizer: string
  readonly accessKey: string
  /** O número da nota e a série, lidos da chave (posições 26–34 e 23–25 — D-NE283). */
  readonly number: number
  readonly serie: number
  readonly dhEmission: string
  readonly digestValue: string
  readonly receipt: string | null
  readonly protocol: string | null
  readonly dhRecbto: string | null
  readonly lastQueriedAt: string | null
  readonly nfeNotRegisteredAt: string | null
  readonly lastEvent: number | null
  readonly lastKind: TransmissionEventKind | null
  readonly lastCode: string | null
  /** O instante (UTC do banco) em que a última voz foi gravada — o recibo só se consulta depois de 15 s dela (RF-NFE-17). */
  readonly lastEventAt: string | null
  /** Quando a TENTATIVA foi criada (UTC do banco): o `reconfirm` não aceita o 217 de uma tentativa recém-criada (pode estar sendo enviada agora). */
  readonly createdAt: string | null
}

const T = MERCHANDISE_TRANSMISSION_TABLE
const EV = MERCHANDISE_VOICE_FAMILY.eventTable
const fmt = (col: string, as: string): string => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s') AS ${as}`

/** A tentativa com a ÚLTIMA voz dela (a de maior nº de evento), lida por qualquer chave. */
const SELECT_ATTEMPT = `SELECT t.attempt, t.life_event AS lifeEvent, t.environment, t.authorizer, t.access_key AS accessKey, ${fmt('t.dh_emission', 'dhEmission')},
         t.digest_value AS digestValue, t.receipt, t.protocol, ${fmt('t.dh_recbto', 'dhRecbto')}, ${fmt('t.last_queried_at', 'lastQueriedAt')},
         ${fmt('t.nfe_not_registered_at', 'nfeNotRegisteredAt')}, e.event AS lastEvent, e.kind AS lastKind, e.authority_code AS lastCode, ${fmt('e.created_at', 'lastEventAt')}, ${fmt('t.created_at', 'createdAt')}
    FROM ${T} t
    LEFT JOIN ${EV} e
      ON e.tb_institution_id = t.tb_institution_id AND e.tb_invoice_id = t.tb_invoice_id AND e.terminal = t.terminal AND e.attempt = t.attempt AND e.deleted = 'N'
     AND e.event = (SELECT MAX(x.event) FROM ${EV} x WHERE x.tb_institution_id = t.tb_institution_id AND x.tb_invoice_id = t.tb_invoice_id
                      AND x.terminal = t.terminal AND x.attempt = t.attempt AND x.deleted = 'N')`

function mapAttempt(r: any): AttemptRow {
  const key = String(r.accessKey)
  if (!/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/.test(key)) throw new Error('tentativa com chave de acesso fora da forma')
  if (r.environment !== 'H' && r.environment !== 'P') throw new Error('tentativa com ambiente fora de H e P')
  return {
    attempt: Number(r.attempt), lifeEvent: Number(r.lifeEvent), environment: r.environment, authorizer: String(r.authorizer), accessKey: key,
    number: Number(key.slice(25, 34)), serie: Number(key.slice(22, 25)), dhEmission: String(r.dhEmission), digestValue: String(r.digestValue),
    receipt: r.receipt == null ? null : String(r.receipt), protocol: r.protocol == null ? null : String(r.protocol),
    dhRecbto: r.dhRecbto == null ? null : String(r.dhRecbto), lastQueriedAt: r.lastQueriedAt == null ? null : String(r.lastQueriedAt),
    nfeNotRegisteredAt: r.nfeNotRegisteredAt == null ? null : String(r.nfeNotRegisteredAt),
    lastEvent: r.lastEvent == null ? null : Number(r.lastEvent), lastKind: r.lastKind == null ? null : (String(r.lastKind) as TransmissionEventKind),
    lastCode: r.lastCode == null ? null : String(r.lastCode), lastEventAt: r.lastEventAt == null ? null : String(r.lastEventAt),
    createdAt: r.createdAt == null ? null : String(r.createdAt),
  }
}

/** A última tentativa da VIDA da nota (a de maior nº), ou null. Leitura não travante: sob a trava da nota todo escritor está serializado. */
export async function latestAttempt(q: Q, ref: InvoiceRef, lifeEvent: number): Promise<AttemptRow | null> {
  const [rows] = await q.query(
    `${SELECT_ATTEMPT} WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = ? AND t.life_event = ? AND t.deleted = 'N' ORDER BY t.attempt DESC LIMIT 1`,
    [ref.institutionId, ref.invoiceId, ref.terminal, lifeEvent])
  return Array.isArray(rows) && rows[0] ? mapAttempt(rows[0]) : null
}

/** Uma tentativa pelo nº. */
export async function getAttempt(q: Q, ref: InvoiceRef, attempt: number): Promise<AttemptRow | null> {
  const [rows] = await q.query(
    `${SELECT_ATTEMPT} WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = ? AND t.attempt = ? AND t.deleted = 'N'`,
    [ref.institutionId, ref.invoiceId, ref.terminal, attempt])
  return Array.isArray(rows) && rows[0] ? mapAttempt(rows[0]) : null
}

/** Todas as tentativas da nota na vida (D-NE36: o 539 consulta as chaves de TODAS as nossas tentativas), da mais antiga à mais nova. */
export async function attemptsOfLife(q: Q, ref: InvoiceRef, lifeEvent: number): Promise<AttemptRow[]> {
  const [rows] = await q.query(
    `${SELECT_ATTEMPT} WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = ? AND t.life_event = ? AND t.deleted = 'N' ORDER BY t.attempt ASC`,
    [ref.institutionId, ref.invoiceId, ref.terminal, lifeEvent])
  return Array.isArray(rows) ? rows.map(mapAttempt) : []
}

/** Quem DETÉM a chave (a UNIQUE é do país): a tentativa desta nota, ou null. */
export async function findKeyHolder(q: Q, ref: InvoiceRef, accessKey: string): Promise<AttemptRow | null> {
  const [rows] = await q.query(
    `${SELECT_ATTEMPT} WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = ? AND t.access_key = ? AND t.deleted = 'N'`,
    [ref.institutionId, ref.invoiceId, ref.terminal, accessKey])
  return Array.isArray(rows) && rows[0] ? mapAttempt(rows[0]) : null
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// A barreira e a política do número (puras)
// ---------------------------------------------------------------------------------------------------------------------------------------

const registered = (a: AttemptRow): boolean => a.protocol !== null
const kindOf = (a: AttemptRow) => ({ lastKind: a.lastKind, authorityRecorded: registered(a), attempt: a.attempt, accessKey: a.accessKey })

/**
 * O 217 PROVADO (D-NE292, RF-NFE-78): a tentativa está SEM voz, sem recibo e sem protocolo e a rota `reconfirm` gravou o fato `nfe_not_registered_at` pela peça
 * `notRegisteredProven` do núcleo. O fato NÃO é voz (D-NE235): a tentativa continua sem voz e o núcleo ainda a conta como viva; aqui ele só solta a NOVA tentativa.
 */
export const provenNotRegistered = (a: AttemptRow): boolean => a.lastKind === null && a.nfeNotRegisteredAt !== null && a.receipt === null && a.protocol === null

/** O 409 da barreira de nova tentativa (D-NE7/D-NE56): viva (sem voz, P ou outra não final), autorizada ou registrada (denegada). Null = pode abrir. */
export function barrierOf(latest: AttemptRow | null): HttpError | null {
  if (!latest) return null
  if (provenNotRegistered(latest)) return null                                   // o 217 provado solta a nova tentativa — por ato explícito do usuário (D-NE292)
  const view = kindOf(latest)
  if (isAuthorized(view)) return new HttpError(409, `A nota já tem NF-e autorizada (tentativa ${latest.attempt}) — nada a transmitir`, undefined, ErrorCodes.FISCAL_ALREADY_AUTHORIZED)
  if (isLiveTransmission(view)) {
    return new HttpError(409, `Há transmissão em andamento (tentativa ${latest.attempt}) — consultar o fisco antes de qualquer reenvio`, undefined, ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS)
  }
  if (blocksNewAttempt({ lastKind: latest.lastKind, authorityRecorded: registered(latest) })) {
    return new HttpError(409, `A NF-e da tentativa ${latest.attempt} foi registrada pelo fisco (denegada) — o número queimou, não se retransmite`, undefined, ErrorCodes.FISCAL_ALREADY_AUTHORIZED)
  }
  return null
}

export type NumberPolicy =
  | { readonly action: 'generate' }
  | { readonly action: 'reuse'; readonly number: number; readonly serie: number }

/**
 * O número da próxima tentativa (D-NE257/D-NE282): sem tentativa na vida → gera; a última fechada SEM registro do fisco por R ou F, ou em voo com o 217 PROVADO (fato gravado — D-NE292) → reaproveita o mesmo número e a
 * mesma série; qualquer outra coisa (viva, autorizada, denegada, cancelada, inutilizada) é a barreira e quem chama já recusou — aqui recusa de novo, nunca reaproveita.
 */
export function numberPolicy(latest: AttemptRow | null): NumberPolicy {
  if (!latest) return { action: 'generate' }
  const blocked = barrierOf(latest)
  if (blocked) throw blocked
  if ((latest.lastKind === 'R' || latest.lastKind === 'F') && !registered(latest)) return { action: 'reuse', number: latest.number, serie: latest.serie }
  if (provenNotRegistered(latest)) return { action: 'reuse', number: latest.number, serie: latest.serie }
  throw new HttpError(409, `A tentativa ${latest.attempt} não está fechada por rejeição ou falha — o número não pode ser reaproveitado`, undefined, ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS)
}

/**
 * O número NOVO, pela peça do núcleo, DENTRO da transação da nota e DEPOIS de `openIssuer` forUpdate (contrato do núcleo). 409 `FISCAL_NUMBER_SEQUENCE_NOT_OPEN`
 * (produção não aberta, D-NE265) sobe cru: quem chama desfaz a transação inteira sem abrir a sequência.
 */
export async function generateNumber(itx: InvoiceTx, institutionId: number, serie: number): Promise<{ number: number; environment: 'H' | 'P' }> {
  assertInvoiceTx(itx)
  return nextInvoiceNumber(itx.conn, { institutionId, model: '55', serie }) as Promise<{ number: number; environment: 'H' | 'P' }>
}

/** Sorteia o `cNF` de 8 dígitos por `crypto`, recusado pelo `assertCnf` (igual ao número ou sequência proibida) — sorteia de novo. */
export function drawCnf(number: number, random: (max: number) => number = max => crypto.randomInt(0, max)): string {
  for (let i = 0; i < 64; i++) {
    const cnf = String(random(100_000_000)).padStart(8, '0')
    try { assertCnf(cnf, number); return cnf } catch { /* sorteia de novo */ }
  }
  throw new Error('cNF: 64 sorteios recusados (impossível com um sorteador honesto)')
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Escritores (sob a trava da nota — `InvoiceTx`)
// ---------------------------------------------------------------------------------------------------------------------------------------

const isKeyCollision = (e: unknown): boolean => {
  const err = e as { errno?: number; code?: string; message?: string }
  return (err?.errno === 1062 || err?.code === 'ER_DUP_ENTRY') && /uk_invoice_merchandise_transmission_key/.test(String(err?.message ?? ''))
}

export interface NewAttempt {
  readonly lifeEvent: number
  readonly environment: 'H' | 'P'
  readonly authorizer: string
  /**
   * Monta a chave com um `cNF` NOVO e o candidato ASSINADO daquela chave a cada chamada (a colisão da UNIQUE pede outro sorteio, e o `digest_value` é do candidato
   * da chave gravada): devolve a chave e o `DigestValue` do `infNFe` assinado (27 Base64 + `=`). Quem chama guarda o resto (o XML assinado) na própria closure.
   */
  readonly make: () => Promise<{ accessKey: string; digestValue: string }> | { accessKey: string; digestValue: string }
  /** O `dhEmi` assinado em UTC ('AAAA-MM-DD HH:MM:SS' — `toUtcDb`). */
  readonly dhEmissionUtc: string
}

/**
 * INSERT da tentativa: MAX+1 sob a trava da nota. A colisão da UNIQUE da chave (outra nota do país com o mesmo cNF/número) sorteia outra chave, até 5 vezes.
 * A tentativa nasce SEM voz (em voo). Devolve o nº da tentativa e a chave gravada.
 */
export async function insertAttempt(itx: InvoiceTx, p: NewAttempt, userId: number | null): Promise<{ attempt: number; accessKey: string }> {
  assertInvoiceTx(itx)
  const { conn, ref } = itx
  const [max] = await conn.query(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM ${T} WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ?`,
    [ref.institutionId, ref.invoiceId, ref.terminal]) as [any[], unknown]
  const attempt = Number(max[0]?.next)
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('insertAttempt: nº da tentativa ilegível')
  for (let i = 0; i < 5; i++) {
    assertInvoiceTx(itx)                                                          // 2ª conferência logo antes de gravar (NE1A2-02): nada depois do COMMIT
    const { accessKey, digestValue } = await p.make()
    assertInvoiceTx(itx)                                                          // `make` é async (assina): confere de novo depois dela
    try {
      await conn.query(
        `INSERT INTO ${T} (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, authorizer, access_key, dh_emission, digest_value,
                           tb_user_id, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
        [ref.institutionId, ref.invoiceId, ref.terminal, attempt, p.lifeEvent, p.environment, p.authorizer, accessKey, p.dhEmissionUtc, digestValue, userId])
      return { attempt, accessKey }
    } catch (e) {
      if (!isKeyCollision(e)) throw e
    }
  }
  throw new HttpError(409, 'Não foi possível cunhar uma chave de acesso livre depois de 5 sorteios do cNF', undefined, ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS)
}

/** Write-once (NULL → valor UMA vez, `WHERE col IS NULL`): devolve `true` se gravou, `false` se já estava gravado (ou a tentativa não existe). */
async function writeOnce(itx: InvoiceTx, attempt: number, sets: string, onlyIfNull: string, params: unknown[]): Promise<boolean> {
  assertInvoiceTx(itx)
  const { conn, ref } = itx
  const [res] = await conn.query(
    `UPDATE ${T} SET ${sets}, updated_at = NOW() WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND attempt = ? AND deleted = 'N' AND ${onlyIfNull} IS NULL`,
    [...params, ref.institutionId, ref.invoiceId, ref.terminal, attempt]) as [any, unknown]
  return Number(res?.affectedRows ?? 0) === 1
}

/** O `nRec` do 103/105: write-once (a saída do P é a consulta do recibo — D-NE33). */
export function fillReceipt(itx: InvoiceTx, attempt: number, nRec: string): Promise<boolean> {
  if (!/^[0-9]{15}$/.test(nRec)) throw new Error('fillReceipt: nRec com 15 dígitos')
  return writeOnce(itx, attempt, 'receipt = ?', 'receipt', [nRec])
}

/**
 * O protocolo e o `dhRecbto` do `protNFe` (autorização OU denegação): write-once; o protocolo é o REGISTRO pelo fisco (D-NE56/D-NE61). Quem chama grava a voz na
 * MESMA transação. `dhRecbtoUtc` em UTC ('AAAA-MM-DD HH:MM:SS') ou null.
 */
export function fillAuthorityData(itx: InvoiceTx, attempt: number, d: { protocol: string; dhRecbtoUtc: string | null }): Promise<boolean> {
  if (!/^([0-9]{15}|[0-9]{17})$/.test(d.protocol)) throw new Error('fillAuthorityData: nProt com 15 ou 17 dígitos')
  return writeOnce(itx, attempt, 'protocol = ?, dh_recbto = ?', 'protocol', [d.protocol, d.dhRecbtoUtc])
}

/** A cota do rodízio/656: o carimbo da última consulta a ESTA chave (fora da transação da nota é aceito — só `Q`). */
export async function touchQueriedAt(q: Q, ref: InvoiceRef, attempt: number): Promise<void> {
  await q.query(
    `UPDATE ${T} SET last_queried_at = NOW(), updated_at = NOW() WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND attempt = ? AND deleted = 'N'`,
    [ref.institutionId, ref.invoiceId, ref.terminal, attempt])
}

/** As vozes das tentativas da vida da nota, na ordem (tentativa, evento) — a leitura da rota `GET /v1/nfe/invoices/{id}`. */
export async function voicesOfLife(q: Q, ref: InvoiceRef, lifeEvent: number): Promise<{ attempt: number; event: number; kind: TransmissionEventKind; authorityCode: string | null; message: string | null; dh: string | null; source: 'P' | 'Q' }[]> {
  const [rows] = await q.query(
    `SELECT e.attempt, e.event, e.kind, e.authority_code AS authorityCode, e.message, ${fmt('e.dh', 'dh')}, e.source
       FROM ${EV} e JOIN ${T} t ON t.tb_institution_id = e.tb_institution_id AND t.tb_invoice_id = e.tb_invoice_id AND t.terminal = e.terminal AND t.attempt = e.attempt
      WHERE e.tb_institution_id = ? AND e.tb_invoice_id = ? AND e.terminal = ? AND t.life_event = ? AND e.deleted = 'N' AND t.deleted = 'N'
      ORDER BY e.attempt, e.event`, [ref.institutionId, ref.invoiceId, ref.terminal, lifeEvent])
  return (Array.isArray(rows) ? rows : []).map((r: any) => ({
    attempt: Number(r.attempt), event: Number(r.event), kind: String(r.kind) as TransmissionEventKind, authorityCode: r.authorityCode == null ? null : String(r.authorityCode),
    message: r.message == null ? null : String(r.message), dh: r.dh == null ? null : String(r.dh), source: String(r.source) as 'P' | 'Q',
  }))
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Leituras da NFE.E6.P2 (a inutilização e o rodízio) — aqui porque só este arquivo nomeia a tabela das tentativas (cerca de `nfe-attempt.test.ts`)
// ---------------------------------------------------------------------------------------------------------------------------------------

/** As tentativas cujo número (posições 26–34 da chave) cai na faixa, na série e no ambiente: número, nota, terminal, vida e protocolo (a inutilização decide quem é dono). */
export async function attemptsInNumberRange(q: Q, institutionId: number, environment: 'H' | 'P', serie: number, from: number, to: number): Promise<{ number: unknown; invoiceId: unknown; terminal: unknown; lifeEvent: unknown; protocol: unknown }[]> {
  const [rows] = await q.query(
    `SELECT CAST(SUBSTRING(access_key, 26, 9) AS UNSIGNED) AS number, tb_invoice_id AS invoiceId, terminal, life_event AS lifeEvent, protocol FROM ${T} WHERE tb_institution_id = ? AND environment = ? `
    + `AND CAST(SUBSTRING(access_key, 23, 3) AS UNSIGNED) = ? AND CAST(SUBSTRING(access_key, 26, 9) AS UNSIGNED) BETWEEN ? AND ? AND deleted = 'N' ORDER BY number`,
    [institutionId, environment, serie, from, to])
  return (Array.isArray(rows) ? rows : []) as { number: unknown; invoiceId: unknown; terminal: unknown; lifeEvent: unknown; protocol: unknown }[]
}

/**
 * As tentativas ABERTAS do estabelecimento para o rodízio (sem voz, P ou K na última voz), só a ÚLTIMA de cada nota e só o que cabe em [since] (UTC 'AAAA-MM-DD hh:mm:ss'), as menos consultadas
 * primeiro, no máximo [limit].
 */
export async function openAttemptsOfInstitution(q: Q, institutionId: number, since: string, limit: number): Promise<any[]> {
  const [rows] = await q.query(
    `SELECT t.tb_invoice_id AS invoiceId, t.terminal, t.attempt, t.access_key AS accessKey, t.environment, e.kind AS lastKind, DATE_FORMAT(COALESCE(e.created_at, t.created_at), '%Y-%m-%d %H:%i:%s') AS since
       FROM ${T} t
       LEFT JOIN ${EV} e ON e.tb_institution_id = t.tb_institution_id AND e.tb_invoice_id = t.tb_invoice_id AND e.terminal = t.terminal AND e.attempt = t.attempt AND e.deleted = 'N'
        AND e.event = (SELECT MAX(x.event) FROM ${EV} x WHERE x.tb_institution_id = t.tb_institution_id AND x.tb_invoice_id = t.tb_invoice_id AND x.terminal = t.terminal AND x.attempt = t.attempt AND x.deleted = 'N')
      WHERE t.tb_institution_id = ? AND t.deleted = 'N' AND (e.kind IS NULL OR e.kind IN ('P', 'K'))
        AND t.attempt = (SELECT MAX(y.attempt) FROM ${T} y WHERE y.tb_institution_id = t.tb_institution_id AND y.tb_invoice_id = t.tb_invoice_id AND y.terminal = t.terminal AND y.deleted = 'N')
        AND COALESCE(e.created_at, t.created_at) >= ?
      ORDER BY t.last_queried_at IS NOT NULL, t.last_queried_at ASC, t.tb_invoice_id ASC LIMIT ?`,
    [institutionId, since, limit])
  return Array.isArray(rows) ? rows : []
}


// ---------------------------------------------------------------------------------------------------------------------------------------
// Leituras da NFE.E6.P4 (a lista `pending`, a numeração e a listagem) — só este arquivo nomeia a tabela das tentativas
// ---------------------------------------------------------------------------------------------------------------------------------------

/** As tentativas (com a última voz) de VÁRIAS notas do mesmo estabelecimento e terminal, da mais antiga à mais nova; lote (a chave da nota inteira por parâmetro, D-NE12). */
export async function attemptsOfInvoices(q: Q, institutionId: number, terminal: number, invoiceIds: readonly number[]): Promise<(AttemptRow & { invoiceId: number })[]> {
  if (invoiceIds.length === 0) return []
  const [rows] = await q.query(
    `${SELECT_ATTEMPT.replace('SELECT t.attempt,', 'SELECT t.tb_invoice_id AS invoiceId, t.attempt,')} WHERE t.tb_institution_id = ? AND t.terminal = ? AND t.tb_invoice_id IN (?) AND t.deleted = 'N' ORDER BY t.tb_invoice_id, t.attempt ASC`,
    [institutionId, terminal, [...invoiceIds]])
  return Array.isArray(rows) ? rows.map((r: any) => ({ ...mapAttempt(r), invoiceId: Number(r.invoiceId) })) : []
}

/** O maior número JÁ GERADO da série no ambiente (posições 26–34 da chave; qualquer tentativa, viva ou não) — leitura simples, sem trava (D-NE257: o contador é desta API); null = nenhum. */
export async function highestAttemptNumber(q: Q, institutionId: number, environment: 'H' | 'P', serie: number): Promise<number | null> {
  const [rows] = await q.query(
    `SELECT MAX(CAST(SUBSTRING(access_key, 26, 9) AS UNSIGNED)) AS highest FROM ${T} WHERE tb_institution_id = ? AND environment = ? AND CAST(SUBSTRING(access_key, 23, 3) AS UNSIGNED) = ? AND deleted = 'N'`,
    [institutionId, environment, serie])
  const v = Array.isArray(rows) && rows[0] ? rows[0].highest : null
  return v == null ? null : Number(v)
}

/** As tentativas da série (número, nota, terminal, vida, protocolo e o instante da emissão em UTC) para derivar os buracos. */
export async function attemptsOfSerie(q: Q, institutionId: number, environment: 'H' | 'P', serie: number): Promise<{ number: number; invoiceId: number; terminal: number; lifeEvent: number; protocol: string | null; dhEmission: string }[]> {
  const [rows] = await q.query(
    `SELECT CAST(SUBSTRING(access_key, 26, 9) AS UNSIGNED) AS number, tb_invoice_id AS invoiceId, terminal, life_event AS lifeEvent, protocol, ${fmt('dh_emission', 'dhEmission')} FROM ${T} `
    + `WHERE tb_institution_id = ? AND environment = ? AND CAST(SUBSTRING(access_key, 23, 3) AS UNSIGNED) = ? AND deleted = 'N' ORDER BY number`,
    [institutionId, environment, serie])
  return (Array.isArray(rows) ? rows : []).map((r: any) => ({ number: Number(r.number), invoiceId: Number(r.invoiceId), terminal: Number(r.terminal), lifeEvent: Number(r.lifeEvent), protocol: r.protocol == null ? null : String(r.protocol), dhEmission: String(r.dhEmission) }))
}
