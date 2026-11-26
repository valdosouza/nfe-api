import nodemailer from 'nodemailer'
import { HttpError, logger, openSmtpCredential, type MasterKeyRing, type OpenedSmtpCredential, type Pool } from 'fiscal-api'

/**
 * O envio pela conta do CONTRIBUINTE (NFE.E6.P4 mudança 6; D-NE236; parecer do `setes-conceito`: uma peça por conta — a da plataforma é `ops-alert.ts`). O núcleo 5.3.0 GUARDA a conta; quem ENVIA é
 * a família. A senha existe em claro SÓ no retorno de `openSmtpCredential` (a ÚNICA leitura, para UM envio): vai ao transporte e daqui não sai — nem em log, nem em erro, nem em resposta. Esta peça
 * é o ÚNICO arquivo que a abre (cerca `deploy-e1-p13.test.ts`). Servidor sem criptografia não existe (`security` é `tls` ou `starttls`); a porta é dado da conta (nunca derivada).
 * Nada de rede nos testes: o transporte é injetável (`createTransport`).
 */

export interface OutgoingMail {
  readonly to: readonly string[]
  readonly subject: string
  readonly text: string
  readonly attachments: readonly { readonly filename: string; readonly content: string | Buffer; readonly contentType: string }[]
}
export interface MailTransport { sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }> }
export interface ClientMailerDeps {
  readonly pool: Pool
  readonly keyring: MasterKeyRing
  /** Injetável: os testes nunca abrem conexão. */
  readonly createTransport?: (account: OpenedSmtpCredential) => MailTransport
}

/** O transporte real: TLS implícito (`tls`) ou STARTTLS exigido (`starttls` — nunca cai para texto), prazos curtos, TLS 1.2 no mínimo. */
export function realTransport(account: OpenedSmtpCredential): MailTransport {
  return nodemailer.createTransport({
    host: account.host, port: account.port, secure: account.security === 'tls', requireTLS: account.security === 'starttls',
    auth: { user: account.username, pass: account.password }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000, tls: { minVersion: 'TLSv1.2' },
  }) as unknown as MailTransport
}

export interface SentMail { readonly messageId: string | null; readonly from: string }

/** Abre a conta do estabelecimento, envia e esquece. Sem conta = 409 `SMTP_CREDENTIAL_MISSING`, ilegível = 409 `SMTP_CREDENTIAL_UNREADABLE`, chave-mestra ausente = 503 (do núcleo). Falha do servidor = 502 `FISCAL_EMAIL_SEND_FAILED` sem eco do servidor. */
export async function sendThroughClientAccount(deps: ClientMailerDeps, institutionId: number, mail: OutgoingMail): Promise<SentMail> {
  const account = await openSmtpCredential({ pool: deps.pool, keyring: deps.keyring }, institutionId)
  const transport = (deps.createTransport ?? realTransport)(account)
  try {
    const info = await transport.sendMail({
      from: account.senderAddress, to: [...mail.to], subject: mail.subject, text: mail.text,
      attachments: mail.attachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    })
    return { messageId: info?.messageId ? String(info.messageId) : null, from: account.senderAddress }
  } catch (e) {
    // só o CÓDIGO técnico vai ao log e à resposta: o texto do servidor pode ecoar usuário e endereços
    const code = String((e as { code?: unknown } | null)?.code ?? 'UNKNOWN')
    logger.warn('E-mail da NF-e não enviado pela conta do estabelecimento', { institutionId, code })
    throw new HttpError(502, 'O servidor de e-mail do estabelecimento recusou ou não respondeu — a nota segue autorizada; tente de novo ou confira a conta de envio', [{ field: 'smtp', message: code }], MAIL_SEND_FAILED)
  }
}

export const MAIL_SEND_FAILED = 'FISCAL_EMAIL_SEND_FAILED'
