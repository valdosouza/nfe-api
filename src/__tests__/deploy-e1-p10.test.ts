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

/**
 * Linha de COMENTÁRIO = dois hifens na coluna 1 seguidos de ESPAÇO (ou a linha só com os dois hifens). Gate adversarial: o MySQL/MariaDB
 * só trata `--` como comentário se vier espaço ou controle depois — `--GRANT ALL …` é COMANDO para o motor, e uma cerca que o descartasse
 * como comentário deixaria passar o que o administrador roda.
 */
const isComment = (line: string): boolean => /^--( |$)/.test(line)

/** Os comandos VIVOS do script: sem as linhas de comentário, partidos no `;`. Comentário de bloco não é aceito (esconderia um GRANT). */
function liveStatements(sql: string): string[] {
  const code = sql.split(/\r?\n/).filter(line => !isComment(line)).join('\n')
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

  it('cada linha do script é vazia, comentário (dois hifens e o espaço) ou um dos três GRANT exatos — nada que esconda ou corte um comando', () => {
    expect(GRANTS).not.toMatch(/\/\*|\*\//)
    const allowed = new Set(PUBLISHED.map(view => `GRANT SELECT ON \`fiscal_api\`.\`${view}\` TO 'setes_api'@'%';`))
    for (const line of GRANTS.split(/\r?\n/)) {
      expect([line, line === '' || isComment(line) || allowed.has(line)]).toEqual([line, true])
    }
  })

  it('o arquivo não tem separador de linha que o JS não parte (CR solto, U+2028/2029), NBSP, BOM nem caractere de controle', () => {
    // gate adversarial: um comentário seguido de CR solto e de um GRANT é UMA linha para o `split` e DUAS para o editor e o cliente do banco
    const stray = [0x2028, 0x2029, 0xA0, 0xFEFF, 0x7F, ...Array.from({ length: 32 }, (_, i) => i).filter(c => c !== 0x0A && c !== 0x0D)]
    for (const code of stray) expect([code.toString(16), GRANTS.includes(String.fromCharCode(code))]).toEqual([code.toString(16), false])
    expect(GRANTS.split(String.fromCharCode(13, 10)).join('').includes(String.fromCharCode(13))).toBe(false)      // CR solto
  })

  it('a pasta `ops/` só tem este script (um segundo .sql não seria visto por cerca nenhuma)', () => {
    expect(fs.readdirSync(path.resolve(__dirname, '..', '..', 'ops'))).toEqual(['grants.sql'])
  })

  it('o texto manda conferir que o usuário JÁ existe antes de rodar (GRANT a usuário inexistente pode criá-lo sem senha)', () => {
    expect(GRANTS).toContain("SELECT 1 FROM mysql.user WHERE user = 'setes_api' AND host = '%'")
    expect(GRANTS).toMatch(/NO_AUTO_CREATE_USER/)
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
