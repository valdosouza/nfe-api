/// <reference types="jest" />
// nfe-api:NFE.E4.P3.T1 — validação XSD local (`src/authority/xsd.ts`; D-NE181, D-NE115, D-NE211, D-NE43; RF-NFE-19). Ficha
// `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e4-p3-xsd-respostas-raizes.md`, mudança 1. Nada vai à rede.
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DEFAULT_XSD_DIR, SCHEMA_SETS, XsdManifestError, loadSchemaSets, validateMessage, type MessageKind } from '../authority/xsd'
import { buildNfeXml } from '../nfe/nfe-builder'
import * as fx from './xsd-fixtures'
import { sale2027, saleInput, saleKey, signNfe } from './nfe-fixtures'
import { enviNFe } from '../authority/messages'

jest.setTimeout(60_000)

describe('mensagens válidas passam (uma de cada tipo da NE-3)', () => {
  const cases: [MessageKind, string][] = [
    ['consStatServ', fx.consStatServ()],
    ['consSitNFe', fx.consSitNFe()],
    ['consReciNFe', fx.consReciNFe()],
    ['consCad', fx.consCad()],
    ['inutNFe', fx.inutNFe()],
    ['envEvento110111', fx.envEvento110111()],
    ['envEvento110111', fx.envEvento110111('14126000000000123')],   // nProt de 17 dígitos (TProt 15|17 do PL_010d/Evento)
  ]
  it.each(cases)('%s', async (kind, xml) => {
    expect(await validateMessage(kind, xml)).toEqual({ ok: true })
  })
})

describe('um campo fora do padrão em cada uma → recusa com a lista de erros (D-NE43)', () => {
  const cases: [string, MessageKind, string, RegExp][] = [
    ['tpAmb = 3', 'consStatServ', fx.consStatServ('3'), /tpAmb/],
    ['chave com 43 dígitos', 'consSitNFe', fx.consSitNFe(fx.CHAVE.slice(0, 43)), /chNFe/],
    ['nRec com letra', 'consReciNFe', fx.consReciNFe('41100000000000A'), /nRec/],
    ['CNPJ com 13 dígitos', 'consCad', fx.consCad(fx.CNPJ.slice(0, 13)), /CNPJ/],
    ['nNFIni = 0', 'inutNFe', fx.inutNFe('0'), /nNFIni/],
    ['xJust com 14 caracteres no detEvento (e110111)', 'envEvento110111', fx.envEvento110111(undefined, 'Justificativa.'), /xJust/],
    ['nProt com 16 dígitos no detEvento (e110111)', 'envEvento110111', fx.envEvento110111('1412600000000012'), /nProt/],
  ]
  it.each(cases)('%s', async (_label, kind, xml, field) => {
    const r = await validateMessage(kind, xml)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' | ')).toMatch(field)   // a recusa é pelo campo trocado, não por acidente
  })
  it('envEvento com dois detEvento → recusa (D-NE39: 1 evento por lote)', async () => {
    const one = fx.envEvento110111()
    const two = one.replace('</evento></envEvento>', '</evento>' + one.slice(one.indexOf('<evento '), one.indexOf('</envEvento>')) + '</envEvento>')
    const r = await validateMessage('envEvento110111', two)
    expect(r.ok).toBe(false)
  })
})

