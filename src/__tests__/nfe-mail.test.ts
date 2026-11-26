/// <reference types="jest" />
/**
 * NFE.E6.P4 mudança 6 (ficha-nfe-e6-p4-rotas-email-operacao.md §6-6; D-NE53, D-NE236, D-NE261, D-NE264; S-1 a S-4, S-15): a conta de envio do estabelecimento (cadastro pela rota do emitente), o
 * envio pela conta do CONTRIBUINTE e o e-mail da nota (anexos, assunto, corpo, destinatário). Nenhuma conexão: o transporte é falso e o `nodemailer` nunca abre rede. A SENHA nunca sai: nem em
 * resposta, nem em erro, nem em log, nem no texto do e-mail.
 */
import fs from 'fs'
import path from 'path'
import { generateKeyPairSync, randomBytes } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { FsFiscalStorage, HttpError, MasterKeyRing, ProductTokenVerifier, invoiceRef } from 'fiscal-api'
import { createApp } from '../app'
import type { AppContext } from '../context'
import { loadServerCa } from '../authority/server-ca'
import { Breaker } from '../nfe/breaker'
import { sendThroughClientAccount, type MailTransport } from '../mail/client-mailer'
import { MAIL_BODY, composeInvoiceMail, recipientsOf, subjectOf } from '../mail/invoice-mail'
import * as invoicesService from '../modules/invoices/invoices.service'
import * as smtpService from '../modules/emitter/smtp-credential.service'
import { FAKE_TECH } from './technical-responsible-fake'

jest.mock('../modules/invoices/invoices.service', () => ({ ...jest.requireActual('../modules/invoices/invoices.service'), xml: jest.fn(), danfe: jest.fn() }))
jest.mock('../modules/emitter/smtp-credential.service', () => ({ saveSendingAccount: jest.fn(), getSendingAccountStatus: jest.fn(), removeSendingAccount: jest.fn() }))
jest.mock('../mail/invoice-mail', () => ({ ...jest.requireActual('../mail/invoice-mail'), sendInvoiceEmail: jest.fn() }))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    openSmtpCredential: jest.fn(),
    erp: { ...actual.erp, orderInterface: jest.fn(), institutionZone: jest.fn() },
    access: { ...actual.access, liveIdentity: jest.fn(), accessVerdict: jest.fn(), reachableKeys: jest.fn() },
  }
})
jest.setTimeout(60_000)

const f = fiscal as unknown as Record<string, any>
const accessM = f.access as Record<string, jest.Mock>
const erpM = f.erp as Record<string, jest.Mock>
const xmlM = (invoicesService as unknown as Record<string, jest.Mock>).xml
const danfeM = (invoicesService as unknown as Record<string, jest.Mock>).danfe
const smtpM = smtpService as unknown as Record<string, jest.Mock>
const mailModule = jest.requireMock('../mail/invoice-mail') as { sendInvoiceEmail: jest.Mock }
const actualMail = jest.requireActual('../mail/invoice-mail') as typeof import('../mail/invoice-mail')

