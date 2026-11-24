import { mod11Ascii48 } from 'fiscal-api'
import type { Uf } from '../authority/authorizers'
import { assertAccessKey, CUF } from '../authority/messages'

/**
 * CHAVE DE ACESSO da NF-e — 44 posições montadas POR PARTES (NFE.E5.P3.T1; MOC 7.00, visão geral §5.4; NT Conjunta 2025.001 para o CNPJ
 * alfanumérico; RF-NFE-33, RF-NFE-34, RF-NFE-44 e a proposta RF-NFE-53):
 *   cUF(2) + AAMM(4) + CNPJ(14) + mod(2) + série(3) + nNF(9) + tpEmis(1) + cNF(8) + cDV(1)
 * O cDV é o módulo 11 do núcleo (`mod11Ascii48`: cada caractere vale ASCII − 48, pesos 2 a 9 da direita para a esquerda — serve ao CNPJ
 * numérico e ao alfanumérico). Molde: o Id do `infInut` (`number-void.ts` — "nunca mais literal montado à mão").
 *
 * Fora da peça, de propósito (prompt_onda_nfe_sefaz.md §22.2-1 e -5): o cNF é SORTEADO na reserva (tentativa nova = chave nova — D-NE7) e o
 * número nasce na transmissão (D-NE257); aqui os dois são RECEBIDOS. A peça só confere o cNF (rej. 897 — NT 2019.001).
 * Entrada inválida = `Error` simples com o nome da parte (erro de quem chama, não recusa de nota — como o `assertAccessKey`).
 */

/** As 20 sequências que o cNF não pode ter (MOC 7.00, Anexo I, B03-10 — rej. 897): os dez repetidos e as dez "escadas". */
export const FORBIDDEN_CNF: readonly string[] = Object.freeze([
  ...Array.from({ length: 10 }, (_, d) => String(d).repeat(8)),
  '12345678', '23456789', '34567890', '45678901', '56789012', '67890123', '78901234', '89012345', '90123456', '01234567',
])

/** O cNF: 8 dígitos, diferente do número da nota (com zeros à esquerda) e fora das 20 sequências. */
export function assertCnf(cnf: string, number: number): void {
  if (typeof cnf !== 'string' || !/^[0-9]{8}$/.test(cnf)) throw new Error('cnf: 8 dígitos')
  if (FORBIDDEN_CNF.includes(cnf)) throw new Error('cnf: sequência proibida (rej. 897)')
  if (Number(cnf) === number) throw new Error('cnf: igual ao número da nota (rej. 897)')
}

export interface AccessKeyParts {
  uf: Uf
  /** A data do `dhEmi` na zona do estabelecimento, `AAAA-MM-DD` — quem chama decide o fuso; daqui sai o AAMM. */
  emissionDate: string
  /** CNPJ do emitente na forma canônica (14 posições, alfanumérico nas 12 primeiras). */
  cnpj: string
  model: '55'
  /** 0 a 909 (910 a 969 é emitente pessoa física — fora desta API, F-NFE-5). */
  serie: number
  /** 1 a 999.999.999. */
  number: number
  /** tpEmis do leiaute. */
  emissionType: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 9
  cnf: string
}

const intIn = (name: string, v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`${name}: inteiro de ${min} a ${max}`)
  return v
}

/** Monta a chave e a devolve JÁ conferida pelas regras de forma da consulta (`assertAccessKey` — rej. 613 a 619). */
export function buildAccessKey(p: AccessKeyParts): string {
  if (!Object.prototype.hasOwnProperty.call(CUF, p.uf)) throw new Error('uf: UF desconhecida')
  const date = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.exec(typeof p.emissionDate === 'string' ? p.emissionDate : '')
  if (!date) throw new Error('emissionDate: AAAA-MM-DD')
  if (typeof p.cnpj !== 'string' || !/^[0-9A-Z]{12}[0-9]{2}$/.test(p.cnpj)) throw new Error('cnpj: 14 posições na forma canônica')
  if (p.model !== '55') throw new Error('model: só o 55 (D-NE2)')
  const serie = intIn('serie', p.serie, 0, 909)
  const number = intIn('number', p.number, 1, 999_999_999)
  if (![1, 2, 3, 4, 5, 6, 7, 9].includes(p.emissionType)) throw new Error('emissionType: tpEmis do leiaute')
  assertCnf(p.cnf, number)
  const body = `${CUF[p.uf]}${date[1].slice(2)}${date[2]}${p.cnpj}${p.model}${String(serie).padStart(3, '0')}${String(number).padStart(9, '0')}${p.emissionType}${p.cnf}`
  if (body.length !== 43) throw new Error(`chave: ${body.length} posições antes do DV (esperadas 43)`)
  const key = `${body}${mod11Ascii48(body)}`
  assertAccessKey(key, p.uf)
  return key
}

/** O `Id` do `infNFe`: "NFe" + chave (rej. 502). */
export const infNFeId = (accessKey: string): string => `NFe${accessKey}`