// nfe-api:NFE.E4.P3.T4 — o `detEvento` sai pelo leitor estrito e é ESCRITO a partir do nó (N17 — D-NE72, D-NE85…D-NE90), sem recorte
describe('detEvento pelo leitor estrito (NFE.E4.P3.T4)', () => {
  const DET = '<detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>141260000000001</nProt><xJust>Cancelamento de teste em homologacao</xJust></detEvento>'
  const withDet = (det: string) => {
    const env = fx.envEvento110111()
    expect(env).toContain(DET)
    return env.replace(DET, det)
  }
  it('entidades no xJust voltam escapadas no documento próprio e passam no e110111', async () => {
    expect(await validateMessage('envEvento110111', fx.envEvento110111(undefined, 'Cancelado &amp; refeito &lt;teste&gt; "H"'))).toEqual({ ok: true })
  })
  it('detEvento com prefixo (ou com o xmlns da NF-e repetido) passa — o documento próprio é escrito sem prefixo', async () => {
    const NS = 'http://www.portalfiscal.inf.br/nfe'
    const prefixed = `<n:detEvento xmlns:n="${NS}" versao="1.00"><n:descEvento>Cancelamento</n:descEvento><n:nProt>141260000000001</n:nProt>`
      + '<n:xJust>Cancelamento de teste em homologacao</n:xJust></n:detEvento>'
    expect(await validateMessage('envEvento110111', withDet(prefixed))).toEqual({ ok: true })
    expect(await validateMessage('envEvento110111', withDet(DET.replace('<detEvento ', `<detEvento xmlns="${NS}" `)))).toEqual({ ok: true })
  })
  it('um detEvento dentro do outro (o conteúdo é `xs:any skip` no envelope) → recusa nossa pela D-NE39', async () => {
    expect(await validateMessage('envEvento110111', withDet(DET.replace('</xJust>', '</xJust><detEvento versao="1.00"/>')))).toEqual({
      ok: false, errors: ['envEvento: deve haver exatamente um detEvento (D-NE39)'],
    })
  })
  it('xmlns de outro namespace declarado e não usado num filho é só declaração: passa', async () => {
    expect(await validateMessage('envEvento110111', withDet(DET.replace('<nProt>', '<nProt xmlns:o="urn:outro">')))).toEqual({ ok: true })
  })
  it.each([['aspas', '1.00&quot;'], ['tab', '1.00&#9;']])('atributo com %s volta escapado e o e110111 recusa pelo versao (não por XML quebrado)', async (_l, v) => {
    const r = await validateMessage('envEvento110111', withDet(DET.replace('versao="1.00"', `versao="${v}"`)))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toEqual([expect.stringMatching(/attribute 'versao': \[facet 'enumeration'\]/)])
  })
  it('envelope que o libxml aceita e o leitor estrito recusa (DOCTYPE) → recusa nossa pelo N17', async () => {
    const env = fx.envEvento110111()
    const r = await validateMessage('envEvento110111', `<!DOCTYPE envEvento>${env}`)
    expect(r).toEqual({ ok: false, errors: ['envEvento: ilegível pelo leitor estrito (N17)'] })
  })
  it('o documento próprio é o detEvento INTEIRO: um campo errado no fim continua recusado pelo e110111', async () => {
    const r = await validateMessage('envEvento110111', withDet(DET.replace('</xJust>', '</xJust><extra>1</extra>')))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' | ')).toMatch(/extra/)
  })
  it.each([
    ['comentário', DET.replace('<nProt>', '<!-- x --><nProt>')],
    ['PI', DET.replace('<nProt>', '<?pi x?><nProt>')],
    ['CDATA', DET.replace('Cancelamento de teste em homologacao', '<![CDATA[Cancelamento de teste em homologacao]]>')],
    ['filho de outro namespace', DET.replace('</xJust>', '</xJust><o:x xmlns:o="urn:outro">1</o:x>')],
    ['atributo qualificado', DET.replace('versao="1.00"', 'versao="1.00" xmlns:o="urn:outro" o:a="1"')],
  ])('nó fora do e110111 no detEvento (%s) → recusa nossa, antes do libxml', async (_label, det) => {
    expect(await validateMessage('envEvento110111', withDet(det))).toEqual({
      ok: false, errors: ['envEvento: detEvento com nó fora do e110111 (outro namespace ou sem namespace, atributo qualificado, CDATA, comentário ou PI)'],
    })
  })
})

