import { Router } from 'express'
import { route, sendOk, institutionOf } from 'fiscal-api'
import type { AppContext } from '../../context'
import { requireAdmin } from '../guards'
import { parseWith } from '../validate'
import { issuerDto, certificateDto } from './emitter.dto'
import { smtpCredentialDto } from './smtp-credential.dto'
import * as smtp from './smtp-credential.service'
import * as service from './emitter.service'

/**
 * /v1/emitter — o A1 e a habilitação do estabelecimento do token (contrato: openapi/nfe-api.v1.yaml). Ato do ADMIN da institution.
 * Router fino: a regra está no service (e a política no emitter do NÚCLEO — D-NE9). A borda é a da nfse-api (D-NE166), sem a cerca da
 * virada (D-NE10): a do A1 mora dentro do núcleo.
 */
export function emitterRoutes(ctx: AppContext): Router {
  const router = Router()

  router.get('/', route('GET /v1/emitter', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    sendOk(res, await service.fetchEmitter(ctx, inst))
  }))

  router.put('/certificate', route('PUT /v1/emitter/certificate', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    sendOk(res, await service.saveCertificate(ctx, inst, parseWith(certificateDto, req.body)))
  }))

  router.delete('/certificate', route('DELETE /v1/emitter/certificate', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    sendOk(res, await service.removeCertificate(ctx, inst))
  }))

  // a conta de envio de e-mail (D-NE236; S-2): a senha é write-only — o GET devolve só a situação, o PUT e o DELETE devolvem a situação; 422 `SMTP_CREDENTIAL_INVALID` vem do núcleo
  router.get('/smtp-credential', route('GET /v1/emitter/smtp-credential', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    sendOk(res, await smtp.getSendingAccountStatus(ctx, inst))
  }))

  router.put('/smtp-credential', route('PUT /v1/emitter/smtp-credential', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    sendOk(res, await smtp.saveSendingAccount(ctx, inst, parseWith(smtpCredentialDto, req.body)))
  }))

  router.delete('/smtp-credential', route('DELETE /v1/emitter/smtp-credential', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    sendOk(res, await smtp.removeSendingAccount(ctx, inst))
  }))

  router.put('/issuers/:model', route('PUT /v1/emitter/issuers/:model', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    sendOk(res, await service.saveIssuer(ctx, inst, req.params.model, parseWith(issuerDto, req.body)))
  }))

  router.delete('/issuers/:model', route('DELETE /v1/emitter/issuers/:model', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    sendOk(res, await service.removeIssuer(ctx, inst, req.params.model))
  }))

  return router
}
