import { erp, openIssuer, requiredFiscalCredentialsFor, type InstitutionPayload } from 'fiscal-api'
import type { AppContext } from '../context'
import { readEmitter } from '../facts/merchandise-facts'
import { documentInvalid } from '../nfe/errors'
import { readComposedFacts } from '../nfe/compose'
import type { ReconcileDeps } from '../nfe/reconcile'
import type { NfeActor, NfeDeps } from '../nfe/transmission'
import { emitterFromParty, type VoidDeps } from '../nfe/void-range'

/**
 * A peça de MONTAGEM das dependências da NF-e (NFE.E6.P4 mudança 1; ficha §6-1): sai de `invoices.service.ts` para que as rotas da nota, do estabelecimento (rodízio),
 * da numeração e da inutilização montem as dependências do MESMO jeito. A regra mora em `src/nfe`; aqui só se liga o `AppContext` (pool, anel de chaves, arquivo fiscal, CA do
 * servidor, responsável técnico e o disjuntor UNICO do processo) às portas que a regra pede. Nada aqui fala com o fisco: o transporte é o do `callSoap` (o `request` real só entra
 * sem injeção).
 */

export const actorOf = (inst: InstitutionPayload): NfeActor => ({ institutionId: inst.institutionId, schemaName: inst.schemaName, userId: inst.userId })

/** As dependências (montadas por chamada: nada de estado de controle — o único estado é o `Breaker` do contexto, um por processo). */
export function nfeDepsOf(ctx: AppContext, now: () => Date = () => new Date()): NfeDeps & ReconcileDeps {
  return {
    pool: ctx.pool, storage: ctx.storage, now, breaker: ctx.breaker,
    openIssuer: (conn, actor) => openIssuer({ pool: ctx.pool, keyring: ctx.keyring }, actor.institutionId, '55', { conn, forUpdate: true, schemaName: actor.schemaName }),
    readFacts: (q, actor, ref, environment) => readComposedFacts(q, { storage: ctx.storage, techResponsible: ctx.technicalResponsible }, actor, ref, environment),
    zoneOf: (q, actor) => erp.institutionZone(q, actor.schemaName, actor.institutionId),
    establishmentCnpj: (q, actor) => erp.establishmentCnpj(q, actor.institutionId),
    credentialsFor: async (q, actor, scope) => {
      const required = await requiredFiscalCredentialsFor(q, { state: scope.uf, model: '55', environment: scope.environment, at: scope.at, institutionId: actor.institutionId })
      if (required.length === 0) return null                                      // a UF × modelo × ambiente não exige código
      if (required.length > 1) throw documentInvalid('A UF exige mais de um código fiscal — fora do 1º release', [{ field: 'infRespTec', message: 'Mais de uma credencial exigida' }])
      return { codeId: required[0].codeId, codeValue: required[0].codeValue }
    },
    ca: () => ctx.serverCa.pem as never,
  }
}

/** Mais o emitente SEM nota (a inutilização é ato sobre a numeração): o estabelecimento é a entidade de mesmo id (`readEmitter`), a UF é a do endereço principal. */
export function voidDepsOf(ctx: AppContext, now: () => Date = () => new Date()): VoidDeps {
  return { ...nfeDepsOf(ctx, now), emitterOf: async (q, actor) => emitterFromParty(await readEmitter(q, actor.schemaName, actor.institutionId)) }
}
