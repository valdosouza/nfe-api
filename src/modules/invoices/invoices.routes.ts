import { Router } from 'express'
import { route, sendOk, institutionOf, invoiceRef, WEB_TERMINAL, type InstitutionPayload, type InvoiceRef } from 'fiscal-api'
import type { AppContext } from '../../context'
import { parseInvoiceId, requireBranchInterface, requireBranchPrivilege } from '../guards'
import * as service from './invoices.service'

/**
 * /v1/nfe/invoices — o ciclo da NF-e (NFE.E6.P1 mudança 10; contrato: openapi/nfe-api.v1.yaml): ler a situação, transmitir, consultar o fisco e reconfirmar o 217. Router
 * fino: guardas (licença do ramo + privilégio por NOME do verbo — D-PV40: consultar ≠ transmitir) e a chamada ao service; a regra está em `src/nfe`. O terminal da web
 * (`WEB_TERMINAL`) só aparece AQUI, na borda; daqui para dentro a nota viaja inteira (D-NE12).
 */
const webRefOf = (inst: InstitutionPayload, raw: string): InvoiceRef => invoiceRef(inst.institutionId, parseInvoiceId(raw), WEB_TERMINAL)

export function invoicesRoutes(ctx: AppContext): Router {
  const router = Router()

  router.get('/:invoiceId', route('GET /v1/nfe/invoices/:invoiceId', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireBranchInterface(ctx, inst, ref)
    sendOk(res, await service.fiscalView(ctx, inst, ref))
  }))

  router.post('/:invoiceId/transmit', route('POST /v1/nfe/invoices/:invoiceId/transmit', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireBranchPrivilege(ctx, inst, ref, 'TRANSMITIR')
    const r = await service.transmit(ctx, inst, ref)
    sendOk(res, r.data, r.status)
  }))

  router.post('/:invoiceId/refresh', route('POST /v1/nfe/invoices/:invoiceId/refresh', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireBranchPrivilege(ctx, inst, ref, 'CONSULTAR')                   // D-PV40: consultar ≠ transmitir
    sendOk(res, await service.refresh(ctx, inst, ref, req.query.all === 'true'))
  }))

  router.post('/:invoiceId/reconfirm', route('POST /v1/nfe/invoices/:invoiceId/reconfirm', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireBranchPrivilege(ctx, inst, ref, 'TRANSMITIR')                  // o fato "o fisco não registrou" abre caminho para reenviar: é ato de quem transmite (D-NE235)
    sendOk(res, await service.reconfirm(ctx, inst, ref))
  }))

  return router
}
