/// <reference types="jest" />
// nfe-api DEPLOY.E1.P10.T1 (D-F15, D-NE158, D-NE161, D-NE170; PM-9 — 2026-11-22; ficha
// `projetos/nfe-api/GERAL/ficha-deploy-e1-p9-p10-adocao-5-0-0-e-grant.md` no Vault): na janela da NE-6 o usuário do setes-api ganha o
// SELECT das TRÊS views publicadas — as tentativas da NF-e, as faixas retiradas e a habilitação por modelo — e de mais nada. O
// `ops/grants.sql` é rodado por um administrador na implantação: uma linha a mais aqui é uma porta aberta em produção, e uma a menos
// derruba o boot do setes-api com o núcleo 5.0.0. CERCA: os comandos VIVOS do arquivo são exatamente os três, cada um sobre uma view que
// o pacote instalado publica pelo NOME (constante do núcleo) e que alguma migration cria.
import fs from 'fs'
import path from 'path'
import { CORE_MIGRATIONS_DIR, MERCHANDISE_VOICE_READING, WITHDRAWN_RANGES_VIEW, ISSUER_VIEW } from 'fiscal-api'
import { NFE_MIGRATIONS_DIR } from '../migrations'

const GRANTS = fs.readFileSync(path.resolve(__dirname, '..', '..', 'ops', 'grants.sql'), 'utf8')

/** Os comandos VIVOS do script: sem as linhas de comentário (`--`), partidos no `;`. Comentário de bloco não é aceito (esconderia um GRANT). */
function liveStatements(sql: string): string[] {
  const code = sql.split(/\r?\n/).filter(line => !/^\s*--/.test(line)).join('\n')
  return code.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s !== '')
}

const PUBLISHED = [MERCHANDISE_VOICE_READING.transmissionView, WITHDRAWN_RANGES_VIEW, ISSUER_VIEW]
const live = liveStatements(GRANTS)

describe('GRANT das views publicadas ao setes-api — janela da NE-6 (DEPLOY.E1.P10, PM-9)', () => {
  it('as três views são as que o núcleo instalado publica, pelo nome', () => {
    expect(PUBLISHED).toEqual(['vw_invoice_merchandise_transmission', 'vw_invoice_number_void', 'vw_establishment_issuer'])
  })

  it('os comandos vivos do script são EXATAMENTE os três GRANT SELECT, um por view, ao setes_api', () => {
    expect(live).toEqual(PUBLISHED.map(view => `GRANT SELECT ON \`fiscal_api\`.\`${view}\` TO 'setes_api'@'%'`))
  })

  it('o script não tem comentário de bloco nem comentário no fim de uma linha viva (nada que esconda ou corte um comando)', () => {
    expect(GRANTS).not.toMatch(/\/\*|\*\//)
    expect(GRANTS).not.toMatch(/^\s*#/m)
    for (const line of GRANTS.split(/\r?\n/).filter(l => l.trim() !== '' && !/^\s*--/.test(l))) {
      expect([line, /^GRANT SELECT ON `fiscal_api`\.`vw_[a-z_]+` TO 'setes_api'@'%';$/.test(line)]).toEqual([line, true])
    }
  })

  it('nenhum comando vivo concede tabela interna, escrita, outro objeto ou outro usuário', () => {
    for (const stmt of live) {
      expect([stmt, /`tb_|\*|\bALL\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bLOCK\b|\bSHOW\b|\bWITH\b|\bOPTION\b/i.test(stmt)]).toEqual([stmt, false])
      expect([stmt, (stmt.match(/'[^']*'@'[^']*'/g) ?? []).join()]).toEqual([stmt, "'setes_api'@'%'"])
    }
  })

  it('cada view concedida nasce numa migration — da família ou do núcleo instalado', () => {
    const migrations = [NFE_MIGRATIONS_DIR, CORE_MIGRATIONS_DIR]
      .flatMap(dir => fs.readdirSync(dir).filter(f => f.endsWith('.sql')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')))
    for (const view of PUBLISHED) {
      expect([view, migrations.some(sql => sql.includes(`CREATE OR REPLACE VIEW \`${view}\``))]).toEqual([view, true])
    }
  })
})
