/**
 * NFE.E5.P2.T2 — UMA peça deriva o nItem (D-NE103, D-NE220; RF-NFE-31 — rej. 927). Os casos são os do vetor proposto
 * `nfe-nitem.json` (ficha-nfe-e5-p2-fonte-de-fatos-mercadoria.md §4 e §6-2).
 */
import fs from 'fs'
import path from 'path'
import { ItemNumberingError, NFE_MAX_ITEMS, numberItems } from '../nfe/item-numbering'

const code = (fn: () => unknown): unknown => {
  try { fn() } catch (e) { return e instanceof ItemNumberingError ? { code: e.code, itemIds: e.itemIds } : e }
  return 'não recusou'
}

describe('nItem — a peça única (RF-NFE-31)', () => {
  it('ids 10, 20, 30 → nItem 1, 2, 3, consecutivo a partir de 1', () => {
    expect(numberItems([10, 20, 30]).items).toEqual([{ itemId: 10, nItem: 1 }, { itemId: 20, nItem: 2 }, { itemId: 30, nItem: 3 }])
  })

  it('a ordem de entrada não muda o resultado: vale a ordem do id (D-NE103)', () => {
    expect(numberItems([30, 10, 20]).items).toEqual(numberItems([10, 20, 30]).items)
    expect(numberItems([2, 10, 1]).items.map(i => i.itemId)).toEqual([1, 2, 10])        // ordem numérica, não de texto
  })

  it('buraco no id (item excluído ou serviço da conjugada fora da lista) → continua consecutivo', () => {
    const n = numberItems([10, 30])                                                     // o id 20 era serviço: quem chama não o entrega
    expect(n.items).toEqual([{ itemId: 10, nItem: 1 }, { itemId: 30, nItem: 2 }])
    expect(n.nItemOf(30)).toBe(2)
    expect(n.nItemOf(20)).toBeUndefined()
  })

  it('nItemOf serve à devolução: o nItem do item de origem pelo id; id ausente = undefined', () => {
    const n = numberItems([7, 3, 5])
    expect([n.nItemOf(3), n.nItemOf(5), n.nItemOf(7), n.nItemOf(4)]).toEqual([1, 2, 3, undefined])
  })

  it('o teto de 990 é da camada 1 (NFE.E5.P5): a peça numera 990 e 991 e só exporta o limite', () => {
    expect(NFE_MAX_ITEMS).toBe(990)
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
    expect(numberItems(ids(990)).items[989]).toEqual({ itemId: 990, nItem: 990 })
    expect(numberItems(ids(991)).items[990]).toEqual({ itemId: 991, nItem: 991 })
  })

  it('recusa o que deixaria a numeração indefinida: lista vazia, id repetido (D-NE220), id que não é inteiro positivo', () => {
    expect(code(() => numberItems([]))).toEqual({ code: 'EMPTY', itemIds: [] })
    expect(code(() => numberItems([10, 20, 10, 20, 30]))).toEqual({ code: 'DUPLICATE_ID', itemIds: [10, 20] })
    expect(code(() => numberItems([1, 0, -2, 1.5, NaN]))).toEqual({ code: 'INVALID_ID', itemIds: [0, -2, 1.5, NaN] })
  })

  it('o resultado é imutável e a entrada não é alterada', () => {
    const input = [3, 1, 2]
    const n = numberItems(input)
    expect(input).toEqual([3, 1, 2])
    expect(Object.isFrozen(n)).toBe(true)
    expect(Object.isFrozen(n.items)).toBe(true)
    expect(Object.isFrozen(n.items[0])).toBe(true)
  })
})

describe('CERCA — uma peça só: nenhum outro arquivo de src/ atribui nItem', () => {
  const src = path.resolve(__dirname, '..')
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === '__tests__' ? [] : files(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : [])
  const clean = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  const ASSIGNS = /\bnItem\s*(?::(?!\s*(?:number|string)\b)|=(?!=))/      // chave de objeto `nItem: valor` ou atribuição `nItem =`; o TIPO `nItem: number` não conta

  it('a regex pega a atribuição e deixa passar o tipo e a leitura', () => {
    expect(['{ nItem: i + 1 }', 'x.nItem = 3', 'nItem=1'].map(s => ASSIGNS.test(s))).toEqual([true, true, true])
    expect(['readonly nItem: number', 'it.nItem === 2', 'n.nItemOf(3)', 'det[nItem]'].map(s => ASSIGNS.test(s))).toEqual([false, false, false, false])
  })

  it('só src/nfe/item-numbering.ts atribui', () => {
    const offenders = files(src).filter(f => ASSIGNS.test(clean(f))).map(f => path.relative(src, f).replace(/\\/g, '/'))
    expect(offenders).toEqual(['nfe/item-numbering.ts'])
  })
})
