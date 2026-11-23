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
  // `(?<!:)` — o `//` de uma URL dentro de texto não é comentário (gate adversarial: escondia o resto da linha).
  const clean = (f: string) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
  // Chave de objeto (`nItem: valor`, `'nItem': valor`), atribuição (`nItem =`, `+=`, `['nItem'] =`), declaração tipada com valor
  // (`nItem: number = 1`) e `nItem++`. O TIPO sozinho (`nItem: number`) e a leitura não contam. Limite conhecido: o shorthand `{ nItem }`,
  // a chave computada e outro nome (`nitem`) passam — a cerca pega o descuido, não a má-fé.
  const ASSIGNS = /\bnItem\b['"`]?\]?\s*(?::(?!\s*(?:number|string)\b(?!\s*=))|(?:[-+*/]|\?\?)?=(?!=)|\+\+|--)/

  it('a regex pega a atribuição e deixa passar o tipo e a leitura', () => {
    const caught = ['{ nItem: i + 1 }', 'x.nItem = 3', 'nItem=1', "{ 'nItem': 7 }", "o['nItem'] = 2", 'let nItem: number = 41', 'nItem++', 'nItem += 1']
    expect(caught.filter(s => !ASSIGNS.test(s))).toEqual([])
    const free = ['readonly nItem: number', 'nItem: number', 'it.nItem === 2', 'n.nItemOf(3)', 'det[nItem]', 'f(nItem: string)']
    expect(free.filter(s => ASSIGNS.test(s))).toEqual([])
  })

  it('só src/nfe/item-numbering.ts atribui', () => {
    const offenders = files(src).filter(f => ASSIGNS.test(clean(f))).map(f => path.relative(src, f).replace(/\\/g, '/'))
    expect(offenders).toEqual(['nfe/item-numbering.ts'])
  })
})

describe('G3 — achados do gate adversarial na peça do nItem', () => {
  it('[FIXED] array esparso é recusado (a cópia é validada, não a entrada)', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(code(() => numberItems([1, , 3] as any))).toMatchObject({ code: 'INVALID_ID' })
    expect(code(() => numberItems(new Array(3) as any))).toMatchObject({ code: 'INVALID_ID' })
  })

  it('[FIXED] a mensagem do erro mostra no máximo 20 ids; a lista inteira fica em itemIds', () => {
    const bad = Array.from({ length: 200_000 }, (_, i) => -(i + 1))
    try { numberItems(bad); throw new Error('não recusou') } catch (e: any) {
      expect(e).toBeInstanceOf(ItemNumberingError)
      expect(e.itemIds).toHaveLength(200_000)
      expect(e.message.length).toBeLessThan(300)
      expect(e.message).toContain('200000 no total')
    }
  })

  it('[RESISTED] entradas hostis: texto, null, Infinity, 2^53, bigint, objeto → INVALID_ID; nItemOf de texto → undefined', () => {
    for (const hostile of ['1', null, undefined, Infinity, 2 ** 53, BigInt(1), { valueOf: () => 1 }, [1]]) {
      expect(code(() => numberItems([1, hostile as any]))).toMatchObject({ code: 'INVALID_ID' })
    }
    expect(numberItems([1, 2]).nItemOf('1' as any)).toBeUndefined()
  })

  it('[RESISTED] nItemOf acerta além do 3º item e o resultado não aceita mudança', () => {
    const n = numberItems([50, 40, 30, 20, 10])
    expect([10, 20, 30, 40, 50].map(id => n.nItemOf(id))).toEqual([1, 2, 3, 4, 5])
    expect(() => { (n.items as any).push({ itemId: 60, nItem: 6 }) }).toThrow()
    expect(() => { (n.items[0] as any).nItem = 9 }).toThrow()
  })
})
