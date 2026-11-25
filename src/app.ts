import fs from 'fs'
import path from 'path'
import express, { Express } from 'express'
import swaggerUi from 'swagger-ui-express'
import YAML from 'yaml'
import { corsFor, productAuth, errorMiddleware, access } from 'fiscal-api'
import type { AppContext } from './context'
import { healthHandler } from './health'
import { KeyProof } from './key-proof'
import { emitterRoutes } from './modules/emitter/emitter.routes'
import { invoicesRoutes } from './modules/invoices/invoices.routes'

/**
 * Contrato DESIGN-FIRST (D-F8): o YAML é a fonte; servido em /docs e /v1/openapi.yaml. D-NE166 (NE-2): a nfe-api serve só `GET /v1/health`
 * e o emitente (e, com a NFE.E6.P1, a situação, o transmitir, o consultar e o reconfirmar da nota); as outras rotas do contrato ficam marcadas `x-onda` com a onda que as traz — sem stub 501. A cerca
 * rota × contrato (`app.test.ts`) confere servidas = contrato − marcadas.
 */
export const OPENAPI_PATH = path.resolve(__dirname, '..', 'openapi', 'nfe-api.v1.yaml')

export function loadOpenApi(): any {
  return YAML.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'))
}

/**
 * [keyProof]: a prova da chave do servidor (D-NE189 → D-F243/D-F245) que o boot roda e agenda (`server.ts`). Sem ela (testes), uma prova
 * que nunca rodou — o health diz `masterKey=false` (fecha em falso).
 */
export function createApp(ctx: AppContext, keyProof: KeyProof = new KeyProof(ctx)): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(corsFor(ctx.corsOrigins))
  app.use(express.json({ limit: '128kb' }))          // o maior corpo é o .pfx em base64 (≤ 64 k)

  app.get('/v1/health', healthHandler(ctx, keyProof))
  const doc = loadOpenApi()
  app.get('/v1/openapi.yaml', (_req, res) => { res.type('text/yaml').send(fs.readFileSync(OPENAPI_PATH, 'utf8')) })
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(doc))

  // ACESSO.E1.P1 (D-AU3/D-AU19, molde nfse-api): a SESSÃO viva em toda rota protegida — vínculo, credencial e estabelecimento ativos na
  // `setes_central.vw_user_link`, pelo institution, usuário e schema do token (substitui o antigo schema × institution pela premissa de que a
  // view amarra o schema à institution — molde nfse-api; o sql/70 do setes-api não foi relido nesta entrega); devolve o payload com o PERFIL
  // VIVO no `role` (o verificador entrega o `role` vazio desde o núcleo 3.0.0 — o do token é ignorado). Revogada = 401 SESSION_REVOKED; banco fora = 503
  // SESSION_UNAVAILABLE. D-EA7: o `iat` derruba o token anterior à troca de senha REGISTRADA NO SETES-API (`password_set_at` da view) — a
  // troca feita na auth-api só derruba aqui quando a view ler o instante da credencial (auth-api:AUTH.E2.P5). Desligado (`checkIdentity`
  // false — só testes), nenhuma sessão é conferida e ninguém é admin.
  const auth = productAuth(ctx.verifier, ctx.checkIdentity
    ? (p, iat) => access.liveIdentity(ctx.pool, p, iat)
    : undefined)
  app.use('/v1/emitter', auth, emitterRoutes(ctx))
  app.use('/v1/nfe/invoices', auth, invoicesRoutes(ctx))                // NFE.E6.P1: situação, transmitir, consultar e reconfirmar (o resto do ciclo é da NE-5 que segue)

  app.use((_req, res) => { res.status(404).json({ error: 'Rota não encontrada', code: 'NOT_FOUND' }) })
  app.use(errorMiddleware)
  return app
}
