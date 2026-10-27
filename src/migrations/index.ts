import path from 'path'
import { CORE_MIGRATIONS_DIR, CORE_MIGRATIONS_PROJECT, MigrationSet } from 'fiscal-api'

/** Migrations da FAMÍLIA NF-e (D-F35 — namespace próprio em `_migrations (project, version)`) — resolve igual de src/ (tsx) e dist/ (node). */
export const NFE_MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'src', 'migrations', 'sql')
export const NFE_MIGRATIONS_PROJECT = 'nfe-api'

/** Ordem: núcleo primeiro (certificado + habilitação), depois a família. A 001 é ADITIVA: não toca tabela de outra família (D-NE168). */
export const MIGRATION_SETS: MigrationSet[] = [
  { project: CORE_MIGRATIONS_PROJECT, dir: CORE_MIGRATIONS_DIR },
  { project: NFE_MIGRATIONS_PROJECT, dir: NFE_MIGRATIONS_DIR },
]
