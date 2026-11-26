import { Router } from 'express'
import { route, sendOk, institutionOf } from 'fiscal-api'
import type { AppContext } from '../../context'
import { requireAdmin, requireAnyBranchPrivilege } from '../guards'
import { parseWith } from '../validate'
import { numberingQueryDto, refreshRunDto, voidDto, voidsQueryDto } from './operations.dto'
import * as service from './operations.service'

/**
 * /v1/nfe/{refresh,numbering,voids} — as operações do ESTABELECIMENTO, sem nota na mão (NFE.E6.P4 mudança 5; contrato: openapi/nfe-api.v1.yaml): a passada do rodízio (TRANSMITIR em algum ramo
 * contratado), a numeração do 55 e a inutilização de faixa (admin — D-E14; a numeração e a listagem seguem o mesmo ato administrativo, S-14). Router fino: guarda, validação estrita do corpo
 * e a chamada ao service; a regra mora em `src/nfe`.
 */
export function operationsRoutes(ctx: AppContext): Router {
  const router = Router()

  router.post('/refresh', route('POST /v1/nfe/refresh', async (req, res) => {
    const inst = institutionOf(req)
    await requireAnyBranchPrivilege(ctx, inst, 'TRANSMITIR')
    sendOk(res, await service.refreshRun(ctx, inst, parseWith(refreshRunDto, req.body)))
  }))

  router.get('/numbering', route('GET /v1/nfe/numbering', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    sendOk(res, await service.numbering(ctx, inst, parseWith(numberingQueryDto, req.query)))
  }))

  router.get('/voids', route('GET /v1/nfe/voids', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    // envelope paginado da casa: { ok, page, pageSize, total, data }
    res.status(200).json({ ok: true, ...(await service.listVoidRequests(ctx, inst, parseWith(voidsQueryDto, req.query))) })
  }))

  router.post('/voids', route('POST /v1/nfe/voids', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    sendOk(res, await service.requestVoid(ctx, inst, parseWith(voidDto, req.body)), 201)
  }))

  return router
}