describe('os XSD são dado conferido (D-NE181)', () => {
  it('o manifesto cobre todos os arquivos dos conjuntos e confere com o disco', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(DEFAULT_XSD_DIR, 'MANIFESTO.json'), 'utf8')).files as Record<string, string>
    const used = new Set(Object.values(SCHEMA_SETS).flatMap(s => [s.root, ...Object.values(s.files)]))
    expect([...used].sort()).toEqual(Object.keys(manifest).sort())
    for (const [rel, hash] of Object.entries(manifest)) {
      expect([rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(DEFAULT_XSD_DIR, rel))).digest('hex')]).toEqual([rel, hash])
    }
    expect(() => loadSchemaSets()).not.toThrow()
  })
  it('manifesto com hash errado → recusa no carregamento', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(DEFAULT_XSD_DIR, 'MANIFESTO.json'), 'utf8')).files as Record<string, string>
    const bad = { ...manifest, [SCHEMA_SETS.consStatServ.root]: '0'.repeat(64) }
    expect(() => loadSchemaSets(DEFAULT_XSD_DIR, bad)).toThrow(XsdManifestError)
    expect(() => loadSchemaSets(DEFAULT_XSD_DIR, bad)).toThrow(/diferente do manifesto/)
  })
  it('include para http:// fora do conjunto → nosso erro antes do libxml (nunca rede)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd-'))
    const manifest: Record<string, string> = {}
    for (const rel of new Set(Object.values(SCHEMA_SETS).flatMap(s => [s.root, ...Object.values(s.files)]))) {
      let text = fs.readFileSync(path.join(DEFAULT_XSD_DIR, rel), 'utf8')
      if (rel === SCHEMA_SETS.consStatServ.root) text = text.replace('schemaLocation="leiauteConsStatServ_v4.00.xsd"', 'schemaLocation="http://exemplo.invalido/x.xsd"')
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
      fs.writeFileSync(path.join(tmp, rel), text)
      manifest[rel] = crypto.createHash('sha256').update(text).digest('hex')
    }
    expect(() => loadSchemaSets(tmp, manifest)).toThrow(/include fora do conjunto em consStatServ: http:\/\/exemplo\.invalido\/x\.xsd/)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('NFe — o documento do builder da NE-4 (NFE.E5.P3; raiz nfe_v4.00.xsd do PL_010f)', () => {
  it('a NFe vazia é recusada, com a lista de erros do validador (nunca passa calada)', async () => {
    const r = await validateMessage('NFe', '<NFe xmlns="http://www.portalfiscal.inf.br/nfe"></NFe>')
    expect(r.ok).toBe(false)
    expect((r as { errors: readonly string[] }).errors.join(' ')).toMatch(/infNFe/)
  })
  it('raiz de outra mensagem não passa como NFe', async () => {
    expect((await validateMessage('NFe', '<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"></enviNFe>')).ok).toBe(false)
  })
})

describe('os retornos do evento e da inutilização (NFE.E6.P2 mudança 1)', () => {
  const CH = '41261107742094000113550010000000151482130575'
  const NS = 'http://www.portalfiscal.inf.br/nfe'
  const retEvento = (cStat = '135', extra = '') =>
    `<retEnvEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb><verAplic>PR</verAplic><cOrgao>41</cOrgao><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>`
    + `<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>PR</verAplic><cOrgao>41</cOrgao><cStat>${cStat}</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>`
    + `<chNFe>${CH}</chNFe><tpEvento>110111</tpEvento><xEvento>Cancelamento registrado</xEvento><nSeqEvento>1</nSeqEvento><dhRegEvento>2026-11-25T10:00:00-03:00</dhRegEvento><nProt>141260000000002</nProt>${extra}</infEvento></retEvento></retEnvEvento>`
  const retInut = (cStat = '102', extra = '') =>
    `<retInutNFe xmlns="${NS}" versao="4.00"><infInut><tpAmb>2</tpAmb><verAplic>PR</verAplic><cStat>${cStat}</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo><cUF>41</cUF><ano>26</ano>`
    + `<CNPJ>07742094000113</CNPJ><mod>55</mod><serie>1</serie><nNFIni>10</nNFIni><nNFFin>12</nNFFin><dhRecbto>2026-11-25T10:00:00-03:00</dhRecbto><nProt>141260000000003</nProt>${extra}</infInut></retInutNFe>`

  it('retEnvEvento e retInutNFe reais da SEFAZ (montados na suíte) passam; sem o motivo ou com a versão trocada, caem', async () => {
    expect(await validateMessage('retEnvEvento', retEvento())).toEqual({ ok: true })
    expect(await validateMessage('retInutNFe', retInut())).toEqual({ ok: true })
    expect((await validateMessage('retEnvEvento', retEvento().replace(/<xMotivo>Evento[^<]*<\/xMotivo>/, ''))).ok).toBe(false)
    expect((await validateMessage('retEnvEvento', retEvento().replace('versao="1.00"><idLote', 'versao="9.99"><idLote'))).ok).toBe(false)
    expect((await validateMessage('retInutNFe', retInut().replace(/<xMotivo>[^<]*<\/xMotivo>/, ''))).ok).toBe(false)
    expect((await validateMessage('retInutNFe', retInut().replace('<mod>55</mod>', '<mod>77</mod>'))).ok).toBe(false)
  })

  it('os conjuntos do procEventoNFe e do procInutNFe carregam (as cópias estão no manifesto)', () => {
    for (const k of ['procEventoNFe', 'procInutNFe', 'retEnvEvento', 'retInutNFe'] as const) expect([k, typeof SCHEMA_SETS[k].root]).toEqual([k, 'string'])
    expect(() => loadSchemaSets()).not.toThrow()
  })
})

