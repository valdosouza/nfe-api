import { z } from 'zod'

/**
 * Habilitação do modelo 55: SÓ o ambiente (D-F21/D-NE11 — a série e o número do 55 são do ERP, cunhados no faturamento; a coluna `serie`
 * da habilitação é só da SE). `strict()` = o `additionalProperties: false` do contrato: um corpo com `serie` é recusado com 400 — nunca
 * aceito e ignorado em silêncio (a série "configurada" aqui não valeria nada e enganaria quem configura).
 */
export const issuerDto = z.object({
  environment: z.enum(['H', 'P']),
}).strict()

/** Upload WRITE-ONLY do A1 (D-N5): o .pfx em base64 e a senha existem só nesta requisição. A MESMA regra da nfse-api (peça do núcleo). */
export const certificateDto = z.object({
  pfxBase64: z.string().min(1).max(64_000),
  password:  z.string().max(200),
})

export type IssuerDto = z.infer<typeof issuerDto>
export type CertificateDto = z.infer<typeof certificateDto>
