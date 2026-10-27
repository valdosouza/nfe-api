import {
  HttpError, ErrorCodes, InstitutionPayload, IssuerModel, erp, IssuerCertificateStatus, EmitterActor, EmitterView, IssuerItemView,
  emitterView, writeIssuer, deleteIssuer, uploadCertificate, deleteCertificate, modelsOf,
} from 'fiscal-api'
import type { AppContext } from '../../context'
import type { IssuerDto, CertificateDto } from './emitter.dto'

/**
 * Emitente do estabelecimento na nfe-api = o EMITTER do núcleo (D-NE9 — parte 2 da NE-1a) montado para a família de MERCADORIA: a
 * política (trava das linhas da habilitação, cerca do A1 no grão do estabelecimento, vivas da família na habilitação, vivas de TODAS as
 * famílias no DELETE do A1) mora no núcleo; aqui fica a borda — o DTO (só o ambiente) e a recusa do modelo que não é desta onda.
 */

export type { EmitterView, IssuerItemView }

const BRANCH = 'merchandise' as const
/**
 * D-NE2 (F4 = só o 55; a NFC-e 65 é da F5) + D-NE166: a NE-2 habilita só o 55. O 65 está no domínio da habilitação do núcleo
 * (`modelsOf('merchandise')` = 55/65), mas nenhuma peça desta API o serve ainda — habilitá-lo aqui seria prometer o que a F5 ainda não
 * decidiu. Ampliar = decisão (entrada na F5), nunca "só tirar o filtro".
 */
export const SERVED_MODELS = Object.freeze(['55'] as const satisfies readonly IssuerModel[])

const actorOf = (inst: InstitutionPayload): EmitterActor => ({ institutionId: inst.institutionId, userId: inst.userId, schemaName: inst.schemaName })

export async function fetchEmitter(ctx: AppContext, inst: InstitutionPayload): Promise<EmitterView> {
  return emitterView(ctx, inst.institutionId, BRANCH)
}

/** O que do parâmetro volta na mensagem: CORTADO e sem caractere de controle (gate adversarial da NE-2 — o eco de 3.000 posições/`%0A` não é diagnóstico). */
const shown = (raw: string): string => { const s = String(raw).replace(/[^\x20-\x7E]/g, '?'); return s.length > 12 ? `${s.slice(0, 12)}…` : s }

function assertModel(model: string): IssuerModel {
  const mine = SERVED_MODELS.find(m => m === model)
  if (!mine) {
    const why = model === 'SE' ? 'o SE é da nfse-api' : (modelsOf(BRANCH) as readonly string[]).includes(model) ? 'o 65 vem com a F5 (D-NE2)' : 'modelo fora do domínio'
    throw new HttpError(422, `A nfe-api habilita só o modelo 55 (recebido ${shown(model)}) — ${why}`,
      [{ field: 'model', message: 'Modelo não suportado nesta API' }], ErrorCodes.FISCAL_MODEL_NOT_SUPPORTED)
  }
  return mine
}

export async function saveIssuer(ctx: AppContext, inst: InstitutionPayload, modelRaw: string, input: IssuerDto): Promise<EmitterView> {
  const model = assertModel(modelRaw)
  // D-F21/D-NE11: a série é do ERP — a habilitação do 55 guarda só o ambiente (`serie` NULL por construção, nunca lida do corpo)
  await writeIssuer(ctx, actorOf(inst), model, { environment: input.environment, serie: null })
  return fetchEmitter(ctx, inst)
}

export async function removeIssuer(ctx: AppContext, inst: InstitutionPayload, modelRaw: string): Promise<EmitterView> {
  const model = assertModel(modelRaw)
  await deleteIssuer(ctx, actorOf(inst), model)
  return fetchEmitter(ctx, inst)
}

export async function saveCertificate(ctx: AppContext, inst: InstitutionPayload, input: CertificateDto): Promise<IssuerCertificateStatus> {
  // D-N29/D-CJ2 (a MESMA borda da nfse-api): o A1 tem que ser do CNPJ do emitente — o FATO em três estados chega à conferência; o caminho
  // feliz faz UMA leitura (o CNPJ válido) e o fato só é lido quando falta ou está errado, para dizer qual dos dois
  const expectedCnpj = (await erp.establishmentCnpj(ctx.pool, inst.institutionId)) ?? await erp.establishmentCnpjFact(ctx.pool, inst.institutionId)
  return uploadCertificate(ctx, actorOf(inst), input, { expectedCnpj })
}

export async function removeCertificate(ctx: AppContext, inst: InstitutionPayload): Promise<IssuerCertificateStatus> {
  return deleteCertificate(ctx, actorOf(inst))
}
