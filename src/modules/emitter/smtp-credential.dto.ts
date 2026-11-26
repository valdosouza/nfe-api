import { z } from 'zod'

/**
 * A conta de envio do estabelecimento (D-NE236). `strict()` = o `additionalProperties: false` do contrato. A FORMA fina (host sem esquema, remetente com `@`, tamanho da senha em bytes) é conferida pelo
 * núcleo (a gravação do núcleo devolve 422 com os campos); aqui só o formato do JSON. Não existe `security` "sem cifra": a senha do cliente nunca trafega em claro.
 */
export const smtpCredentialDto = z.object({
  host:          z.string().min(1).max(255),
  port:          z.number().int().min(1).max(65535),
  security:      z.enum(['tls', 'starttls']),
  username:      z.string().min(1).max(255),
  senderAddress: z.string().min(3).max(254),
  password:      z.string().min(1).max(512),
}).strict()

export type SmtpCredentialDto = z.infer<typeof smtpCredentialDto>
