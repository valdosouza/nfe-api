/**
 * NFE.E5.P3.T2 — o XML da venda sai com formatadores tipados e campo obrigatório vazio recusado antes do envio, passa no XSD local e não
 * leva grupo de ISSQN (ficha-nfe-e5-p3-builder-nfe.md §6-5). O XSD exige a assinatura: a prova é sobre a NF-e assinada com o A1 de teste.
 */
import { ELEMENT, attrOf, elementsOf, parseXml } from 'fiscal-api'
import { validateMessage } from '../authority/xsd'
import { buildNfeXml, PROC_EMI, TP_IMP, VER_PROC, type NfeInput } from '../nfe/nfe-builder'
import { saleInput, saleItem, saleKey, signNfe, SETES_CNPJ } from './nfe-fixtures'

jest.setTimeout(60_000)                                          // a 1ª validação carrega o libxml em WASM e gera o par RSA de teste

const KEY = saleKey()
const refused = (input: NfeInput, key = KEY): { status?: number; code?: string; fields: { field: string; message: string }[] } => {
  try { buildNfeXml(input, key) } catch (e: any) { return { status: e.statusCode, code: e.code, fields: e.fields ?? [] } }
  return { fields: [{ field: '(não recusou)', message: '' }] }
}
const xsd = async (input: NfeInput, key = KEY) => validateMessage('NFe', signNfe(buildNfeXml(input, key)))
const tags = (xml: string, parent: string): string[] => {
  const node = elementsOf(parseXml(xml), false).find(e => e.nodeType === ELEMENT && (e.localName ?? e.nodeName) === parent)!
  const out: string[] = []
  for (let i = 0; i < node.childNodes.length; i++) { const c = node.childNodes[i]; if (c.nodeType === ELEMENT) out.push(c.localName ?? c.nodeName) }
  return out
}
const one = (xml: string, tag: string): string | null => { const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml); return m ? m[1] : null }

describe('NFE.E5.P3.T2 — a venda passa no XSD local (PL_010f), assinada', () => {
  it('venda interna do Simples, dois itens, duas parcelas, em homologação → válida', async () => {
    expect(await xsd(saleInput())).toEqual({ ok: true })
  })

  it('em produção, com o nome real do destinatário → válida', async () => {
    const built = buildNfeXml(saleInput({ environment: '1' }), KEY)
    expect(one(built.xml, 'tpAmb')).toBe('1')
    expect(built.xml).toContain('<dest><CNPJ>11222333000181</CNPJ><xNome>CLIENTE DE TESTE S.A.</xNome>')
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })

  it('sem assinatura NÃO passa (o TNFe exige a Signature): o builder devolve o documento para assinar', async () => {
    const built = buildNfeXml(saleInput(), KEY)
    expect(built.id).toBe(`NFe${KEY}`)
    expect(built.xml.startsWith(`<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe versao="4.00" Id="NFe${KEY}">`)).toBe(true)
    expect(built.xml).not.toContain('Signature')
    expect((await validateMessage('NFe', built.xml)).ok).toBe(false)
  })

  it('variações do perfil seguem válidas: CSOSN 102, PIS/COFINS CST 49 com valor, CEST, GTIN, transportadora, sem cobrança, à vista', async () => {
    const input = saleInput({
      items: [
        saleItem(0, { icms: { orig: '0', CSOSN: '102', pCredSN: null, vCredICMSSN: null }, CEST: '0100100', indEscala: 'S', cEAN: '7891234567895', cEANTrib: '7891234567895' }),
        saleItem(1, { pis: { CST: '49', vBC: '1000.00', pAliq: '0.65', value: '6.50' }, cofins: { CST: '99', vBC: '0.00', pAliq: '0', value: '0.00' }, vFreteCents: 1500, vDescCents: 500, vOutroCents: 100 }),
      ],
      erpTotalCents: 400000 + 1500 - 500 + 100,
      installments: [], payments: [{ tPag: '01', cents: 401100 }],
      transp: { modFrete: '1', carrier: { CNPJ: '11444777000161', xNome: 'TRANSPORTES DE TESTE LTDA', IE: '123456789', xEnder: 'Rodovia BR-116, km 100', xMun: 'Curitiba', UF: 'PR' } },
      note: null, csrt: null,
    })
    expect(await xsd(input)).toEqual({ ok: true })
  })
})

