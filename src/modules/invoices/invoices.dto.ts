import { z } from 'zod'

/** `POST …/cancel`: o motivo (`xJust` do evento, TJust 15–255 — CONFERENCIAS 6). `strict()` = o `additionalProperties` do contrato: campo a mais é 400, nunca ignorado em silêncio. */
export const cancelDto = z.object({
  reason: z.string().min(15).max(255),
}).strict()
export type CancelDto = z.infer<typeof cancelDto>
