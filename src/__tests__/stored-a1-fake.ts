// nfe-api DEPLOY.E1.P6 (D-F243; gêmea: nfse-api b3f192e) + DEPLOY.E1.P13 (núcleo 5.3.0; gêmea: nfse-api 32cab45): pool FALSO com segredos
// guardados (A1 e senha SMTP, os dois donos do cofre), para provar a chave com o `verifyStoredKeys` REAL do núcleo sem banco. O SQL de amostra
// por versão (`ROW_NUMBER`) recebe linhas `{v, id, cipher, iv, tag}` seladas em memória com o anel dado e a AAD do dono (`certificateAad` /
// `smtpCredentialAad`) — a mesma forma que o banco devolve; o SQL que cita a tabela da 009 responde com as senhas, o outro com os A1.
// O conteúdo selado é gerado na hora (nunca versionado). Sem `.test.ts`: fora do `testMatch`.
import { randomBytes } from 'crypto'
import { certificateAad, smtpCredentialAad, MasterKeyRing } from 'fiscal-api'

export interface StoredA1 { institutionId: number; sealedWith: MasterKeyRing }
/** Senha SMTP guardada: mesma forma do A1. */
export type StoredSmtp = StoredA1

function rowsOf(list: StoredA1[], aadOf: (id: number) => string) {
  return list.map(({ institutionId, sealedWith }) => {
    const s = sealedWith.seal(randomBytes(64), aadOf(institutionId))
    return { v: s.version, id: institutionId, cipher: s.cipher, iv: s.iv, tag: s.tag }
  }).sort((a, b) => a.v - b.v || a.id - b.id)
}

export function storedA1Pool(a1s: StoredA1[], smtps: StoredSmtp[] = []): any {
  const a1Rows = rowsOf(a1s, certificateAad)
  const smtpRows = rowsOf(smtps, smtpCredentialAad)
  const query = jest.fn(async (sql: string) => {
    const rows = /tb_establishment_smtp_credential/.test(sql) ? smtpRows : a1Rows
    if (/ROW_NUMBER\(\)/.test(sql)) return [rows]
    if (/SELECT DISTINCT cipher_key_version/.test(sql)) return [[...new Set(rows.map(r => r.v))].map(v => ({ v }))]
    return [[{ x: 1 }]]
  })
  return { query, getConnection: jest.fn() }
}
