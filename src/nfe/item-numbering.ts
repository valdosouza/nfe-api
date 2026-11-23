/**
 * nItem — a ÚNICA peça que numera os itens da NF-e (D-NE103, D-NE188-4, D-NE220; RF-NFE-31 — MOC 7.00, H02-10: `det` de 1 a 990, nItem
 * consecutivo a partir de 1, rej. 927). Pura: os mesmos ids dão sempre a mesma numeração, em qualquer ordem de entrada.
 *
 * A ORDEM é a do id do item do pedido (D-NE103) — nunca a ordem da consulta nem o `kind` do produto (mudar a ordem muda o passado). O id é
 * único por pedido entre os `kind` (cerca no faturamento do ERP — D-NE220). Quem chama entrega SÓ os itens que vão ao `det`: os de mercadoria
 * com cálculo registrado (D-NE248); o serviço da nota conjugada fica fora, então o nItem é a POSIÇÃO entre as mercadorias, não o próprio id.
 *
 * Serve ao builder (o `det[nItem]`) e à devolução (o nItem do item de origem, pelo `nItemOf`). Nenhum outro arquivo atribui nItem — cerca em
 * `src/__tests__/item-numbering.test.ts`.
 *
 * O teto de 990 NÃO é aplicado aqui: a peça numera todos e a camada 1 (NFE.E5.P5) recusa a nota com mais itens que `NFE_MAX_ITEMS`
 * (prompt_onda_nfe_sefaz.md §22.2-3 d). Aqui só se recusa o que deixaria a numeração indefinida: lista vazia, id repetido e id que não é
 * inteiro positivo.
 */
export const NFE_MAX_ITEMS = 990

export type ItemNumberingErrorCode = 'EMPTY' | 'DUPLICATE_ID' | 'INVALID_ID'

export class ItemNumberingError extends Error {
  constructor(readonly code: ItemNumberingErrorCode, readonly itemIds: readonly number[]) {
    super(`nItem: ${code}${itemIds.length ? ` (${itemIds.join(', ')})` : ''}`)
    this.name = 'ItemNumberingError'
  }
}

export interface NumberedItem {
  readonly itemId: number
  readonly nItem: number
}

export interface ItemNumbering {
  /** Na ordem do nItem (1, 2, 3…). */
  readonly items: readonly NumberedItem[]
  /** O nItem de um id do pedido; `undefined` se o id não está na nota (item de serviço, excluído ou de outro pedido). */
  nItemOf(itemId: number): number | undefined
}

export function numberItems(itemIds: readonly number[]): ItemNumbering {
  if (itemIds.length === 0) throw new ItemNumberingError('EMPTY', [])
  const invalid = itemIds.filter(id => !Number.isSafeInteger(id) || id <= 0)
  if (invalid.length) throw new ItemNumberingError('INVALID_ID', invalid)
  const sorted = [...itemIds].sort((a, b) => a - b)
  const repeated = [...new Set(sorted.filter((id, i) => i > 0 && id === sorted[i - 1]))]
  if (repeated.length) throw new ItemNumberingError('DUPLICATE_ID', repeated)
  const items: readonly NumberedItem[] = Object.freeze(sorted.map((itemId, i) => Object.freeze({ itemId, nItem: i + 1 })))
  const byId = new Map(items.map(it => [it.itemId, it.nItem]))
  return Object.freeze({ items, nItemOf: (itemId: number) => byId.get(itemId) })
}
