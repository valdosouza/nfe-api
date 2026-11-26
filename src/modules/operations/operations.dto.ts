import { z } from 'zod'

const serie = z.string().regex(/^(0|[1-9][0-9]{0,2})$/, 'Série de 0 a 999 (sem zeros à esquerda)')
const pageFields = {
  page:     z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}

/** `POST /v1/nfe/refresh`: o teto de notas da passada (contrato: 1 a 50). */
export const refreshRunDto = z.object({ limit: z.number().int().min(1).max(50).optional() }).strict()
/** `GET /v1/nfe/numbering`. */
export const numberingQueryDto = z.object({ serie, environment: z.enum(['H', 'P']).optional() })
/** `GET /v1/nfe/voids`. */
export const voidsQueryDto = z.object(pageFields)
/** `POST /v1/nfe/voids` (contrato: `additionalProperties: false`). */
export const voidDto = z.object({
  serie,
  year:   z.number().int().min(2000).max(2099).optional(),
  from:   z.number().int().min(1).max(999_999_999),
  to:     z.number().int().min(1).max(999_999_999),
  reason: z.string().min(15).max(255),
}).strict()

export type RefreshRunDto = z.infer<typeof refreshRunDto>
export type NumberingQueryDto = z.infer<typeof numberingQueryDto>
export type VoidsQueryDto = z.infer<typeof voidsQueryDto>
export type VoidDto = z.infer<typeof voidDto>
