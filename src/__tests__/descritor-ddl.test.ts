/// <reference types="jest" />
// O DESCRITOR da família NF-e e a leitura publicada AMARRADOS ao DDL da família (molde: nfse-api `descritor-ddl.test.ts`, gates da parte 2
// da NE-1a — socrático #8 + D-NE76): sem isto, só a suíte ao vivo pegaria um nome errado.
//  - a tabela da voz do descritor (`MERCHANDISE_VOICE_FAMILY.eventTable`) é o JOIN da última voz na view de tentativas;
//  - a view de tentativas `vw_<x>` está sobre a tabela `tb_<x>` (a CONVENÇÃO que o "família instalada?" da D-NE76 usa no núcleo);
//  - D-NE160: NÃO existe view de vozes da NF-e.
import fs from 'fs'
import path from 'path'
import { MERCHANDISE_VOICE_READING } from 'fiscal-api'
import { MERCHANDISE_VOICE_FAMILY, MERCHANDISE_TRANSMISSION_TABLE } from '../nfe/voice-family'
import { NUMBER_VOID_TABLE } from '../nfe/number-void'

const SQL_DIR = path.resolve(__dirname, '..', 'migrations', 'sql')
const statements = fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql')).sort()
  .flatMap(f => fs.readFileSync(path.join(SQL_DIR, f), 'utf8').replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean))
const viewBody = (view: string): string => {
  const defs = statements.filter(s => new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+\`?${view}\`?\\s+AS`, 'i').test(s))
  expect(defs.length).toBeGreaterThan(0)
  return defs[defs.length - 1]
}
const views = statements.map(s => /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+`?(\w+)`?\s+AS/i.exec(s)?.[1]).filter(Boolean)
const tablesCreated = statements.map(s => /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i.exec(s)?.[1]).filter(Boolean)
const mainFrom = (body: string) => /\bFROM\s+`?(\w+)`?\s+\w+/i.exec(body)?.[1]
const joins = (body: string) => [...body.matchAll(/\bJOIN\s+`?(\w+)`?\s+\w+/gi)].map(m => m[1])

describe('o descritor da NF-e × o DDL da família', () => {
  it('a tabela da voz do descritor existe e é o JOIN da última voz na view de tentativas; a leitura do descritor é a publicada pelo núcleo', () => {
    const table = MERCHANDISE_VOICE_FAMILY.eventTable
    expect(table).toBe('tb_invoice_merchandise_transmission_event')
    expect(tablesCreated).toContain(table)
    expect(joins(viewBody(MERCHANDISE_VOICE_READING.transmissionView))).toEqual([table])
    expect(MERCHANDISE_VOICE_FAMILY.reading).toBe(MERCHANDISE_VOICE_READING)
    expect(MERCHANDISE_VOICE_FAMILY.label).toBe('NF-e')
  })
  it('D-NE76: a view de tentativas `vw_<x>` está sobre a tabela `tb_<x>`; a tabela das faixas também existe', () => {
    const view = MERCHANDISE_VOICE_READING.transmissionView
    expect(view).toMatch(/^vw_/)
    expect(MERCHANDISE_TRANSMISSION_TABLE).toBe(`tb_${view.slice(3)}`)
    expect(tablesCreated).toContain(MERCHANDISE_TRANSMISSION_TABLE)
    expect(mainFrom(viewBody(view))).toBe(MERCHANDISE_TRANSMISSION_TABLE)
    expect(tablesCreated).toContain(NUMBER_VOID_TABLE)
    expect(mainFrom(viewBody('vw_invoice_number_void'))).toBe(NUMBER_VOID_TABLE)
  })
  it('D-NE160: as views da família são SÓ a de tentativas e a das faixas retiradas — nenhuma view de vozes', () => {
    expect(views.sort()).toEqual(['vw_invoice_merchandise_transmission', 'vw_invoice_number_void'])
    expect(tablesCreated.sort()).toEqual(['tb_invoice_merchandise_transmission', 'tb_invoice_merchandise_transmission_event', 'tb_invoice_number_void'])
  })
})
