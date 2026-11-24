import 'dotenv/config'
import {
  logger, assertSessionInvariants, assertIssuerModelDomainEnforced, assertIssuerEnvironmentDomainEnforced, assertFamilyViewsReadable,
  assertWithdrawnRangesViewReadable, assertIssuerViewReadable, MERCHANDISE_VOICE_READING, runMigrations, fiscalStorageRootFromEnv, access,
  assertFiscalCodeDomainsEnforced, assertRequiredProviderCodesPresent, assertNumberSequenceDomainsEnforced,
} from 'fiscal-api'
import { contextFromEnv } from './context'
import { createApp } from './app'
import { KeyProof } from './key-proof'
import { MIGRATION_SETS } from './migrations'
import { assertMerchandiseVoiceDomainsEnforced, assertMerchandiseStrictSession } from './nfe/voice-family'
import { assertNumberVoidDomainsEnforced, assertNumberVoidUniqueKeys } from './nfe/number-void'
import { assertCorsOrigins } from './cors-origins'

async function main(): Promise<void> {
  const ctx = contextFromEnv()
  // D-NE217 (DEPLOY.E1.P8): o `contextFromEnv` já conferiu as quatro variáveis do responsável técnico — o log diz só que conferiu, sem valor
  logger.info('Responsável técnico (infRespTec — D-NE217): conferido')
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
  // D-NE158 (DEPLOY.E1.P9, núcleo 5.0.0): a família ENTROU no catálogo `VOICE_READINGS` na janela da NE-6 e a conferência não tem mais
  // lista padrão — a nfe-api segue passando a PRÓPRIA leitura (D-F113 por família), nunca o catálogo inteiro: o boot dela não depende
  // das migrations de outra família (D-NE76)
  await assertFamilyViewsReadable(ctx.pool, ctx.fiscalDb, [MERCHANDISE_VOICE_READING])
  await assertWithdrawnRangesViewReadable(ctx.pool, ctx.fiscalDb)   // D-NE161: a view das faixas retiradas responde ao SELECT publicado
  // D-NE170 (migration 007 do núcleo 5.0.0): a habilitação por modelo publicada ao ERP — a TERCEIRA view que o `ops/grants.sql` daqui
  // concede ao setes-api; o boot confere as três (gate da DEPLOY.E1.P9: `_migrations` marcada e view ausente não passa calada)
  await assertIssuerViewReadable(ctx.pool, ctx.fiscalDb)
  // DEPLOY.E1.P8 — configuração fiscal por UF (migration 006 do núcleo 4.1.0, D-NE221/D-NE223): os domínios pelo CHECK binário de nome
  // certo, e o boot RECUSA se faltar a credencial do fornecedor (o CSRT) exigida para algum (modelo × ambiente) com habilitação viva — o
  // erro diz UF, tipo, modelo e ambiente. Cadastro: `scripts/fiscal-credential.mjs` do núcleo, só pelo Valdo (D-NE226), até a tela.
  // É PRESENÇA NO INSTANTE DO BOOT, de todas as UFs com regra (a habilitação não tem UF), só dono `provider`: NÃO substitui a conferência
  // por nota — o builder (NFE.E5.P3) chama `requiredFiscalCredentialsFor` pela UF do emitente × modelo × ambiente (D-NE218) e calcula o
  // `hashCSRT` na família (§22.6-3). Habilitação nova (55/P, 65) sem o código exigido derruba o PRÓXIMO boot — cadastrar o código antes.
  await assertFiscalCodeDomainsEnforced(ctx.pool)
  // DEPLOY.E1.P11 (núcleo 5.1.0, migration 008, D-NE255/D-NE257/D-NE265): os domínios do último número da NF-e (`tb_fiscal_number_sequence`) pelo CHECK de nome
  // certo — a sonda faz INSERT numa transação sempre desfeita. Fica ANTES da conferência do CSRT: a recusa do código do fornecedor no dev não pode mascarar a sonda nova.
  await assertNumberSequenceDomainsEnforced(ctx.pool)
  await assertRequiredProviderCodesPresent(ctx.pool)
  // ACESSO.E1.P1 (D-AU3/D-AU12): a sessão viva é lida em TODA rota protegida — sem a `vw_user_link` (script sql/70) ou sem o GRANT nela
  // (seção 1a do nfse-api/ops/grants.sql — o MESMO usuário 'fiscal_api'), o serviço NÃO sobe
  logger.info(`Sessão viva (setes_central.vw_user_link): ${await access.assertSessionViewReadable(ctx.pool)}`)
  if (ctx.keyring.currentVersion === null) logger.warn('FISCAL_MASTER_KEYS ausente — o A1 não abre (operações fiscais respondem 503) até configurar')
  // D-NE189 → D-F250: a 1ª prova da chave (abre UM A1 guardado por versão — D-F243) roda ANTES de ouvir a porta: não há health "sem prova".
  // Falhou = sobe assim mesmo com masterKey=false e o motivo no log. Depois, a cada 5 minutos (D-F245/D-F251). Banco que trava sem recusar
  // segura o `listen` até o prazo da rodada (1 intervalo) — é o preço de não ter janela sem prova (igual à nfse-api).
  const keyProof = new KeyProof(ctx)
  logger.info(`Prova da chave-mestra na partida (D-F243): ${await keyProof.run() ? 'ok' : 'FALHOU — /v1/health com masterKey=false (ver o log)'}`)
  keyProof.start()
  const port = Number(process.env.PORT ?? 3003)
  createApp(ctx, keyProof).listen(port, () => logger.info(`nfe-api ouvindo na porta ${port}`, { fiscalDb: ctx.fiscalDb }))
}

main().catch(err => {
  logger.error('Falha no boot da nfe-api', { err: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