describe('NFE.E5.P3.T2 — o que o XML leva e na ordem do leiaute', () => {
  const xml = buildNfeXml(saleInput(), KEY).xml

  it('a ordem do infNFe e do ide; cUF, cNF, série, número, tpEmis e cDV saem DA CHAVE', () => {
    expect(tags(xml, 'infNFe')).toEqual(['ide', 'emit', 'dest', 'det', 'det', 'total', 'transp', 'cobr', 'pag', 'infAdic', 'infRespTec'])
    expect(tags(xml, 'ide')).toEqual(['cUF', 'cNF', 'natOp', 'mod', 'serie', 'nNF', 'dhEmi', 'tpNF', 'idDest', 'cMunFG', 'tpImp', 'tpEmis', 'cDV', 'tpAmb',
      'finNFe', 'indFinal', 'indPres', 'indIntermed', 'procEmi', 'verProc'])
    expect(['cUF', 'cNF', 'mod', 'serie', 'nNF', 'tpEmis', 'cDV', 'tpImp', 'procEmi', 'verProc', 'indIntermed', 'cMunFG'].map(t => one(xml, t)))
      .toEqual(['41', KEY.slice(35, 43), '55', '1', '15', '1', KEY[43], TP_IMP, PROC_EMI, VER_PROC, '0', '4106902'])
  })

  it('homologação: o xNome do destinatário é o texto fixo; o xProd do item 1 não muda (55 com tpImp 1) — D-NE216', () => {
    expect(xml).toContain('<dest><CNPJ>11222333000181</CNPJ><xNome>NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xNome>')
    expect(xml).toContain('<xProd>Flange usinada em aço Ø 50 mm</xProd>')
  })

  it('o det leva o atributo da peça do nItem; SEM GTIN; unidades e valores nos tipos do leiaute; zeros do item são OMITIDOS', () => {
    const doc = parseXml(xml)
    const dets = elementsOf(doc, false).filter(e => e.nodeType === ELEMENT && (e.localName ?? e.nodeName) === 'det')
    expect(dets.map(d => attrOf(d, 'nItem'))).toEqual(['1', '2'])
    expect(tags(xml, 'prod')).toEqual(['cProd', 'cEAN', 'xProd', 'NCM', 'CFOP', 'uCom', 'qCom', 'vUnCom', 'vProd', 'cEANTrib', 'uTrib', 'qTrib', 'vUnTrib', 'indTot'])
    expect(['cEAN', 'cEANTrib', 'qCom', 'vUnCom', 'vProd'].map(t => one(xml, t))).toEqual(['SEM GTIN', 'SEM GTIN', '2', '1500', '3000.00'])
    expect(xml).toContain('<qCom>3</qCom><vUnCom>333.333333</vUnCom><vProd>1000.00</vProd>')
  })

  it('imposto: ICMSSN101 com os quatro campos, PISNT e COFINSNT só com o CST — e NENHUM ISSQN', () => {
    expect(xml).toContain('<imposto><vTotTrib>403.50</vTotTrib><ICMS><ICMSSN101><orig>0</orig><CSOSN>101</CSOSN><pCredSN>2.86</pCredSN><vCredICMSSN>85.80</vCredICMSSN></ICMSSN101></ICMS>'
      + '<PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS></imposto>')
    expect(xml).not.toMatch(/ISSQN|<IPI>|<II>|ICMS00|IBSCBS/)
  })

  it('ICMSTot: os 19 campos obrigatórios, na ordem, somados dos itens; os zeros do TOTAL saem "0.00"', () => {
    expect(tags(xml, 'ICMSTot')).toEqual(['vBC', 'vICMS', 'vICMSDeson', 'vFCP', 'vBCST', 'vST', 'vFCPST', 'vFCPSTRet', 'vProd', 'vFrete', 'vSeg', 'vDesc', 'vII',
      'vIPI', 'vIPIDevol', 'vPIS', 'vCOFINS', 'vOutro', 'vNF', 'vTotTrib'])
    expect(xml).toContain('<vProd>4000.00</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol>'
      + '<vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>4000.00</vNF><vTotTrib>538.00</vTotTrib></ICMSTot>')
  })

  it('cobrança (D-NE272): fatura com o número da nota e duplicatas 001, 002; pagamento pela forma do cadastro', () => {
    expect(xml).toContain('<cobr><fat><nFat>15</nFat><vOrig>4000.00</vOrig><vLiq>4000.00</vLiq></fat>'
      + '<dup><nDup>001</nDup><dVenc>2026-12-22</dVenc><vDup>2000.00</vDup></dup><dup><nDup>002</nDup><dVenc>2027-01-19</dVenc><vDup>2000.00</vDup></dup></cobr>'
      + '<pag><detPag><tPag>15</tPag><vPag>4000.00</vPag></detPag></pag>')
  })

  it('infCpl: a frase FIXA do Simples e, depois, a observação da nota; a frase do crédito NÃO é escrita aqui (D-NE271, D-NE274)', () => {
    expect(one(xml, 'infCpl')).toBe('DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. NÃO GERA DIREITO A CRÉDITO FISCAL DE IPI. | Pedido 5001')
    // A frase do crédito vem pronta do ERP web, na observação: sai UMA vez, como veio.
    const credit = 'PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R$ 114,40; CORRESPONDENTE À ALÍQUOTA DE 2,86%, NOS TERMOS DO ART. 23 DA LEI COMPLEMENTAR Nº 123, DE 2006.'
    const withCredit = buildNfeXml(saleInput({ note: credit }), KEY).xml
    expect(withCredit.split('PERMITE O APROVEITAMENTO').length - 1).toBe(1)
    expect(one(withCredit, 'infCpl')).toBe(`DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. NÃO GERA DIREITO A CRÉDITO FISCAL DE IPI. | ${credit}`)
    // Os campos próprios do crédito seguem no item (art. 60 § 5º).
    expect(withCredit).toContain('<pCredSN>2.86</pCredSN><vCredICMSSN>85.80</vCredICMSSN>')
  })

  it('de 01/01/2027 em diante a venda sem o grupo do Simples é RECUSADA (D-NE290) e a frase fixa deixa de ir (nfe-ibscbs-2027.test.ts prova a nota completa)', () => {
    const key27 = saleKey({ emissionDate: '2027-01-04' })
    const in27 = saleInput({ dhEmi: '2027-01-04T09:00:00-03:00', installments: [{ dueDate: '2027-02-04', cents: 400000 }], note: null })
    expect(refused(in27, key27).fields.map(f => f.field)).toEqual(['det[10].simples', 'det[30].simples'])
  })

  it('responsável técnico com o par idCSRT + hashCSRT; sem o CSRT o grupo vai sem o par', () => {
    expect(xml).toContain(`<infRespTec><CNPJ>${SETES_CNPJ}</CNPJ><xContato>Suporte Setes</xContato><email>suporte@setes.example</email><fone>4133334444</fone><idCSRT>01</idCSRT><hashCSRT>aWv6LeEM4X6u4+qBI2OYZ8grigw=</hashCSRT></infRespTec>`)
    expect(buildNfeXml(saleInput({ csrt: null }), KEY).xml).toContain('<fone>4133334444</fone></infRespTec>')
  })

  it('texto com acento, aspas, & e < é escapado e a nota segue válida', async () => {
    const input = saleInput({ natOp: 'Venda "especial" <A&B>', items: [saleItem(0, { xProd: 'Peça nº 1 — não'.replace('—', '-') + ' & Cia <x>' }), saleItem(1)] })
    const built = buildNfeXml(input, KEY)
    expect(built.xml).toContain('<natOp>Venda &quot;especial&quot; &lt;A&amp;B&gt;</natOp>')
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })

  it('o mesmo insumo dá sempre o mesmo XML (puro)', () => {
    expect(buildNfeXml(saleInput(), KEY).xml).toBe(xml)
  })

  it('prova de dente do XSD: trocar a ordem de dois elementos do ide derruba a validação', async () => {
    const built = buildNfeXml(saleInput(), KEY)
    const swapped = built.xml.replace(/(<tpNF>1<\/tpNF>)(<idDest>1<\/idDest>)/, '$2$1')
    expect(swapped).not.toBe(built.xml)
    expect((await validateMessage('NFe', signNfe({ xml: swapped, id: built.id }))).ok).toBe(false)
  })
})

