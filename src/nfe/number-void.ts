import { assertCheckRefuses } from 'fiscal-api'

/**
 * INUTILIZAÇÃO de faixa — a tabela da NUMERAÇÃO da família (D-NE8/D-NE40/D-NE161/D-NE163; migration 001 desta API). O escritor (reserva do
 * pedido, voz do fisco na MESMA linha, reenvio do mesmo Id) chega na NE-5; a leitura das faixas RETIRADAS é a peça do núcleo
 * (`numbering/withdrawn-ranges.ts` — o setes-api lê na NE-6). Aqui, na NE-2: o NOME da tabela e as sondas do boot dos domínios dela.
 */
export const NUMBER_VOID_TABLE = 'tb_invoice_number_void'

/**
 * Id do infInut (D-NE40): ID + cUF(2) + AA(2) + CNPJ(14, alfanumérico nas 12 primeiras) + mod(2) + série(3) + nNFIni(9) + nNFFin(9) = 43.
 * Montado por PARTES (a prova da NE-2 achou um Id digitado à mão com 45 posições — nunca mais literal de 43 à mão).
 */
export function voidId(p: { uf?: string; yy?: string; cnpj?: string; model?: string; serie: number; from: number; to: number; prefix?: string }): string {
  const cnpj = p.cnpj ?? 'ABCDEF78000195'
  if (cnpj.length !== 14) throw new Error('voidId: CNPJ com 14 posições')
  const id = `${p.prefix ?? 'ID'}${p.uf ?? '41'}${p.yy ?? '26'}${cnpj}${p.model ?? '55'}${String(p.serie).padStart(3, '0')}${String(p.from).padStart(9, '0')}${String(p.to).padStart(9, '0')}`
  if (id.length !== 43) throw new Error(`voidId: ${id.length} posições (esperadas 43)`)
  return id
}

/**
 * D-NE163 — a IDENTIDADE da faixa retirada é fato do banco em duas UNIQUE: a da faixa `(institution, model, serie, environment, number_from,
 * number_to, withdrawn)` e a da prova `(environment, withdrawn_void_id)`. UMA fonte (a 001 e esta constante — `migration-001.test.ts` compara).
 */
export const NUMBER_VOID_UNIQUE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  uk_invoice_number_void_range:     Object.freeze(['tb_institution_id', 'model', 'serie', 'environment', 'number_from', 'number_to', 'withdrawn']),
  uk_invoice_number_void_withdrawn: Object.freeze(['environment', 'withdrawn_void_id']),
})

/**
 * Sonda do boot da IDENTIDADE da faixa (gate adversarial da NE-2, BOOT_BLIND_SPOT): `CREATE TABLE IF NOT EXISTS` mantém CALADA uma tabela que
 * nasceu de outro DDL (o rascunho v1.1 tinha os MESMOS 15 nomes de CHECK e a UNIQUE da prova SEM o ambiente) — as sondas de CHECK passariam e a
 * D-NE163 estaria ausente. Lê o `information_schema.STATISTICS` da tabela no banco da conexão e exige as duas UNIQUE com EXATAMENTE estas colunas,
 * nesta ordem, únicas. Falha ALTO com o diagnóstico (nunca "sobe e descobre no 1º 1062").
 */