const SECRET = 'S3nh4-Super-Secreta-do-Cliente'
const ACCOUNT = { host: 'smtp.cliente.com.br', port: 587, security: 'starttls' as const, username: 'nfe@cliente.com.br', senderAddress: 'nfe@cliente.com.br', password: SECRET }
const KEY = '41261107742094000113550010000000151514710954'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const token = () => jwt.sign({ institutionId: 1, userId: 7, schemaName: 'setes_setes' }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
const SERVER_CA = loadServerCa(path.resolve(__dirname, '..', '..', 'acervo', 'icp', 'raizes-icp-brasil.pem'), new Date('2026-11-21T12:00:00Z'))
const ctx = (over: Partial<AppContext> = {}): AppContext => ({
  db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
  pool: { query: jest.fn(async () => [[]]), getConnection: jest.fn() } as any, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage('/tmp/nfe-mail-nao-usado'),
  fiscalDb: 'fiscal_api', verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: [], checkIdentity: true, serverCa: SERVER_CA, technicalResponsible: FAKE_TECH, breaker: new Breaker(() => new Date()), ...over,
})
const A = { Authorization: `Bearer ${token()}` }
const inst = { institutionId: 1, userId: 7, schemaName: 'setes_setes' } as any
const ref = invoiceRef(1, 5001, 0)

/** `Queryable` falso que responde pelo texto do SQL. */
function fakeQ(handlers: { match: RegExp; rows: any[] | ((p: unknown) => any[]) }[]) {
  const calls: { sql: string; params: any }[] = []
  return { calls, async query(sql: string, params?: any): Promise<[any, any]> { calls.push({ sql, params }); const h = handlers.find(x => x.match.test(sql)); if (!h) throw new Error(`SQL sem resposta: ${sql.slice(0, 70)}`); return [typeof h.rows === 'function' ? h.rows(params) : h.rows, []] } }
}

beforeEach(() => {
  jest.clearAllMocks()
  accessM.liveIdentity.mockImplementation(async (_q: unknown, p: any) => ({ ...p, role: 'admin' }))
  accessM.accessVerdict.mockResolvedValue('ok'); accessM.reachableKeys.mockResolvedValue(['orders'])
  erpM.orderInterface.mockResolvedValue('orders'); erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
})

describe('sendThroughClientAccount — o envio pela conta do contribuinte', () => {
  const mail = { to: ['cliente@dest.com.br'], subject: 'Envio de NF-e Nº 15', text: 'corpo', attachments: [{ filename: 'a.xml', content: '<x/>', contentType: 'application/xml' }] }
  const deps = (transport: MailTransport) => ({ pool: {} as never, keyring: {} as never, createTransport: jest.fn(() => transport) })

  it('abre a conta UMA vez, monta o transporte com a conta e envia: remetente = o da conta; a senha só vai ao transporte, nunca à mensagem', async () => {
    f.openSmtpCredential.mockResolvedValue(ACCOUNT)
    const sendMail = jest.fn(async () => ({ messageId: '<id@x>' }))
    const d = deps({ sendMail })
    const r = await sendThroughClientAccount(d, 1, mail)
    expect(r).toEqual({ messageId: '<id@x>', from: 'nfe@cliente.com.br' })
    expect(f.openSmtpCredential).toHaveBeenCalledTimes(1)
    expect(f.openSmtpCredential.mock.calls[0][1]).toBe(1)
    expect(d.createTransport).toHaveBeenCalledWith(ACCOUNT)
    const sent = sendMail.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(sent[0]).toMatchObject({ from: 'nfe@cliente.com.br', to: ['cliente@dest.com.br'], subject: 'Envio de NF-e Nº 15', text: 'corpo' })
    expect(JSON.stringify(sent[0])).not.toContain(SECRET)
  })

  it('os erros da conta são os do núcleo, sem enviar nada: sem conta 409, senha ilegível 409, sem chave-mestra 503', async () => {
    const sendMail = jest.fn()
    for (const [status, code] of [[409, 'SMTP_CREDENTIAL_MISSING'], [409, 'SMTP_CREDENTIAL_UNREADABLE'], [503, 'MASTER_KEY_UNAVAILABLE']] as const) {
      f.openSmtpCredential.mockRejectedValueOnce(new HttpError(status, 'x', undefined, code))
      await expect(sendThroughClientAccount(deps({ sendMail }), 1, mail)).rejects.toMatchObject({ statusCode: status, code })
    }
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('falha do servidor = 502 FISCAL_EMAIL_SEND_FAILED só com o CÓDIGO técnico; o texto do servidor e a senha não vão à resposta nem ao log', async () => {
    f.openSmtpCredential.mockResolvedValue(ACCOUNT)
    const boom = Object.assign(new Error(`535 5.7.8 usuario nfe@cliente.com.br senha ${SECRET} recusada`), { code: 'EAUTH' })
    const e: any = await sendThroughClientAccount(deps({ sendMail: jest.fn(async () => { throw boom }) }), 1, mail).catch(x => x)
    expect([e.statusCode, e.code, e.fields]).toEqual([502, 'FISCAL_EMAIL_SEND_FAILED', [{ field: 'smtp', message: 'EAUTH' }]])
    const logged = JSON.stringify((f.logger.warn as jest.Mock).mock.calls)
    expect(JSON.stringify(e)).not.toContain(SECRET); expect(e.message).not.toContain(SECRET)
    expect(logged).not.toContain(SECRET); expect(logged).not.toContain('nfe@cliente.com.br')
  })

  it('o transporte real: TLS implícito só em `tls`, STARTTLS exigido em `starttls`, nunca sem cifra (sem abrir conexão)', () => {
    const { realTransport } = jest.requireActual('../mail/client-mailer') as typeof import('../mail/client-mailer')
    for (const [security, secure, requireTLS] of [['tls', true, false], ['starttls', false, true]] as const) {
      const t = realTransport({ ...ACCOUNT, security, port: secure ? 465 : 587 }) as unknown as { options: Record<string, any> }
      expect([security, t.options.secure, t.options.requireTLS, t.options.tls.minVersion]).toEqual([security, secure, requireTLS, 'TLSv1.2'])
      expect([t.options.host, t.options.auth.user]).toEqual(['smtp.cliente.com.br', 'nfe@cliente.com.br'])
    }
  })

  it('cerca de texto: a senha só aparece no transporte real (uma linha) — nenhuma interpolação em log ou erro neste arquivo', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'mail', 'client-mailer.ts'), 'utf8')
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    expect(code.filter(l => /\bpassword\b/.test(l))).toHaveLength(1)                         // só o `pass:` do transporte real
    expect(code.filter(l => /logger\.|new HttpError/.test(l) && /password|pass\b|account\b/.test(l))).toEqual([])
  })
})