describe('NFE.E5.P3.T2 — campo obrigatório vazio é recusado ANTES do envio, com o campo, sem XML', () => {
  // [campo esperado na recusa, a entrada com UM campo esvaziado]
  const base = saleInput()
  const emptied: [string, NfeInput][] = [
    ['ide.natOp', saleInput({ natOp: '' })], ['ide.natOp', saleInput({ natOp: null })], ['ide.dhEmi', saleInput({ dhEmi: null })],
    ['emit.xNome', saleInput({ emit: { ...base.emit, xNome: ' ' } })], ['emit.IE', saleInput({ emit: { ...base.emit, IE: null } })], ['emit.CRT', saleInput({ emit: { ...base.emit, CRT: null } })],
    ['emit.CNPJ', saleInput({ emit: { ...base.emit, CNPJ: null } })],
    ...(['xLgr', 'nro', 'xBairro', 'cMun', 'xMun', 'UF', 'CEP'] as const).map(f => [`emit.ender.${f}`, saleInput({ emit: { ...base.emit, ender: { ...base.emit.ender, [f]: null } } })] as [string, NfeInput]),
    ['dest.documento', saleInput({ dest: { ...base.dest, CNPJ: null } })], ['dest.xNome', saleInput({ environment: '1', dest: { ...base.dest, xNome: null } })],
    ['dest.indIEDest', saleInput({ dest: { ...base.dest, indIEDest: null } })], ['dest.IE', saleInput({ dest: { ...base.dest, IE: null } })],
    ...(['xLgr', 'nro', 'xBairro', 'cMun', 'xMun', 'UF'] as const).map(f => [`dest.ender.${f}`, saleInput({ dest: { ...base.dest, ender: { ...base.dest.ender, [f]: null } } })] as [string, NfeInput]),
    ...(['cProd', 'xProd', 'NCM', 'CFOP', 'uCom', 'qCom', 'vUnCom', 'uTrib', 'qTrib', 'vUnTrib'] as const).map(f => [`det[10].${f}`, saleInput({ items: [saleItem(0, { [f]: null }), saleItem(1)] })] as [string, NfeInput]),
    ['det[10].CSOSN', saleInput({ items: [saleItem(0, { icms: { ...saleItem(0).icms, CSOSN: null } }), saleItem(1)] })],
    ['det[10].orig', saleInput({ items: [saleItem(0, { icms: { ...saleItem(0).icms, orig: null } }), saleItem(1)] })],
    ['det[30].pis.CST', saleInput({ items: [saleItem(0), saleItem(1, { pis: { CST: null } })] })],
    ['det[30].cofins.CST', saleInput({ items: [saleItem(0), saleItem(1, { cofins: { CST: null } })] })],
    ['pag.detPag[1].tPag', saleInput({ payments: [{ tPag: null, cents: 400000 }] })],
    ['transp.modFrete', saleInput({ transp: { modFrete: null } })],
    ['cobr.dup[2].dVenc', saleInput({ installments: [{ dueDate: '2026-12-22', cents: 200000 }, { dueDate: null, cents: 200000 }] })],
  ]

  it.each(emptied)('%s vazio → 422 FISCAL_DOCUMENT_INVALID citando o campo', (field, input) => {
    const r = refused(input)
    expect([r.status, r.code]).toEqual([422, 'FISCAL_DOCUMENT_INVALID'])
    expect(r.fields.map(f => f.field)).toContain(field)
  })

  it('a lista vem INTEIRA: três campos ruins de grupos diferentes numa recusa só', () => {
    const r = refused(saleInput({ natOp: null, dest: { ...base.dest, IE: null }, items: [saleItem(0, { NCM: '7325' }), saleItem(1)] }))
    expect(r.fields.map(f => f.field).sort()).toEqual(['dest.IE', 'det[10].NCM', 'ide.natOp'])
  })

  it('a nota de base não tem recusa nenhuma', () => {
    expect(() => buildNfeXml(saleInput(), KEY)).not.toThrow()
  })
})

