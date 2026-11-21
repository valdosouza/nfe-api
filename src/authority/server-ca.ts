import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

/**
 * RAÍZES ICP-Brasil do SERVIDOR da SEFAZ como DADO (NE-3, nfe-api:NFE.E4.P3.T3 — D-NE187, D-NE202, D-NE54 a, D-NE57; regra RF-NFE-27).
 *
 * - Um PEM SÓ com as raízes ICP-Brasil vigentes (extraídas do zip oficial do ITI conferido pelo SHA-512 — ferramenta `icp_roots.py` do
 *   acervo do Vault) e, ao lado, a FICHA JSON (mesmo nome, `.json`): por certificado, SHA-256 do DER, subject e validade; e a fonte.
 * - Caminho por `SEFAZ_SERVER_CA_PATH` (fora do `dist/`); OBRIGATÓRIO — sem padrão no código. O boot RECUSA: caminho ausente, arquivo
 *   inexistente, PEM vazio, ficha ausente, PEM diferente da ficha (contagem, ordem ou SHA-256) e certificado fora da validade em `now`.
 * - O PEM vai no `ca` do `httpsRequest` (no Node `ca` SUBSTITUI a loja padrão — D-NE57). Sem pinagem do certificado FOLHA do servidor
 *   (a autorizadora o troca sem aviso — D-NE187). O alarme a 60 dias do vencimento e o roteiro de troca são da NFE.E6.P4.
 */

export interface ServerCaCertificate {
  readonly file:      string
  readonly sha256:    string
  readonly subject:   string
  readonly notBefore: string
  readonly notAfter:  string
}

export interface ServerCa {
  /** O PEM inteiro (vai no `ca`). */
  readonly pem:          string
  /** A fonte declarada na ficha (ex.: "ITI ACcompactado.zip"). */
  readonly source:       string
  readonly certificates: readonly ServerCaCertificate[]
}

export type ServerCaRefusal =
  | 'path-missing' | 'file-missing' | 'pem-empty' | 'ficha-missing' | 'ficha-mismatch' | 'certificate-expired'

export class ServerCaRefusedError extends Error {
  constructor(public readonly reason: ServerCaRefusal, detail: string) {
    super(`Raízes ICP do servidor da SEFAZ recusadas (${reason}): ${detail} — o serviço não sobe (D-NE187)`)
    this.name = 'ServerCaRefusedError'
  }
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

/** A ficha JSON fica ao lado do PEM, com o mesmo nome e `.json`. */
export const fichaPathOf = (pemPath: string): string => pemPath.replace(/\.pem$/i, '') + '.json'

/** Carrega e confere as raízes. `now` é parâmetro (o boot usa o relógio; os testes injetam a data). */
export function loadServerCa(pemPath: string | undefined, now: Date): ServerCa {
  if (!pemPath || !pemPath.trim()) throw new ServerCaRefusedError('path-missing', 'SEFAZ_SERVER_CA_PATH ausente')
  const abs = path.resolve(pemPath)
  if (!fs.existsSync(abs)) throw new ServerCaRefusedError('file-missing', `arquivo inexistente: ${abs}`)
  const pem = fs.readFileSync(abs, 'utf8')
  const blocks = pem.match(PEM_BLOCK) ?? []
  if (blocks.length === 0) throw new ServerCaRefusedError('pem-empty', 'nenhum certificado no PEM')
  const fichaPath = fichaPathOf(abs)
  if (!fs.existsSync(fichaPath)) throw new ServerCaRefusedError('ficha-missing', `ficha inexistente: ${fichaPath}`)
  const ficha = JSON.parse(fs.readFileSync(fichaPath, 'utf8')) as { source?: string; certificates?: ServerCaCertificate[] }
  const listed = ficha.certificates ?? []
  if (listed.length !== blocks.length) {
    throw new ServerCaRefusedError('ficha-mismatch', `o PEM tem ${blocks.length} certificado(s) e a ficha ${listed.length}`)
  }
  blocks.forEach((block, i) => {
    const cert = new crypto.X509Certificate(block)
    const sha256 = crypto.createHash('sha256').update(cert.raw).digest('hex')
    if (sha256 !== listed[i].sha256) throw new ServerCaRefusedError('ficha-mismatch', `certificado ${i + 1} diferente da ficha (${listed[i].file})`)
    if (now.getTime() < Date.parse(cert.validFrom) || now.getTime() > Date.parse(cert.validTo)) {
      throw new ServerCaRefusedError('certificate-expired', `${listed[i].file} fora da validade em ${now.toISOString()}`)
    }
  })
  return { pem, source: String(ficha.source ?? ''), certificates: listed }
}
