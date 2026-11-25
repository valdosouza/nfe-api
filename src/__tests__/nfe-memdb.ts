/**
 * O banco EM MEMÓRIA dos testes da transmissão e da reconciliação da NF-e (NFE.E6.P1): só o SQL que `attempt.ts`, `not-registered.ts` e o escritor de voz do núcleo usam,
 * mais a trava da nota (`lockInvoice`). Não é um motor: é a prova de que o código fala o SQL certo e reage ao que o banco devolve. O motor real é o `nfe-attempt-db.test.ts`.
 */
import { FiscalFileConflictError, type HttpsCall, type HttpsResult } from 'fiscal-api'
import { SOAP12_NS } from '../authority/soap'

export const fmt = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ')

export class MemDb {
  attempts: any[] = []
  events: any[] = []
  inserted = 0
  /** A nota está apagada no ERP (a trava devolve `deleted = 'S'`). */
  deleted = false
  /** Transações abertas agora (o fisco NUNCA é chamado com uma aberta). */
  openTx = 0
  clock = new Date('2026-11-24T13:20:00Z')
  /** Ganchos para o teste mexer no banco "no meio" (a voz que entra durante a pergunta ao fisco). */
  async query(sql: string, params: unknown[] = []): Promise<[any, any]> {
    await new Promise(r => setImmediate(r))
    const s = sql.replace(/\s+/g, ' ').trim()
    const now = fmt(this.clock)
    if (/FROM `setes_x`\.tb_invoice WHERE/.test(s)) return [[{ deleted: this.deleted ? 'S' : 'N' }], []]
    if (/FROM `setes_x`\.vw_invoice_life/.test(s)) return [[{ lifeEvent: 1, lastEvent: 1, lastKind: 'E' }], []]
    if (/^SELECT COALESCE\(MAX\(attempt\)/.test(s)) return [[{ next: this.attempts.length + 1 }], []]
    if (/^SELECT COALESCE\(MAX\(event\)/.test(s)) return [[{ next: this.events.filter(e => e.attempt === params[3]).length + 1 }], []]
    if (/^INSERT INTO tb_invoice_merchandise_transmission_event/.test(s)) {
      this.events.push({ attempt: params[3], event: params[4], kind: params[5], authority_code: params[6], message: params[7], dh: params[8], source: params[9], createdAt: now })
      return [{ affectedRows: 1 }, []]
    }
    if (/^INSERT INTO tb_invoice_merchandise_transmission /.test(s)) {
      if (this.attempts.some(a => a.accessKey === params[7])) throw Object.assign(new Error("Duplicate entry for key 'uk_invoice_merchandise_transmission_key'"), { errno: 1062, code: 'ER_DUP_ENTRY' })
      this.inserted++
      this.attempts.push({ attempt: params[3], lifeEvent: params[4], environment: params[5], authorizer: params[6], accessKey: params[7], dhEmission: params[8], digestValue: params[9],
        receipt: null, protocol: null, dhRecbto: null, lastQueriedAt: null, nfeNotRegisteredAt: null })
      return [{ affectedRows: 1 }, []]
    }
    if (/^UPDATE tb_invoice_merchandise_transmission SET nfe_not_registered_at/.test(s)) {
      const attempt = params[3]
      const row = this.attempts.find(a => a.attempt === attempt)
      const seen = Number(params[8])
      if (!row || row.nfeNotRegisteredAt !== null || this.events.some(e => e.attempt === attempt && e.event > seen)) return [{ affectedRows: 0 }, []]
      row.nfeNotRegisteredAt = now
      return [{ affectedRows: 1 }, []]
    }
    if (/^UPDATE tb_invoice_merchandise_transmission SET last_queried_at/.test(s)) {
      const row = this.attempts.find(a => a.attempt === params[3])
      if (row) row.lastQueriedAt = now
      return [{ affectedRows: row ? 1 : 0 }, []]
    }
    if (/^UPDATE tb_invoice_merchandise_transmission SET/.test(s)) {
      const row = this.attempts.find(a => a.attempt === params[params.length - 1])
      if (!row) return [{ affectedRows: 0 }, []]
      if (s.includes('receipt = ?') && row.receipt === null) { row.receipt = params[0]; return [{ affectedRows: 1 }, []] }
      if (s.includes('protocol = ?') && row.protocol === null) { row.protocol = params[0]; row.dhRecbto = params[1]; return [{ affectedRows: 1 }, []] }
      return [{ affectedRows: 0 }, []]
    }
    if (/^SELECT COUNT\(\*\) AS n FROM tb_invoice_merchandise_transmission_event/.test(s)) {
      const n = this.events.filter(e => e.attempt === params[3] && e.kind === params[4] && (params.length === 5 ? e.dh === null : [params[5], params[6]].includes(e.dh))).length
      return [[{ n }], []]
    }
    if (/FROM tb_invoice_merchandise_transmission_event e JOIN/.test(s)) {
      return [this.events.map(e => ({ attempt: e.attempt, event: e.event, kind: e.kind, authorityCode: e.authority_code, message: e.message, dh: e.dh, source: e.source })), []]
    }
    if (/FROM tb_invoice_merchandise_transmission t/.test(s)) {
      const view = (a: any) => {
        const evs = this.events.filter(e => e.attempt === a.attempt)
        const e = evs[evs.length - 1]
        return { ...a, lastEvent: e?.event ?? null, lastKind: e?.kind ?? null, lastCode: e?.authority_code ?? null, lastEventAt: e?.createdAt ?? null }
      }
      if (/ORDER BY t\.attempt ASC/.test(s)) return [this.attempts.map(view), []]
      if (/t\.attempt = \?/.test(s)) { const a = this.attempts.find(x => x.attempt === params[3]); return [a ? [view(a)] : [], []] }
      if (/t\.access_key = \?/.test(s)) { const a = this.attempts.find(x => x.accessKey === params[3]); return [a ? [view(a)] : [], []] }
      const last = [...this.attempts].reverse()[0]
      return [last ? [view(last)] : [], []]
    }
    return [{ affectedRows: 1 }, []]
  }
  /** A conexão que `withTransaction` do núcleo usa, contando as transações abertas. */
  connection() {
    return {
      query: this.query.bind(this),
      beginTransaction: async () => { this.openTx++ },
      commit: async () => { this.openTx-- },
      rollback: async () => { this.openTx-- },
      release: () => {},
    }
  }
}

export function memStorage() {
  const files = new Map<string, string>()
  const id = (key: any, name: string) => `${key.cnpj}/${key.environment}/${key.serie}/${name}`
  return {
    files,
    /** Gravação única do núcleo 5.2.0: mesmos bytes = o caminho; bytes diferentes = `FiscalFileConflictError` (nunca sobrescreve). */
    save: (key: any, name: string, xml: string, _when?: Date) => {
      const at = id(key, name)
      const had = files.get(at)
      if (had !== undefined) { if (had === xml) return at; throw new FiscalFileConflictError(at) }
      files.set(at, xml)
      return at
    },
    find: (key: any, name: string) => (files.has(id(key, name)) ? id(key, name) : null),
    read: (ref: string) => String(files.get(ref)),
    probe: () => true,
  }
}

export const soapEnvelope = (inner: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${SOAP12_NS}"><soap:Body><nfeResultMsg xmlns="urn:x">${inner}</nfeResultMsg></soap:Body></soap:Envelope>`
export const ok = (text: string): HttpsResult => ({ status: 200, headers: {}, text })
export type Reply = (c: HttpsCall) => HttpsResult | Promise<HttpsResult>
