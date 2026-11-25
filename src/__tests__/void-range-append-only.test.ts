/// <reference types="jest" />
/**
 * A cerca do APPEND-ONLY da tabela das faixas inutilizadas (NFE.E6.P2 — D-NE171 com a exceção da Q2/D-NE293; ficha-nfe-e6-p2-cancelar-inutilizar-rodizio.md §7-5): em todo o `src/` (menos os testes)
 * só `src/nfe/void-range.ts` escreve em `tb_invoice_number_void`, e escreve DUAS coisas — o INSERT da reserva e UM UPDATE que preenche a linha PENDENTE
 * (`authority_code IS NULL`, o write-once da resposta do fisco). Nenhum outro UPDATE, nenhum DELETE, nenhum `deleted` diferente de 'N'. O nome da tabela é LITERAL nas escritas (o texto da
 * cerca o enxerga); as sondas do boot (`number-void.ts`) rodam em transação sempre desfeita e ficam de fora pelo nome do arquivo.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const SRC = path.resolve(__dirname, '..')
const WRITER = path.join('nfe', 'void-range.ts')
const PROBES = path.join('nfe', 'number-void.ts')

const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const full = path.join(dir, e.name)
  if (e.isDirectory()) return e.name === '__tests__' ? [] : files(full)
  return /\.(ts|js|mjs|sql)$/.test(e.name) && !full.includes(`${path.sep}migrations${path.sep}`) ? [full] : []
})
const code = (file: string): string => /\.ts$/.test(file) ? ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)) : fs.readFileSync(file, 'utf8')
const flat = (s: string): string => s.replace(/\s+/g, ' ')

describe('tb_invoice_number_void é append-only (D-NE171 + Q2/D-NE293)', () => {
  const all = files(SRC).map(f => ({ rel: path.relative(SRC, f), text: flat(code(f)) }))

  it('só o void-range.ts escreve na tabela (INSERT e o UPDATE do write-once); as sondas do boot ficam de fora', () => {
    const writers = all.filter(f => f.rel !== PROBES && /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(`?tb_invoice_number_void`?|\$\{NUMBER_VOID_TABLE\})/i.test(f.text)).map(f => f.rel)
    expect(writers).toEqual([WRITER])
  })

  it('no void-range.ts: UM INSERT, UM UPDATE (com authority_code IS NULL, só preenchimento) e NENHUM DELETE', () => {
    const t = (all.find(f => f.rel === WRITER) as { text: string }).text
    expect((t.match(/INSERT\s+INTO\s+\$\{NUMBER_VOID_TABLE\}/gi) ?? [])).toHaveLength(1)
    const updates = t.match(/UPDATE\s+`?tb_invoice_number_void`?[^'"`]*/gi) ?? []
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatch(/SET authority_code = \?, message = \?, protocol = \?, dh_recbto = \?, updated_at = NOW\(\) WHERE tb_institution_id = \? AND id = \? AND authority_code IS NULL$/)
    expect(t).not.toMatch(/\bDELETE\b/i)
    expect(t).not.toMatch(/UPDATE\s+\$\{NUMBER_VOID_TABLE\}/i)                                  // o UPDATE tem o nome LITERAL: a cerca precisa vê-lo
  })

  it("nenhum `deleted` diferente de 'N' é escrito na tabela das faixas (D-NE171)", () => {
    const t = (all.find(f => f.rel === WRITER) as { text: string }).text
    expect(t).not.toMatch(/deleted\s*=\s*['"]S['"]/i)
    expect(t).not.toMatch(/SET[^'"`]*\bdeleted\b/i)
    expect(t).toMatch(/'N'\)`?,/)                                                                // o INSERT grava deleted = 'N'
  })
})
