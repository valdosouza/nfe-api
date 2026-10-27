import 'dotenv/config'
import {
  logger, assertSessionInvariants, assertIssuerModelDomainEnforced, assertIssuerEnvironmentDomainEnforced, assertFamilyViewsReadable,
  assertWithdrawnRangesViewReadable, MERCHANDISE_VOICE_READING, runMigrations,
} from 'fiscal-api'
import { contextFromEnv } from './context'
import { createApp } from './app'
import { MIGRATION_SETS } from './migrations'
import { assertMerchandiseVoiceDomainsEnforced } from './nfe/voice-family'
import { assertNumberVoidDomainsEnforced, assertNumberVoidUniqueKeys } from './nfe/number-void'
import { assertCorsOrigins } from './cors-origins'

async function main(): Promise<void> {
  const ctx = contextFromEnv()
  logger.info(`CORS (origens do app — D-F146): ${assertCorsOrigins(ctx.corsOrigins)}`)
  // migrations: núcleo primeiro, depois a família (trava nomeada — duas instâncias sobem juntas — D-F35)
  const applied = await runMigrations(ctx.db, MIGRATION_SETS)
  if (applied.length) logger.info('Migrations aplicadas no boot', { applied })
  await assertSessionInvariants(ctx.pool)
  await assertIssuerModelDomainEnforced(ctx.pool)          // D-F45/D-NE84: CHECK BINÁRIO do domínio do modelo (migrations 004/005 do núcleo)
  await assertIssuerEnvironmentDomainEnforced(ctx.pool)    // D-F120: CHECK BINÁRIO do ambiente da habilitação (migration 005 do núcleo)
  await assertMerchandiseVoiceDomainsEnforced(ctx.pool)    // D-F107/D-F120 na NF-e: kind (lista da família), source, ambiente, chave, autorizador… (001 desta API)
  await assertNumberVoidDomainsEnforced(ctx.pool)          // D-NE163: domínios da faixa inutilizada (001 desta API)
  await assertNumberVoidUniqueKeys(ctx.pool)               // D-NE163: as DUAS UNIQUE da faixa com as colunas decididas (CREATE IF NOT EXISTS não corrige tabela antiga)
  // D-NE158: a família está FORA do catálogo até a janela da NE-6 — a nfe-api confere a PRÓPRIA view passando a leitura (D-F113 por família)
  await assertFamilyViewsReadable(ctx.pool, ctx.fiscalDb, [MERCHANDISE_VOICE_READING])
  await assertWithdrawnRangesViewReadable(ctx.pool, ctx.fiscalDb)   // D-NE161: a view das faixas retiradas responde ao SELECT publicado
  if (ctx.keyring.currentVersion === null) logger.warn('FISCAL_MASTER_KEYS ausente — o A1 não abre (operações fiscais respondem 503) até configurar')
  const port = Number(process.env.PORT ?? 3003)
  createApp(ctx).listen(port, () => logger.info(`nfe-api ouvindo na porta ${port}`, { fiscalDb: ctx.fiscalDb }))
}

main().catch(err => {
  logger.error('Falha no boot da nfe-api', { err: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
