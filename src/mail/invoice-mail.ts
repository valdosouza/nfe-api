import { HttpError, logger, type InstitutionPayload, type InvoiceRef } from 'fiscal-api'
import type { AuthorizedEvent } from '../nfe/authorized-hook'
import { DEFAULT_MAIL_SUBJECT, readMailConfig } from '../facts/nfe-lists'
import type { AppContext } from '../context'
import { NfeErrors } from '../nfe/errors'
import * as invoices from '../modules/invoices/invoices.service'
import { sendThroughClientAccount, type ClientMailerDeps, type OutgoingMail, type SentMail } from './client-mailer'

/**
 * O e-mail da NF-e ao destinatário (NFE.E6.P4 mudança 6; D-NE53, D-NE261, D-NE264; RF-NFE-43): anexa o XML da VOZ com protocolo (`procNFe`, e o `procEventoNFe` se cancelada) e o DANFE (PDF). As DUAS
 * vias — o botão (`POST …/email`) e o automático depois da autorização (mudança 7) — usam a MESMA composição e o MESMO leitor de destinatário (S-3); só o gatilho muda. Assunto = configuração da
 * empresa (`nfe_email_subject`, com `{number}`); corpo = o texto padrão fixo, igual para todas as empresas (D-NE264). Nada é inventado: os anexos são os arquivos guardados (N10) e o DANFE sai do
 * mesmo arquivo; o e-mail não é obrigação fiscal (RF-NFE-43), é entrega ao destinatário.
 */

export const MAIL_BODY = (n: { number: number; serie: number; accessKey: string }): string => [
  'Prezado(a),',
  '',
  `Segue a NF-e nº ${n.number}, série ${n.serie}, chave de acesso ${n.accessKey}.`,
  'Em anexo estão o arquivo XML da nota (o documento fiscal eletrônico, com o protocolo de autorização) e o DANFE em PDF.',
  'Guarde o arquivo XML: ele é o documento fiscal.',
  '',
  'Esta é uma mensagem enviada pelo sistema de emissão de notas do emitente.',
].join('\n')

/** `{number}` do assunto = o número da nota; nenhum outro marcador existe (texto da empresa nunca é interpretado além disso). */
export const subjectOf = (template: string, number: number): string => (template.trim() === '' ? DEFAULT_MAIL_SUBJECT : template).split('{number}').join(String(number)).slice(0, 255).replace(/[\r\n]+/g, ' ')

export interface ComposedMail { readonly mail: Omit<OutgoingMail, 'to'>; readonly accessKey: string; readonly number: number; readonly serie: number; readonly autoSend: boolean }

/** Monta o e-mail da nota autorizada (ou cancelada: o DANFE leva o carimbo). Nota sem autorização = 409 `FISCAL_NOT_AUTHORIZED` (dos leitores de arquivo); arquivo que falta = 409 `FISCAL_FILE_MISSING`. */
export async function composeInvoiceMail(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef): Promise<ComposedMail> {
  const x = await invoices.xml(ctx, inst, ref)
  const d = await invoices.danfe(ctx, inst, ref)
  const number = Number(x.accessKey.slice(25, 34)), serie = Number(x.accessKey.slice(22, 25))
  const config = await readMailConfig(ctx.pool, inst.schemaName, inst.institutionId)
  const attachments: Omit<OutgoingMail, 'to'>['attachments'][number][] = [
    { filename: `${x.accessKey}-procNFe.xml`, content: x.procNFe, contentType: 'application/xml' },
    { filename: `DANFE-${x.accessKey}.pdf`, content: Buffer.from(d.pdfBase64, 'base64'), contentType: 'application/pdf' },
  ]
  if (x.cancelEvent !== null) attachments.push({ filename: `${x.accessKey}-evt110111-proc.xml`, content: x.cancelEvent, contentType: 'application/xml' })
  return { mail: { subject: subjectOf(config.subject, number), text: MAIL_BODY({ number, serie, accessKey: x.accessKey }), attachments }, accessKey: x.accessKey, number, serie, autoSend: config.autoSend }
}

/** O teto de destinos do contrato. */
export const MAX_RECIPIENTS = 5

