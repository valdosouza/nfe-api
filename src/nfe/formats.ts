import { isXsdTString } from 'fiscal-api'

/**
 * FORMATADORES TIPADOS da NF-e 4.00 (NFE.E5.P3.T2 — `tiposBasico_v4.00.xsd` do PL_010f; RF-NFE-66; D-NE28). Toda conta é em DECIMAL EXATO
 * (BigInt) — nunca ponto flutuante (prompt_onda_nfe_sefaz.md §22.2-5). A fonte de fatos entrega os decimais como TEXTO exato; aqui eles
 * viram centavos inteiros ou o texto do tipo do leiaute. O que não cabe no tipo é RECUSADO com `FormatError` — nunca cortado, nunca
 * arredondado calado. Quem monta traduz o `FormatError` no campo da recusa.
 */

export class FormatError extends Error {
  constructor(readonly reason: 'vazio' | 'nao-decimal' | 'negativo' | 'casas-demais' | 'grande-demais' | 'zero' | 'texto-invalido' | 'tamanho', detail: string) {
    super(`${reason}: ${detail}`)
    this.name = 'FormatError'
  }
}

/** Um decimal exato: `units` × 10^-`scale`. */
export interface Decimal { readonly units: bigint; readonly scale: number }

const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/

/** Lê o decimal como o banco o escreve ("100.00", "2.0000", "50"). Vazio, expoente, vírgula, espaço ou sinal de mais = recusa. */
export function parseDecimal(text: unknown): Decimal {
  if (text === null || text === undefined || text === '') throw new FormatError('vazio', 'valor ausente')
  if (typeof text !== 'string') throw new FormatError('nao-decimal', 'esperado texto decimal')
  const m = DECIMAL.exec(text)
  if (!m) throw new FormatError('nao-decimal', 'esperado dígitos com ponto decimal')
  const frac = m[3] ?? ''
  const units = BigInt(m[2] + frac)
  return { units: m[1] && units !== 0n ? -units : units, scale: frac.length }
}

const pow10 = (n: number): bigint => 10n ** BigInt(n)

/** Arredonda para `scale` casas, meio para cima (em módulo). */
export function roundHalfUp(d: Decimal, scale: number): Decimal {
  if (d.scale <= scale) return { units: d.units * pow10(scale - d.scale), scale }
  const div = pow10(d.scale - scale)
  const neg = d.units < 0n
  const abs = neg ? -d.units : d.units
  const rounded = (abs + div / 2n) / div
  return { units: neg ? -rounded : rounded, scale }
}

export const multiply = (a: Decimal, b: Decimal): Decimal => ({ units: a.units * b.units, scale: a.scale + b.scale })

export function subtract(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale)
  return { units: a.units * pow10(scale - a.scale) - b.units * pow10(scale - b.scale), scale }
}

const toSafeNumber = (units: bigint, what: string): number => {
  if (units > BigInt(Number.MAX_SAFE_INTEGER) || units < -BigInt(Number.MAX_SAFE_INTEGER)) throw new FormatError('grande-demais', what)
  return Number(units)
}

/**
 * Texto decimal → CENTAVOS inteiros, EXATO: casas além da segunda só se forem zero ("0.000000" e "12.340000" passam; "12.345" é recusado —
 * valor monetário registrado com fração de centavo não se arredonda aqui). Negativo é recusado.
 */
export function toCents(text: unknown): number {
  const d = parseDecimal(text)
  if (d.units < 0n) throw new FormatError('negativo', 'valor monetário negativo')
  if (d.scale <= 2) return toSafeNumber(d.units * pow10(2 - d.scale), 'valor monetário')
  const div = pow10(d.scale - 2)
  if (d.units % div !== 0n) throw new FormatError('casas-demais', 'valor monetário com mais de 2 casas')
  return toSafeNumber(d.units / div, 'valor monetário')
}

/** Decimal → centavos com arredondamento meio para cima (o produto quantidade × unitário — S11 da ficha). Negativo é recusado. */
export function roundToCents(d: Decimal): number {
  const r = roundHalfUp(d, 2)
  if (r.units < 0n) throw new FormatError('negativo', 'valor monetário negativo')
  return toSafeNumber(r.units, 'valor monetário')
}

const assertCents = (cents: unknown): number => {
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents)) throw new FormatError('nao-decimal', 'esperado centavos inteiros')
  if (cents < 0) throw new FormatError('negativo', 'valor monetário negativo')
  return cents
}

/** TDec_1302 — centavos → "0.00", "1234.56"; até 13 dígitos inteiros. */
export function dec1302(cents: number): string {
  const c = assertCents(cents)
  const int = Math.trunc(c / 100)
  if (String(int).length > 13) throw new FormatError('grande-demais', 'mais de 13 dígitos inteiros')
  return `${int}.${String(c % 100).padStart(2, '0')}`
}

