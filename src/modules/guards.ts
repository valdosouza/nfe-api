import { HttpError, ErrorCodes, InstitutionPayload, InvoiceRef, isAdmin, erp, access } from 'fiscal-api'
import type { AppContext } from '../context'

/**
 * Guardas da borda da nfe-api (molde: `nfse-api/src/modules/guards.ts`). Na NE-2 só o emitente é servido (D-NE166) — o privilégio do RAMO
 * (TRANSMITIR/CANCELAR na interface `orders`/`order-returns` — D-F13/D-F14/D-F46) e o escopo da passada chegam com as rotas da NE-5,
 * lendo a fonte de fatos (`erp.*` do núcleo). Nada aqui sem consumidor.
 *
 * D-NE10: SEM cerca da virada — o 55 nasce na nfe-api (não há réplica do ERP para ele). O A1 é comum: a cerca do estabelecimento é a
 * 1ª instrução do próprio emitter do núcleo (`assertCertificateWritable`), não uma guarda da borda.
 */

/**
 * Emitente (A1 + habilitação) é ato do ADMIN do estabelecimento (adminGuard do produto) — pelo PERFIL VIVO (ACESSO.E1.P1, D-AU3/D-AU19):
 * o `role` que `isAdmin` lê é o que o [check] do `productAuth` (`access.liveIdentity`, em `app.ts`) pôs no payload; o do token nunca chega
 * aqui (o verificador entrega `role: ''` desde o núcleo 3.0.0 — sem a sessão viva, ninguém é admin).
 */
export function requireAdmin(inst: InstitutionPayload): void {
  if (!isAdmin(inst)) throw new HttpError(403, 'Ação exclusiva do administrador do estabelecimento', undefined, ErrorCodes.ADMIN_REQUIRED)
}

/**
 * Autorização de AÇÃO na porta fiscal (NFE.E6.P1 mudança 10 — D-F13/D-F14/D-F37/D-PV40; molde `nfse-api/src/modules/guards.ts`): a REGRA é do ERP (privilégio na interface do
 * RAMO da nota — a interface vem da view de política `vw_order_interface`, lida pelo núcleo) e a nfe-api a APLICA. Licença antes do privilégio (a ordem do diagnóstico mora na
 * biblioteca `access`): 403 `INTERFACE_NOT_ALLOWED` (ramo não contratado — vale também para o admin) × 403 `PRIVILEGE_REQUIRED`. O privilégio é citado pelo NOME do verbo
 * (D-PV49/D-PV53 — nenhum número de privilégio nas APIs fiscais): TRANSMITIR para transmitir e reconfirmar, CONSULTAR para consultar (D-PV40: consultar ≠ transmitir).
 */
export async function requireBranchPrivilege(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef, privilege: access.PrivilegeName): Promise<void> {
  const key = await erp.orderInterface(ctx.pool, inst.schemaName, ref)
  const verdict = await access.accessVerdict(ctx.pool, inst, [key], privilege)
  if (verdict === 'not-contracted') throw new HttpError(403, `Interface ${key} não contratada para este estabelecimento`, undefined, ErrorCodes.INTERFACE_NOT_ALLOWED)
  if (verdict === 'no-privilege') throw new HttpError(403, `Privilégio necessário para esta ação na interface ${key}`, undefined, ErrorCodes.PRIVILEGE_REQUIRED)
}

/** Leitura: a interface do ramo tem de estar ao ALCANCE (contratada; o super vê todas — A-PV1). */
export async function requireBranchInterface(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef): Promise<void> {
  const key = await erp.orderInterface(ctx.pool, inst.schemaName, ref)
  if ((await access.reachableKeys(ctx.pool, inst, [key])).length === 0) {
    throw new HttpError(403, `Interface ${key} não contratada para este estabelecimento`, undefined, ErrorCodes.INTERFACE_NOT_ALLOWED)
  }
}

/** id de rota: inteiro positivo, senão 400. */
export function parseInvoiceId(raw: string): number {
  const id = Number(raw)
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(400, 'invoiceId inválido', [{ field: 'invoiceId', message: 'Informe um id (inteiro positivo)' }], ErrorCodes.INVALID_ID)
  }
  return id
}
