/// <reference types="jest" />
// nfe-api:NFE.E4.P3.T3 — raízes ICP-Brasil do servidor da SEFAZ como dado (`src/authority/server-ca.ts`; D-NE187, D-NE202, D-NE54 a;
// RF-NFE-27). Ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e4-p3-xsd-respostas-raizes.md`, mudança 3.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { contextFromEnv } from '../context'
import { FAKE_TECH } from './technical-responsible-fake'
import { ServerCaRefusedError, fichaPathOf, loadServerCa } from '../authority/server-ca'

const PEM = path.resolve(__dirname, '..', '..', 'acervo', 'icp', 'raizes-icp-brasil.pem')
const FICHA = fichaPathOf(PEM)
const NOW = new Date('2026-11-21T12:00:00Z')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nfe-api-ca-'))
const refusal = (fn: () => unknown) => { try { fn(); return null } catch (e) { return e instanceof ServerCaRefusedError ? e.reason : String(e) } }

describe('as raízes do acervo carregam (ICP-Brasil v5 a v12, fonte = zip do ITI)', () => {
  it('PEM + ficha válidos → carrega as 6 raízes, na ordem da ficha', () => {
    const ca = loadServerCa(PEM, NOW)
    expect(ca.source).toBe('ITI ACcompactado.zip')
    expect(ca.certificates.map(c => c.file)).toEqual(
      ['ICP-Brasilv5.crt', 'ICP-Brasilv6.crt', 'ICP-Brasilv7.crt', 'ICP-Brasilv10.crt', 'ICP-Brasilv11.crt', 'ICP-Brasilv12.crt'])
    expect(ca.pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(6)
    expect(ca.certificates.every(c => /ICP-Brasil/.test(c.subject))).toBe(true)
  })
})

describe('o boot recusa (D-NE187)', () => {
  it('caminho ausente ou vazio', () => {
    expect(refusal(() => loadServerCa(undefined, NOW))).toBe('path-missing')
    expect(refusal(() => loadServerCa('  ', NOW))).toBe('path-missing')
  })
  it('arquivo inexistente', () => {
    expect(refusal(() => loadServerCa(path.join(tmp(), 'nao-existe.pem'), NOW))).toBe('file-missing')
  })
  it('PEM sem certificado', () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'r.pem'), '')
    fs.copyFileSync(FICHA, path.join(d, 'r.json'))
    expect(refusal(() => loadServerCa(path.join(d, 'r.pem'), NOW))).toBe('pem-empty')
  })
  it('ficha ausente', () => {
    const d = tmp()
    fs.copyFileSync(PEM, path.join(d, 'r.pem'))
    expect(refusal(() => loadServerCa(path.join(d, 'r.pem'), NOW))).toBe('ficha-missing')
  })
  it('PEM diferente da ficha (um certificado a menos; ordem trocada)', () => {
    const blocks = fs.readFileSync(PEM, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n?/g) ?? []
    const d = tmp()
    fs.writeFileSync(path.join(d, 'a.pem'), blocks.slice(1).join(''))
    fs.copyFileSync(FICHA, path.join(d, 'a.json'))
    expect(refusal(() => loadServerCa(path.join(d, 'a.pem'), NOW))).toBe('ficha-mismatch')
    fs.writeFileSync(path.join(d, 'b.pem'), [blocks[1], blocks[0], ...blocks.slice(2)].join(''))
    fs.copyFileSync(FICHA, path.join(d, 'b.json'))
    expect(refusal(() => loadServerCa(path.join(d, 'b.pem'), NOW))).toBe('ficha-mismatch')
  })
  it('certificado vencido na data (a v5 vence em 2029-03-02)', () => {
    expect(refusal(() => loadServerCa(PEM, new Date('2029-03-03T00:00:00Z')))).toBe('certificate-expired')
  })
  it('contextFromEnv sem SEFAZ_SERVER_CA_PATH → o serviço não sobe', () => {
    const env = { DB_HOST: 'x', DB_USER: 'x', DB_PASSWORD: 'x', FISCAL_DB_NAME: 'fiscal_api', STORAGE_PATH: tmp() } as NodeJS.ProcessEnv
    const over = { pool: { query: jest.fn(), getConnection: jest.fn() } as any, technicalResponsible: FAKE_TECH }   // DEPLOY.E1.P8
    expect(() => contextFromEnv(env, over)).toThrow(ServerCaRefusedError)
    expect(() => contextFromEnv(env, over)).toThrow(/SEFAZ_SERVER_CA_PATH/)
  })
})
