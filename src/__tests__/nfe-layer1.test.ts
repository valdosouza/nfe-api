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
import { returnKey, returnSaleInput, sale2027, SETES_CNPJ, saleInput, saleItem, saleKey } from './nfe-fixtures'

jest.setTimeout(120_000)

const SALE_KEY = saleKey()
const SALE: Layer1Context = { environment: 'H', emitterUf: 'PR', authorizerUf: 'PR', now: new Date('2026-11-24T10:20:00-03:00'), erpTotalCents: 400000, csrtRequired: true }
const RETURN: Layer1Context = { ...SALE, now: new Date('2026-11-25T09:05:00-03:00'), erpTotalCents: 250000 }
const sale = (): string => buildNfeXml(saleInput(), SALE_KEY).xml
const ret = (): string => buildNfeXml(returnSaleInput(), returnKey()).xml
/** As regras que de FATO saíram numa violação (a cerca do catálogo confere estas, não a intenção do teste). */
const emitted = new Set<string>()

/** A chave montada à mão, coerente (para o que o `buildAccessKey` recusa de propósito). */
const manualKey = (o: { cnf: string; number?: number; serie?: number }): string => {
  const body = `412611${SETES_CNPJ}55${String(o.serie ?? 1).padStart(3, '0')}${String(o.number ?? 15).padStart(9, '0')}1${o.cnf}`
  return body + mod11Ascii48(body)
}
const run = async (_rule: string | string[], xml: string, ctx: Layer1Context = SALE): Promise<Layer1Violation[]> => {
  const v = await validateCandidate(xml, ctx)
  for (const x of v) emitted.add(x.rule)
  return v
}
const of = (v: Layer1Violation[], rule: string): Layer1Violation[] => v.filter(x => x.rule === rule)
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
    expect([rules(b), rejs(b, 'R4')]).toEqual([['R1', 'R4'], [503]])                          // a chave também deixa de bater com o Id
  })

  it('fronteiras da série: 889 e 909 com procEmi 0', async () => {
    const at889 = await run('R4', swap(sale(), '<serie>1</serie>', '<serie>889</serie>'))
    expect(of(at889, 'R4')).toEqual([])
    const at909 = await run('R4', swap(sale(), '<serie>1</serie>', '<serie>909</serie>'))
    expect(rejs(at909, 'R4')).toEqual([244])
  })

  it('dhCont sozinho e xJust sozinho também acendem o 556', async () => {
    for (const extra of ['<dhCont>2026-11-24T10:00:00-03:00</dhCont>', '<xJust>Falha de comunicacao com a SEFAZ</xJust>']) {
      const v = await run('R4', swap(sale(), '</verProc>', `</verProc>${extra}`))
      expect(rejs(v, 'R4')).toEqual([556])
    }
  })

  it('modelo 65 e CRT 3 saem do perfil (R4); procEmi, série e CRT ausentes são violação, não exceção', async () => {
    expect(of(await run('R4', swap(sale(), '<mod>55</mod>', '<mod>65</mod>')), 'R4').map(x => x.field)).toEqual(['ide/mod'])
    expect(of(await run('R4', swap(sale(), '<CRT>1</CRT>', '<CRT>3</CRT>')), 'R4').map(x => x.field)).toEqual(['emit/CRT'])
    for (const [tag, field] of [['procEmi', 'ide/procEmi'], ['serie', 'ide/serie'], ['CRT', 'emit/CRT']]) {
      const v = await run('R4', sale().replace(new RegExp(`<${tag}>[^<]*</${tag}>`), ''))
      expect(of(v, 'R4').map(x => x.field)).toContain(field)
    }
  })

  it('tpEmis diferente de 1 → R4 sem número (fora do 1º release)', async () => {
    const v = await run('R4', swap(sale(), '<tpEmis>1</tpEmis>', '<tpEmis>6</tpEmis>'))
    expect([rules(v), of(v, 'R4').map(x => x.field), rejs(v, 'R4')]).toEqual([['R1', 'R4'], ['ide/tpEmis'], []])
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

  it('a nota sem item acende a R7; o teto de 990 não é alcançável sob o limite de 500 KB (R12 vem antes)', async () => {
    const none = sale().replace(/<det [\s\S]*<\/det>/, '')
    expect(of(await run('R7', none), 'R7').map(x => x.field)).toEqual(['det'])
    const det = /<det nItem="1">[\s\S]*?<\/det>/.exec(sale())![0]
    expect(Buffer.byteLength(det, 'utf8') * 991).toBeGreaterThan(489_760)             // 991 itens do menor formato do builder já estouram a R12
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

  const rich = (): { xml: string; ctx: Layer1Context } => {
    const items = [saleItem(0, { vFreteCents: 1000, vSegCents: 200, vDescCents: 500, vOutroCents: 300 }), saleItem(1)]
    const total = 400000 + 1000 + 200 - 500 + 300
    const xml = buildNfeXml(saleInput({ items, erpTotalCents: total, installments: [], payments: [{ tPag: '01', cents: total }] }), SALE_KEY).xml
    return { xml, ctx: { ...SALE, erpTotalCents: total } }
  }
  const TOT = { vBC: 531, vICMS: 532, vICMSDeson: 795, vFCP: 861, vBCST: 533, vST: 534, vFCPST: 862, vFCPSTRet: 859, vProd: 564, vFrete: 535, vSeg: 536, vDesc: 537, vII: 601, vIPI: 538, vIPIDevol: 863, vPIS: 602, vCOFINS: 603, vOutro: 604 } as const

  it('a nota rica (frete, seguro, desconto, outras) passa limpa', async () => {
    const { xml, ctx } = rich()
    expect(await run('R9', xml, ctx)).toEqual([])
  })

  it('cada um dos 18 campos do ICMSTot, adulterado em 1 centavo, acende SÓ a R8 com a rejeição da SEFAZ daquele campo', async () => {
    const { xml, ctx } = rich()
    for (const [f, rej] of Object.entries(TOT)) {
      const tot = /<ICMSTot>[\s\S]*?<\/ICMSTot>/.exec(xml)![0]
      const cur = new RegExp(`<${f}>([0-9.]+)</${f}>`).exec(tot)![1]
      const bumped = (Math.round(Number(cur) * 100) + 1) / 100
      const v = await run('R8', xml.replace(tot, tot.replace(`<${f}>${cur}</${f}>`, `<${f}>${bumped.toFixed(2)}</${f}>`)), ctx)
      expect([f, rules(v), rejs(v)]).toEqual([f, ['R8'], [rej]])
    }
  })

  it('o vTotTrib do total diferente da soma dos itens, ou ausente, acende a R8 (685)', async () => {
    const a = await run('R8', swap(sale(), '<vTotTrib>538.00</vTotTrib>', '<vTotTrib>538.01</vTotTrib>'))
    expect([rules(a), rejs(a)]).toEqual([['R8'], [685]])
    const b = await run('R8', sale().replace(/(<ICMSTot>[\s\S]*?)<vTotTrib>[0-9.]+<\/vTotTrib>/, '$1'))
    expect(rejs(b, 'R8')).toContain(685)
  })

  it('tributo fora do perfil nos itens (IPI) não passa em silêncio: o total e o vNF deixam de bater (R8 538 e R9)', async () => {
    const xml = sale().replace('<PIS>', '<IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vIPI>3.00</vIPI></IPITrib></IPI><PIS>')
    const v = await run(['R8', 'R9'], xml)
    expect(rejs(v, 'R8')).toContain(538)
    expect(rules(v)).toContain('R9')
  })

  it('o vProd de um ITEM adulterado → R8 (o total deixa de ser a soma) e R9 (o vNF deixa de bater com a fórmula dos itens)', async () => {
    const v = await run(['R8', 'R9'], swap(sale(), '<vProd>3000.00</vProd>', '<vProd>3000.01</vProd>'))
    expect(rules(v)).toEqual(['R8', 'R9'])
  })

  it('o vNF escrito diferente da fórmula → R9 (XML inconsistente) e é erro de documento', async () => {
    const xml = swap(sale(), '<vNF>4000.00</vNF>', '<vNF>4000.01</vNF>')
    const v = await run('R9', xml)
    expect([rules(v), rejs(v), v.some(x => x.motorDefect)]).toEqual([['R13', 'R9'], [610, 865], false])   // o vNF maior que o pago também acende o 865
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
      '', '<a>'.repeat(70), `${'<a>'.repeat(65)}x${'</a>'.repeat(65)}`, '<![CDATA[x]]>',
    ]
    for (const xml of hostile) {
      const v = await run('R10', xml)
      expect([rules(v), v.length]).toEqual([['R10'], 1])
    }
  })

  it('o fechamento da raiz vem do nome lido: espaço ou CRLF no fim vai ao XSD sem R10 (só a 588); raiz sem fechamento e `</NFe >` caem na R10', async () => {
    const trailing = await run('R10', sale() + '\r\n')
    expect([rules(trailing), rejs(trailing)]).toEqual([['R11'], [588]])
    const selfClosed = await run('R10', '<NFe xmlns="http://www.portalfiscal.inf.br/nfe"/>')
    expect(rules(selfClosed)).toContain('R10')
    const spaced = await run('R10', sale().replace(/<\/NFe>$/, '</NFe >'))
    expect(of(spaced, 'R10').map(x => x.field)).toEqual(['NFe'])                      // decisão: o fechamento com espaço não é o do leiaute
  })

  it('NFe vazia: a camada acusa o infNFe ausente (R10), sem exceção', async () => {
    expect(rules(await run('R10', '<NFe xmlns="http://www.portalfiscal.inf.br/nfe"></NFe>'))).toEqual(['R10'])
  })
})

describe('a lista inteira (D-NE43)', () => {
  it('várias violações de regras diferentes saem TODAS numa recusa só, cada uma com regra, rejeição e campo', async () => {
    let xml = swap(sale(), 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL', 'MARCADOR-XYZ-123')
    xml = swap(xml, '<det nItem="2">', '<det nItem="3">')
    xml = xml.replace(/<infRespTec>[\s\S]*<\/infRespTec>/, '')
    const ctx = { ...SALE, emitterUf: 'SP' as const }
    const v = await run(['R3', 'R5', 'R6', 'R7'], xml, ctx)
    expect(rules(v)).toEqual(['R3', 'R5', 'R6', 'R7'])
    const err = await thrown(xml, ctx)
    expect([err.status, err.code, err.fields.length]).toEqual([422, 'FISCAL_DOCUMENT_INVALID', v.length])
    expect(err.fields.every(f => /^\[R\d+( · rej\. \d+)?\] /.test(f.message))).toBe(true)
    expect(JSON.stringify([v, err])).not.toMatch(/MARCADOR|aWv6LeEM|SETES USINAGEM/)          // nenhuma violação cita valor de dado nem o hash
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

describe('escapes achados pelo gate adversarial (sondas permanentes)', () => {
  it('espaço entre tags escrito por referência de caractere acende a 588; comentário e CDATA acendem a R11', async () => {
    for (const ref of ['&#10;', '&#x20;', '&#9;']) expect(rejs(await run('R11', swap(sale(), '</ide><emit>', `</ide>${ref}<emit>`)), 'R11')).toEqual([588])
    expect(of(await run('R11', swap(sale(), '</ide><emit>', '</ide><!-- x --><emit>')), 'R11').map(x => x.field)).toEqual(['infNFe'])
    expect(of(await run('R11', swap(sale(), '<cUF>41</cUF>', '<cUF><![CDATA[41]]></cUF>')), 'R11').length).toBeGreaterThan(0)
  })

  it('NBSP e BOM não são "caractere de edição" da 588 (a norma cita LF, CR, TAB e espaço)', async () => {
    expect(rejs(await run('R11', swap(sale(), '</ide><emit>', '</ide>\u00a0<emit>')), 'R11')).toEqual([588])      // NBSP é texto entre tags: vem do nó de texto
    expect(rejs(await run('R11', '\ufeff' + sale()), 'R11')).not.toContain(588)
  })

  it('CNPJ do emitente (207) e do destinatário (208) com DV errado', async () => {
    expect(rejs(await run('R1', swap(sale(), `<emit><CNPJ>${SETES_CNPJ}`, '<emit><CNPJ>07742094000114')), 'R1')).toContain(207)
    expect(rejs(await run('R5', sale().replace(/(<dest><CNPJ>)[0-9]{14}/, '$111222333000182')), 'R5')).toEqual([208])
  })

  it('devolução: chave referenciada igual à própria (316), com DV errado (236), fora da forma (236) e de modelo 65', async () => {
    const own = /Id="NFe(\d{44})"/.exec(ret())![1]
    const ref = /<chaveAcesso>(\d{44})<\/chaveAcesso>/.exec(ret())![1]
    const withKey = (k: string): string => ret().replace(ref, k)
    expect(rejs(await run('R14', withKey(own), RETURN), 'R14')).toEqual([316])
    const badDv = ref.slice(0, 43) + ((Number(ref[43]) + 1) % 10)
    expect(rejs(await run('R14', withKey(badDv), RETURN), 'R14')).toEqual([236])
    expect(rejs(await run('R14', withKey('0'.repeat(43)), RETURN), 'R14')).toEqual([236])
    const m65 = ref.slice(0, 20) + '65' + ref.slice(22, 43)
    const withDv = m65 + mod11Ascii48(m65)
    expect(of(await run('R14', withKey(withDv), RETURN), 'R14').map(x => x.field).length).toBe(1)
  })

  it('devolução com um item sem referência, e detPag ausente (871)', async () => {
    const one = ret().replace(/<DFeReferenciado>[\s\S]*?<\/DFeReferenciado>/, '')
    expect(rejs(await run('R14', one, RETURN), 'R14')).toEqual([321])
    expect(rejs(await run('R13', ret().replace(/<detPag>[\s\S]*?<\/detPag>/, ''), RETURN), 'R13')).toEqual([871])
  })

  it('venda com pagamento menor que o vNF (865); o maior é R13 sem número (escolha nossa)', async () => {
    const less = await run('R13', sale().replace(/<vPag>[0-9.]+<\/vPag>/, '<vPag>1.00</vPag>'))
    expect(rejs(less, 'R13')).toEqual([865])
    const more = await run('R13', sale().replace(/(<detPag>[\s\S]*?<vPag>)[0-9.]+/, '$19999.00'))
    expect([of(more, 'R13').length, rejs(more, 'R13')]).toEqual([1, []])
  })

  it('o dhEmi fora da forma: mês 00, hora 24, dia 32 e fuso -12:00 acendem a R2; +12:00 é aceito', async () => {
    for (const bad of ['2026-00-24T10:15:30-03:00', '2026-11-24T24:15:30-03:00', '2026-11-32T10:15:30-03:00', '2026-11-24T10:15:30-12:00']) {
      expect(of(await run('R2', swap(sale(), '<dhEmi>2026-11-24T10:15:30-03:00</dhEmi>', `<dhEmi>${bad}</dhEmi>`)), 'R2').length).toBe(1)
    }
    expect(of(await run('R2', swap(sale(), '<dhEmi>2026-11-24T10:15:30-03:00</dhEmi>', '<dhEmi>2026-11-24T10:15:30+12:00</dhEmi>')), 'R2')).toEqual([])
  })

  it('o relógio injetado inválido vira violação da R2, nunca janela silenciosa', async () => {
    const v = await run('R2', sale(), { ...SALE, now: new Date('x') })
    expect(of(v, 'R2').map(x => x.field)).toEqual(['contexto/now'])
  })

  it('a data da fórmula do vNF é a do próprio dhEmi (31/12 às 22:30 em -03:00 não vira 2027)', async () => {
    const xml = sale().replace('<dhEmi>2026-11-24T10:15:30-03:00</dhEmi>', '<dhEmi>2026-12-31T22:30:00-03:00</dhEmi>')
    const v = await run('R9', xml, { ...SALE, now: new Date('2026-12-31T22:31:00-03:00') })
    expect(of(v, 'R9')).toEqual([])
  })

  it('a R5 em produção também pega o texto de homologação em outra caixa', async () => {
    const v = await run('R5', swap(sale(), 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL', 'nf-e emitida em ambiente de homologacao - sem valor fiscal'), { ...SALE, environment: 'P' })
    expect(of(v, 'R5').length).toBe(1)
  })

  it('o tamanho: 489.760 bytes passa na R12; 489.761 cai', async () => {
    const base = Buffer.byteLength(sale(), 'utf8')
    const at = (n: number): string => swap(sale(), '</infNFe>', `<x>${'a'.repeat(n - base - '<x></x>'.length)}</x></infNFe>`)
    expect(of(await run('R12', at(489_760)), 'R12')).toEqual([])
    expect(rejs(await run('R12', at(489_761)), 'R12')).toEqual([214])
  })

  it('R6: CNPJ do responsável ausente (973); id sem hash e hash sem id (975)', async () => {
    expect(rejs(await run('R6', sale().replace(/(<infRespTec>)<CNPJ>[0-9]+<\/CNPJ>/, '$1')), 'R6')).toContain(973)
    expect(rejs(await run('R6', sale().replace(/<hashCSRT>[^<]*<\/hashCSRT>/, '')), 'R6')).toEqual([975])
    expect(rejs(await run('R6', sale().replace(/<idCSRT>[^<]*<\/idCSRT>/, '')), 'R6')).toEqual([975])
  })

  it('R11: espaço só no começo ou só no fim do texto; encoding em minúsculas é aceito; raiz com outro nome → 587', async () => {
    expect(of(await run('R11', swap(sale(), '<xFant>SETES</xFant>', '<xFant>SETES </xFant>')), 'R11').length).toBe(1)
    expect(rejs(await run('R11', '<?xml version="1.0" encoding="utf-8"?>' + sale()), 'R11')).toEqual([])
    expect(rejs(await run('R11', sale().replace('<NFe ', '<NFex ').replace('</NFe>', '</NFex>')), 'R11')).toEqual([587])
  })
})

describe('NFE.E5.P6 — a nota do Simples de 2027 com o grupo passa nas 14 regras (o XSD é o do PL_010h)', () => {
  const SALE27: Layer1Context = { ...SALE, now: new Date('2027-01-15T10:20:00-03:00') }
  const s27 = sale2027()
  const xml27 = (): string => buildNfeXml(s27.input, s27.key).xml
  it('venda de 15/01/2027 com cAtivSN, IBSCBS e IBSCBSTot: nenhuma violação (a camada 1 não recusa o grupo)', async () => {
    expect(await validateCandidate(xml27(), SALE27)).toEqual([])
    expect(await thrown(xml27(), SALE27)).toEqual({ fields: [{ field: '(não recusou)', message: '' }] })
  })
  it('o total do Simples sem vBCIBSCBS é pego pela R10 (XSD, rej. 215) — o esquema vigente exige o campo', async () => {
    const v = await validateCandidate(swap(xml27(), '<vBCIBSCBS>4000.00</vBCIBSCBS>', ''), SALE27)
    expect(rules(v)).toEqual(['R10'])
  })
})

describe('a cerca do catálogo: toda regra tem prova neste arquivo', () => {
  it('as 14 regras foram exercitadas pelos testes acima', () => {
    // vale na corrida inteira do arquivo (com -t a cerca não tem o que conferir)
    expect([...emitted].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(LAYER1_RULES.map(r => r.id))
  })
})