export async function assertNumberVoidUniqueKeys(q: { query(sql: string, params?: unknown): Promise<[any, any]> }): Promise<void> {
  const names = Object.keys(NUMBER_VOID_UNIQUE_KEYS)
  const [rows] = await q.query(
    `SELECT INDEX_NAME AS name, COLUMN_NAME AS col, NON_UNIQUE AS nonUnique FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME IN (?, ?) ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [NUMBER_VOID_TABLE, ...names])
  if (!Array.isArray(rows)) throw new Error('assertNumberVoidUniqueKeys: o catálogo do banco não devolveu linhas')
  for (const name of names) {
    const mine = rows.filter((r: any) => r.name === name)
    const cols = mine.map((r: any) => String(r.col))
    const unique = mine.every((r: any) => Number(r.nonUnique) === 0)
    const expected = NUMBER_VOID_UNIQUE_KEYS[name]
    if (!mine.length || !unique || cols.join(',') !== expected.join(',')) {
      throw new Error(`A UNIQUE ${name} de ${NUMBER_VOID_TABLE} não é a da D-NE163 (esperado ${expected.join(',')}; achado ${mine.length ? `${cols.join(',')}${unique ? '' : ' NÃO única'}` : 'ausente'}) — `
        + 'tabela nascida de outro DDL (CREATE TABLE IF NOT EXISTS não a corrige): recriar a tabela antes de qualquer linha')
    }
  }
}

/**
 * Sonda do boot dos domínios da faixa inutilizada (CHECKs BINÁRIOS da 001; molde da D-F45/`assertCheckRefuses`): cada linha com PK própria,
 * TODO o resto válido e Id PRÓPRIO (a UNIQUE da faixa retirada nunca mascara o diagnóstico de uma sonda aceita — F2A1-05/F2A1-07).
 */
export async function assertNumberVoidDomainsEnforced(pool: Parameters<typeof assertCheckRefuses>[0]): Promise<void> {
  const row = (id: number, v: { void?: string; env?: string; authorizer?: string; code?: string | null; protocol?: string | null }, value: string, constraint: string) => ({
    value, constraint,
    params: [id, v.void ?? voidId({ serie: 900, from: id, to: id }), v.env ?? 'H', v.authorizer ?? 'PR', v.code ?? null, v.protocol ?? null],
    sql: `INSERT INTO ${NUMBER_VOID_TABLE} (tb_institution_id, id, void_id, environment, authorizer, reason, authority_code, protocol, deleted)`
      + ` VALUES (0, ?, ?, ?, ?, 'sonda do boot dos dominios da faixa', ?, ?, 'N')` })
  const V = 'ck_invoice_number_void_'
  await assertCheckRefuses(pool, 'o ambiente da faixa inutilizada', [row(1, { env: 'X' }, 'X', `${V}environment`), row(2, { env: 'h' }, 'h', `${V}environment`)])
  // o Id: prefixo minúsculo ('id' — o REGEXP _ci aceitaria), faixa INVERTIDA (nNFIni > nNFFin) e modelo fora da família (57)
  await assertCheckRefuses(pool, 'o Id da faixa inutilizada', [
    row(3, { void: voidId({ prefix: 'id', serie: 900, from: 3, to: 3 }) }, 'id minúsculo', `${V}id`),
    row(4, { void: voidId({ serie: 900, from: 10, to: 1 }) }, 'faixa invertida', `${V}id`),
    row(5, { void: voidId({ model: '57', serie: 900, from: 5, to: 5 }) }, 'modelo 57', `${V}id`),
  ])
  // o autorizador da inutilização: 'pr', 'PR ' (PAD SPACE) e a SVC (não oferece o serviço — CONFERENCIAS 23)
  await assertCheckRefuses(pool, 'o autorizador da faixa inutilizada', [row(6, { authorizer: 'pr' }, 'pr', `${V}authorizer`), row(7, { authorizer: 'PR ' }, 'PR ', `${V}authorizer`), row(8, { authorizer: 'SVC-AN' }, 'SVC-AN', `${V}authorizer`)])
  await assertCheckRefuses(pool, 'o cStat da faixa inutilizada', [row(9, { code: 'AB1' }, 'AB1', `${V}status_code`), row(10, { code: '102 ' }, '102 ', `${V}status_code`)])
  // protocolo só com 102/563: com a resposta pendente (NULL) e com rejeição (256) é recusado; com 16 dígitos também
  await assertCheckRefuses(pool, 'o protocolo da faixa inutilizada', [
    row(11, { protocol: '123456789012345' }, 'protocolo sem resposta', `${V}protocol`),
    row(12, { code: '256', protocol: '123456789012345' }, 'protocolo com rejeição', `${V}protocol`),
    row(13, { code: '102', protocol: '1234567890123456' }, '16 dígitos', `${V}protocol`),
  ])
}
