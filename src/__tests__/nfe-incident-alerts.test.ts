/// <reference types="jest" />
/**
 * NFE.E6.P5 (gate socrático da rodada 2; D-NE54, D-NE237): o `file-conflict` do cancelamento e da inutilização também avisa o suporte, como o da transmissão, do refresh e do reconfirm.
 * O service real, com a regra de negócio (`cancelInvoice`, `voidRange`) e as dependências trocadas; nada de rede, banco ou SMTP.
 */
import { resetIncidentDedup } from '../mail/ops-alert'

jest.mock('../nfe/cancellation', () => ({ ...jest.requireActual('../nfe/cancellation'), cancelInvoice: jest.fn() }))
jest.mock('../nfe/void-range', () => ({ ...jest.requireActual('../nfe/void-range'), voidRange: jest.fn(), findVoidItem: jest.fn() }))
jest.mock('../modules/nfe-deps', () => ({ ...jest.requireActual('../modules/nfe-deps'), nfeDepsOf: jest.fn(() => ({})), voidDepsOf: jest.fn(() => ({})), actorOf: jest.fn((i: any) => i) }))
jest.mock('fiscal-api', () => { const actual = jest.requireActual('fiscal-api'); return { ...actual, erp: { ...actual.erp, institutionZone: jest.fn(async () => 'America/Sao_Paulo') } } })

import { cancelInvoice } from '../nfe/cancellation'
import { voidRange, findVoidItem } from '../nfe/void-range'
import { cancel } from '../modules/invoices/invoices.service'
import { requestVoid } from '../modules/operations/operations.service'

const cancelM = cancelInvoice as jest.Mock
const voidM = voidRange as jest.Mock
const findM = findVoidItem as jest.Mock
const inst = { institutionId: 1, userId: 7, schemaName: 'setes_setes' } as any

beforeEach(() => { jest.clearAllMocks(); resetIncidentDedup() })

describe('o alerta de pendência crítica no cancelamento e na inutilização', () => {
  it('cancelamento com file-conflict chama o alerta UMA vez, com a rota e o código; sem incidente, nada', async () => {
    const opsAlert = jest.fn(async () => undefined)
    const base = { invoiceId: 5001, attempt: 1, atAuthority: true, state: 'cancelled', eventSequence: 1, protocol: '141260000000009', warnings: [], nextStep: 'apply-local-cancel', refusedCStat: null }
    cancelM.mockResolvedValueOnce({ ...base, incident: 'file-conflict' })
    await cancel({ opsAlert } as any, inst, { invoiceId: 5001 } as any, 'Cancelamento por erro de digitacao')
    expect(opsAlert).toHaveBeenCalledTimes(1)
    const [subject, text] = opsAlert.mock.calls[0] as unknown as [string, string]
    expect(subject).toContain('file-conflict')
    expect(text).toContain('Rota: invoice-cancel')
    cancelM.mockResolvedValueOnce({ ...base, incident: null })
    await cancel({ opsAlert } as any, inst, { invoiceId: 5001 } as any, 'Cancelamento por erro de digitacao')
    expect(opsAlert).toHaveBeenCalledTimes(1)
  })

  it('inutilização com file-conflict chama o alerta; a falha do alerta não derruba a operação', async () => {
    const opsAlert = jest.fn(async () => { throw new Error('smtp fora') })
    voidM.mockResolvedValueOnce({ id: 3, voidId: 'ID', state: 'homologated', authorityCode: '102', incident: 'file-conflict', refusedCStat: null })
    findM.mockResolvedValueOnce({ id: 3, voidId: 'ID', serie: 1, from: 10, to: 12, environment: 'H', authorityCode: '102', protocol: '1', message: 'ok', createdAt: '2026-11-27 10:00:00', updatedAt: '2026-11-27 10:00:01' })
    const r: any = await requestVoid({ opsAlert, pool: {} } as any, inst, { serie: '1', from: 10, to: 12, reason: 'faixa pulada por erro de numeracao' } as any).catch((e: any) => e)
    expect(opsAlert).toHaveBeenCalledTimes(1)
    expect((opsAlert.mock.calls[0] as unknown as [string, string])[1]).toContain('Rota: void-range')
    expect(String(r?.message ?? '')).toBe('')
  })
})