describe('NFe — o conjunto é o PL_010h (NFE.E5.P6, D-NE285): o total do Simples exige vBCIBSCBS', () => {
  // Aqui o XSD é provado com o `IBSCBSTot` escrito à mão; o builder que escreve o grupo é provado em nfe-ibscbs-2027.test.ts e no lote abaixo.
  const sale = () => buildNfeXml(saleInput({ dhEmi: '2026-11-24T10:15:30-03:00', installments: [{ dueDate: '2026-12-22', cents: 400000 }] }), saleKey({ emissionDate: '2026-11-24' }))
  const withTotal = (inner: string) => { const b = sale(); return signNfe({ ...b, xml: b.xml.replace('</ICMSTot>', `</ICMSTot><IBSCBSTot>${inner}</IBSCBSTot>`) }) }
  const GROUP = '<gTribSN><vIBSSN>4.00</vIBSSN><vCBSSN>36.00</vCBSSN></gTribSN>'
  it('IBSCBSTot só com gTribSN, sem vBCIBSCBS → recusa (o esquema é o 010h, que o exige)', async () => {
    const r = await validateMessage('NFe', withTotal(GROUP))
    expect(r.ok).toBe(false)
    expect((r as { errors: readonly string[] }).errors.join(' ')).toMatch(/Expected is \( \{http:\/\/www\.portalfiscal\.inf\.br\/nfe\}vBCIBSCBS \)/)
  })
  it('IBSCBSTot com vBCIBSCBS e gTribSN passa; a nota de 2026 sem o grupo continua passando', async () => {
    expect(await validateMessage('NFe', withTotal(`<vBCIBSCBS>4000.00</vBCIBSCBS>${GROUP}`))).toEqual({ ok: true })
    expect(await validateMessage('NFe', signNfe(sale()))).toEqual({ ok: true })
  })
})

describe('o lote da autorização e os retornos validam pelo PL_010h (NFE.E5.P7, junção — a lista da junção, item 3)', () => {
  it('o enviNFe com a NF-e do Simples de 2027 (cAtivSN e IBSCBS > gTribSN) passa; o mesmo XML sem vBCIBSCBS é recusado no lote', async () => {
    const s = sale2027()
    const signed = signNfe(buildNfeXml(s.input, s.key))
    expect(signed).toMatch(/<cAtivSN>/)
    expect(signed).toMatch(/<IBSCBS>[\s\S]*<gTribSN>/)
    expect(await validateMessage('enviNFe', enviNFe('1', signed))).toEqual({ ok: true })
    const b = buildNfeXml(s.input, s.key)
    const semBase = signNfe({ ...b, xml: b.xml.replace(/<vBCIBSCBS>[^<]*<\/vBCIBSCBS>/, '') })
    const r = await validateMessage('enviNFe', enviNFe('1', semBase))
    expect(r.ok).toBe(false)
    expect((r as { errors: readonly string[] }).errors.join(' ')).toMatch(/Expected is \( \{http:\/\/www\.portalfiscal\.inf\.br\/nfe\}vBCIBSCBS \)/)
  })

  it('nenhum conjunto aponta para o leiaute ou o DFeTiposBasicos do PL_010f; enviNFe, retEnviNFe e retConsReciNFe usam o PL_010h', () => {
    for (const [kind, set] of Object.entries(SCHEMA_SETS)) {
      const files = Object.values(set.files ?? {}) as string[]
      expect([kind, files.filter(f => /PL_010f_v1\.04\/(leiauteNFe|DFeTiposBasicos)/.test(f))]).toEqual([kind, []])
    }
    for (const k of ['enviNFe', 'retEnviNFe', 'retConsReciNFe'] as const) {
      expect([k, SCHEMA_SETS[k].files['leiauteNFe_v4.00.xsd'], SCHEMA_SETS[k].files['DFeTiposBasicos_v1.00.xsd']])
        .toEqual([k, 'PL_010h_v1.03/NFe/leiauteNFe_v4.00.xsd', 'PL_010h_v1.03/NFe/DFeTiposBasicos_v1.00.xsd'])
    }
  })
})