describe('NFE.E5.P3.T2 — formato impossível, coerência com a chave e perfil fora do 1º release', () => {
  const base = saleInput()
  const fieldsOf = (input: NfeInput, key = KEY) => refused(input, key).fields.map(f => `${f.field}: ${f.message}`)

  it('texto acima do tamanho é RECUSADO, nunca cortado; caractere fora do alfabeto do leiaute também', () => {
    expect(fieldsOf(saleInput({ natOp: 'x'.repeat(61) }))[0]).toMatch(/^ide\.natOp: Valor inválido \(tamanho/)
    expect(fieldsOf(saleInput({ items: [saleItem(0, { xProd: 'Peça “especial”' }), saleItem(1)] }))[0]).toMatch(/^det\[10\]\.xProd: Valor inválido \(texto-invalido/)
  })

  it('decimais fora do tipo: 5 casas na quantidade, valor negativo, crédito com fração de centavo', () => {
    expect(fieldsOf(saleInput({ items: [saleItem(0, { qCom: '1.23456' }), saleItem(1)] }))[0]).toMatch(/det\[10\]\.qCom: Valor inválido \(casas-demais/)
    expect(fieldsOf(saleInput({ items: [saleItem(0, { vProdCents: -1 }), saleItem(1)] }))[0]).toMatch(/det\[10\]\.vProd: Valor inválido \(negativo/)
    expect(fieldsOf(saleInput({ items: [saleItem(0, { icms: { ...saleItem(0).icms, vCredICMSSN: '85.805' } }), saleItem(1)] }))[0]).toMatch(/det\[10\]\.vCredICMSSN: Valor inválido \(casas-demais/)
  })

  it('coerência com a chave: CNPJ do emitente, ano e mês do dhEmi, município da UF da chave', () => {
    expect(fieldsOf(saleInput({ emit: { ...base.emit, CNPJ: '11222333000181' } }))).toContain('emit.CNPJ: CNPJ do emitente diferente do da chave de acesso')
    expect(fieldsOf(saleInput({ dhEmi: '2026-12-01T00:00:00-03:00', installments: [] }))).toContain('ide.dhEmi: Ano e mês da emissão diferentes dos da chave de acesso')
    expect(fieldsOf(saleInput({ dhEmi: '2026-11-24 10:15:30' }))).toContain('ide.dhEmi: Data e hora fora da forma do leiaute (AAAA-MM-DDThh:mm:ss±hh:00)')
    expect(fieldsOf(saleInput({ emit: { ...base.emit, ender: { ...base.emit.ender, cMun: '3550308' } } }))).toContain('emit.ender.cMun: Município do emitente de UF diferente da chave de acesso')
  })

  it('fora do 1º release: outro CSOSN/CST, PIS tributado, regime normal, exterior, entrada que não é devolução, contingência', () => {
    const out = (input: NfeInput, key = KEY) => fieldsOf(input, key).filter(f => f.includes('fora-do-primeiro-release'))
    expect(out(saleInput({ items: [saleItem(0, { icms: { ...saleItem(0).icms, CSOSN: '500' } }), saleItem(1)] }))).toEqual(['det[10].CSOSN: CSOSN/CST 500 — fora-do-primeiro-release'])
    expect(out(saleInput({ items: [saleItem(0, { icms: { ...saleItem(0).icms, CSOSN: '00' } }), saleItem(1)] }))).toHaveLength(1)
    expect(out(saleInput({ items: [saleItem(0, { pis: { CST: '01' } }), saleItem(1)] }))).toEqual(['det[10].pis.CST: CST 01 — fora-do-primeiro-release'])
    expect(out(saleInput({ emit: { ...base.emit, CRT: '3' } }))).toEqual(['emit.CRT: Regime 3 — fora-do-primeiro-release'])
    expect(out(saleInput({ idDest: '3' }))).toHaveLength(1)
    expect(out(saleInput({ tpNF: '0' }))).toEqual(['ide.tpNF: Nota de entrada que não é devolução — fora-do-primeiro-release'])
  })

  it('destinatário: contribuinte sem IE (728), não contribuinte com CSOSN 101 (600) e sem consumidor final (696), CNPJ e CPF juntos', () => {
    expect(fieldsOf(saleInput({ dest: { ...base.dest, indIEDest: '9', IE: null } }))).toEqual(expect.arrayContaining([
      'ide.indFinal: Destinatário não contribuinte exige consumidor final (rej. 696)', 'dest.indIEDest: CSOSN 101 não é aceito para destinatário não contribuinte (rej. 600)']))
    expect(fieldsOf(saleInput({ dest: { ...base.dest, CPF: '52998224725' } }))).toContain('dest.documento: Informe CNPJ ou CPF, não os dois')
    expect(fieldsOf(saleInput({ dest: { ...base.dest, CNPJ: '11222333000182' } }))).toContain('dest.CNPJ: CNPJ inválido')
  })

  it('não contribuinte pessoa física, consumidor final, CSOSN 102, sem IE → válida', async () => {
    const input = saleInput({
      indFinal: '1', dest: { CPF: '52998224725', xNome: 'Fulano de Tal', ender: base.dest.ender, indIEDest: '9' },
      items: [saleItem(0, { icms: { orig: '0', CSOSN: '102', pCredSN: null, vCredICMSSN: null } }), saleItem(1, { icms: { orig: '0', CSOSN: '102', pCredSN: null, vCredICMSSN: null } })],
    })
    const built = buildNfeXml(input, KEY)
    expect(built.xml).toContain('<indIEDest>9</indIEDest></dest>')
    expect(await validateMessage('NFe', signNfe(built))).toEqual({ ok: true })
  })

  it('pagamento e cobrança: soma diferente do total, parcela zero, vencimento antes da emissão e fora de ordem', () => {
    expect(fieldsOf(saleInput({ payments: [{ tPag: '15', cents: 399999 }] }))).toContain('pag: A soma das formas de pagamento é diferente do total da nota (sem troco no 1º release)')
    expect(fieldsOf(saleInput({ installments: [{ dueDate: '2026-12-22', cents: 0 }] }))).toContain('cobr.dup[1].vDup: Parcela com valor zero ou inválido')
    expect(fieldsOf(saleInput({ installments: [{ dueDate: '2026-11-23', cents: 400000 }] }))).toContain('cobr.dup[1].dVenc: Vencimento anterior à emissão (rej. 900)')
    expect(fieldsOf(saleInput({ installments: [{ dueDate: '2027-01-19', cents: 200000 }, { dueDate: '2026-12-22', cents: 200000 }] }))).toContain('cobr.dup[2].dVenc: Vencimentos fora de ordem (rej. 850)')
    expect(fieldsOf(saleInput({ payments: [] }))).toContain('pag: Nota sem forma de pagamento')
  })

  it('o vNF do ERP que não confere é defeito do motor (outro código), não entra na lista de campos', () => {
    try { buildNfeXml(saleInput({ erpTotalCents: 400001, payments: [{ tPag: '15', cents: 400001 }] }), KEY); throw new Error('não recusou') } catch (e: any) {
      expect([e.statusCode, e.code]).toEqual([422, 'FISCAL_TOTALS_MOTOR_DEFECT'])
    }
  })

  it('itens fora da ordem do nItem e nota sem item são recusados; chave malformada é erro de quem chama', () => {
    expect(fieldsOf(saleInput({ items: [saleItem(1), saleItem(0)] }))).toContain('det: Itens fora da ordem do nItem (1, 2, 3…)')
    expect(fieldsOf(saleInput({ items: [], installments: [], payments: [{ tPag: '15', cents: 0 }] }))).toContain('det: Nota sem item')
    expect(() => buildNfeXml(saleInput(), KEY.slice(0, 43) + ((Number(KEY[43]) + 1) % 10))).toThrow(/DV/)
  })

  it('nenhuma recusa cita o valor do campo de texto (só o campo e o motivo)', () => {
    const r = refused(saleInput({ natOp: 'SEGREDO-'.repeat(10) }))
    expect(JSON.stringify(r.fields)).not.toContain('SEGREDO')
  })
})
