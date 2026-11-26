import { z } from 'zod'

/** `POST …/cancel`: o motivo (`xJust` do evento, TJust 15–255 — CONFERENCIAS 6). `strict()` = o `additionalProperties` do contrato: campo a mais é 400, nunca ignorado em silêncio. */
export const cancelDto = z.object({
  reason: z.string().min(15).max(255),
}).strict()
export type CancelDto = z.infer<typeof cancelDto>

/** `GET …/pending`: página (o envelope paginado da casa) e o filtro do ramo. */
export const pendingQueryDto = z.object({
  page:         z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize:     z.coerce.number().int().min(1).max(100).default(25),
  interfaceKey: z.enum(['orders', 'order-returns']).optional(),
})
export type PendingQueryDto = z.infer<typeof pendingQueryDto>
