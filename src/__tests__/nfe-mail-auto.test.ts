/// <reference types="jest" />
/**
 * NFE.E6.P4 mudança 7 (ficha-nfe-e6-p4-rotas-email-operacao.md §6-7; D-NE237, D-NE261; S-3, S-10): a via AUTOMÁTICA do e-mail (depois da autorização) e o ALERTA de pendência crítica ao suporte pelo SMTP da
 * Setes. O gancho em si (só quem gravou a voz A, nunca desfaz o A) é provado em `nfe-transmission.test.ts` e `nfe-reconcile.test.ts`. Nenhuma conexão: transportes falsos; nenhum valor de variável
 * de ambiente, senha ou conteúdo de nota vai ao alerta, ao log ou à resposta.
 */
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import * as fiscal from 'fiscal-api'
import { invoiceRef, MasterKeyRing } from 'fiscal-api'
import type { AppContext } from '../context'
import { autoSendAfterAuthorization } from '../mail/invoice-mail'
import { INCIDENT_DEDUP_MS, OPS_ALERT_VARS, assertOpsAlertConfigured, createOpsAlert, incidentAlertMessage, isProduction, missingOpsAlertVars, reportIncident, resetIncidentDedup } from '../mail/ops-alert'
import * as invoicesService from '../modules/invoices/invoices.service'
import { Breaker } from '../nfe/breaker'
import { FAKE_TECH } from './technical-responsible-fake'

jest.mock('../modules/invoices/invoices.service', () => ({ ...jest.requireActual('../modules/invoices/invoices.service'), xml: jest.fn(), danfe: jest.fn() }))
jest.mock('../nfe/transmission', () => ({ ...jest.requireActual('../nfe/transmission'), transmitInvoice: jest.fn() }))
jest.mock('../nfe/reconcile', () => ({ ...jest.requireActual('../nfe/reconcile'), refreshInvoice: jest.fn(), reconfirmNotRegistered: jest.fn() }))
jest.mock('../nfe/refresh-all', () => ({ ...jest.requireActual('../nfe/refresh-all'), refreshAll: jest.fn() }))
jest.mock('fiscal-api', () => ({ ...jest.requireActual('fiscal-api'), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, openSmtpCredential: jest.fn(), acquireRefreshLease: jest.fn(), releaseRefreshLease: jest.fn() }))
jest.setTimeout(60_000)

const f = fiscal as unknown as Record<string, any>
const xmlM = (invoicesService as unknown as Record<string, jest.Mock>).xml
const danfeM = (invoicesService as unknown as Record<string, jest.Mock>).danfe
const KEY = '41261107742094000113550010000000151514710954'
const SECRET = 'S3nh4-da-Setes-NAO-VAZAR'
const ACCOUNT = { host: 'smtp.cliente.com.br', port: 587, security: 'starttls' as const, username: 'nfe@cliente.com.br', senderAddress: 'nfe@cliente.com.br', password: SECRET }
const EVENT = { actor: { institutionId: 98, schemaName: 'setes_x', userId: 7 }, ref: invoiceRef(98, 5001, 0), attempt: 1, accessKey: KEY }
const ENV_OK = { SMTP_HOST: 'smtp.setes.com.br', SMTP_PORT: '587', SMTP_USER: 'alertas@setes.com.br', SMTP_PASSWORD: SECRET, SMTP_FROM: 'alertas@setes.com.br', OPS_ALERT_EMAIL: 'suporte@setes.com.br' } as NodeJS.ProcessEnv

const ctx = (config: Array<{ name: string; content: string }> = []): AppContext => ({
  db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' }, pool: { query: jest.fn(async () => [config]), getConnection: jest.fn() } as any, keyring: MasterKeyRing.of({ 1: randomBytes(32) }),
  storage: {} as never, fiscalDb: 'fiscal_api', verifier: {} as never, corsOrigins: [], checkIdentity: false, serverCa: {} as never, technicalResponsible: FAKE_TECH, breaker: new Breaker(() => new Date()),
})
const loggedAll = (): string => JSON.stringify([...(f.logger.info as jest.Mock).mock.calls, ...(f.logger.warn as jest.Mock).mock.calls])

beforeEach(() => {
  jest.clearAllMocks()
  resetIncidentDedup()
  xmlM.mockResolvedValue({ accessKey: KEY, procNFe: '<nfeProc/>', cancelEvent: null })
  danfeM.mockResolvedValue({ accessKey: KEY, pdfBase64: 'JVBERg==' })
  f.openSmtpCredential.mockResolvedValue(ACCOUNT)
})

