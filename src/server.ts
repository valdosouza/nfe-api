import 'dotenv/config'
import {
  logger, assertSessionInvariants, assertIssuerModelDomainEnforced, assertIssuerEnvironmentDomainEnforced, assertFamilyViewsReadable,
  assertWithdrawnRangesViewReadable, MERCHANDISE_VOICE_READING, runMigrations, fiscalStorageRootFromEnv,
} from 'fiscal-api'
import { contextFromEnv } from './context'
import { createApp } from './app'
import { MIGRATION_SETS } from './migrations'
import { assertMerchandiseVoiceDomainsEnforced, assertMerchandiseStrictSession } from './nfe/voice-family'
import { assertNumberVoidDomainsEnforced, assertNumberVoidUniqueKeys } from './nfe/number-void'
import { assertCorsOrigins } from './cors-origins'

async function main(): Promise<void> {
  const ctx = contextFromEnv()
  // gates do DEPLOY.E1.P5: as duas travas de produção (P-DEP-2, D-F236) dependem do NODE_ENV — o boot diz em que ambiente subiu e onde o XML mora
  logger.info(`Ambiente: NODE_ENV=${process.env.NODE_ENV ?? '(ausente — não-produção)'} · arquivo fiscal em ${fiscalStorageRootFromEnv(process.env)}`)
  // D-F236: em produção o núcleo recusa origem que não seja https:// e recusa localhost — o ambiente vem do processo
  logger.info(`CORS (origens do app — D-F146/D-F236): ${assertCorsOrigins(ctx.corsOrigins, process.env.NODE_ENV)}`)
  // migrations: núcleo primeiro, depois a família (trava nomeada — duas instâncias sobem juntas — D-F35)
  const applied = await runMigrations(ctx.db, MIGRATION_SETS)
  if (applied.length) logger.info('Migrations aplicadas no boot', { applied })
  await assertSessionInvariants(ctx.pool)
  await assertIssuerModelDomainEnforced(ctx.pool)          // D-F45/D-NE84: CHECK BINÁRIO do domínio do modelo (migrations 004/005 do núcleo)
  await assertIssuerEnvironmentDomainEnforced(ctx.pool)    // D-F120: CHECK BINÁRIO do ambiente da habilitação (migration 005 do núcleo)
  await assertMerchandiseVoiceDomainsEnforced(ctx.pool)    // D-F107/D-F120 na NF-e: kind (lista da família), source, ambiente, chave, autorizador… (001 desta API)
  await assertMerchandiseStrictSession(ctx.pool)           // D-NE172: a sessão é ESTRITA — a chave de 45 posições é RECUSADA (1406), nunca cortada calada
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
