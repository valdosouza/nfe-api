import nodemailer from 'nodemailer'
import { logger } from 'fiscal-api'
import type { MailTransport } from './client-mailer'

/**
 * O alerta de PENDÊNCIA CRÍTICA ao suporte da Setes (NFE.E6.P4 mudança 7; D-NE54, D-NE237; parecer do `setes-conceito`: uma peça por conta — a do contribuinte é `client-mailer.ts`). Sai pelo SMTP da
 * SETES, a conta da plataforma, em variáveis do `.env` da nfe-api (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`), para o `OPS_ALERT_EMAIL`. Nada do conteúdo da nota entra: só o
 * estabelecimento, a nota, a chave de acesso e o CÓDIGO da pendência. Em PRODUÇÃO o boot recusa subir sem as seis variáveis (S-10, molde do setes-api D-RS5); fora dela, sem SMTP o alerta vai só ao log.
 * Falha do envio vai ao log com o código técnico e NUNCA derruba a operação que a causou (efeito pós-fato). O valor das variáveis nunca vai a log, a erro nem a resposta.
 */

export const OPS_ALERT_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'OPS_ALERT_EMAIL'] as const
export type OpsAlert = (subject: string, text: string) => Promise<void>

/** Produção = `NODE_ENV=production`, normalizado (espaços e caixa) — a mesma leitura do setes-api. */
export const isProduction = (env: NodeJS.ProcessEnv): boolean => String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production'

const present = (env: NodeJS.ProcessEnv, name: string): boolean => String(env[name] ?? '').trim() !== ''

/** As variáveis que faltam (os NOMES, nunca os valores). */
export const missingOpsAlertVars = (env: NodeJS.ProcessEnv): string[] => OPS_ALERT_VARS.filter(n => !present(env, n))

/**
 * A conferência do boot: em produção, faltar qualquer das seis recusa subir (diz os nomes que faltam); a porta tem de ser um inteiro de 1 a 65535. Fora de produção devolve o estado em texto
 * (configurado, ou "só no log"), sem valor nenhum.
 */
export function assertOpsAlertConfigured(env: NodeJS.ProcessEnv): string {
  const missing = missingOpsAlertVars(env)
  const port = Number(env.SMTP_PORT)
  const badPort = present(env, 'SMTP_PORT') && !(Number.isInteger(port) && port >= 1 && port <= 65535)
  if (isProduction(env)) {
    if (missing.length > 0) throw new Error(`Alerta ao suporte (D-NE237): em produção faltam as variáveis ${missing.join(', ')}`)
    if (badPort) throw new Error('Alerta ao suporte (D-NE237): SMTP_PORT fora de 1 a 65535')
    return 'configurado (produção)'
  }
  if (missing.length === OPS_ALERT_VARS.length) return 'não configurado (fora de produção: o alerta vai só ao log)'
  if (missing.length > 0 || badPort) logger.warn(`Alerta ao suporte: configuração incompleta (faltam ${missing.join(', ') || '—'}) — fora de produção o alerta vai só ao log`)
  return missing.length === 0 && !badPort ? 'configurado' : 'incompleto (só no log)'
}

/** O transporte real: porta 465 = TLS implícito; qualquer outra = STARTTLS exigido (nunca texto puro); prazos curtos. */
export function realOpsTransport(env: NodeJS.ProcessEnv): MailTransport {
  const port = Number(env.SMTP_PORT)
  return nodemailer.createTransport({
    host: String(env.SMTP_HOST).trim(), port, secure: port === 465, requireTLS: port !== 465,
    auth: { user: String(env.SMTP_USER), pass: String(env.SMTP_PASSWORD) }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000, tls: { minVersion: 'TLSv1.2' },
  }) as unknown as MailTransport
}

/** O emissor do alerta (montado UMA vez no boot). Sem configuração completa: log. Nunca lança. */
export function createOpsAlert(env: NodeJS.ProcessEnv, createTransport: (env: NodeJS.ProcessEnv) => MailTransport = realOpsTransport): OpsAlert {
  return async (subject, text) => {
    if (missingOpsAlertVars(env).length > 0) { logger.warn(`ALERTA (sem SMTP da Setes): ${subject}`, { text }); return }
    try {
      await createTransport(env).sendMail({ from: String(env.SMTP_FROM).trim(), to: String(env.OPS_ALERT_EMAIL).trim(), subject, text })
    } catch (e) {
      logger.warn('Alerta ao suporte não enviado', { code: String((e as { code?: unknown } | null)?.code ?? 'UNKNOWN'), subject })
    }
  }
}

export interface IncidentAlert { readonly route: string; readonly institutionId: number; readonly invoiceId: number | null; readonly accessKey: string | null; readonly incident: string }

/** O texto do alerta: só ids, a chave de acesso e o código da pendência — nada do documento, nada de segredo. */
export function incidentAlertMessage(a: IncidentAlert): { subject: string; text: string } {
  return {
    subject: `[nfe-api] pendência crítica: ${a.incident}`,
    text: ['Pendência crítica na NF-e (D-NE54).', '', `Pendência: ${a.incident}`, `Rota: ${a.route}`, `Estabelecimento: ${a.institutionId}`, `Nota: ${a.invoiceId ?? '—'}`, `Chave de acesso: ${a.accessKey ?? '—'}`,
      '', 'Veja o log da nfe-api com a chave acima; a nota não foi alterada pela pendência.'].join('\n'),
  }
}

/** Dispara o alerta SEM esperar e sem poder falhar a operação que o causou (a pendência já está gravada e no log). Sem emissor no contexto (testes), nada. */
export function reportIncident(ctx: { readonly opsAlert?: OpsAlert }, a: IncidentAlert): void {
  if (!ctx.opsAlert) return
  const m = incidentAlertMessage(a)
  void ctx.opsAlert(m.subject, m.text).catch(() => undefined)
}
