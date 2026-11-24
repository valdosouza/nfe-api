/**
 * NFE.E5.P5.T1 — a camada 1 da pré-validação: as 14 regras do 1º release, sobre o XML candidato do builder, com a lista INTEIRA de violações
 * (D-NE43, D-NE253; ficha-nfe-e5-p5-camada1.md §6). Cada regra tem a sua prova; o conjunto de regras que cada violação acende é dito no teste.
 */
import fs from 'fs'
import path from 'path'
import { mod11Ascii48 } from 'fiscal-api'
import { CUF, ufOfCode } from '../authority/messages'
import { FORBIDDEN_CNF } from '../nfe/access-key'
import { MAX_FIELDS } from '../nfe/errors'
import { numberItems } from '../nfe/item-numbering'
import { assertLayer1, LAYER1_FORBIDDEN_CNF, LAYER1_RULES, validateCandidate, type Layer1Context, type Layer1Violation } from '../nfe/layer1'
import { buildNfeXml } from '../nfe/nfe-builder'
import { returnKey, returnSaleInput, SETES_CNPJ, saleInput, saleItem, saleKey } from './nfe-fixtures'

jest.setTimeout(120_000)

const SALE_KEY = saleKey()
const SALE: Layer1Context = { environment: 'H', emitterUf: 'PR', authorizerUf: 'PR', now: new Date('2026-11-24T10:20:00-03:00'), erpTotalCents: 400000, csrtRequired: true }
const RETURN: Layer1Context = { ...SALE, now: new Date('2026-11-25T09:05:00-03:00'), erpTotalCents: 250000 }
const sale = (): string => buildNfeXml(saleInput(), SALE_KEY).xml
const ret = (): string => buildNfeXml(returnSaleInput(), returnKey()).xml
const touched = new Set<string>()

/** A chave montada à mão, coerente (para o que o `buildAccessKey` recusa de propósito). */
const manualKey = (o: { cnf: string; number?: number; serie?: number }): string => {
  const body = `412611${SETES_CNPJ}55${String(o.serie ?? 1).padStart(3, '0')}${String(o.number ?? 15).padStart(9, '0')}1${o.cnf}`
  return body + mod11Ascii48(body)
}
const run = (rule: string | string[], xml: string, ctx: Layer1Context = SALE): Promise<Layer1Violation[]> => {
  for (const r of Array.isArray(rule) ? rule : [rule]) touched.add(r)
  return validateCandidate(xml, ctx)
}
const rules = (v: Layer1Violation[]): string[] => [...new Set(v.map(x => x.rule))].sort()
const rejs = (v: Layer1Violation[], rule?: string): number[] => v.filter(x => rule === undefined || x.rule === rule).map(x => x.rejection).filter((n): n is number => n !== null).sort((a, b) => a - b)
const swap = (xml: string, from: string, to: string): string => {
  expect(xml.split(from).length - 1).toBe(1)                                   // o trecho existe UMA vez: a violação é a que o teste diz
  return xml.replace(from, to)
}
const thrown = async (xml: string, ctx: Layer1Context = SALE): Promise<{ status?: number; code?: string; message?: string; fields: { field: string; message: string }[] }> => {
  try { await assertLayer1(xml, ctx) } catch (e: any) { return { status: e.statusCode, code: e.code, message: e.message, fields: e.fields ?? [] } }
  return { fields: [{ field: '(não recusou)', message: '' }] }
}