describe('o e-mail da nota — composição e destinatário (as duas vias usam a mesma)', () => {
  it('subjectOf: {number} vira o número; sem marcador fica o texto; em branco cai no padrão do ERP Desktop; quebra de linha não passa', () => {
    expect(subjectOf('Envio de NF-e Nº {number}', 15)).toBe('Envio de NF-e Nº 15')
    expect(subjectOf('NF-e {number} e {number}', 7)).toBe('NF-e 7 e 7')
    expect(subjectOf('Sua nota chegou', 15)).toBe('Sua nota chegou')
    expect(subjectOf('   ', 15)).toBe('Envio de NF-e Nº 15')
    expect(subjectOf('Linha\r\nBcc: x@y.com {number}', 3)).toBe('Linha Bcc: x@y.com 3')
  })

  it('compõe: procNFe + DANFE (e o procEventoNFe se cancelada); assunto da configuração; corpo fixo com número, série e chave', async () => {
    xmlM.mockResolvedValue({ accessKey: KEY, procNFe: '<nfeProc/>', cancelEvent: null })
    danfeM.mockResolvedValue({ accessKey: KEY, pdfBase64: Buffer.from('%PDF-1.4').toString('base64') })
    const c = ctx({ pool: { query: jest.fn(async () => [[{ name: 'nfe_email_subject', content: 'NF-e {number} da empresa' }, { name: 'fiscal_email_auto_send', content: 'S' }]]) } as any })
    const r = await composeInvoiceMail(c, inst, ref)
    expect([r.number, r.serie, r.autoSend, r.mail.subject]).toEqual([15, 1, true, 'NF-e 15 da empresa'])
    expect(r.mail.attachments.map(a => [a.filename, a.contentType])).toEqual([[`${KEY}-procNFe.xml`, 'application/xml'], [`DANFE-${KEY}.pdf`, 'application/pdf']])
    expect(Buffer.from(r.mail.attachments[1].content as Buffer).toString()).toBe('%PDF-1.4')
    expect(r.mail.text).toBe(MAIL_BODY({ number: 15, serie: 1, accessKey: KEY }))
    expect(r.mail.text).toContain(KEY)
    xmlM.mockResolvedValue({ accessKey: KEY, procNFe: '<nfeProc/>', cancelEvent: '<procEventoNFe/>' })
    expect((await composeInvoiceMail(c, inst, ref)).mail.attachments.map(a => a.filename)).toContain(`${KEY}-evt110111-proc.xml`)
  })

  it('nota sem autorização ou sem arquivo: o erro dos leitores (409) sobe e nada é composto', async () => {
    xmlM.mockRejectedValueOnce(new HttpError(409, 'não há NF-e', undefined, 'FISCAL_NOT_AUTHORIZED'))
    await expect(composeInvoiceMail(ctx(), inst, ref)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_NOT_AUTHORIZED' })
  })

  it('destinatário: o `to` do pedido vale (sem repetidos, no máximo 5); sem `to` = 422 FISCAL_RECIPIENT_EMAIL_MISSING (o cadastro ainda não é lido: sem GRANT)', async () => {
    const c = ctx()
    expect(await recipientsOf(c, inst, ref, ['a@x.com', 'a@x.com', 'b@x.com'])).toEqual(['a@x.com', 'b@x.com'])
    expect(await recipientsOf(c, inst, ref, ['1@x.com', '2@x.com', '3@x.com', '4@x.com', '5@x.com', '6@x.com'])).toHaveLength(5)
    await expect(recipientsOf(c, inst, ref)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_RECIPIENT_EMAIL_MISSING' })
    await expect(recipientsOf(c, inst, ref, [])).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_RECIPIENT_EMAIL_MISSING' })
  })

  it('o envio manual compõe, resolve o destino e envia pela conta do estabelecimento; sem destinatário NADA é enviado', async () => {
    xmlM.mockResolvedValue({ accessKey: KEY, procNFe: '<nfeProc/>', cancelEvent: null })
    danfeM.mockResolvedValue({ accessKey: KEY, pdfBase64: 'JVBERg==' })
    f.openSmtpCredential.mockResolvedValue(ACCOUNT)
    const sendMail = jest.fn(async () => ({ messageId: '<m@x>' }))
    const c = ctx({ pool: fakeQ([{ match: /tb_interface_has_config/, rows: [] }]) as never })
    const r = await actualMail.sendInvoiceEmail(c, inst, ref, ['dest@x.com'], { createTransport: () => ({ sendMail }) })
    expect(r).toEqual({ accessKey: KEY, to: ['dest@x.com'], messageId: '<m@x>' })
    expect((sendMail.mock.calls[0] as unknown as [any])[0].subject).toBe('Envio de NF-e Nº 15')
    const none = ctx({ pool: fakeQ([{ match: /tb_interface_has_config/, rows: [] }]) as never })
    await expect(actualMail.sendInvoiceEmail(none, inst, ref, undefined, { createTransport: () => ({ sendMail }) })).rejects.toMatchObject({ code: 'FISCAL_RECIPIENT_EMAIL_MISSING' })
    expect(sendMail).toHaveBeenCalledTimes(1)
  })
})

describe('POST /v1/nfe/invoices/{id}/email e /v1/emitter/smtp-credential (rotas)', () => {
  it('e-mail: pede TRANSMITIR do ramo; o corpo é opcional; `to` até 5 e válido; campo a mais = 400', async () => {
    mailModule.sendInvoiceEmail.mockResolvedValue({ accessKey: KEY, to: ['d@x.com'], messageId: null })
    const ok = await request(createApp(ctx())).post('/v1/nfe/invoices/5001/email').set(A).send({ to: ['d@x.com'] })
    expect([ok.status, ok.body.data.to]).toEqual([200, ['d@x.com']])
    expect(accessM.accessVerdict.mock.calls[0].slice(2)).toEqual([['orders'], 'TRANSMITIR'])
    expect(mailModule.sendInvoiceEmail.mock.calls[0][3]).toEqual(['d@x.com'])
    expect((await request(createApp(ctx())).post('/v1/nfe/invoices/5001/email').set(A)).status).toBe(200)
    expect(mailModule.sendInvoiceEmail.mock.calls[1][3]).toBeUndefined()
    for (const body of [{ to: ['nao-e-email'] }, { to: [] }, { to: Array.from({ length: 6 }, (_, i) => `u${i}@x.com`) }, { to: ['a@x.com'], cc: ['b@x.com'] }]) {
      expect((await request(createApp(ctx())).post('/v1/nfe/invoices/5001/email').set(A).send(body)).body.code).toBe('VALIDATION_FAILED')
    }
    accessM.accessVerdict.mockResolvedValueOnce('no-privilege')
    expect((await request(createApp(ctx())).post('/v1/nfe/invoices/5001/email').set(A).send({})).status).toBe(403)
    expect(mailModule.sendInvoiceEmail).toHaveBeenCalledTimes(2)
  })

  const status = { configured: true, host: 'smtp.cliente.com.br', port: 587, security: 'starttls', username: 'nfe@cliente.com.br', senderAddress: 'nfe@cliente.com.br', updatedAt: '2026-11-26T20:00:00.000Z' }

  it('credencial: ato do admin (perfil comum = 403); PUT/GET/DELETE devolvem só a situação — a resposta nunca carrega a senha', async () => {
    smtpM.saveSendingAccount.mockResolvedValue(status); smtpM.getSendingAccountStatus.mockResolvedValue(status); smtpM.removeSendingAccount.mockResolvedValue({ ...status, configured: false })
    const body = { host: 'smtp.cliente.com.br', port: 587, security: 'starttls', username: 'nfe@cliente.com.br', senderAddress: 'nfe@cliente.com.br', password: SECRET }
    const put = await request(createApp(ctx())).put('/v1/emitter/smtp-credential').set(A).send(body)
    const get = await request(createApp(ctx())).get('/v1/emitter/smtp-credential').set(A)
    const del = await request(createApp(ctx())).delete('/v1/emitter/smtp-credential').set(A)
    expect([put.status, get.status, del.status, del.body.data.configured]).toEqual([200, 200, 200, false])
    for (const r of [put, get, del]) expect(JSON.stringify(r.body)).not.toContain(SECRET)
    expect(smtpM.saveSendingAccount.mock.calls[0][2]).toEqual(body)
    accessM.liveIdentity.mockImplementation(async (_q: unknown, p: any) => ({ ...p, role: 'user' }))
    for (const r of await Promise.all([request(createApp(ctx())).put('/v1/emitter/smtp-credential').set(A).send(body), request(createApp(ctx())).get('/v1/emitter/smtp-credential').set(A), request(createApp(ctx())).delete('/v1/emitter/smtp-credential').set(A)])) {
      expect([r.status, r.body.code]).toEqual([403, 'ADMIN_REQUIRED'])
    }
    expect(smtpM.saveSendingAccount).toHaveBeenCalledTimes(1)
  })

  it('credencial: o corpo é estrito — segurança sem cifra, porta fora de 1–65535, campo a mais ou faltando = 400, e a senha NÃO é ecoada no erro', async () => {
    const body = { host: 'smtp.cliente.com.br', port: 587, security: 'starttls', username: 'nfe@cliente.com.br', senderAddress: 'nfe@cliente.com.br', password: SECRET }
    for (const bad of [{ ...body, security: 'none' }, { ...body, security: 'plain' }, { ...body, port: 0 }, { ...body, port: 70000 }, { ...body, extra: 1 }, { ...body, password: '' }, { host: 'x' }]) {
      const r = await request(createApp(ctx())).put('/v1/emitter/smtp-credential').set(A).send(bad)
      expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED'])
      expect(JSON.stringify(r.body)).not.toContain(SECRET)
    }
    expect(smtpM.saveSendingAccount).not.toHaveBeenCalled()
  })
})

