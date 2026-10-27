/// <reference types="jest" />
// A migration 001 da família NF-e — o que a NE-2 fixou no DDL (Rodada 15 — `prompt_onda_nfe_sefaz.md` §15.8) e os itens do revisar-ddl que
// se conferem no TEXTO (a prova no banco descartável é `scripts/prove-001-descartavel.ts` — §15.9). Puro.
import fs from 'fs'
import path from 'path'
import { splitStatements, COMMON_TRANSMISSION_COLUMNS, modelsOf } from 'fiscal-api'
import { MERCHANDISE_VOICE_WRITE_KINDS, MERCHANDISE_CANCEL_EVENT_CODES } from '../nfe/voice-family'
import { NUMBER_VOID_UNIQUE_KEYS } from '../nfe/number-void'

const FILE = path.resolve(__dirname, '..', 'migrations', 'sql', '001_nfe_baseline.sql')
const raw = fs.readFileSync(FILE, 'utf8')
const sql = raw.replace(/--[^\n]*/g, '')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const table = (name: string) => norm(sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS \`${name}\` \\([\\s\\S]*?\\) ENGINE=InnoDB[^;]*`))![0])
const view = (name: string) => norm(sql.match(new RegExp(`CREATE OR REPLACE VIEW \`${name}\` AS[\\s\\S]*?;`))![0])
const list = (s: string) => s.split(',').map(x => x.trim().replace(/[`']/g, ''))

describe('forma e re-executabilidade (revisar-ddl)', () => {
  it('5 statements como o runner corta; 3 CREATE TABLE IF NOT EXISTS + 2 CREATE OR REPLACE VIEW; colunas padrão; sem AUTO_INCREMENT; nomes tb_/vw_', () => {
    const st = splitStatements(raw)
    expect(st.map(s => s.split('\n')[0].replace(/\s+\($/, ''))).toEqual([
      'CREATE TABLE IF NOT EXISTS `tb_invoice_merchandise_transmission`', 'CREATE TABLE IF NOT EXISTS `tb_invoice_merchandise_transmission_event`',
      'CREATE TABLE IF NOT EXISTS `tb_invoice_number_void`', 'CREATE OR REPLACE VIEW `vw_invoice_merchandise_transmission` AS', 'CREATE OR REPLACE VIEW `vw_invoice_number_void` AS',
    ])
    for (const t of ['tb_invoice_merchandise_transmission', 'tb_invoice_merchandise_transmission_event', 'tb_invoice_number_void']) {
      for (const col of ['`created_at` DATETIME DEFAULT NULL', '`updated_at` DATETIME DEFAULT NULL', "`deleted` CHAR(1) NOT NULL DEFAULT 'N'"]) expect([t, col, table(t).includes(col)]).toEqual([t, col, true])
      expect(table(t)).toMatch(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci$/)
    }
    expect(sql).not.toMatch(/AUTO_INCREMENT|DEFAULT 'NULL'|DEFAULT 'Y'/)
    // nenhum `--` nem linha terminando em `;` dentro de um COMMENT (o runner tira comentários de linha e corta em `;` no fim da linha)
    for (const line of raw.split(/\r?\n/)) {
      if (/COMMENT '/.test(line)) { expect([line.slice(0, 60), /COMMENT '[^']*--/.test(line), /;\s*$/.test(line)]).toEqual([line.slice(0, 60), false, false]) }
    }
  })
  it('todo CHECK é BINÁRIO (`COLLATE utf8mb4_bin`) e os 15 nomes que as sondas do boot usam existem', () => {
    const checks = [...sql.matchAll(/CONSTRAINT `(ck_\w+)`\s+CHECK \(([\s\S]*?)\)\s*(?:,|\) ENGINE)/g)].map(m => [m[1], norm(m[2])] as const)
    expect(checks.map(c => c[0]).sort()).toEqual([
      'ck_invoice_merchandise_transmission_authorizer', 'ck_invoice_merchandise_transmission_digest', 'ck_invoice_merchandise_transmission_environment',
      'ck_invoice_merchandise_transmission_event_cancel_code', 'ck_invoice_merchandise_transmission_event_kind', 'ck_invoice_merchandise_transmission_event_source',
      'ck_invoice_merchandise_transmission_event_status_code', 'ck_invoice_merchandise_transmission_key', 'ck_invoice_merchandise_transmission_protocol',
      'ck_invoice_merchandise_transmission_receipt', 'ck_invoice_number_void_authorizer', 'ck_invoice_number_void_environment', 'ck_invoice_number_void_id',
      'ck_invoice_number_void_protocol', 'ck_invoice_number_void_status_code',
    ])
    for (const [name, body] of checks) expect([name, body.includes('COLLATE utf8mb4_bin')]).toEqual([name, true])
    // regra 16: domínio de CÓDIGO em VARCHAR = comprimento + lista binária
    for (const name of ['ck_invoice_merchandise_transmission_authorizer', 'ck_invoice_merchandise_transmission_event_cancel_code', 'ck_invoice_number_void_authorizer']) {
      expect([name, checks.find(c => c[0] === name)![1].includes('CHAR_LENGTH(')]).toEqual([name, true])
    }
  })
})

describe('D-F107/D-NE107 — a lista de escrita da família É o CHECK de `kind`; o cancelamento é só o 110111 (D-NE106); os modelos são os do ramo', () => {
  it('UMA fonte: o CHECK tem EXATAMENTE `MERCHANDISE_VOICE_WRITE_KINDS` (mesma ordem), na tabela da voz', () => {
    const m = /CONSTRAINT `ck_invoice_merchandise_transmission_event_kind` CHECK \(`kind` COLLATE utf8mb4_bin IN \(([^)]*)\)\)/.exec(table('tb_invoice_merchandise_transmission_event'))
    expect(m).not.toBeNull()
    expect(list(m![1])).toEqual([...MERCHANDISE_VOICE_WRITE_KINDS])
    expect(list(m![1])).not.toContain('S')
  })
  it('o código da voz C = `MERCHANDISE_CANCEL_EVENT_CODES` (6 posições, binário); a voz que decide leva cStat de 3-4 dígitos', () => {
    const t = table('tb_invoice_merchandise_transmission_event')
    const m = /CHAR_LENGTH\(`authority_code`\) = 6 AND `authority_code` COLLATE utf8mb4_bin IN \(([^)]*)\)/.exec(t)
    expect(list(m![1])).toEqual([...MERCHANDISE_CANCEL_EVENT_CODES])
    expect(t).toMatch(/`kind` COLLATE utf8mb4_bin NOT IN \('A', 'R', 'D', 'P'\) OR \(`authority_code` IS NOT NULL AND `authority_code` COLLATE utf8mb4_bin REGEXP '\^\[0-9\]\{3,4\}\$'\)/)
  })
  it('o modelo na CHAVE (posições 21-22) e no Id da inutilização = `modelsOf(\'merchandise\')`; tpEmis 1/6/7', () => {
    const models = modelsOf('merchandise')
    expect(table('tb_invoice_merchandise_transmission')).toContain(`SUBSTRING(\`access_key\`, 21, 2) COLLATE utf8mb4_bin IN (${models.map(m => `'${m}'`).join(', ')})`)
    expect(table('tb_invoice_merchandise_transmission')).toContain("SUBSTRING(`access_key`, 35, 1) COLLATE utf8mb4_bin IN ('1', '6', '7')")
    expect(table('tb_invoice_number_void')).toContain(`REGEXP '^ID[0-9]{4}[0-9A-Z]{12}[0-9]{2}(${models.join('|')})[0-9]{21}$'`)
  })
})

describe('D-NE163 — a faixa retirada: identidade COMPOSTA com a SÉRIE e o AMBIENTE; a prova por (environment, withdrawn_void_id)', () => {
  const t = table('tb_invoice_number_void')
  it('colunas GERADAS STORED do Id (uma fonte): model (binária), serie, number_from, number_to; `withdrawn` = a ÚNICA regra; `withdrawn_void_id` deriva dela', () => {
    expect(t).toContain('`model` CHAR(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin GENERATED ALWAYS AS (SUBSTRING(`void_id`, 21, 2)) STORED')
    expect(t).toContain('`serie` SMALLINT UNSIGNED GENERATED ALWAYS AS (CAST(SUBSTRING(`void_id`, 23, 3) AS UNSIGNED)) STORED')
    expect(t).toContain('`number_from` INT UNSIGNED GENERATED ALWAYS AS (CAST(SUBSTRING(`void_id`, 26, 9) AS UNSIGNED)) STORED')
    expect(t).toContain('`number_to` INT UNSIGNED GENERATED ALWAYS AS (CAST(SUBSTRING(`void_id`, 35, 9) AS UNSIGNED)) STORED')
    expect(t).toContain("GENERATED ALWAYS AS (IF(`authority_code` IS NULL OR `authority_code` COLLATE utf8mb4_bin IN ('102', '563'), 'S', NULL)) STORED")
    expect(t).toContain("`withdrawn_void_id` VARCHAR(43) GENERATED ALWAYS AS (IF(`withdrawn` = 'S', `void_id`, NULL)) STORED")
    // o predicado "retirada" aparece UMA vez (a 2ª coluna deriva da 1ª — nunca duas cópias da regra)
    expect(t.match(/IN \('102', '563'\), 'S', NULL\)/g)).toHaveLength(1)
  })
  it('UNIQUE da faixa (institution, model, serie, environment, number_from, number_to, withdrawn) e UNIQUE da prova (environment, withdrawn_void_id)', () => {
    expect(t).toContain('UNIQUE KEY `uk_invoice_number_void_range` (`tb_institution_id`, `model`, `serie`, `environment`, `number_from`, `number_to`, `withdrawn`)')
    expect(t).toContain('UNIQUE KEY `uk_invoice_number_void_withdrawn` (`environment`, `withdrawn_void_id`)')
    expect(t).not.toMatch(/UNIQUE KEY `uk_invoice_number_void_withdrawn` \(`withdrawn_void_id`\)/)      // o defeito do rascunho (sem o ambiente)
    // UMA fonte: a constante da sonda do boot (`NUMBER_VOID_UNIQUE_KEYS`) = as duas UNIQUE do DDL, na ordem
    for (const [name, cols] of Object.entries(NUMBER_VOID_UNIQUE_KEYS)) expect(t).toContain(`UNIQUE KEY \`${name}\` (${cols.map(c => `\`${c}\``).join(', ')})`)
  })
  it('D-NE161: a view das faixas retiradas publica (institution, id, model, serie, number_from, number_to, environment, created_at), SEM `authority_recorded`, só as retiradas', () => {
    const v = view('vw_invoice_number_void')
    expect(v).toBe("CREATE OR REPLACE VIEW `vw_invoice_number_void` AS SELECT v.`tb_institution_id`, v.`id`, v.`model`, v.`serie`, v.`number_from`, v.`number_to`, v.`environment`, v.`created_at` FROM `tb_invoice_number_void` v WHERE v.`deleted` = 'N' AND v.`withdrawn` = 'S';")
    expect(v).not.toContain('authority_recorded')
  })
})

describe('D-NE160/D-NE56 — a view de tentativas publica a projeção comum + `dh_emission`; o registro é o PROTOCOLO; sem view de vozes', () => {
  it('colunas publicadas = COMMON_TRANSMISSION_COLUMNS + dh_emission; nada interno; `authority_recorded` pelo protocolo com COLLATE bin', () => {
    const v = view('vw_invoice_merchandise_transmission')
    const select = v.slice(0, v.indexOf(' FROM '))
    for (const [column] of COMMON_TRANSMISSION_COLUMNS) expect([column, select.includes(`\`${column}\``)]).toEqual([column, true])
    expect(select).toContain('t.`dh_emission`')
    for (const internal of ['t.`protocol`,', 't.`authorizer`', 't.`receipt`', 't.`dh_recbto`', 't.`digest_value`', '`model`']) expect([internal, select.includes(internal)]).toEqual([internal, false])
    expect(select).toContain("IF(t.`protocol` IS NULL, 'N', 'S') COLLATE utf8mb4_bin AS `authority_recorded`")
    expect(v).toMatch(/LEFT JOIN `tb_invoice_merchandise_transmission_event` le ON .* AND NOT EXISTS \(SELECT 1 FROM `tb_invoice_merchandise_transmission_event` x WHERE .* AND x\.`event` > le\.`event`\) WHERE t\.`deleted` = 'N';$/)
    expect(sql).not.toContain('vw_invoice_merchandise_transmission_event')
  })
})
