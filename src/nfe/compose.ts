import { erp, invoiceRef, isAuthorized, type FiscalStorage, type InvoiceRef, type Queryable, type TechnicalResponsible } from 'fiscal-api'
import type { Environment } from '../authority/authorizers'
import * as facts from '../facts/merchandise-facts'
import { latestAttempt } from './attempt'
import { documentInvalid, returnMismatch } from './errors'
import { merchandiseFileKey } from './fiscal-file'
import { numberItems, type ItemNumbering } from './item-numbering'
import { IBSCBS_SIMPLES_FROM } from './nfe-builder'
import { nfeInputFromFacts, originRef, type NfeInputSources } from './nfe-input'
import { assertReturnMatchesOrigin, originKeyOf, readOriginSimples, type OriginItemSimples, type ReturnItemCheck } from './return-reference'
import type { ComposedFacts, NfeActor } from './transmission'

/**
 * A COMPOSIÇÃO dos fatos da nota (NFE.E6.P1 mudança 9 — D-NE103, D-NE219, D-NE248, D-NE278; ficha §6-9): lê o ERP SÓ por `src/facts` (SELECT), monta a entrada do builder pela
 * ponte pura e, na DEVOLUÇÃO, confere cada item contra o `-procNFe.xml` ARQUIVADO da nota de origem (`assertReturnMatchesOrigin`: `cProd`, `vUnCom` e `qCom` devolvida ≤ a da
 * origem; o `procNFe` precisa ser autorizado e da nossa chave — a SEFAZ não confere por item) ANTES de abrir tentativa. A origem tem de ter sido emitida por esta nfe-api e
 * estar autorizada (última voz A, protocolo gravado) e o arquivo existir; senão 422 com o item, nunca se chuta a chave.
 * As leituras entram por `ComposeReaders` (o padrão é a fonte de fatos), para o teste injetar fatos sem banco.
 *
 * SIMPLES DE 2027 (NFE.E5.P7, junção do NFE.E5.P6 — D-NE286, D-NE288, D-NE289; ficha-nfe-e5-p7 S1 e S2): só quando a nota é de 01/01/2027 em diante
 * (`dt_emission` — D-NE278) e o emitente é do Simples (CRT 1), a mesma condição da ponte. Na venda, o IBS/CBS que o faturamento congelou
 * (`readItemSimples`); na devolução, o grupo do item da origem lido do MESMO procNFe arquivado que a conferência usa (`readOriginSimples`), com a chave
 * tirada dele (`originKeyOf`) e conferida contra a da tentativa autorizada. Em 2026, nenhuma leitura nem recusa nova: a chave segue a da tentativa.
 */

export interface ComposeReaders {
  readonly readInvoice: typeof facts.readMerchandiseInvoice
  readonly listItems: typeof facts.listMerchandiseItems
  readonly readNature: typeof facts.readOperationNature
  readonly readEmitter: typeof facts.readEmitter
  readonly readRecipient: typeof facts.readRecipient
  readonly readPayments: typeof facts.readPayments
  readonly readShipping: typeof facts.readShipping
  readonly readReturnOrigins: typeof facts.readReturnOrigins
  readonly readItemSimples: typeof facts.readItemSimples
  readonly invoiceLife: (q: Queryable, schemaName: string, ref: InvoiceRef) => Promise<{ lifeEvent: number | null } | null>
  readonly institutionZone: (q: Queryable, schemaName: string, institutionId: number) => Promise<string>
}

export const DEFAULT_READERS: ComposeReaders = {
  readInvoice: facts.readMerchandiseInvoice, listItems: facts.listMerchandiseItems, readNature: facts.readOperationNature, readEmitter: facts.readEmitter,
  readRecipient: facts.readRecipient, readPayments: facts.readPayments, readShipping: facts.readShipping, readReturnOrigins: facts.readReturnOrigins,
  readItemSimples: facts.readItemSimples,
  invoiceLife: (q, s, r) => erp.invoiceLife(q, s, r), institutionZone: (q, s, i) => erp.institutionZone(q, s, i),
}

export interface ComposeEnv {
  readonly storage: Pick<FiscalStorage, 'find' | 'read'>
  readonly techResponsible: TechnicalResponsible
  readonly readers?: ComposeReaders
}

const procName = (accessKey: string): string => `${accessKey}-procNFe.xml`

