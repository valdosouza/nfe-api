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

// ---------------------------------------------------------------------------------------------------------------------------------------
// NFE.E6.P4 mudança 8 — dado RECARREGÁVEL (D-NE54 a) e o alarme dos 60 dias
// ---------------------------------------------------------------------------------------------------------------------------------------

/** O aviso de vencimento: a 60 dias da raiz que vence primeiro (D-NE187; roteiro de troca = recarregar o PEM e a ficha, sem reiniciar). */
export const CA_EXPIRY_WARN_DAYS = 60
const DAY_MS = 86_400_000

/** Dias inteiros até a raiz que vence PRIMEIRO (negativo = vencida); a ficha é conferida no carregamento, aqui só se lê o `notAfter`. */
export function serverCaDaysLeft(ca: ServerCa, now: Date): number {
  const ends = ca.certificates.map(c => Date.parse(c.notAfter)).filter(t => !Number.isNaN(t))
  if (ends.length === 0) return Number.POSITIVE_INFINITY
  return Math.floor((Math.min(...ends) - now.getTime()) / DAY_MS)
}

export interface ServerCaWatchHooks {
  readonly now?: () => Date
  /** Recarregou um PEM novo (o conjunto de raízes mudou na ficha). */
  readonly onReload?: (ca: ServerCa) => void
  /** O PEM mudou mas NÃO passou na conferência (ou sumiu): ficou a cadeia anterior; só o motivo, nunca o conteúdo. */
  readonly onRefused?: (reason: string) => void
  /** Falta `days` dias (≤ 60) para a primeira raiz vencer — no máximo uma vez por dia. */
  readonly onExpiring?: (days: number) => void
}

/**
 * Relê as raízes quando o arquivo muda: compara tamanho e data do PEM e da ficha a cada chamada (barato, síncrono) e só recarrega se mudou. Recarga recusada MANTÉM a cadeia anterior (o serviço
 * nunca fica sem raízes por causa de um arquivo ruim) e avisa uma vez por mudança. `check()` não lança.
 */
export function watchServerCa(target: { serverCa: ServerCa }, pemPath: string, hooks: ServerCaWatchHooks = {}): { check(): void } {
  const now = hooks.now ?? (() => new Date())
  const abs = path.resolve(pemPath)
  const stampOf = (): string => [abs, fichaPathOf(abs)].map(p => { try { const s = fs.statSync(p); return `${s.size}:${s.mtimeMs}` } catch { return 'ausente' } }).join('|')
  let seen = stampOf()
  let lastWarned = 0
  return {
    check(): void {
      const stamp = stampOf()
      if (stamp !== seen) {
        seen = stamp                                                                  // a mesma mudança recusada não avisa de novo a cada chamada
        try { target.serverCa = loadServerCa(abs, now()); hooks.onReload?.(target.serverCa) }
        catch (e) { hooks.onRefused?.(e instanceof ServerCaRefusedError ? e.reason : 'erro') }
      }
      const days = serverCaDaysLeft(target.serverCa, now())
      if (days <= CA_EXPIRY_WARN_DAYS && now().getTime() - lastWarned >= DAY_MS) { lastWarned = now().getTime(); hooks.onExpiring?.(days) }
    },
  }
}
