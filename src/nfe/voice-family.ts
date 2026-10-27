import { TransmissionEventKind, VoiceEventInput, defineVoiceFamily, MERCHANDISE_VOICE_READING, assertCheckRefuses } from 'fiscal-api'

/**
 * A FAMÍLIA de MERCADORIA (NF-e 55 / NFC-e 65) declara a escrita da voz dela (D-F108; NE-2 — `prompt_onda_nfe_sefaz.md` §15.4 E3): a tabela
 * da voz e a LISTA DE ESCRITA moram aqui (a família é a dona — o CHECK da migration 001 DESTA API protege EXATAMENTE esta lista: D-F107);
 * o escritor é o GENÉRICO do núcleo (`defineVoiceFamily` — funil em execução, MAX+1 sob a trava da nota, `InvoiceTx` — D-NE74).
 *
 * Lista POSITIVA da família (D-NE107, D-NE14/D-NE56): A autorizada · R rejeitada · D denegada (FINAL e registrada — D-NE61) · P em
 * processamento (103/105 com recibo — D-NE33) · C cancelada (110111 — D-NE106) · K cancelamento em voo (fato nosso) · F falha conclusiva ·
 * N o pedido de cancelamento não vigora (D-NE83). SEM S (D-NE107): "tentativa sem voz" já é o em voo da família; S entra só se a NE-5
 * precisar, junto com a saída dela (D-F105 — a NF-e PODE produzir S, desde que dê a saída na mesma entrega).
 * O TIPO pega o produtor SEMÂNTICO (constante, shorthand, mapa, parâmetro) que nenhuma cerca textual pega; o FUNIL do núcleo confere a mesma
 * lista em EXECUÇÃO (cast, spread, JSON: o tipo some no JS); o CHECK BINÁRIO da 001 fecha o que passa POR FORA do código. A lista é UMA
 * constante e o tipo DERIVA dela (o `satisfies` garante que cada kind existe no vocabulário comum). Ampliar = decisão.
 *
 * D-NE167 (= Q-NE167 (a), Valdo 2026-10-20): a D-NE82 (c) — registro de descritores EM EXECUÇÃO no núcleo — está REJEITADA. CONHECIMENTO
 * NEGATIVO: um registro em memória de processo não cobre o OUTRO serviço (a nfse-api e a nfe-api são processos distintos sobre o mesmo
 * banco); a defesa EM EXECUÇÃO contra um 2º descritor da mesma tabela com outra lista é o CHECK BINÁRIO da tabela da família no BANCO
 * (D-F107 — vale para qualquer processo; a sonda do boot abaixo prova 'S' recusado). "Um descritor só" por SERVIÇO é promessa da cerca por
 * AST (`src/__tests__/voice-kind-fence.ts` — a mesma da nfse-api): `defineVoiceFamily` só aparece NESTE arquivo.
 */
// congelada em execução: é a FONTE ÚNICA que o CHECK da 001 e a sonda do boot usam (D-F107) — `as const` é só tipo
export const MERCHANDISE_VOICE_WRITE_KINDS = Object.freeze(['A', 'R', 'D', 'P', 'C', 'K', 'F', 'N'] as const satisfies readonly TransmissionEventKind[])
export type MerchandiseVoiceWriteKind = typeof MERCHANDISE_VOICE_WRITE_KINDS[number]
export type TransmissionEventInput = VoiceEventInput<MerchandiseVoiceWriteKind>

/** O ÚNICO código de evento de cancelamento da F4 (D-NE106) — o CHECK `…_event_cancel_code` da 001 tem EXATAMENTE esta lista (teste compara). */
export const MERCHANDISE_CANCEL_EVENT_CODES = Object.freeze(['110111'] as const)

export const MERCHANDISE_VOICE_FAMILY = defineVoiceFamily({
  reading:    MERCHANDISE_VOICE_READING,
  eventTable: 'tb_invoice_merchandise_transmission_event',
  writeKinds: MERCHANDISE_VOICE_WRITE_KINDS,
  label:      'NF-e',                      // a família diz o nome dela nas mensagens (o núcleo não tem literal de família)
})

/** A tabela de TENTATIVAS da família (a view publicada `vw_<x>` está sobre `tb_<x>` — convenção da D-NE76; teste `descritor-ddl` compara). */
export const MERCHANDISE_TRANSMISSION_TABLE = `tb_${MERCHANDISE_VOICE_READING.transmissionView.slice(3)}`

/** Chave de acesso VÁLIDA para as sondas (TChNFe: 6 dígitos + 12 alfanuméricos + 26 dígitos; mod 55 nas posições 21-22, tpEmis 1 na 35) — o
 *  sufixo [n] entra no cNF para cada sonda ter chave própria (a UNIQUE da chave nunca mascara o diagnóstico de uma sonda aceita). */
const probeKey = (n: number, opts: { lower?: boolean; emission?: string } = {}): string => {
  const cnpj = opts.lower ? 'abcdef780001' : 'ABCDEF780001'
  return `412610${cnpj}95` + '55' + '001' + '000000001' + (opts.emission ?? '1') + String(n).padStart(8, '0') + '0'
}
const VALID_DIGEST = 'A'.repeat(27) + '='