describe('autoSendAfterAuthorization — a via automática (D-NE261)', () => {
  it('opção ligada e destinatário: envia pela conta do estabelecimento, com a MESMA composição do botão (procNFe + DANFE, assunto da empresa)', async () => {
    const sendMail = jest.fn(async () => ({ messageId: '<a@x>' }))
    const r = await autoSendAfterAuthorization(ctx([{ name: 'nfe_email_subject', content: 'NF-e {number}' }]), EVENT, { createTransport: () => ({ sendMail }), recipients: async () => ['dest@x.com'] })
    expect(r).toBe('sent')
    const m = (sendMail.mock.calls[0] as unknown as [any])[0]
    expect([m.to, m.subject, m.from, m.attachments.map((a: any) => a.filename)]).toEqual([['dest@x.com'], 'NF-e 15', 'nfe@cliente.com.br', [`${KEY}-procNFe.xml`, `DANFE-${KEY}.pdf`]])
  })

  it('opção DESLIGADA na empresa (`fiscal_email_auto_send` = N): não envia nem abre a conta', async () => {
    const sendMail = jest.fn()
    const r = await autoSendAfterAuthorization(ctx([{ name: 'fiscal_email_auto_send', content: 'N' }]), EVENT, { createTransport: () => ({ sendMail }), recipients: async () => ['dest@x.com'] })
    expect(r).toBe('off')
    expect([sendMail.mock.calls.length, f.openSmtpCredential.mock.calls.length]).toEqual([0, 0])
    expect([xmlM.mock.calls.length, danfeM.mock.calls.length]).toEqual([0, 0])                  // nem lê o arquivo nem renderiza o DANFE (até 20 s numa nota longa) à toa
  })

  it('sem destinatário no cadastro (e hoje sem leitor, por falta do GRANT): nada é enviado, só o log informativo sem endereço', async () => {
    const sendMail = jest.fn()
    expect(await autoSendAfterAuthorization(ctx(), EVENT, { createTransport: () => ({ sendMail }) })).toBe('no-recipient')
    expect(await autoSendAfterAuthorization(ctx(), EVENT, { createTransport: () => ({ sendMail }), recipients: async () => [] })).toBe('no-recipient')
    expect(sendMail).not.toHaveBeenCalled()
    expect([xmlM.mock.calls.length, danfeM.mock.calls.length]).toEqual([0, 0])
    expect(loggedAll()).toContain(KEY)
  })

  it('NUNCA lança: conta sem cadastro, servidor recusando e arquivo faltando viram "failed" com log do código técnico — sem senha, sem endereço', async () => {
    const boom = Object.assign(new Error(`535 senha ${SECRET} recusada para nfe@cliente.com.br`), { code: 'EAUTH' })
    expect(await autoSendAfterAuthorization(ctx(), EVENT, { createTransport: () => ({ sendMail: async () => { throw boom } }), recipients: async () => ['dest@x.com'] })).toBe('failed')
    f.openSmtpCredential.mockRejectedValueOnce(new fiscal.HttpError(409, 'sem conta', undefined, 'SMTP_CREDENTIAL_MISSING'))
    expect(await autoSendAfterAuthorization(ctx(), EVENT, { recipients: async () => ['dest@x.com'] })).toBe('failed')
    xmlM.mockRejectedValueOnce(new fiscal.HttpError(409, 'sem arquivo', undefined, 'FISCAL_FILE_MISSING'))
    expect(await autoSendAfterAuthorization(ctx(), EVENT, { recipients: async () => ['dest@x.com'] })).toBe('failed')
    const log = loggedAll()
    expect(log).not.toContain(SECRET); expect(log).not.toContain('nfe@cliente.com.br'); expect(log).toContain('EAUTH'); expect(log).toContain('SMTP_CREDENTIAL_MISSING')
  })

  it('o destino automático respeita o teto de 5', async () => {
    const sendMail = jest.fn(async () => ({}))
    await autoSendAfterAuthorization(ctx(), EVENT, { createTransport: () => ({ sendMail }), recipients: async () => Array.from({ length: 9 }, (_, i) => `u${i}@x.com`) })
    expect((sendMail.mock.calls[0] as unknown as [any])[0].to).toHaveLength(5)
  })
})

