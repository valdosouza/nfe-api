/**
 * FORMATAÇÃO DO DANFE (NFE.E6.P3 — ficha §7, mudança 3/4). Funções PURAS de texto: o XML manda, o desenho só apresenta. Nada aqui inventa dado:
 * valor ausente (`null`) sai como texto VAZIO, e o que não se reconhece sai como veio. Decimais do XML (ponto) viram vírgula e milhar com ponto,
 * mantendo TODAS as casas do XML (o DANFE reproduz o conteúdo das tags — Anexo II 3.x).
 */

/** `1234.5000` → `1.234,5000`; `null`/vazio → `''`; o que não é decimal fica como veio. */
export function brDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value)
  if (!m) return value
  const grouped = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${m[1]}${grouped}${m[3] !== undefined ? `,${m[3]}` : ''}`
}

/** `2026-11-24T10:16:02-03:00` → `24/11/2026`; `2026-11-24` → `24/11/2026`; outro formato fica como veio. */
export function brDate(value: string | null | undefined): string {
  if (!value) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : value
}

/** `2026-11-24T10:16:02-03:00` → `10:16:02` (o relógio do próprio XML, sem converter fuso); sem hora → `''`. */
export function clockTime(value: string | null | undefined): string {
  if (!value) return ''
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(value)
  return m ? m[1] : ''
}

/** `2026-11-24T10:16:02-03:00` → `24/11/2026 10:16:02`. */
export function brDateTime(value: string | null | undefined): string {
  const date = brDate(value)
  const time = clockTime(value)
  return time ? `${date} ${time}` : date
}

/** CNPJ (14 caracteres, numérico ou alfanumérico) → `AA.AAA.AAA/AAAA-DD`; CPF (11) → `000.000.000-00`; outro tamanho fica como veio. */
export function federalId(value: string | null | undefined): string {
  if (!value) return ''
  if (/^[0-9A-Z]{14}$/.test(value)) return `${value.slice(0, 2)}.${value.slice(2, 5)}.${value.slice(5, 8)}/${value.slice(8, 12)}-${value.slice(12)}`
  if (/^\d{11}$/.test(value)) return `${value.slice(0, 3)}.${value.slice(3, 6)}.${value.slice(6, 9)}-${value.slice(9)}`
  return value
}

/** `81925530` → `81925-530`; outro formato fica como veio. */
export function brZip(value: string | null | undefined): string {
  if (!value) return ''
  return /^\d{8}$/.test(value) ? `${value.slice(0, 5)}-${value.slice(5)}` : value
}

/** O número da nota com 9 dígitos agrupados de 3 em 3 (`15` → `000.000.015`); fora de 1 a 9 dígitos fica como veio. */
export function invoiceNumber(value: string | null | undefined): string {
  if (!value) return ''
  if (!/^\d{1,9}$/.test(value)) return value
  const p = value.padStart(9, '0')
  return `${p.slice(0, 3)}.${p.slice(3, 6)}.${p.slice(6)}`
}

/** A chave de 44 caracteres em 11 blocos de 4 separados por espaço (Anexo II, Campo 1); outro tamanho fica como veio. */
export function accessKeyBlocks(key: string): string {
  return key.length === 44 ? key.match(/.{4}/g)!.join(' ') : key
}

/** Junta só as partes presentes: `join(['Rua X', '10', null], ', ')` → `Rua X, 10`. */
export function joinParts(parts: readonly (string | null | undefined)[], separator: string): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(separator)
}
