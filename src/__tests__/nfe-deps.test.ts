/// <reference types="jest" />
/**
 * NFE.E6.P4 mudança 1 (ficha-nfe-e6-p4-rotas-email-operacao.md §6-1): a peça de montagem das dependências da NF-e. O disjuntor do contexto é UM por processo e chega igual a toda
 * rota e ao rodízio (sem isso cada chamada teria um disjuntor novo, nunca aberto); a inutilização ganha o emitente sem nota pelo `readEmitter`. Nada vai ao fisco nem ao banco.
 */
import { randomBytes } from 'crypto'
import path from 'path'
import { MasterKeyRing } from 'fiscal-api'
import type { AppContext } from '../context'
import { contextFromEnv } from '../context'
import { loadServerCa } from '../authority/server-ca'
import { Breaker } from '../nfe/breaker'
import { nfeDepsOf, voidDepsOf } from '../modules/nfe-deps'
import * as merchandiseFacts from '../facts/merchandise-facts'
import { FAKE_TECH } from './technical-responsible-fake'

jest.mock('../facts/merchandise-facts', () => ({ ...jest.requireActual('../facts/merchandise-facts'), readEmitter: jest.fn() }))

const SERVER_CA = loadServerCa(path.resolve(__dirname, '..', '..', 'acervo', 'icp', 'raizes-icp-brasil.pem'), new Date('2026-11-21T12:00:00Z'))
const pool = { query: jest.fn(), getConnection: jest.fn() } as never

const ctxOf = (over: Partial<AppContext> = {}): AppContext => ({
  db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' }, pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }),
  storage: {} as never, fiscalDb: 'fiscal_api', verifier: {} as never, corsOrigins: [],
  checkIdentity: false, serverCa: SERVER_CA, technicalResponsible: FAKE_TECH, breaker: new Breaker(() => new Date()), ...over,
})

describe('nfeDepsOf — o disjuntor é o do contexto', () => {
  it('toda montagem leva O MESMO Breaker do contexto (um por processo)', () => {
    const ctx = ctxOf()
    expect(nfeDepsOf(ctx).breaker).toBe(ctx.breaker)
    expect(nfeDepsOf(ctx).breaker).toBe(nfeDepsOf(ctx).breaker)
    expect(voidDepsOf(ctx).breaker).toBe(ctx.breaker)
  })

  it('o contexto do boot cria o Breaker uma vez, e o override de teste vale', () => {
    const own = new Breaker(() => new Date())
    expect(ctxOf({ breaker: own }).breaker).toBe(own)
    const src = jest.requireActual('fs').readFileSync(path.join(__dirname, '..', 'context.ts'), 'utf8') as string
    expect(src.match(/new Breaker\(/g)).toHaveLength(1)                       // só no contextFromEnv: nenhuma rota cria o seu
    expect(typeof contextFromEnv).toBe('function')
  })

  it('o disjuntor aberto por uma montagem vale para a outra (o estado não se perde entre chamadas)', () => {
    const ctx = ctxOf()
    const scope = { cnpj: '11222333000181', environment: 'H' as const, service: 'autorizacao' as const }
    nfeDepsOf(ctx).breaker!.recordRefused(scope, '656')
    expect(nfeDepsOf(ctx).breaker!.isOpen(scope)).toBe(true)
    expect(voidDepsOf(ctx).breaker!.isOpen(scope)).toBe(true)
  })
})

describe('voidDepsOf — o emitente sem nota', () => {
  const actor = { institutionId: 7, schemaName: 'setes_x', userId: 1 }
  const read = merchandiseFacts.readEmitter as unknown as jest.Mock

  it('CNPJ, UF do endereço principal e presença da IE vêm do estabelecimento', async () => {
    read.mockResolvedValueOnce({ cnpj: '11222333000181', stateRegistration: '123', addresses: [{ main: 'N', stateCode: 'SP' }, { main: 'S', stateCode: 'PR' }] })
    expect(await voidDepsOf(ctxOf()).emitterOf({} as never, actor)).toEqual({ cnpj: '11222333000181', uf: 'PR', hasStateRegistration: true })
    expect(read).toHaveBeenCalledWith(expect.anything(), 'setes_x', 7)
  })

  it('sem CNPJ ou sem UF recusa 422 (a inutilização não se monta)', async () => {
    read.mockResolvedValueOnce({ cnpj: null, stateRegistration: null, addresses: [] })
    await expect(voidDepsOf(ctxOf()).emitterOf({} as never, actor)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_EMITTER_INCOMPLETE' })
  })
})