/**
 * Os destinatários: o `to` do pedido (já validado). O e-mail do CADASTRO do destinatário ainda NÃO é lido: as tabelas dele (`tb_entity_has_mailing`, `tb_mailing`) não têm GRANT para o `fiscal_api`
 * (D-AU12 — o GRANT mora no `nfse-api/ops/grants.sql` e é ato do Valdo no banco); o leitor pronto está nas notas da sessão e entra com o GRANT (bloqueante registrado). Sem `to` = 422
 * `FISCAL_RECIPIENT_EMAIL_MISSING` e nada é enviado.
 */
export async function recipientsOf(_ctx: AppContext, _inst: InstitutionPayload, _ref: InvoiceRef, requested?: readonly string[]): Promise<string[]> {
  const to = requested && requested.length > 0 ? [...new Set(requested)].slice(0, MAX_RECIPIENTS) : []
  if (to.length === 0) throw new HttpError(422, 'Informe o e-mail de destino: a leitura do e-mail do destinatário no cadastro ainda não está liberada', [{ field: 'to', message: 'Informe ao menos um e-mail' }], NfeErrors.RECIPIENT_EMAIL_MISSING)
  return to
}

export interface EmailResponse { readonly accessKey: string; readonly to: readonly string[]; readonly messageId: string | null }

/** A VIA MANUAL (o botão): ato explícito do usuário. A conta é a do estabelecimento (núcleo); os erros da conta são os do núcleo (409 `SMTP_CREDENTIAL_MISSING`/`_UNREADABLE`, 503 sem chave-mestra). */
export async function sendInvoiceEmail(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef, requestedTo: readonly string[] | undefined, deps: Pick<ClientMailerDeps, 'createTransport'> = {}): Promise<EmailResponse> {
  const composed = await composeInvoiceMail(ctx, inst, ref)
  const to = await recipientsOf(ctx, inst, ref, requestedTo)
  const sent: SentMail = await sendThroughClientAccount({ pool: ctx.pool, keyring: ctx.keyring, ...deps }, inst.institutionId, { ...composed.mail, to })
  return { accessKey: composed.accessKey, to, messageId: sent.messageId }
}


/** De onde vêm os destinos do cadastro do destinatário: porta injetável. Hoje NÃO há leitor (as tabelas do e-mail do cadastro não têm GRANT — bloqueante registrado), então a via automática só envia com destino. */
export type RecipientsReader = (ctx: AppContext, who: Pick<InstitutionPayload, 'institutionId' | 'schemaName'>, ref: InvoiceRef) => Promise<string[]>
export const NO_CADASTRO_READER: RecipientsReader = async () => []

export type AutoMailResult = 'sent' | 'off' | 'no-recipient' | 'failed'

/**
 * A VIA AUTOMÁTICA (D-NE261): depois de a nota passar a autorizada, envia o e-mail quando a opção da empresa está ligada (`fiscal_email_auto_send`, padrão 'S'), com a MESMA composição e o MESMO leitor
 * de destinatário do botão. NUNCA lança e nunca desfaz o A: a falha vai ao log com o código técnico (sem conteúdo, sem endereço, sem senha). Sem destinatário no cadastro, nada é enviado (a via manual segue
 * valendo). Não há fato de "e-mail enviado" no 1º release: o disparo é só de quem GRAVOU a voz A (`authorized-hook.ts`).
 */
export async function autoSendAfterAuthorization(ctx: AppContext, e: AuthorizedEvent, deps: Pick<ClientMailerDeps, 'createTransport'> & { recipients?: RecipientsReader } = {}): Promise<AutoMailResult> {
  try {
    const who = { institutionId: e.actor.institutionId, schemaName: e.actor.schemaName }
    const composed = await composeInvoiceMail(ctx, who as InstitutionPayload, e.ref)
    if (!composed.autoSend) return 'off'
    const to = (await (deps.recipients ?? NO_CADASTRO_READER)(ctx, who, e.ref)).slice(0, MAX_RECIPIENTS)
    if (to.length === 0) { logger.info('E-mail automático da NF-e não enviado: sem destinatário no cadastro (a via manual segue valendo)', { accessKey: e.accessKey }); return 'no-recipient' }
    await sendThroughClientAccount({ pool: ctx.pool, keyring: ctx.keyring, createTransport: deps.createTransport }, e.actor.institutionId, { ...composed.mail, to })
    return 'sent'
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    logger.warn('E-mail automático da NF-e falhou; a nota segue autorizada', { accessKey: e.accessKey, error: typeof code === 'string' ? code : err instanceof Error ? err.name : 'erro' })
    return 'failed'
  }
}
