/**
 * D-F40 — o custo das leituras que CRESCEM COM O HISTÓRICO é critério de aceite (molde: `nfse-api/scripts/explain-leituras.ts`).
 * SOMENTE LEITURA. Chama as funções REAIS do núcleo (o SQL é capturado interceptando `query` — nada é duplicado aqui) e roda `EXPLAIN`
 * + mede o tempo (mediana de N execuções) das leituras da família NF-e que já existem na NE-2:
 *   - as tentativas de UMA nota na vida (`readFamilyTransmissions` sobre a view publicada — o selo, o plano de cancelamento na NE-6);
 *   - as tentativas em LOTE (`readFamilyTransmissionsMany` — a lista de notas);
 *   - as faixas RETIRADAS da numeração de um eixo (`readWithdrawnRanges` — a cunhagem do número no ERP, NE-6).
 * A contagem de vivas do emitter (`countLiveTransmissions`) percorre o CATÁLOGO `VOICE_READINGS` — a família ENTROU nele na janela da NE-6
 * (D-NE158, núcleo 5.0.0 — DEPLOY.E1.P9) e passou a ser contada; este script ainda não a captura da função real (a forma é a mesma
 * WHERE, provada em `prove-001-descartavel.ts`).
 * Regra (cerca M5): subconsulta DEPENDENTE por ALL/index = FALHA; MATERIALIZED varrendo = FALHA; a tabela que dirige pode varrer no dev — AVISO.
 * Desde a NE-4 (NFE.E5.P2): com o 2º argumento (o id de uma nota 55 FATURADA do estabelecimento), entram as leituras da FONTE DE FATOS da
 * mercadoria (`src/facts/merchandise-facts.ts`) — nota e ramo, itens com o cálculo registrado, FCP, natOp, emitente, destinatário,
 * pagamento, transporte e o elo da devolução. Elas provam contra o banco real que as colunas e os JOINs existem; uma recusa da fonte
 * (nota sem item, item sem cálculo) ou a falta de SELECT numa tabela central é FALHA aqui.
 *   npx tsx --require tsconfig-paths/register scripts/explain-leituras.ts [institutionId=1] [invoiceId]
 * EXPLAIN de VIEW exige `SHOW VIEW` — rode com um usuário de diagnóstico em EXPLAIN_DB_USER / EXPLAIN_DB_PASSWORD se o do serviço não tiver.
 */
import 'dotenv/config'
import {
  createFiscalPool, dbConfigFromEnv, MERCHANDISE_VOICE_READING, readFamilyTransmissions, readFamilyTransmissionsMany, readWithdrawnRanges,
  invoiceRef, WEB_TERMINAL,
} from 'fiscal-api'
import {
  listMerchandiseItems, readEmitter, readMerchandiseInvoice, readOperationNature, readPayments, readRecipient, readReturnOrigins, readShipping,
} from '../src/facts/merchandise-facts'

const INST = Number(process.argv[2] ?? 1)
const FACTS_INVOICE = process.argv[3] ? Number(process.argv[3]) : null
const RUNS = 7
type Plan = { id: number; select_type: string; table: string; type: string; key: string | null; rows: number; Extra: string | null }

