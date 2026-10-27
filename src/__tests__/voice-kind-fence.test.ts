/// <reference types="jest" />
// D-NE167 (NE-2, Valdo 2026-10-20): a cerca por AST da família NF-e — "um descritor só" (`defineVoiceFamily` só em `nfe/voice-family.ts`),
// escritor único, descritor nunca como valor solto; e a SEMÂNTICA fixada: a defesa EM EXECUÇÃO contra um 2º descritor é o CHECK binário
// da 001 (a sonda do boot grava 'S' e exige a recusa pelo nome) — a D-NE82 (c) está REJEITADA.
import fs from 'fs'
import path from 'path'
import { lockFlags, writerCallFlags, voiceWriterViolations, voiceFenceScope, VOICE_FAMILY_DESCRIPTORS, VOICE_SQL_WRITERS, relWorkspace } from './voice-kind-fence'
import { MERCHANDISE_VOICE_WRITE_KINDS } from '../nfe/voice-family'

describe('a cerca pega o que promete (sintético)', () => {
  it('um 2º DESCRITOR de família fora do autorizado (`defineVoiceFamily` por qualquer grafia) é violação: furaria a lista de escrita sem SQL nenhum', () => {
    for (const src of [
      "export const F = defineVoiceFamily({ reading: MERCHANDISE_VOICE_READING, eventTable: 'tb_invoice_merchandise_transmission_event', writeKinds: ['S'] })",
      "import { defineVoiceFamily as def } from 'fiscal-api'\nexport const F = def({ reading: R, eventTable: T, writeKinds: K })",
      "import * as core from 'fiscal-api'\nexport const F = core.defineVoiceFamily({ reading: R, eventTable: T, writeKinds: K })",
      "const f = core['defineVoiceFamily']",
      // gate adversarial (FENCE_BYPASS): código dinâmico e nome MONTADO
      "const d = new Function('return require(\"fiscal-api\").defineVoiceFamily')()",
      "const d = Function('return 1')()",
      "const d = eval('core.defineVoiceFamily')",
      "const d = (core as any)['define' + 'VoiceFamily']",
      "import * as core from 'fiscal-api'\nconst d = Object.values(core).find(f => String(f.name).endsWith('VoiceFamily'))",
    ]) expect([src, writerCallFlags(src)]).toEqual([src, true])
    const legit = "export const MERCHANDISE_VOICE_FAMILY = defineVoiceFamily({ reading: MERCHANDISE_VOICE_READING, eventTable: 'tb_invoice_merchandise_transmission_event', writeKinds: MERCHANDISE_VOICE_WRITE_KINDS, label: 'NF-e' })"
    expect(writerCallFlags(legit, { allowFamilyDescriptor: true })).toBe(false)
    expect(writerCallFlags(legit)).toBe(true)
  })
  it('chamada ao escritor com objeto sob cast/spread, kind fora da lista da família, escritor como valor solto, descritor espalhado, SQL de escrita na voz', () => {
    for (const src of [
      "MERCHANDISE_VOICE_FAMILY.insertTransmissionEvent(itx, 1, null, { kind: 'S', source: 'P' })",
      "MERCHANDISE_VOICE_FAMILY.insertTransmissionEvent(itx, 1, null, { ...e })",
      "MERCHANDISE_VOICE_FAMILY.insertTransmissionEvent(itx, 1, null, e as any)",
      "const w = MERCHANDISE_VOICE_FAMILY.insertTransmissionEvent; wrap(w)",
      "const x = { ...MERCHANDISE_VOICE_FAMILY }",
      "Object.values(MERCHANDISE_VOICE_FAMILY)",
      "q.query(`INSERT INTO tb_invoice_merchandise_transmission_event (kind) VALUES ('A')`)",
      "q.query(`UPDATE tb_invoice_merchandise_transmission_event SET kind = 'A' WHERE event = 1`)",
      "q.query('DELETE FROM tb_invoice_merchandise_transmission_event WHERE event = 1')",
      // gate adversarial (FENCE_BYPASS): a tabela da voz montada por template de literal, concatenação e join
      "q.query(`INSERT INTO ${'tb_invoice_merchandise_transmission_event'} (kind) VALUES ('A')`)",
      "q.query('INSERT INTO tb_invoice_merchandise_' + 'transmission_event (kind) VALUES (1)')",
      "q.query(['INSERT INTO', 'tb_invoice_merchandise_transmission_event', '(kind) VALUES (1)'].join(' '))",
      "const T = 'tb_invoice_merchandise_transmission_event'\nq.query('UPDATE ' + T + ' SET kind = ? WHERE event = 1')",
      "Object.assign(OUTCOME_KIND, { rejected: 'A' })",
      // o DESCRITOR como VALOR solto (argumento de uma política) é violação — a porta das políticas recebe o OBJETO LITERAL com as ligações
      // do repositório (`{ insertTransmissionEvent, hasTransmissionEvent }`), como a nfse-api faz (NE1A2-10)
      "recordVoiceOnce(MERCHANDISE_VOICE_FAMILY, itx, 1, null, { kind: 'D', source: 'P', authorityCode: '301' })",
    ]) expect([src, writerCallFlags(src)]).toEqual([src, true])
    for (const src of [
      "MERCHANDISE_VOICE_FAMILY.insertTransmissionEvent(itx, 1, null, { kind: 'P', source: 'P', authorityCode: '103' })",
      "MERCHANDISE_VOICE_FAMILY.insertTransmissionEvent(itx, 1, null, { kind: OUTCOME_KIND[outcome], source: 'P' })",
      "export const insertTransmissionEvent = MERCHANDISE_VOICE_FAMILY.insertTransmissionEvent\nrecordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, 1, null, { kind: 'D', source: 'P', authorityCode: '301' })",
      "q.query(`SELECT 1 FROM tb_invoice_merchandise_transmission_event WHERE event = 1`)",
      "q.query(`INSERT INTO tb_invoice_merchandise_transmission (attempt) VALUES (1)`)",
    ]) expect([src, writerCallFlags(src)]).toEqual([src, false])
    expect(MERCHANDISE_VOICE_WRITE_KINDS.includes('S' as any)).toBe(false)
  })
  it('D-NE80: a trava do `withInvoiceTx` numa família é só `erp.lockInvoice` — também com a chave entre aspas/computada e com `erp` sombreado (gate adversarial)', () => {
    for (const src of [
      "withInvoiceTx(pool, who, ref, { label, lock: myLock }, fn)",
      "withInvoiceTx(pool, who, ref, { label, \"lock\": myLock }, fn)",
      "withInvoiceTx(pool, who, ref, { label, ['lock']: myLock }, fn)",
      "const erp = { lockInvoice: myLock }\nwithInvoiceTx(pool, who, ref, { label, lock: erp.lockInvoice }, fn)",
      "import { erp } from './meu-erp'\nwithInvoiceTx(pool, who, ref, { label, lock: erp.lockInvoice }, fn)",
      "function f(erp: any) { return withInvoiceTx(pool, who, ref, { label, lock: erp.lockInvoice }, fn) }",
    ]) expect([src, lockFlags(src)]).toEqual([src, true])
    expect(lockFlags("import { erp } from 'fiscal-api'\nwithInvoiceTx(pool, who, ref, { label, lock: erp.lockInvoice }, fn)")).toBe(false)
  })
})

