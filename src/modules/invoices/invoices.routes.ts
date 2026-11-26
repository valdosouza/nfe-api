import { Router } from 'express'
import { route, sendOk, institutionOf, invoiceRef, WEB_TERMINAL, type InstitutionPayload, type InvoiceRef } from 'fiscal-api'
import type { AppContext } from '../../context'
import { parseWith } from '../validate'
import { sendInvoiceEmail } from '../../mail/invoice-mail'
import { cancelDto, emailDto, pendingQueryDto } from './invoices.dto'
import { contractedBranches, parseInvoiceId, requireBranchInterface, requireBranchPrivilege } from '../guards'
import * as service from './invoices.service'

/**
 * /v1/nfe/invoices — o ciclo da NF-e (NFE.E6.P1 mudança 10; contrato: openapi/nfe-api.v1.yaml): ler a situação, transmitir, consultar o fisco e reconfirmar o 217. Router
 * fino: guardas (licença do ramo + privilégio por NOME do verbo — D-PV40: consultar ≠ transmitir) e a chamada ao service; a regra está em `src/nfe`. O terminal da web
 * (`WEB_TERMINAL`) só aparece AQUI, na borda; daqui para dentro a nota viaja inteira (D-NE12).
 */
const webRefOf = (inst: InstitutionPayload, raw: string): InvoiceRef => invoiceRef(inst.institutionId, parseInvoiceId(raw), WEB_TERMINAL)

export function invoicesRoutes(ctx: AppContext): Router {
  const router = Router()

  // a lista ANTES da rota `/:invoiceId` (senão `pending` seria lido como id): as notas faturadas sem NF-e viva, só dos ramos CONTRATADOS (nenhum = vazia — D-F14/D-F37); o filtro do ramo pedido
  // vale dentro do que está contratado
  router.get('/pending', route('GET /v1/nfe/invoices/pending', async (req, res) => {
    const inst = institutionOf(req)
    const { interfaceKey, ...page } = parseWith(pendingQueryDto, req.query)
    const contracted = await contractedBranches(ctx, inst)
    const allowed = interfaceKey ? contracted.filter(k => k === interfaceKey) : contracted
    const r = await service.pending(ctx, inst, page, allowed)
    res.status(200).json({ ok: true, page: page.page, pageSize: page.pageSize, total: r.total, data: r.items })      // envelope paginado da casa
  }))

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

  router.get('/:invoiceId/xml', route('GET /v1/nfe/invoices/:invoiceId/xml', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireBranchInterface(ctx, inst, ref)
    sendOk(res, await service.xml(ctx, inst, ref))
  }))

  router.get('/:invoiceId/danfe', route('GET /v1/nfe/invoices/:invoiceId/danfe', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireBranchInterface(ctx, inst, ref)                                // leitura do arquivo: o contrato não nomeia privilégio (S-14)
    sendOk(res, await service.danfe(ctx, inst, ref))
  }))

  // o botão de envio (D-NE261 via manual): ato explícito de quem TRANSMITE (envia o documento fiscal pela conta do estabelecimento — o contrato não nomeia o verbo, S-14); o corpo é opcional
  router.post('/:invoiceId/email', route('POST /v1/nfe/invoices/:invoiceId/email', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireBranchPrivilege(ctx, inst, ref, 'TRANSMITIR')
    const body = parseWith(emailDto, req.body)
    sendOk(res, await sendInvoiceEmail(ctx, inst, ref, body.to))
  }))

  router.post('/:invoiceId/cancel', route('POST /v1/nfe/invoices/:invoiceId/cancel', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireBranchPrivilege(ctx, inst, ref, 'CANCELAR')
    const body = parseWith(cancelDto, req.body)
    sendOk(res, await service.cancel(ctx, inst, ref, body.reason))
  }))

  return router
}