/**
 * Sonda do boot (molde da D-F45, generalizado em `assertCheckRefuses` do núcleo; §5 do rascunho do DDL): os domínios da TENTATIVA e da VOZ
 * da NF-e são os CHECKs BINÁRIOS da migration 001 desta API, e o MOTOR os aplica. Numa transação SEMPRE desfeita, sem a FK onde a sonda mira
 * a tabela filha, cada linha com PK PRÓPRIA (F2A1-07) e com TODO o resto válido (F2A1-05: a recusa tem de vir do CHECK de NOME certo — a
 * violação de outro CHECK não prova o domínio). Cada par = o valor FORA do domínio e a forma que uma colação `_ci`/PAD SPACE aceitaria.
 */
export async function assertMerchandiseVoiceDomainsEnforced(pool: Parameters<typeof assertCheckRefuses>[0]): Promise<void> {
  const EV = MERCHANDISE_VOICE_FAMILY.eventTable
  const ev = (event: number, kind: string, code: string | null, source: string, value: string, constraint: string) => ({ value, constraint,
    params: [event, kind, code, source],
    sql: `INSERT INTO ${EV} (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, source, deleted)`
      + ` VALUES (0, 0, 0, 0, ?, ?, ?, ?, 'N')` })
  const KIND = 'ck_invoice_merchandise_transmission_event_kind', SOURCE = 'ck_invoice_merchandise_transmission_event_source'
  const STATUS = 'ck_invoice_merchandise_transmission_event_status_code', CANCEL = 'ck_invoice_merchandise_transmission_event_cancel_code'
  // kind: 'S' (fora da lista — D-NE107) e 'a' (minúscula de um válido)
  await assertCheckRefuses(pool, 'o kind da voz da NF-e', [ev(1, 'S', null, 'P', 'S', KIND), ev(2, 'a', '100', 'P', 'a', KIND)], { withoutForeignKeys: true })
  await assertCheckRefuses(pool, 'a origem (source) da voz da NF-e', [ev(3, 'A', '100', 'X', 'X', SOURCE), ev(4, 'A', '100', 'q', 'q', SOURCE)], { withoutForeignKeys: true })
  // a voz que DECIDE leva cStat de 3-4 dígitos: '1000 0' (espaço no meio) e 'ABC' recusados; A sem código também
  await assertCheckRefuses(pool, 'o cStat da voz A/R/D/P da NF-e', [ev(5, 'A', '1000 0', 'P', '1000 0', STATUS), ev(6, 'R', 'ABC', 'P', 'ABC', STATUS), ev(7, 'D', null, 'P', 'NULL', STATUS)], { withoutForeignKeys: true })
  // o código do cancelamento é EXATO (regra 16): '110111 ' (PAD SPACE) e o 101101 da NFS-e (outra família) recusados
  await assertCheckRefuses(pool, 'o código do cancelamento na voz C da NF-e', [ev(8, 'C', '110111 ', 'Q', '110111 ', CANCEL), ev(9, 'C', '101101', 'Q', '101101', CANCEL)], { withoutForeignKeys: true })

  const TX = MERCHANDISE_TRANSMISSION_TABLE
  const tx = (attempt: number, v: { env?: string; authorizer?: string; key?: string; digest?: string; receipt?: string | null; protocol?: string | null }, value: string, constraint: string) => ({
    value, constraint,
    params: [attempt, v.env ?? 'H', v.authorizer ?? 'PR', v.key ?? probeKey(attempt), v.digest ?? VALID_DIGEST, v.receipt ?? null, v.protocol ?? null],
    sql: `INSERT INTO ${TX} (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, authorizer, access_key, dh_emission, digest_value, receipt, protocol, deleted)`
      + ` VALUES (0, 0, 0, ?, 1, ?, ?, ?, NOW(), ?, ?, ?, 'N')` })
  const T = 'ck_invoice_merchandise_transmission_'
  await assertCheckRefuses(pool, 'o ambiente da tentativa da NF-e', [tx(1, { env: 'X' }, 'X', `${T}environment`), tx(2, { env: 'h' }, 'h', `${T}environment`)])
  // a chave: CNPJ em minúscula (o REGEXP _ci aceitaria) e tpEmis '2' (fora de 1/6/7)
  await assertCheckRefuses(pool, 'a chave de acesso da tentativa da NF-e', [tx(3, { key: probeKey(3, { lower: true }) }, 'chave minúscula', `${T}key`), tx(4, { key: probeKey(4, { emission: '2' }) }, 'tpEmis 2', `${T}key`)])
  // o autorizador: 'pr' (minúscula), 'PR ' (PAD SPACE — regra 16) e 'AN' (não autoriza NF-e)
  await assertCheckRefuses(pool, 'o autorizador da tentativa da NF-e', [tx(5, { authorizer: 'pr' }, 'pr', `${T}authorizer`), tx(6, { authorizer: 'PR ' }, 'PR ', `${T}authorizer`), tx(7, { authorizer: 'AN' }, 'AN', `${T}authorizer`)])
  await assertCheckRefuses(pool, 'o DigestValue da tentativa da NF-e', [tx(8, { digest: 'x' }, 'x', `${T}digest`), tx(9, { digest: 'a'.repeat(28) }, 'sem o = final', `${T}digest`)])
  await assertCheckRefuses(pool, 'o recibo da tentativa da NF-e', [tx(10, { receipt: '12345' }, '12345', `${T}receipt`), tx(11, { receipt: '12345678901234A' }, '12345678901234A', `${T}receipt`)])
  await assertCheckRefuses(pool, 'o protocolo da tentativa da NF-e', [tx(12, { protocol: '1234567890123456' }, '16 dígitos', `${T}protocol`), tx(13, { protocol: '12345678901234a' }, 'com letra', `${T}protocol`)])
}