describe('o código REAL da nfe-api', () => {
  it('nenhuma violação em src/ e scripts/; o descritor autorizado existe e é o único que chama `defineVoiceFamily`', () => {
    expect(voiceWriterViolations()).toEqual([])
    expect(VOICE_FAMILY_DESCRIPTORS).toEqual(['nfe-api/src/nfe/voice-family.ts'])
    for (const f of [...VOICE_FAMILY_DESCRIPTORS, ...VOICE_SQL_WRITERS]) expect([f, fs.existsSync(path.resolve(__dirname, '..', '..', '..', f))]).toEqual([f, true])
    const declaring = voiceFenceScope().filter(f => /\bdefineVoiceFamily\b/.test(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))).map(relWorkspace)
    expect(declaring).toEqual(VOICE_FAMILY_DESCRIPTORS)
    expect(voiceFenceScope().filter(lockFlagsOf)).toEqual([])
  })
  it('D-NE167 — a semântica fixada: a sonda do boot grava S (fora da lista) e exige a recusa pelo CHECK de nome certo — o banco é a defesa em execução', () => {
    const probes = fs.readFileSync(path.resolve(__dirname, '..', 'nfe', 'voice-family.ts'), 'utf8')
    expect(probes).toMatch(/ev\(1, 'S', null, 'P', 'S', KIND\)/)
    expect(probes).toMatch(/const KIND = 'ck_invoice_merchandise_transmission_event_kind'/)
  })
})

const lockFlagsOf = (f: string) => lockFlags(fs.readFileSync(f, 'utf8'))
