/// <reference types="jest" />
// nfe-api:NFE.E4.P3.T1 — validação XSD local (`src/authority/xsd.ts`; D-NE181, D-NE115, D-NE211, D-NE43; RF-NFE-19). Ficha
// `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e4-p3-xsd-respostas-raizes.md`, mudança 1. Nada vai à rede.
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DEFAULT_XSD_DIR, SCHEMA_SETS, XsdManifestError, loadSchemaSets, validateMessage, type MessageKind } from '../authority/xsd'
import * as fx from './xsd-fixtures'

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