async function main(): Promise<void> {
  const base = dbConfigFromEnv()
  const cfg = process.env.EXPLAIN_DB_USER ? { ...base, user: process.env.EXPLAIN_DB_USER, password: process.env.EXPLAIN_DB_PASSWORD ?? '' } : base
  const pool = createFiscalPool(cfg)
  const failures: string[] = [], warnings: string[] = []
  try {
    const captured: { label: string; sql: string; params: unknown[] }[] = []
    const capture = (label: string) => ({ query: async (sql: string, params: unknown[] = []) => { captured.push({ label, sql, params }); return pool.query(sql, params) } }) as any
    await readFamilyTransmissions(capture('tentativas da nota (vida)'), MERCHANDISE_VOICE_READING, cfg.database, invoiceRef(INST, 1, WEB_TERMINAL), 1)
    await readFamilyTransmissionsMany(capture('tentativas em lote'), MERCHANDISE_VOICE_READING, cfg.database, { institutionId: INST, terminal: WEB_TERMINAL }, [{ invoiceId: 1, lifeEvent: 1 }, { invoiceId: 2, lifeEvent: 1 }])
    await readWithdrawnRanges(capture('faixas retiradas (55, série 1, P)'), cfg.database, { institutionId: INST, model: '55', serie: 1, environment: 'P' })
    if (FACTS_INVOICE != null) {
      const [inst] = await pool.query(`SELECT schema_name AS schemaName FROM setes_central.tb_institution WHERE id = ?`, [INST]) as unknown as [{ schemaName: string }[]]
      if (!inst[0]) throw new Error(`estabelecimento ${INST} não encontrado`)
      const schema = inst[0].schemaName, ref = invoiceRef(INST, FACTS_INVOICE, WEB_TERMINAL)
      const fact = async (label: string, fn: (q: any) => Promise<unknown>): Promise<any> => {
        try { return await fn(capture(`fatos: ${label}`)) } catch (e: any) { failures.push(`fatos: ${label}: ${e?.code ?? ''} ${e?.message ?? e}`); return null }
      }
      const header = await fact('nota e ramo', q => readMerchandiseInvoice(q, schema, ref))
      const items = await fact('itens + FCP', q => listMerchandiseItems(q, schema, ref))
      if (items) await fact('natOp', q => readOperationNature(q, items))
      await fact('emitente', q => readEmitter(q, schema, INST))
      if (header) await fact('destinatário', q => readRecipient(q, schema, INST, header.entityId))
      await fact('pagamento', q => readPayments(q, schema, ref))
      await fact('transporte', q => readShipping(q, schema, ref))
      await fact('elo da devolução', q => readReturnOrigins(q, schema, ref))
      console.log(`
FATOS da nota ${FACTS_INVOICE} (${schema}): ${header ? `modelo ${header.model}, série ${header.serie}, vNF ${header.totalValue}, indPres ${header.indPres}` : 'não lida'}; ${items ? `${items.length} item(ns)` : 'itens não lidos'}`)
    }
    for (const c of captured) {
      const [plan] = await pool.query(`EXPLAIN ${c.sql}`, c.params) as unknown as [Plan[]]
      const times: number[] = []
      for (let i = 0; i < RUNS; i++) {
        const t0 = process.hrtime.bigint()
        await pool.query(c.sql, c.params)
        times.push(Number(process.hrtime.bigint() - t0) / 1e6)
      }
      times.sort((a, b) => a - b)
      console.log(`\n== ${c.label} — mediana ${times[Math.floor(RUNS / 2)].toFixed(1)} ms (máx ${times[RUNS - 1].toFixed(1)} ms)`)
      for (const p of plan) {
        console.log(`   ${String(p.id).padEnd(3)} ${String(p.select_type).padEnd(20)} ${String(p.table).padEnd(40)} ${String(p.type).padEnd(8)} ${String(p.key ?? '-').padEnd(42)} rows=${p.rows} ${p.Extra ?? ''}`)
        const scan = p.type === 'ALL' || p.type === 'index'
        if (scan && /DEPENDENT/.test(String(p.select_type))) failures.push(`${c.label}: ${p.select_type} em ${p.table} por ${p.type} (varredura POR LINHA)`)
        else if (scan && /MATERIALIZED/.test(String(p.select_type))) failures.push(`${c.label}: ${p.select_type} em ${p.table} por ${p.type} (materialização sem o filtro da institution)`)
        else if (scan) warnings.push(`${c.label}: ${p.table} por ${p.type} (rows=${p.rows}) — conferir com volume na F3`)
      }
    }
  } finally {
    await pool.end()
  }
  if (warnings.length) console.log(`\nAVISOS (${warnings.length}):\n - ${warnings.join('\n - ')}`)
  if (failures.length) { console.log(`\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}`); process.exit(1) }
  console.log('\nOK — nenhuma subconsulta dependente varrendo por linha nem materialização varrendo o banco inteiro.')
}

main().catch(err => { console.error('[explain-leituras] FALHA:', err?.message ?? err); process.exit(1) })
