import {
  Pool, createFiscalPool, dbConfigFromEnv, FiscalDbConfig, FiscalStorage, MasterKeyRing, ProductTokenVerifier, FsFiscalStorage,
  fiscalStorageRootFromEnv,
} from 'fiscal-api'

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
  /** Confere no banco que o schema do token é o da institution (defesa em profundidade). */
  checkIdentity: boolean
}

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppContext> = {}): AppContext {
  const db = dbConfigFromEnv(env)
  const pool: Pool = overrides.pool ?? createFiscalPool(db)
  return {
    db,
    pool,
    keyring:  overrides.keyring ?? MasterKeyRing.fromEnv(env),
    // D-F241/P-DEP-2: a raiz é a do núcleo — em produção `STORAGE_PATH` obrigatório e ABSOLUTO; fora dela, `STORAGE_PATH` ou <cwd>/storage
    storage:  overrides.storage ?? new FsFiscalStorage(fiscalStorageRootFromEnv(env)),
    fiscalDb: db.database,
    verifier: overrides.verifier ?? ProductTokenVerifier.fromEnv(env),
    corsOrigins: overrides.corsOrigins ?? String(env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    checkIdentity: overrides.checkIdentity ?? true,
  }
}
