import { HttpError, ErrorCodes, InstitutionPayload, isAdmin } from 'fiscal-api'

/**
 * Guardas da borda da nfe-api (molde: `nfse-api/src/modules/guards.ts`). Na NE-2 só o emitente é servido (D-NE166) — o privilégio do RAMO
 * (TRANSMITIR/CANCELAR na interface `orders`/`order-returns` — D-F13/D-F14/D-F46) e o escopo da passada chegam com as rotas da NE-5,
 * lendo a fonte de fatos (`erp.*` do núcleo). Nada aqui sem consumidor.
 *
 * D-NE10: SEM cerca da virada — o 55 nasce na nfe-api (não há réplica do ERP para ele). O A1 é comum: a cerca do estabelecimento é a
 * 1ª instrução do próprio emitter do núcleo (`assertCertificateWritable`), não uma guarda da borda.
 */

/** Emitente (A1 + habilitação) é ato do ADMIN do estabelecimento (adminGuard do produto). */
export function requireAdmin(inst: InstitutionPayload): void {
  if (!isAdmin(inst)) throw new HttpError(403, 'Ação exclusiva do administrador do estabelecimento', undefined, ErrorCodes.ADMIN_REQUIRED)
}