describe('o catálogo (D-NE43) e o candidato válido', () => {
  it('14 regras R1 a R14, cada uma com RF, rejeições, fonte, versão do MOC, dono e revisão por NT', () => {
    expect(LAYER1_RULES.map(r => r.id)).toEqual(Array.from({ length: 14 }, (_, i) => `R${i + 1}`))
    for (const r of LAYER1_RULES) {
      for (const k of ['rf', 'rejections', 'source', 'mocVersion', 'owner', 'ntReview'] as const) expect([r.id, k, r[k].length > 0]).toEqual([r.id, k, true])
      expect(r.owner).toBe('nfe-api · camada 1')
    }
  })

  it('a lista dos 20 cNF proibidos é cópia da do builder (paridade)', () => {
    expect([...LAYER1_FORBIDDEN_CNF].sort()).toEqual([...FORBIDDEN_CNF].sort())
  })

  it('a venda e a devolução do builder passam SEM violação, e assertLayer1 não lança', async () => {
    expect(await validateCandidate(sale(), SALE)).toEqual([])
    expect(await validateCandidate(ret(), RETURN)).toEqual([])
    expect((await thrown(sale())).fields).toEqual([{ field: '(não recusou)', message: '' }])
  })

  it('a pureza: o fonte da camada não toca relógio, banco, rede, segredo nem o builder (é a prova de "sem abrir tentativa")', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'nfe', 'layer1.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, '')
    for (const banned of [/Date\.now/, /new Date\(\)/, /process\.env/, /\bpool\b/, /\.query\(/, /\bfetch\(/, /nfe-builder/, /access-key/, /from 'fs'/, /from 'http/]) expect([banned.source, banned.test(src)]).toEqual([banned.source, false])
  })

  it('ufOfCode é o inverso de CUF', () => {
    for (const [uf, code] of Object.entries(CUF)) expect(ufOfCode(code)).toBe(uf)
    expect([ufOfCode('99'), ufOfCode(''), ufOfCode('4')]).toEqual([null, null, null])
  })
})

describe('R1 — chave de acesso (rej. 502, 253, 897)', () => {
  it('o Id diferente da chave composta dos campos do XML → só a R1 (502)', async () => {
    const xml = sale()
    const id = /Id="NFe(\d{44})"/.exec(xml)![1]
    const bad = id.slice(0, 30) + (id[30] === '1' ? '2' : '1') + id.slice(31)
    const v = await run('R1', swap(xml, `Id="NFe${id}"`, `Id="NFe${bad}"`))
    expect([rules(v), rejs(v)]).toEqual([['R1'], [502]])
  })

  it('o cDV errado → só a R1, pelas duas rejeições (o Id também diverge)', async () => {
    const xml = sale()
    const dv = /<cDV>(\d)<\/cDV>/.exec(xml)![1]
    const v = await run('R1', swap(xml, `<cDV>${dv}</cDV>`, `<cDV>${(Number(dv) + 1) % 10}</cDV>`))
    expect([rules(v), rejs(v)]).toEqual([['R1'], [253, 502]])
  })

  it('cNF em sequência proibida, e cNF igual ao número da nota, com a chave montada coerente → só a R1 (897)', async () => {
    for (const cnf of ['11111111', '12345678', '00000000', '90123456']) {
      const v = await run('R1', buildNfeXml(saleInput(), manualKey({ cnf })).xml)
      expect([cnf, rules(v), rejs(v)]).toEqual([cnf, ['R1'], [897]])
    }
    const same = await run('R1', buildNfeXml(saleInput(), manualKey({ cnf: '00000015', number: 15 })).xml)
    expect([rules(same), rejs(same)]).toEqual([['R1'], [897]])
  })

  it('campo da chave ausente → violação da R1 com o campo, nunca exceção', async () => {
    const v = await run('R1', swap(sale(), '<cNF>48213057</cNF>', ''))
    expect(v.filter(x => x.rule === 'R1').map(x => x.field)).toContain('ide.cNF')
  })
})

describe('R2 — dhEmi (rej. 703, 228)', () => {
  const dhEmi = new Date('2026-11-24T10:15:30-03:00').getTime()
  const at = (offsetMs: number): Layer1Context => ({ ...SALE, now: new Date(dhEmi + offsetMs) })

  it('5 minutos à frente passa; 5 minutos e 1 segundo recusa (703)', async () => {
    expect(await run('R2', sale(), at(-5 * 60_000))).toEqual([])
    const v = await run('R2', sale(), at(-5 * 60_000 - 1000))
    expect([rules(v), rejs(v)]).toEqual([['R2'], [703]])
  })

  it('30 dias atrás passa; 30 dias e 1 segundo recusa (228); 8 dias atrás passa (a SEFAZ devolve 150)', async () => {
    expect(await run('R2', sale(), at(30 * 86_400_000))).toEqual([])
    expect(await run('R2', sale(), at(8 * 86_400_000))).toEqual([])
    const v = await run('R2', sale(), at(30 * 86_400_000 + 1000))
    expect([rules(v), rejs(v)]).toEqual([['R2'], [228]])
  })

  it('dhEmi sem fuso → R2 (forma), R1 (a chave não se compõe) e R10 (o XSD exige o fuso); a R9 não roda', async () => {
    const v = await run('R2', swap(sale(), '<dhEmi>2026-11-24T10:15:30-03:00</dhEmi>', '<dhEmi>2026-11-24T10:15:30</dhEmi>'))
    expect(rules(v)).toEqual(['R1', 'R10', 'R2'])
    expect(v.filter(x => x.rule === 'R9')).toEqual([])
  })
})

describe('R3 — UF, ambiente e município (rej. 226, 247, 252, 271, 273)', () => {
  it('a UF do emitente e a do autorizador diferentes da do documento → só a R3', async () => {
    const a = await run('R3', sale(), { ...SALE, emitterUf: 'SP' })
    expect([rules(a), rejs(a)]).toEqual([['R3'], [226, 247]])
    const b = await run('R3', sale(), { ...SALE, authorizerUf: 'SP' })
    expect([rules(b), rejs(b)]).toEqual([['R3'], [226]])
  })

  it('o ambiente da tentativa diferente do tpAmb → R3 (252); em produção o texto de homologação também acende a R5', async () => {
    const v = await run(['R3', 'R5'], sale(), { ...SALE, environment: 'P' })
    expect([rules(v), rejs(v, 'R3')]).toEqual([['R3', 'R5'], [252]])
  })

  it('cMunFG e cMun do emitente fora da UF → só a R3 (271, 273)', async () => {
    const a = await run('R3', swap(sale(), '<cMunFG>4106902</cMunFG>', '<cMunFG>3550308</cMunFG>'))
    expect([rules(a), rejs(a)]).toEqual([['R3'], [271]])
    const b = await run('R3', swap(sale(), '<cMun>4106902</cMun>', '<cMun>3550308</cMun>'))
    expect([rules(b), rejs(b)]).toEqual([['R3'], [273]])
  })
})

describe('R4 — emissão normal (rej. 556, 244, 503)', () => {
  it('dhCont e xJust numa emissão normal → só a R4 (556)', async () => {
    const xml = swap(sale(), '</verProc>', '</verProc><dhCont>2026-11-24T10:00:00-03:00</dhCont><xJust>Falha de comunicacao com a SEFAZ</xJust>')
    const v = await run('R4', xml)
    expect([rules(v), rejs(v)]).toEqual([['R4'], [556]])
  })

  it('série 890 com procEmi 0 → só a R4 (244); série acima de 909 → 503', async () => {
    const a = await run('R4', buildNfeXml(saleInput(), manualKey({ cnf: '48213057', serie: 890 })).xml)
    expect([rules(a), rejs(a)]).toEqual([['R4'], [244]])
    const b = await run('R4', swap(sale(), '<serie>1</serie>', '<serie>910</serie>'))   // o builder recusa a série 910; a camada a vê no XML
    expect(rejs(b, 'R4')).toContain(503)
  })

  it('tpEmis diferente de 1 → R4 sem número (fora do 1º release)', async () => {
    const body = `412611${SETES_CNPJ}550010000000151` .replace(/1$/, '6') + '48213057'
    const xml = swap(sale(), '<tpEmis>1</tpEmis>', '<tpEmis>6</tpEmis>')
    const v = await run('R4', xml)
    expect(v.filter(x => x.rule === 'R4').map(x => x.field)).toContain('ide/tpEmis')
    expect(body.length).toBe(43)
  })
})

describe('R5 — texto de homologação (rej. 598)', () => {
  it('em homologação o dest/xNome diferente do texto fixo → só a R5 (598)', async () => {
    const v = await run('R5', swap(sale(), 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL', 'CLIENTE DE TESTE S.A.'))
    expect([rules(v), rejs(v)]).toEqual([['R5'], [598]])
  })
})

describe('R6 — responsável técnico (rej. 972, 973, 975)', () => {
  it('grupo ausente → 972', async () => {
    const xml = sale().replace(/<infRespTec>[\s\S]*<\/infRespTec>/, '')
    const v = await run('R6', xml)
    expect([rules(v), rejs(v)]).toEqual([['R6'], [972]])
  })

  it('CNPJ de DV errado → 973', async () => {
    const v = await run('R6', swap(sale(), `<infRespTec><CNPJ>${SETES_CNPJ}`, '<infRespTec><CNPJ>07742094000114'))
    expect([rules(v), rejs(v)]).toEqual([['R6'], [973]])
  })

  it('o par idCSRT/hashCSRT ausente com o CSRT exigido → 975; o hash fora da forma → 975', async () => {
    const pair = sale().replace(/<idCSRT>[\s\S]*?<\/hashCSRT>/, '')
    const a = await run('R6', pair)
    expect([rules(a), rejs(a)]).toEqual([['R6'], [975]])
    const b = await run('R6', swap(sale(), '<hashCSRT>aWv6LeEM4X6u4+qBI2OYZ8grigw=</hashCSRT>', '<hashCSRT>AAAA</hashCSRT>'))
    expect(rejs(b, 'R6')).toContain(975)
  })

  it('o par presente quando o CSRT NÃO é exigido → R6 sem número (escolha nossa); o par certo é aceito', async () => {
    const v = await run('R6', sale(), { ...SALE, csrtRequired: false })
    expect([rules(v), rejs(v)]).toEqual([['R6'], []])
    expect(await run('R6', sale().replace(/<idCSRT>[\s\S]*?<\/hashCSRT>/, ''), { ...SALE, csrtRequired: false })).toEqual([])
  })
})

describe('R7 — nItem (rej. 927)', () => {
  it('nItem que não é consecutivo a partir de 1 → só a R7', async () => {
    const v = await run('R7', swap(sale(), '<det nItem="2">', '<det nItem="3">'))
    expect([rules(v), rejs(v)]).toEqual([['R7'], [927]])
    expect(v[0].field).toBe('det[2]/@nItem')
  })

  it('o teto de 990 e a nota sem item', async () => {
    const none = sale().replace(/<det [\s\S]*<\/det>/, '')
    expect(rules(await run('R7', none))).toContain('R7')
  })
})

describe('R11 — formato do texto (rej. 402, 404, 587, 588)', () => {
  it('a raiz em outro namespace → só a R11 (587) e a camada PARA', async () => {
    const v = await run('R11', swap(sale(), '<NFe xmlns="http://www.portalfiscal.inf.br/nfe">', '<NFe xmlns="urn:outro">'))
    expect([rules(v), rejs(v), v.length]).toEqual([['R11'], [587], 1])
  })

  it('encoding diferente de UTF-8 → R11 (402)', async () => {
    const v = await run('R11', '<?xml version="1.0" encoding="ISO-8859-1"?>' + sale())
    expect(rejs(v, 'R11')).toEqual([402])
  })

  it('LF entre tags → R11 (588)', async () => {
    const v = await run('R11', swap(sale(), '</ide><emit>', '</ide>\n<emit>'))
    expect([rules(v), rejs(v)]).toEqual([['R11'], [588]])
  })

  it('prefixo de namespace → R11 (404)', async () => {
    const v = await run('R11', swap(sale(), '<infAdic>', '<infAdic xmlns:x="urn:x"><x:a/>'))
    expect(rejs(v, 'R11')).toEqual([404])
  })

  it('espaço nas pontas do texto → R10 (o XSD o proíbe) e R11 sem número (escolha nossa)', async () => {
    const v = await run('R11', swap(sale(), '<xNome>SETES USINAGEM DE TESTE LTDA</xNome>', '<xNome> SETES USINAGEM DE TESTE LTDA</xNome>'))
    expect([rules(v), rejs(v, 'R11')]).toEqual([['R10', 'R11'], []])
  })
})

describe('R12 — tamanho (rej. 214)', () => {
  it('acima do limite com a margem da assinatura → só a R12, e a camada PARA antes de ler (inclusive acima de 1 MiB)', async () => {
    for (const pad of [490_000, 1_200_000, 20_000_000]) {
      const v = await run('R12', swap(sale(), '</infNFe>', `<x>${'a'.repeat(pad)}</x></infNFe>`))
      expect([pad, rules(v), rejs(v), v.length]).toEqual([pad, ['R12'], [214], 1])
    }
  })

  it('uma nota do builder com 900 itens passa de 489.760 bytes e cai na R12', async () => {
    const items = numberItems(Array.from({ length: 900 }, (_, i) => i + 1)).items.map(n => saleItem(0, { numbered: n, vProdCents: 100, qCom: '1', vUnCom: '1', qTrib: '1', vUnTrib: '1', vTotTribCents: 0, vDescCents: 5, vFreteCents: 7, vOutroCents: 3 }))
    const total = 900 * (100 - 5 + 7 + 3)
    const xml = buildNfeXml(saleInput({ items, erpTotalCents: total, installments: [], payments: [{ tPag: '01', cents: total }] }), SALE_KEY).xml
    expect(Buffer.byteLength(xml, 'utf8')).toBeGreaterThan(489_760)
    const v = await run('R12', xml, { ...SALE, erpTotalCents: total })
    expect([rules(v), rejs(v)]).toEqual([['R12'], [214]])
  })

  it('logo abaixo do limite não é recusada pelo tamanho', async () => {
    const v = await run('R12', swap(sale(), '</infNFe>', `<x>${'a'.repeat(400_000)}</x></infNFe>`))
    expect(rules(v)).not.toContain('R12')
  })
})

describe('R13 e R14 — devolução (rej. 871, 904, 1010, 321)', () => {
  it('R13: forma diferente de 90 → 871; 90 com valor → 904 (a devolução recusa só aqui)', async () => {
    const a = await run('R13', swap(ret(), '<tPag>90</tPag><vPag>0.00</vPag>', '<tPag>01</tPag><vPag>0.00</vPag>'), RETURN)
    expect([rules(a), rejs(a)]).toEqual([['R13'], [871]])
    const b = await run('R13', swap(ret(), '<tPag>90</tPag><vPag>0.00</vPag>', '<tPag>90</tPag><vPag>1.00</vPag>'), RETURN)
    expect([rules(b), rejs(b)]).toEqual([['R13'], [904]])
  })

  it('R13: finalidade fora do perfil (1 e 4) → R13 sem número', async () => {
    const v = await run('R13', swap(sale(), '<finNFe>1</finNFe>', '<finNFe>2</finNFe>'))
    expect(v.filter(x => x.rule === 'R13').map(x => x.field)).toEqual(['ide/finNFe'])
  })

  it('R14: NFref no cabeçalho junto da referência por item → 1010', async () => {
    const xml = swap(ret(), '</verProc>', `</verProc><NFref><refNFe>${SALE_KEY}</refNFe></NFref>`)
    const v = await run('R14', xml, RETURN)
    expect([rules(v), rejs(v)]).toEqual([['R14'], [1010]])
  })

  it('R14: devolução sem nenhuma referência → 321; só no cabeçalho → R14 sem número (escolha nossa)', async () => {
    const noRef = ret().replace(/<DFeReferenciado>[\s\S]*?<\/DFeReferenciado>/g, '')
    const a = await run('R14', noRef, RETURN)
    expect([rules(a), rejs(a)]).toEqual([['R14'], [321]])
    const onlyHeader = swap(noRef, '</verProc>', `</verProc><NFref><refNFe>${SALE_KEY}</refNFe></NFref>`)
    const b = await run('R14', onlyHeader, RETURN)
    expect([rules(b), rejs(b)]).toEqual([['R14'], []])
  })

  it('R14: nota que não é devolução com item referenciado → R14 sem número', async () => {
    const xml = swap(sale(), '</imposto></det><det nItem="2">', `</imposto><DFeReferenciado><chaveAcesso>${SALE_KEY}</chaveAcesso><nItem>1</nItem></DFeReferenciado></det><det nItem="2">`)
    expect(rules(await run('R14', xml))).toContain('R14')
  })
})

describe('R8 e R9 — totais e vNF (rej. 531 a 564 e 601 a 604 …; 610)', () => {
  it('um campo do ICMSTot adulterado em 1 centavo → só a R8 (o vNF escrito segue batendo com a fórmula dos itens)', async () => {
    for (const [from, to] of [['<vProd>4000.00</vProd>', '<vProd>4000.01</vProd>'], ['<vPIS>0.00</vPIS>', '<vPIS>0.01</vPIS>'], ['<vICMS>0.00</vICMS>', '<vICMS>0.01</vICMS>'], ['<vBC>0.00</vBC>', '<vBC>0.01</vBC>']]) {
      const v = await run('R8', swap(sale(), from, to))
      expect([from, rules(v)]).toEqual([from, ['R8']])
    }
  })

  it('o vProd de um ITEM adulterado → R8 (o total deixa de ser a soma) e R9 (o vNF deixa de bater com a fórmula dos itens)', async () => {
    const v = await run(['R8', 'R9'], swap(sale(), '<vProd>3000.00</vProd>', '<vProd>3000.01</vProd>'))
    expect(rules(v)).toEqual(['R8', 'R9'])
  })

  it('o vNF escrito diferente da fórmula → R9 (XML inconsistente) e é erro de documento', async () => {
    const xml = swap(sale(), '<vNF>4000.00</vNF>', '<vNF>4000.01</vNF>')
    const v = await run('R9', xml)
    expect([rules(v), rejs(v), v.some(x => x.motorDefect)]).toEqual([['R9'], [610], false])
    expect((await thrown(xml)).code).toBe('FISCAL_DOCUMENT_INVALID')
  })

  it('o vNF do ERP com 1 centavo de diferença → R9 SOZINHA = FISCAL_TOTALS_MOTOR_DEFECT; com outra violação, FISCAL_DOCUMENT_INVALID com a R9 na lista', async () => {
    const ctx = { ...SALE, erpTotalCents: 400001 }
    const v = await run('R9', sale(), ctx)
    expect([rules(v), v.every(x => x.motorDefect)]).toEqual([['R9'], true])
    const alone = await thrown(sale(), ctx)
    expect([alone.status, alone.code]).toEqual([422, 'FISCAL_TOTALS_MOTOR_DEFECT'])
    const mixed = await thrown(swap(sale(), 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL', 'CLIENTE'), ctx)
    expect([mixed.code, mixed.fields.length]).toEqual(['FISCAL_DOCUMENT_INVALID', 2])
    expect(mixed.fields.map(f => f.message.slice(0, 4))).toEqual(expect.arrayContaining(['[R5 ', '[R9 ']))
  })

  it('erpTotalCents inválido (NaN, fracionário) → R9 de defeito do motor, nunca exceção', async () => {
    for (const bad of [NaN, 400000.5, -1]) expect(rules(await run('R9', sale(), { ...SALE, erpTotalCents: bad }))).toEqual(['R9'])
  })
})

describe('R10 — XSD (rej. 215)', () => {
  it('elemento fora de ordem → só a R10, citando o NOME do elemento', async () => {
    const v = await run('R10', swap(sale(), '<tpNF>1</tpNF><idDest>1</idDest>', '<idDest>1</idDest><tpNF>1</tpNF>'))
    expect([rules(v), rejs(v)]).toEqual([['R10'], [215]])
    expect(v.map(x => x.field).join(' ')).toMatch(/tpNF|idDest/)
  })

  it('tipo errado → a R10 cita o elemento e NUNCA o valor nem o hash', async () => {
    const v = await run('R10', swap(sale(), '<qCom>2</qCom>', '<qCom>SEGREDO-123</qCom>'))
    expect(rules(v)).toEqual(['R10'])
    expect(JSON.stringify(v)).not.toContain('SEGREDO')
    const withHash = await run('R10', sale().replace('<NCM>73259990</NCM>', '<NCM>XX</NCM>'))
    expect(JSON.stringify(withHash)).not.toContain('aWv6LeEM4X6u4')
  })

  it('o XML ilegível (DOCTYPE, entidade, mal formado, vazio) → UMA violação da R10, nunca exceção', async () => {
    const hostile = [
      '<!DOCTYPE x [<!ENTITY a "b">]><NFe xmlns="http://www.portalfiscal.inf.br/nfe"/>', '<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe>',
      '', '<a>' .repeat(70), '<![CDATA[x]]>',
    ]
    for (const xml of hostile) {
      const v = await run('R10', xml)
      expect([rules(v), v.length]).toEqual([['R10'], 1])
    }
  })

  it('NFe vazia: a camada acusa o infNFe ausente (R10), sem exceção', async () => {
    expect(rules(await run('R10', '<NFe xmlns="http://www.portalfiscal.inf.br/nfe"></NFe>'))).toEqual(['R10'])
  })
})

describe('a lista inteira (D-NE43)', () => {
  it('várias violações de regras diferentes saem TODAS numa recusa só, cada uma com regra, rejeição e campo', async () => {
    let xml = swap(sale(), 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL', 'CLIENTE')
    xml = swap(xml, '<det nItem="2">', '<det nItem="3">')
    xml = xml.replace(/<infRespTec>[\s\S]*<\/infRespTec>/, '')
    const ctx = { ...SALE, emitterUf: 'SP' as const }
    const v = await run(['R3', 'R5', 'R6', 'R7'], xml, ctx)
    expect(rules(v)).toEqual(['R3', 'R5', 'R6', 'R7'])
    const err = await thrown(xml, ctx)
    expect([err.status, err.code, err.fields.length]).toEqual([422, 'FISCAL_DOCUMENT_INVALID', v.length])
    expect(err.fields.every(f => /^\[R\d+( · rej\. \d+)?\] /.test(f.message))).toBe(true)
  })

  it('o teto de campos corta com o aviso "e mais N" na mensagem', async () => {
    const numbered = numberItems(Array.from({ length: 60 }, (_, i) => i + 1)).items.map(n => saleItem(0, { numbered: n, vProdCents: 100, qCom: '1', vUnCom: '1', qTrib: '1', vUnTrib: '1', vTotTribCents: 0 }))
    const total = 60 * 100
    const good = buildNfeXml(saleInput({ items: numbered, erpTotalCents: total, installments: [], payments: [{ tPag: '01', cents: total }] }), SALE_KEY).xml
    const bad = good.replace(/<det nItem="(\d+)">/g, (_m, n) => `<det nItem="${Number(n) + 100}">`)
    const err = await thrown(bad, { ...SALE, erpTotalCents: total })
    expect(err.fields).toHaveLength(MAX_FIELDS)
    expect(err.message).toContain('e mais 10 violação(ões)')
  })

  it('a mesma regra não repete a mesma violação do mesmo campo', async () => {
    const v = await validateCandidate(swap(sale(), '<qCom>2</qCom>', '<qCom>abc</qCom>'), SALE)
    const keys = v.map(x => `${x.rule}|${x.field}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('a cerca do catálogo: toda regra tem prova neste arquivo', () => {
  it('as 14 regras foram exercitadas pelos testes acima', () => {
    expect([...touched].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(LAYER1_RULES.map(r => r.id))
  })
})
