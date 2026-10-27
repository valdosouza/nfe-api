import fs from 'fs'
import path from 'path'
import express, { Express } from 'express'
import swaggerUi from 'swagger-ui-express'
import YAML from 'yaml'
import { corsFor, productAuth, errorMiddleware, erp } from 'fiscal-api'
import type { AppContext } from './context'
import { healthHandler } from './health'
import { emitterRoutes } from './modules/emitter/emitter.routes'

/**
 * Contrato DESIGN-FIRST (D-F8): o YAML é a fonte; servido em /docs e /v1/openapi.yaml. D-NE166 (NE-2): a nfe-api serve só `GET /v1/health`
 * e o emitente; as outras rotas do contrato ficam marcadas `x-onda` com a onda que as traz (NE-3/NE-5) — sem stub 501. A cerca
 * rota × contrato (`app.test.ts`) confere servidas = contrato − marcadas.
 */
export const OPENAPI_PATH = path.resolve(__dirname, '..', 'openapi', 'nfe-api.v1.yaml')

export function loadOpenApi(): any {
  return YAML.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'))
}

export function createApp(ctx: AppContext): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(corsFor(ctx.corsOrigins))
  app.use(express.json({ limit: '128kb' }))          // o maior corpo é o .pfx em base64 (≤ 64 k)

  app.get('/v1/health', healthHandler(ctx))
  const doc = loadOpenApi()
  app.get('/v1/openapi.yaml', (_req, res) => { res.type('text/yaml').send(fs.readFileSync(OPENAPI_PATH, 'utf8')) })
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(doc))

  const auth = productAuth(ctx.verifier, ctx.checkIdentity
    ? p => erp.assertInstitutionSchema(ctx.pool, p.institutionId, p.schemaName)
    : undefined)
  app.use('/v1/emitter', auth, emitterRoutes(ctx))

  app.use((_req, res) => { res.status(404).json({ error: 'Rota não encontrada', code: 'NOT_FOUND' }) })
  app.use(errorMiddleware)
  return app
}