/** TDec_1302Opc — o tipo NÃO aceita zero: zero devolve `null` e o elemento é omitido por quem escreve. */
export function dec1302Opc(cents: number): string | null {
  return assertCents(cents) === 0 ? null : dec1302(cents)
}

/** Decimal não negativo na forma canônica (sem zeros à direita; inteiro sem ponto), dentro dos limites de dígitos do tipo. */
function variableDecimal(text: unknown, maxInt: number, maxFrac: number, minFrac: number): string {
  const d = parseDecimal(text)
  if (d.units < 0n) throw new FormatError('negativo', 'valor negativo')
  const digits = d.units.toString().padStart(d.scale + 1, '0')
  const int = digits.slice(0, digits.length - d.scale)
  let frac = digits.slice(digits.length - d.scale).replace(/0+$/, '')
  if (frac.length > maxFrac) throw new FormatError('casas-demais', `mais de ${maxFrac} casas decimais`)
  if (int.length > maxInt) throw new FormatError('grande-demais', `mais de ${maxInt} dígitos inteiros`)
  frac = frac.padEnd(minFrac, '0')
  return frac ? `${int}.${frac}` : int
}

/** TDec_1104v — quantidades (`qCom`, `qTrib`): até 11 inteiros e 0 a 4 casas. */
export const dec1104v = (text: unknown): string => variableDecimal(text, 11, 4, 0)

/** TDec_1110v — valores unitários (`vUnCom`, `vUnTrib`): até 11 inteiros e 0 a 10 casas. */
export const dec1110v = (text: unknown): string => variableDecimal(text, 11, 10, 0)

/** TDec_0302a04 — alíquotas (`pCredSN`): até 3 inteiros e 2 a 4 casas ("0.00", "2.86", "12.3456"). */
export const dec0302a04 = (text: unknown): string => variableDecimal(text, 3, 4, 2)

/** Decimal → texto canônico com até `maxFrac` casas; recusa (nunca arredonda) se a fração não couber. */
export function decimalText(d: Decimal, maxInt: number, maxFrac: number): string {
  const sign = d.units < 0n ? '-' : ''
  const abs = (d.units < 0n ? -d.units : d.units).toString().padStart(d.scale + 1, '0')
  return variableDecimal(`${sign}${abs.slice(0, abs.length - d.scale)}${d.scale ? `.${abs.slice(abs.length - d.scale)}` : ''}`, maxInt, maxFrac, 0)
}

/**
 * Divisão EXATA em até `maxFrac` casas: `a ÷ b` se o quociente fecha nessas casas; senão `null` (quem chama recusa — S8 da ficha: nunca
 * arredonda calado).
 */
export function divideExact(a: Decimal, b: Decimal, maxFrac: number): Decimal | null {
  if (b.units === 0n) return null
  const num = a.units * pow10(b.scale) * pow10(maxFrac)
  const den = b.units * pow10(a.scale)
  if (num % den !== 0n) return null
  return { units: num / den, scale: maxFrac }
}

/**
 * Texto livre da NF-e (D-NE28): UTF-8 COM acentos; tira caractere de controle (vira espaço), colapsa espaços e apara as pontas. O que sobra
 * tem de ser um `TString` do leiaute (U+0020 a U+00FF — predicado ÚNICO do workspace: `isXsdTString` do núcleo) dentro do tamanho — senão
 * RECUSA; nunca corta nem troca caractere. Vazio depois da limpeza = recusa `vazio`.
 */
export function nfeText(value: unknown, min: number, max: number): string {
  if (value === null || value === undefined) throw new FormatError('vazio', 'texto ausente')
  if (typeof value !== 'string') throw new FormatError('texto-invalido', 'esperado texto')
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/ +/g, ' ').trim()
  if (clean === '') throw new FormatError('vazio', 'texto vazio')
  if (clean.length < min || clean.length > max) throw new FormatError('tamanho', `de ${min} a ${max} caracteres (tem ${clean.length})`)
  if (!isXsdTString(clean, min, max)) throw new FormatError('texto-invalido', 'caractere fora do alfabeto do leiaute (U+0020 a U+00FF)')
  return clean
}

/** Só dígitos, com tamanho exato ou faixa; qualquer outro caractere = recusa (não normaliza — quem lê o cadastro entrega canônico). */
export function digits(value: unknown, min: number, max: number = min): string {
  if (value === null || value === undefined || value === '') throw new FormatError('vazio', 'valor ausente')
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new FormatError('texto-invalido', 'esperado só dígitos')
  if (value.length < min || value.length > max) throw new FormatError('tamanho', min === max ? `${min} dígitos` : `de ${min} a ${max} dígitos`)
  return value
}
