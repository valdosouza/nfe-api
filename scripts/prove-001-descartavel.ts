/**
 * PROVA da migration 001 da família NF-e num banco DESCARTÁVEL (NE-2 — `prompt_onda_nfe_sefaz.md` §15.4 E2; D-F53: só `fiscal_api_adv*`,
 * NUNCA o `fiscal_api` real — o script recusa outro nome). O que prova, na ordem:
 *   1. o runner aplica o núcleo inteiro (001–007 no pacote 5.0.0) + nfe-api 001 (idempotente: a 2ª passada não aplica nada) e o arquivo 001 inteiro RE-EXECUTA sem erro
 *      com dado dentro (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE VIEW — D-F123);
 *   2. as SONDAS do boot (cada CHECK pelo NOME — PADROES §11 regras 11/16): `assertMerchandiseVoiceDomainsEnforced` + `assertNumberVoidDomainsEnforced`;
 *   3. D-NE163: colunas GERADAS STORED do Id (model/serie/number_from/number_to/withdrawn → withdrawn_void_id encadeada) + UNIQUE da faixa
 *      RETIRADA por (institution, model, serie, environment, number_from, number_to) — a MESMA faixa em P passa (o ambiente separa), a
 *      REJEITADA não bloqueia (história), outra SÉRIE passa, a mesma faixa retirada com OUTRO ANO no Id é barrada (1062) — e a UNIQUE da prova
 *      `(environment, withdrawn_void_id)` existe com essas colunas;
 *   4. D-NE56/D-NE61: a view publica `authority_recorded` pelo PROTOCOLO (P sem protocolo = 'N'; A com protocolo = 'S') e o mapa do núcleo
 *      recusa a D sem registro (falha ALTO — D-NE61) e aceita a linha mapeada; a leitura das faixas (`readWithdrawnRanges`) lê o que entrou;
 *   5. EXPLAIN das leituras REAIS (SQL capturado das funções do núcleo — nada copiado): por nota, em lote, a contagem de vivas do emitter
 *      (na forma que ele roda desde que a família entrou no catálogo, no núcleo 5.0.0 — a mesma WHERE, ainda escrita aqui) e as faixas retiradas — nenhuma subconsulta DEPENDENTE
 *      por varredura, nenhuma MATERIALIZED varrendo (molde do `explain-leituras` da nfse-api / cerca M5);
 *   6. `SET NAMES utf8mb4 COLLATE <x>` em três colações lendo as duas views (regra 3 do PADROES §11 — erro 1267 só no leitor de outra colação).
 * Ao final deixa o banco como achou (apaga o que inseriu) — o DROP DATABASE é do condutor.
 *   npx tsx --require tsconfig-paths/register scripts/prove-001-descartavel.ts    (FISCAL_DB_NAME=fiscal_api_adv_ne2 no .env)
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import {
  createFiscalPool, dbConfigFromEnv, runMigrations, splitStatements, MERCHANDISE_VOICE_READING, familyViewSelect, readFamilyTransmissions,
  readFamilyTransmissionsMany, readWithdrawnRanges, withdrawnRangesQuery, invoiceRef, WEB_TERMINAL, FINAL_TRANSMISSION_KINDS, mapCommonView,
} from 'fiscal-api'
import { MIGRATION_SETS, NFE_MIGRATIONS_DIR } from '../src/migrations'
import { assertMerchandiseVoiceDomainsEnforced, MERCHANDISE_TRANSMISSION_TABLE, MERCHANDISE_VOICE_FAMILY } from '../src/nfe/voice-family'
import { assertNumberVoidDomainsEnforced, assertNumberVoidUniqueKeys, NUMBER_VOID_TABLE, NUMBER_VOID_UNIQUE_KEYS, voidId } from '../src/nfe/number-void'

type Plan = { id: number; select_type: string; table: string; type: string; key: string | null; rows: number; Extra: string | null }
const INST = 999_001, INVOICE = 6200, TERMINAL = WEB_TERMINAL
const KEY = (n: number) => `412610ABCDEF78000195` + '55' + '001' + String(n).padStart(9, '0') + '1' + String(n).padStart(8, '0') + '0'
const fails: string[] = []
const ok = (what: string, cond: boolean, detail = '') => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails.push(what) }
const isDup = (e: any) => e?.errno === 1062
const isCheck = (e: any, name: string) => e?.errno === 4025 && String(e?.sqlMessage ?? '').includes(`\`${name}\``)

async function main(): Promise<void> {
  const cfg = dbConfigFromEnv()
  if (!/^fiscal_api_adv[a-z0-9_]*$/.test(cfg.database)) throw new Error(`D-F53: a prova só roda em banco descartável fiscal_api_adv* (FISCAL_DB_NAME=${cfg.database})`)
  console.log(`== prova da 001 em ${cfg.database} (MariaDB/MySQL em ${cfg.host}:${cfg.port}, usuário ${cfg.user})`)

  // 1. runner — idempotente; re-execução do arquivo inteiro
  const first = await runMigrations(cfg, MIGRATION_SETS)
  console.log(`runner: ${first.length ? `aplicou ${first.join(', ')}` : 'nada pendente (já aplicada antes)'}`)
  ok('runner idempotente (2ª passada não aplica nada)', (await runMigrations(cfg, MIGRATION_SETS)).length === 0)
  const pool = createFiscalPool(cfg)
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p)
  const [ver] = await q('SELECT VERSION() AS v')
  console.log(`motor: ${(ver as any[])[0].v}`)
  try {
    await q(`DELETE FROM ${MERCHANDISE_VOICE_FAMILY.eventTable} WHERE tb_institution_id = ?`, [INST])
    await q(`DELETE FROM ${MERCHANDISE_TRANSMISSION_TABLE} WHERE tb_institution_id = ?`, [INST])
    await q(`DELETE FROM ${NUMBER_VOID_TABLE} WHERE tb_institution_id = ?`, [INST])

    // 2. as sondas do boot
    await assertMerchandiseVoiceDomainsEnforced(pool); ok('sondas do boot — domínios da tentativa e da voz (cada CHECK pelo nome)', true)
    await assertNumberVoidDomainsEnforced(pool); ok('sondas do boot — domínios da faixa inutilizada (cada CHECK pelo nome)', true)

    // 3. D-NE163 — geradas + UNIQUE da faixa retirada
    const ins = (id: number, v: { yy?: string; serie?: number; from?: number; to?: number; env?: string; code?: string | null }) => q(
      `INSERT INTO ${NUMBER_VOID_TABLE} (tb_institution_id, id, void_id, environment, authorizer, reason, authority_code, created_at, updated_at) VALUES (?, ?, ?, ?, 'PR', 'prova da 001 no descartavel', ?, NOW(), NOW())`,
      [INST, id, voidId({ yy: v.yy, serie: v.serie ?? 1, from: v.from ?? 1, to: v.to ?? 10 }), v.env ?? 'H', v.code ?? null])
    await ins(1, {})                                                 // pendente em H
    const [g] = await q(`SELECT model, serie, number_from AS f, number_to AS t, withdrawn AS w, withdrawn_void_id AS wid FROM ${NUMBER_VOID_TABLE} WHERE tb_institution_id = ? AND id = 1`, [INST])
    const r = (g as any[])[0]
    ok('colunas GERADAS do Id (model 55 / serie 1 / 1..10 / withdrawn S / withdrawn_void_id = Id)', r.model === '55' && Number(r.serie) === 1 && Number(r.f) === 1 && Number(r.t) === 10 && r.w === 'S' && r.wid === voidId({ serie: 1, from: 1, to: 10 }), JSON.stringify(r))
    await ins(2, { env: 'P' }); ok('a MESMA faixa em P passa (o ambiente separa — defeito do rascunho corrigido)', true)
    await ins(3, { code: '256' }); ok('a REJEITADA da mesma faixa em H passa (história; withdrawn NULL)', true)
    await ins(4, { serie: 2 }); ok('a mesma faixa noutra SÉRIE passa (a série é parte da identidade — emenda do Valdo)', true)
    const dup = await ins(5, { yy: '27' }).then(() => null, e => e)
    ok('a mesma faixa RETIRADA em H com OUTRO ANO no Id é barrada pela chave composta (1062 uk_invoice_number_void_range)', isDup(dup) && /uk_invoice_number_void_range/.test(dup?.sqlMessage ?? ''), dup?.sqlMessage)
    await assertNumberVoidUniqueKeys(pool)
    ok(`sonda do boot das DUAS UNIQUE da faixa (D-NE163): ${Object.entries(NUMBER_VOID_UNIQUE_KEYS).map(([k, v]) => `${k}(${v.join(',')})`).join(' · ')}`, true)
    const [rej] = await q(`SELECT withdrawn AS w, withdrawn_void_id AS wid FROM ${NUMBER_VOID_TABLE} WHERE tb_institution_id = ? AND id = 3`, [INST])
    ok('a rejeitada tem withdrawn/withdrawn_void_id NULL (fora das duas UNIQUE)', (rej as any[])[0].w === null && (rej as any[])[0].wid === null)
    const ranges = await readWithdrawnRanges(pool, cfg.database, { institutionId: INST, model: '55', serie: 1, environment: 'H' })
    ok('leitura das faixas retiradas (núcleo) devolve só a pendente de H/série 1 (não a rejeitada, não a de P, não a série 2)', ranges.length === 1 && ranges[0].numberFrom === 1 && ranges[0].numberTo === 10 && ranges[0].id === 1, JSON.stringify(ranges))

    // 4. registro pelo protocolo + invariantes do mapa
    await q(`INSERT INTO ${MERCHANDISE_TRANSMISSION_TABLE} (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, authorizer, access_key, dh_emission, digest_value, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 'H', 'PR', ?, NOW(), ?, NOW(), NOW())`,
      [INST, INVOICE, TERMINAL, KEY(1), 'A'.repeat(27) + '='])
    await q(`INSERT INTO ${MERCHANDISE_VOICE_FAMILY.eventTable} (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 'P', '103', 'Lote recebido com sucesso', NOW(), 'P', NOW(), NOW())`, [INST, INVOICE, TERMINAL])
    const ref = invoiceRef(INST, INVOICE, TERMINAL)
    let rows = await readFamilyTransmissions(pool, MERCHANDISE_VOICE_READING, cfg.database, ref, 1)
    ok('view: P sem protocolo = NÃO registrada (authorityRecorded false, lastKind P, lastCode 103)', rows.length === 1 && !rows[0].authorityRecorded && rows[0].lastKind === 'P' && rows[0].lastCode === '103' && rows[0].accessKey === KEY(1), JSON.stringify(rows[0]))
    await q(`INSERT INTO ${MERCHANDISE_VOICE_FAMILY.eventTable} (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, created_at, updated_at) VALUES (?, ?, ?, 1, 2, 'A', '100', 'Autorizado o uso da NF-e', NOW() + INTERVAL 1 SECOND, 'Q', NOW(), NOW())`, [INST, INVOICE, TERMINAL])
    await q(`UPDATE ${MERCHANDISE_TRANSMISSION_TABLE} SET protocol = '141260000012345', dh_recbto = NOW() WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND attempt = 1 AND protocol IS NULL`, [INST, INVOICE, TERMINAL])
    rows = await readFamilyTransmissions(pool, MERCHANDISE_VOICE_READING, cfg.database, ref, 1)
    ok('view: A com protocolo = REGISTRADA (authorityRecorded true, lastKind A, dhEmission presente)', rows.length === 1 && rows[0].authorityRecorded && rows[0].lastKind === 'A' && !!rows[0].dhEmission, JSON.stringify(rows[0]))
    // D-NE61 na view desta família: uma D gravada POR FORA sem protocolo chega à view como 'N' e o mapa do núcleo a recusa (falha ALTO)
    await q(`INSERT INTO ${MERCHANDISE_TRANSMISSION_TABLE} (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, authorizer, access_key, dh_emission, digest_value, created_at, updated_at) VALUES (?, ?, ?, 2, 1, 'H', 'PR', ?, NOW(), ?, NOW(), NOW())`,
      [INST, INVOICE + 1, TERMINAL, KEY(2), 'B'.repeat(27) + '='])
    await q(`INSERT INTO ${MERCHANDISE_VOICE_FAMILY.eventTable} (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, created_at, updated_at) VALUES (?, ?, ?, 2, 1, 'D', '301', 'Uso Denegado', NOW(), 'P', NOW(), NOW())`, [INST, INVOICE + 1, TERMINAL])
    const dErr = await readFamilyTransmissions(pool, MERCHANDISE_VOICE_READING, cfg.database, invoiceRef(INST, INVOICE + 1, TERMINAL), 1).then(() => null, e => e)
    ok('D-NE61: D sem protocolo (gravada por fora) é recusada pelo mapa do núcleo — nunca "não registrada" calada', /D-NE61/.test(String(dErr?.message)), String(dErr?.message).slice(0, 100))
    await q(`UPDATE ${MERCHANDISE_TRANSMISSION_TABLE} SET protocol = '141260000012346' WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND attempt = 2`, [INST, INVOICE + 1, TERMINAL])
    const dRows = await readFamilyTransmissions(pool, MERCHANDISE_VOICE_READING, cfg.database, invoiceRef(INST, INVOICE + 1, TERMINAL), 1)
    ok('D com protocolo = registrada e FINAL (o número queimou — D-E7)', dRows[0].authorityRecorded && dRows[0].lastKind === 'D' && FINAL_TRANSMISSION_KINDS.has('D'))
    const lote = await readFamilyTransmissionsMany(pool, MERCHANDISE_VOICE_READING, cfg.database, { institutionId: INST, terminal: TERMINAL }, [{ invoiceId: INVOICE, lifeEvent: 1 }, { invoiceId: INVOICE + 1, lifeEvent: 1 }])
    ok('leitura em LOTE (pares nota × vida) devolve as duas', lote.length === 2)
    void mapCommonView

    // 5. EXPLAIN do SQL REAL (capturado)
    const captured: { label: string; sql: string; params: unknown[] }[] = []
    const capture = (label: string) => ({ query: async (sql: string, params: unknown[] = []) => { captured.push({ label, sql, params }); return pool.query(sql, params) } }) as any
    await readFamilyTransmissions(capture('tentativas da nota (vida)'), MERCHANDISE_VOICE_READING, cfg.database, ref, 1)
    await readFamilyTransmissionsMany(capture('tentativas em lote'), MERCHANDISE_VOICE_READING, cfg.database, { institutionId: INST, terminal: TERMINAL }, [{ invoiceId: INVOICE, lifeEvent: 1 }, { invoiceId: INVOICE + 1, lifeEvent: 1 }])
    await readWithdrawnRanges(capture('faixas retiradas'), cfg.database, { institutionId: INST, model: '55', serie: 1, environment: 'H' })
    // a contagem de vivas do emitter (`countLiveTransmissions`) percorre o CATÁLOGO — a família entrou nele no núcleo 5.0.0 (D-NE158); a forma dela é
    // a MESMA WHERE sobre a view publicada: registrada aqui com a view desta família para o EXPLAIN (capturar da função real do
    // emitter fica para quem mexer neste script)
    const finals = [...FINAL_TRANSMISSION_KINDS].map(k => `'${k}'`).join(',')
    captured.push({ label: 'vivas do emissor (forma do countLiveTransmissions)', params: [INST, null, null],
      sql: `SELECT COUNT(*) AS n FROM ${MERCHANDISE_VOICE_READING.transmissionView} t WHERE t.tb_institution_id = ? AND (? IS NULL OR t.environment = ?) AND (t.last_kind IS NULL OR t.last_kind NOT IN (${finals}))` })
    void familyViewSelect
    for (const c of captured) {
      const [plan] = await pool.query(`EXPLAIN ${c.sql}`, c.params) as unknown as [Plan[]]
      console.log(`\n== EXPLAIN ${c.label}`)
      for (const p of plan) {
        console.log(`   ${String(p.id).padEnd(3)} ${String(p.select_type).padEnd(20)} ${String(p.table).padEnd(40)} ${String(p.type).padEnd(8)} ${String(p.key ?? '-').padEnd(42)} rows=${p.rows} ${p.Extra ?? ''}`)
        const scan = p.type === 'ALL' || p.type === 'index'
        if (scan && /DEPENDENT/.test(String(p.select_type))) fails.push(`${c.label}: ${p.select_type} em ${p.table} por ${p.type} (varredura POR LINHA)`)
        else if (scan && /MATERIALIZED/.test(String(p.select_type))) fails.push(`${c.label}: ${p.select_type} em ${p.table} por ${p.type} (materialização sem o filtro da institution)`)
        else if (scan) console.log(`   AVISO: ${p.table} por ${p.type} (rows=${p.rows}) — tabela que dirige; conferir com volume na F3`)
      }
      ok(`EXPLAIN ${c.label}: PRIMARY/SIMPLE fundidas, nada dependente por varredura`, plan.every(p => !(/DEPENDENT|MATERIALIZED/.test(p.select_type) && (p.type === 'ALL' || p.type === 'index'))))
    }

    // 6. colações
    for (const coll of ['utf8mb4_general_ci', 'utf8mb4_unicode_ci', 'utf8mb4_bin']) {
      // conexão própria por colação (pela fábrica do núcleo — o mysql2 é dependência do núcleo, não desta API)
      const one = createFiscalPool({ ...cfg, connectionLimit: 1 })
      const conn = await one.getConnection()
      try {
        await conn.query(`SET NAMES utf8mb4 COLLATE ${coll}`)
        const [a] = await conn.query(`SELECT COUNT(*) AS n FROM ${MERCHANDISE_VOICE_READING.transmissionView} WHERE tb_institution_id = ? AND authority_recorded = 'S'`, [INST])
        const [b] = await conn.query(withdrawnRangesQuery(cfg.database, { institutionId: INST, model: '55', serie: 1, environment: 'H' }).sql, withdrawnRangesQuery(cfg.database, { institutionId: INST, model: '55', serie: 1, environment: 'H' }).params)
        const [c] = await conn.query(`SELECT COUNT(*) AS n FROM ${MERCHANDISE_VOICE_READING.transmissionView} WHERE tb_institution_id = ? AND (last_kind IS NULL OR last_kind NOT IN (${finals}))`, [INST])
        ok(`SET NAMES ${coll}: registradas=${(a as any[])[0].n}, faixas=${(b as any[]).length}, vivas=${(c as any[])[0].n} (sem 1267)`, Number((a as any[])[0].n) === 2 && (b as any[]).length === 1 && Number((c as any[])[0].n) === 0)
      } catch (e: any) {
        ok(`SET NAMES ${coll}`, false, e?.sqlMessage ?? e?.message)
      } finally { conn.release(); await one.end() }
    }

    // 1b. re-execução do ARQUIVO inteiro com dado dentro (statement a statement, como o runner corta)
    const file = fs.readdirSync(NFE_MIGRATIONS_DIR).find(f => /^001_/.test(f))!
    for (const st of splitStatements(fs.readFileSync(path.join(NFE_MIGRATIONS_DIR, file), 'utf8'))) await q(st)
    const [kept] = await q(`SELECT (SELECT COUNT(*) FROM ${NUMBER_VOID_TABLE} WHERE tb_institution_id = ?) AS faixas, (SELECT COUNT(*) FROM ${MERCHANDISE_TRANSMISSION_TABLE} WHERE tb_institution_id = ?) AS tx`, [INST, INST])
    ok('re-execução do arquivo 001 com dado dentro: sem erro e o dado fica', Number((kept as any[])[0].faixas) === 4 && Number((kept as any[])[0].tx) === 2, JSON.stringify((kept as any[])[0]))
    // um CHECK por nome depois da re-execução (a 2ª passada não perdeu constraint)
    const after = await q(`INSERT INTO ${MERCHANDISE_VOICE_FAMILY.eventTable} (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, source, deleted) VALUES (?, ?, ?, 1, 9, 'S', 'P', 'N')`, [INST, INVOICE, TERMINAL]).then(() => null, e => e)
    ok('depois da re-execução o CHECK do kind segue recusando S pelo nome', isCheck(after, 'ck_invoice_merchandise_transmission_event_kind'))
  } finally {
    await q(`DELETE FROM ${MERCHANDISE_VOICE_FAMILY.eventTable} WHERE tb_institution_id = ?`, [INST])
    await q(`DELETE FROM ${MERCHANDISE_TRANSMISSION_TABLE} WHERE tb_institution_id = ?`, [INST])
    await q(`DELETE FROM ${NUMBER_VOID_TABLE} WHERE tb_institution_id = ?`, [INST])
    await pool.end()
  }
  if (fails.length) { console.log(`\nFALHAS (${fails.length}):\n - ${fails.join('\n - ')}`); process.exit(1) }
  console.log('\nOK — 001 provada no descartável (runner idempotente, sondas pelo nome, geradas + UNIQUE com série e ambiente, registro pelo protocolo, EXPLAIN por chave, 3 colações, re-execução).')
}

main().catch(err => { console.error('[prove:001] FALHA:', err?.sqlMessage ?? err?.message ?? err); process.exit(1) })