/** Compõe os fatos da nota em `ComposedFacts`: série, emitente, UF, data, hora e o construtor do candidato (venda ou devolução já conferida). */
export async function readComposedFacts(q: Queryable, env: ComposeEnv, actor: NfeActor, ref: InvoiceRef, environment: Environment): Promise<ComposedFacts> {
  const r = env.readers ?? DEFAULT_READERS
  const schema = actor.schemaName
  const header = await r.readInvoice(q, schema, ref)
  const items = await r.listItems(q, schema, ref)
  const emitter = await r.readEmitter(q, schema, actor.institutionId)
  const recipient = await r.readRecipient(q, schema, actor.institutionId, header.entityId)
  const returnOrigins = await r.readReturnOrigins(q, schema, ref)
  const base: NfeInputSources = {
    environment: environment === 'H' ? '2' : '1', dhEmi: `${header.dtEmission}T00:00:00-03:00`, header, items,
    operationNature: (await r.readNature(q, items)).operationNature, emitter, recipient,
    payments: await r.readPayments(q, schema, ref), shipping: await r.readShipping(q, schema, ref), returnOrigins, techResponsible: env.techResponsible,
  }
  // Simples de 2027 (S1): a condição da ponte, pela data do faturamento e o CRT do emitente
  // a data na forma AAAA-MM-DD antes da comparação (um `dt_emission` nulo vira o texto 'null', que passaria no >=) — como a ponte e o `dhEmiOf`
  const simples2027 = /^\d{4}-\d{2}-\d{2}$/.test(header.dtEmission) && header.dtEmission >= IBSCBS_SIMPLES_FROM && emitter.tax?.crt === '1'
  // só a VENDA lê o que o faturamento congelou; a devolução tira o grupo do XML da origem (D-NE288)
  if (simples2027 && returnOrigins.length === 0) base.simples = await r.readItemSimples(q, schema, ref)

  // devolução: as notas de origem, cada uma com a chave AUTORIZADA, a numeração dos itens dela e o procNFe arquivado conferido contra os itens devolvidos
  let origins: Map<string, { accessKey: string; numbering: ItemNumbering; simples?: ReadonlyMap<number, OriginItemSimples> }> | undefined
  const procByOrigin = new Map<string, { xml: string; accessKey: string }>()
  if (returnOrigins.length > 0) {
    origins = new Map()
    const zone = await r.institutionZone(q, schema, actor.institutionId)
    const distinct = [...new Map(returnOrigins.map(o => [originRef(o.originInvoiceId, o.originTerminal), o])).values()]
    for (const o of distinct) {
      const oRef = invoiceRef(actor.institutionId, o.originInvoiceId, o.originTerminal)
      const key = originRef(o.originInvoiceId, o.originTerminal)
      const life = await r.invoiceLife(q, schema, oRef)
      const attempt = life && life.lifeEvent !== null ? await latestAttempt(q, oRef, life.lifeEvent) : null
      if (!attempt || attempt.protocol === null || !isAuthorized({ lastKind: attempt.lastKind })) continue         // sem NF-e autorizada conhecida: a ponte cita o item
      const found = env.storage.find(merchandiseFileKey({ cnpj: attempt.accessKey.slice(6, 20), model: '55', serie: attempt.serie, environment: attempt.environment, zone }), procName(attempt.accessKey), [attempt.dhEmission])
      if (found === null) throw documentInvalid('O procNFe arquivado da nota de origem não foi encontrado', [{ field: 'origin', message: `Nota de origem ${o.originInvoiceId}: ${procName(attempt.accessKey)} ausente do arquivo fiscal` }])
      const numbering = numberItems((await r.listItems(q, schema, oRef)).map(i => i.itemId))
      const xml = env.storage.read(found)
      if (simples2027) {
        // S2: a chave sai do MESMO XML que a conferência usa e tem de ser a da tentativa autorizada; o grupo do Simples da origem também sai dele
        const accessKey = originKeyOf(xml)
        if (accessKey !== attempt.accessKey) {
          throw returnMismatch('A nota de origem da devolução não pode ser conferida', [{ field: 'origin', message: `Nota de origem ${o.originInvoiceId}: a chave do procNFe arquivado não é a da tentativa autorizada da origem` }])
        }
        origins.set(key, { accessKey, numbering, simples: readOriginSimples(xml) })
        procByOrigin.set(key, { xml, accessKey })
      } else {
        origins.set(key, { accessKey: attempt.accessKey, numbering })
        procByOrigin.set(key, { xml, accessKey: attempt.accessKey })
      }
    }
    base.origins = origins
  }

  // a ponte pura: a lista inteira de violações sobe daqui (422), antes de qualquer tentativa
  const trial = nfeInputFromFacts(base)

  if (origins && procByOrigin.size > 0) {
    for (const [key, proc] of procByOrigin) {
      const numbering = (origins.get(key) as { numbering: ItemNumbering }).numbering
      const checks: ReturnItemCheck[] = []
      for (const link of returnOrigins.filter(l => originRef(l.originInvoiceId, l.originTerminal) === key)) {
        const item = items.find(i => i.itemId === link.itemId)
        const numbered = numbering.items.find(n => n.itemId === link.originItemId)
        if (item && numbered) checks.push({ itemId: item.itemId, cProd: item.merchandiseId === null ? null : String(item.merchandiseId), qCom: item.quantity, vUnCom: item.unitValue, origin: { accessKey: proc.accessKey, numbered } })
      }
      if (checks.length) assertReturnMatchesOrigin(checks, proc.xml, trial.emit.CNPJ ?? '')
    }
  }

  const uf = trial.emit.ender.UF
  const serie = Number(header.serie)
  if (!trial.emit.CNPJ || !uf) throw documentInvalid('O emitente não pôde ser composto', [{ field: 'emit', message: 'CNPJ ou UF do emitente ausente' }])
  return {
    serie, cnpj: trial.emit.CNPJ, uf: uf as ComposedFacts['uf'], hasStateRegistration: !!trial.emit.IE, dtEmission: header.dtEmission, createdAt: header.createdAt, lifeEvent: header.lifeEvent, lifeDate: header.lifeDate,
    buildInput: ({ dhEmi, csrt }) => nfeInputFromFacts({ ...base, dhEmi, csrt }),
  }
}