describe('o alerta de pendência crítica ao suporte (D-NE237, S-10)', () => {
  it('produção sem qualquer das seis variáveis recusa o boot dizendo os NOMES que faltam — nunca os valores', () => {
    expect(OPS_ALERT_VARS).toEqual(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'OPS_ALERT_EMAIL'])
    for (const name of OPS_ALERT_VARS) {
      const env = { ...ENV_OK, NODE_ENV: 'production', [name]: '  ' } as NodeJS.ProcessEnv
      let msg = ''
      try { assertOpsAlertConfigured(env) } catch (e) { msg = (e as Error).message }
      expect([name, msg.includes(name)]).toEqual([name, true])
      expect(msg).not.toContain(SECRET)
    }
    expect(() => assertOpsAlertConfigured({ ...ENV_OK, NODE_ENV: 'production', SMTP_PORT: '99999' })).toThrow(/SMTP_PORT/)
    expect(assertOpsAlertConfigured({ ...ENV_OK, NODE_ENV: 'production' })).toBe('configurado (produção)')
    expect(() => assertOpsAlertConfigured({ NODE_ENV: 'production' })).toThrow(/faltam as variáveis SMTP_HOST, SMTP_PORT/)
  })

  it('"production" é lido normalizado (caixa e espaços); "prod" não é produção', () => {
    expect([' Production ', 'production', 'PRODUCTION'].map(v => isProduction({ NODE_ENV: v }))).toEqual([true, true, true])
    expect([isProduction({ NODE_ENV: 'prod' }), isProduction({}), isProduction({ NODE_ENV: 'development' })]).toEqual([false, false, false])
  })

  it('fora de produção sem nada: sobe e o alerta vai só ao log; com configuração pela metade avisa sem valor', () => {
    expect(assertOpsAlertConfigured({})).toMatch(/só ao log/)
    expect(assertOpsAlertConfigured(ENV_OK)).toBe('configurado')
    assertOpsAlertConfigured({ SMTP_HOST: 'x', SMTP_PASSWORD: SECRET })
    expect(JSON.stringify((f.logger.warn as jest.Mock).mock.calls)).not.toContain(SECRET)
    expect(missingOpsAlertVars({ SMTP_HOST: 'x' })).toHaveLength(5)
  })

  it('o emissor envia pelo SMTP da SETES (nunca pelo do cliente) para o OPS_ALERT_EMAIL; sem configuração só loga; falha do envio nunca lança', async () => {
    const sendMail = jest.fn(async () => ({}))
    await createOpsAlert(ENV_OK, () => ({ sendMail }))('assunto', 'texto')
    expect((sendMail.mock.calls[0] as unknown as [any])[0]).toEqual({ from: 'alertas@setes.com.br', to: 'suporte@setes.com.br', subject: 'assunto', text: 'texto' })
    expect(f.openSmtpCredential).not.toHaveBeenCalled()                                       // a conta do contribuinte nunca entra aqui
    const spy = jest.fn()
    await createOpsAlert({}, () => ({ sendMail: spy }))('assunto', 'texto')
    expect(spy).not.toHaveBeenCalled()
    await expect(createOpsAlert(ENV_OK, () => ({ sendMail: async () => { throw Object.assign(new Error(`falhou ${SECRET}`), { code: 'ECONNREFUSED' }) } }))('a', 't')).resolves.toBeUndefined()
    expect(loggedAll()).not.toContain(SECRET)
    expect(loggedAll()).toContain('ECONNREFUSED')
  })

  it('a mensagem leva só ids, a chave de acesso e o CÓDIGO da pendência — nada do documento nem de segredo', () => {
    const m = incidentAlertMessage({ route: 'refresh', institutionId: 98, invoiceId: 5001, accessKey: KEY, incident: 'digest-mismatch' })
    expect(m.subject).toBe('[nfe-api] pendência crítica: digest-mismatch')
    for (const part of ['digest-mismatch', 'refresh', '98', '5001', KEY]) expect(m.text).toContain(part)
    expect(m.text).not.toMatch(/senha|password|csrt/i)
  })

  it('reportIncident não espera nem pode falhar: o emissor que rejeita não vira erro; sem emissor no contexto não faz nada', async () => {
    const alert = jest.fn(async () => { throw new Error('caiu') })
    expect(() => reportIncident({ opsAlert: alert }, { route: 'transmit', institutionId: 1, invoiceId: 2, accessKey: KEY, incident: 'file-conflict' })).not.toThrow()
    await new Promise(r => setImmediate(r))
    expect(alert).toHaveBeenCalledTimes(1)
    expect(() => reportIncident({}, { route: 'transmit', institutionId: 1, invoiceId: 2, accessKey: null, incident: 'x' })).not.toThrow()
  })

  it('a MESMA pendência avisa UMA vez por janela (a passada repete a consulta e a pendência continua): outra nota, outro código ou a janela vencida avisam de novo', () => {
    const alert = jest.fn(async () => undefined)
    const a = { route: 'refresh-all', institutionId: 1, invoiceId: 2, accessKey: KEY, incident: 'digest-mismatch' }
    reportIncident({ opsAlert: alert }, a, 1_000); reportIncident({ opsAlert: alert }, a, 1_000 + 60_000); reportIncident({ opsAlert: alert }, a, 1_000 + INCIDENT_DEDUP_MS - 1)
    expect(alert).toHaveBeenCalledTimes(1)
    reportIncident({ opsAlert: alert }, { ...a, invoiceId: 3 }, 2_000); reportIncident({ opsAlert: alert }, { ...a, incident: 'file-conflict' }, 2_000); reportIncident({ opsAlert: alert }, { ...a, institutionId: 9 }, 2_000)
    expect(alert).toHaveBeenCalledTimes(4)
    reportIncident({ opsAlert: alert }, a, 1_000 + INCIDENT_DEDUP_MS)
    expect(alert).toHaveBeenCalledTimes(5)
  })

  it('cada rota com pendência crítica AVISA o suporte (comportamento): transmit, refresh, reconfirm e a passada do rodízio; sem incidente, silêncio', async () => {
    const real = jest.requireActual('../modules/invoices/invoices.service') as typeof import('../modules/invoices/invoices.service')
    const ops = jest.requireActual('../modules/operations/operations.service') as typeof import('../modules/operations/operations.service')
    const alert = jest.fn(async () => undefined)
    const c = { ...ctx(), opsAlert: alert }
    const inst = { institutionId: 98, userId: 7, schemaName: 'setes_x' } as any
    const tick = () => new Promise(r => setImmediate(r))
    const base = { invoiceId: 5001, attempt: 1, accessKey: KEY, via: 'key' as const, outcome: { kind: 'none' as const, reason: 'digest-divergente' }, digestCheck: 'mismatch' as const, notRegistered: false, next: null }
    const tx = jest.requireMock('../nfe/transmission') as { transmitInvoice: jest.Mock }
    const rc = jest.requireMock('../nfe/reconcile') as { refreshInvoice: jest.Mock; reconfirmNotRegistered: jest.Mock }
    tx.transmitInvoice.mockResolvedValue({ invoiceId: 5001, attempt: 1, accessKey: KEY, number: 15, serie: 1, outcome: { kind: 'A', authorityCode: '100', message: 'm' }, nProt: '1', nRec: null, next: null, authorityCode: '100', incident: 'file-conflict' })
    await real.transmit(c, inst, EVENT.ref); await tick()
    rc.refreshInvoice.mockResolvedValue({ ...base, incident: 'digest-mismatch' })
    await real.refresh(c, inst, EVENT.ref, false); await tick()
    rc.reconfirmNotRegistered.mockResolvedValue({ invoiceId: 5001, attempt: 1, accessKey: KEY, recorded: false, reason: 'nao-e-217', refresh: { ...base, incident: 'authorized-in-closed-attempt' } })
    await real.reconfirm(c, inst, EVENT.ref); await tick()
    expect(alert.mock.calls.map(x => (x as unknown as [string])[0])).toEqual(['[nfe-api] pendência crítica: file-conflict', '[nfe-api] pendência crítica: digest-mismatch', '[nfe-api] pendência crítica: authorized-in-closed-attempt'])
    alert.mockClear()
    rc.refreshInvoice.mockResolvedValue({ ...base, incident: null })
    await real.refresh(c, inst, EVENT.ref, false); await tick()
    expect(alert).not.toHaveBeenCalled()                                                       // sem pendência, nenhum alerta
    f.acquireRefreshLease.mockResolvedValue('tok'); f.releaseRefreshLease.mockResolvedValue(true)
    const all = jest.requireMock('../nfe/refresh-all') as { refreshAll: jest.Mock }
    all.refreshAll.mockResolvedValue({ scanned: 1, consulted: 1, throttled: 0, tooOld: 0, skipped: 0, circuitOpen: false, changed: 0, incidents: [{ invoiceId: 77, incident: 'open-attempt-outside-current-life' }], results: [] })
    await ops.refreshRun(c, inst, {}); await tick()
    expect(alert.mock.calls.map(x => (x as unknown as [string])[0])).toEqual(['[nfe-api] pendência crítica: open-attempt-outside-current-life'])
  })

  it('o boot confere as variáveis ANTES de ouvir a porta, uma vez', () => {
    const src = read()
    expect(src.indexOf('assertOpsAlertConfigured(process.env)')).toBeGreaterThan(0)
    expect(src.indexOf('assertOpsAlertConfigured(process.env)')).toBeLessThan(src.indexOf('.listen('))
    expect(src.match(/assertOpsAlertConfigured\(/g)).toHaveLength(1)
    function read(): string { return fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8') }
  })
})
