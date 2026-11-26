import {
  logger, Pool, createFiscalPool, dbConfigFromEnv, FiscalDbConfig, FiscalStorage, MasterKeyRing, ProductTokenVerifier, FsFiscalStorage,
  fiscalStorageRootFromEnv, technicalResponsibleFromEnv, type TechnicalResponsible,
} from 'fiscal-api'
import { loadServerCa, watchServerCa, type ServerCa } from './authority/server-ca'
import { StatusBoard } from './authority/status-board'
import { Breaker } from './nfe/breaker'
import { createOpsAlert, type OpsAlert } from './mail/ops-alert'

/**
 * Dependências do serviço (montadas UMA vez no boot; os testes montam as suas). Nada de estado de CONTROLE aqui — só recursos (pool,
 * anel de chaves, storage, verificador do JWT). Molde: `nfse-api/src/context.ts`. O adaptador SEFAZ entra na NE-3 (D-NE162/§15.5 do
 * `prompt_onda_nfe_sefaz.md`) — a NE-2 não tem transporte.
 *
 * D-NE10: o 55 NASCE na nfe-api — não existe réplica do ERP nem cerca da virada para ele; por isso aqui não há o `assertRetiredEnv` da
 * nfse-api (`FISCAL_LEGACY_INSTITUTIONS` é história da família de serviço). A escrita do A1 (comum) segue a cerca do emitter do núcleo.
 */
export interface AppContext {
  db:          FiscalDbConfig
  pool:        Pool
  keyring:     MasterKeyRing
  storage:     FiscalStorage
  /** Banco fiscal (onde as views da família moram) — para a conferência do boot e as leituras publicadas. */
  fiscalDb:    string
  verifier:    ProductTokenVerifier
  corsOrigins: string[]
  /**
   * Lê a SESSÃO viva e o PERFIL vivo em toda rota protegida (`access.liveIdentity` — ACESSO.E1.P1, D-AU3/D-AU19). SEMPRE true no
   * `contextFromEnv` (nenhuma variável de ambiente o desliga — teste fixa); desligado (só por override em teste) NENHUMA sessão é conferida.
   */
  checkIdentity: boolean
  /**
   * Raízes ICP-Brasil do SERVIDOR da SEFAZ (D-NE187/D-NE202 — NFE.E4.P3.T3): `SEFAZ_SERVER_CA_PATH` obrigatório; sem elas o serviço não
   * sobe. Vai no `ca` das chamadas ao fisco.
   */
  serverCa: ServerCa
  /**
   * Responsável técnico da instância — os dados PÚBLICOS do `infRespTec` (D-NE217; valores = os do ERP Desktop, postos no `.env` pelo
   * Valdo — D-NE229), lidos e conferidos pela peça do núcleo `technicalResponsibleFromEnv` (núcleo 4.1.0, DEPLOY.E1.P8): variável ausente ou
   * fora da forma = o serviço NÃO sobe. O builder (NFE.E5.P3) lê daqui; o valor nunca vai a log. Congelado no boot: troca = reiniciar.
   */
  technicalResponsible: TechnicalResponsible
  /**
   * O disjuntor contra o 656 (D-NE54 b; NFE.E6.P4 mudança 1): UM por processo, estado em memória (cai com o reinício — o fisco é quem segura o bloqueio). As rotas e o rodízio
   * recebem O MESMO (`nfeDepsOf`); sem ele cada chamada teria um disjuntor novo e nunca aberto.
   */
  breaker: Breaker
  /**
   * O alerta de pendência crítica ao suporte da Setes (D-NE237; NFE.E6.P4 mudança 7): pelo SMTP da PLATAFORMA (`.env`), nunca pelo do cliente. Opcional: os testes não o montam; o boot de produção
   * recusa subir sem as variáveis (`assertOpsAlertConfigured`).
   */
  opsAlert?: OpsAlert
  /** O quadro do estado por autorizador (D-NE54 c; NFE.E6.P4 mudança 8): o health lê, a passada do rodízio escreve. Opcional: os testes não o montam (o health diz `authorities: []`). */
  statusBoard?: StatusBoard
  /**
   * Relê as raízes ICP quando o PEM ou a ficha mudam (D-NE54 a — dado recarregável) e dá o alarme dos 60 dias; chamada barata e síncrona, feita pelo health e por toda chamada ao fisco. Ausente nos
   * testes que injetam `serverCa`. Recarga recusada mantém `serverCa` como está.
   */
  checkServerCa?: () => void
}

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppContext> = {}): AppContext {
  // D-NE217 (DEPLOY.E1.P8): a 1ª conferência — tudo ou nada; o erro do responsável técnico sai antes dos de banco, storage e CA (diz o
  // NOME da variável, nunca o valor). O override é SÓ de teste (o `server.ts` não o passa).
  const technicalResponsible = overrides.technicalResponsible ?? technicalResponsibleFromEnv(env)
  const db = dbConfigFromEnv(env)
  const pool: Pool = overrides.pool ?? createFiscalPool(db)
  const ctx: AppContext = {
    db,
    pool,
    keyring:  overrides.keyring ?? MasterKeyRing.fromEnv(env),
    // D-F241/P-DEP-2: a raiz é a do núcleo — em produção `STORAGE_PATH` obrigatório e ABSOLUTO; fora dela, `STORAGE_PATH` ou <cwd>/storage
    storage:  overrides.storage ?? new FsFiscalStorage(fiscalStorageRootFromEnv(env)),
    // depois do STORAGE_PATH (a ordem do erro no boot é a de sempre); `now` = o relógio — os testes injetam `serverCa`
    serverCa: overrides.serverCa ?? loadServerCa(env.SEFAZ_SERVER_CA_PATH, new Date()),
    fiscalDb: db.database,
    verifier: overrides.verifier ?? ProductTokenVerifier.fromEnv(env),
    corsOrigins: overrides.corsOrigins ?? String(env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    checkIdentity: overrides.checkIdentity ?? true,
    technicalResponsible,
    breaker: overrides.breaker ?? new Breaker(() => new Date()),
    opsAlert: overrides.opsAlert ?? createOpsAlert(env),
    statusBoard: overrides.statusBoard ?? new StatusBoard(() => new Date()),
  }
  if (!overrides.serverCa) {
    const when = new Date()
    ctx.checkServerCa = watchServerCa(ctx, String(env.SEFAZ_SERVER_CA_PATH), {
      onReload: ca => logger.info('Raízes ICP do servidor da SEFAZ recarregadas (D-NE54 a)', { certificates: ca.certificates.length, source: ca.source }),
      onRefused: reason => logger.warn(`Raízes ICP novas recusadas (${reason}): fica a cadeia anterior — o serviço segue (D-NE187)`),
      onExpiring: days => {
        const text = `A primeira raiz ICP-Brasil do servidor da SEFAZ vence em ${days} dia(s) (D-NE187): troque o PEM e a ficha em ${when.toISOString().slice(0, 10)} ou antes — a nfe-api relê o arquivo sem reiniciar.`
        logger.warn(text)
        if (ctx.opsAlert) void ctx.opsAlert('[nfe-api] raízes ICP do servidor da SEFAZ perto de vencer', text).catch(() => undefined)
      },
    }).check
  }
  return ctx
}
