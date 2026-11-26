import { clearSmtpCredential, smtpCredentialStatus, storeSmtpCredential, type InstitutionPayload, type SmtpCredentialStatus } from 'fiscal-api'
import type { AppContext } from '../../context'
import type { SmtpCredentialDto } from './smtp-credential.dto'

/**
 * A conta de envio de e-mail do ESTABELECIMENTO (NFE.E6.P4 mudança 6; S-2; D-NE236; parecer do `setes-conceito` de 2026-11-26): a nfe-api é a dona do ato (cadastro do contribuinte, não da NF-e) e usa SÓ
 * as três peças de cadastro do núcleo 5.3.0. A SENHA é write-only: entra em `storeSmtpCredential` e nunca volta — nem na resposta de gravar, nem na situação, nem em log. Quem ABRE a senha é só o
 * envio (`src/mail/client-mailer.ts`); a cerca de `deploy-e1-p13.test.ts` fecha cada arquivo nas peças dele. A conta não é do modelo 55: não passa por `SERVED_MODELS` nem pelo CNPJ do emitente.
 */

export async function saveSendingAccount(ctx: AppContext, inst: InstitutionPayload, input: SmtpCredentialDto): Promise<SmtpCredentialStatus> {
  return storeSmtpCredential({ pool: ctx.pool, keyring: ctx.keyring }, inst.institutionId, { ...input, userId: inst.userId })
}

export async function getSendingAccountStatus(ctx: AppContext, inst: InstitutionPayload): Promise<SmtpCredentialStatus> {
  return smtpCredentialStatus(ctx.pool, inst.institutionId)
}

/** Apaga a conta (a cifra vira NULL); devolve a situação depois — `configured: false`. */
export async function removeSendingAccount(ctx: AppContext, inst: InstitutionPayload): Promise<SmtpCredentialStatus> {
  await clearSmtpCredential({ pool: ctx.pool }, inst.institutionId, inst.userId)
  return smtpCredentialStatus(ctx.pool, inst.institutionId)
}
