import crypto from 'crypto'
import { isValidCnpj, xmlElement, xmlGroup, type TechnicalResponsible } from 'fiscal-api'
import { digits, nfeText } from './formats'

/**
 * RESPONSÁVEL TÉCNICO — o grupo `infRespTec` (NFE.E5.P3 — RF-NFE-30; NT 2018.005; D-NE217, D-NE218, D-NE221, D-NE223, D-NE229).
 *  - os dados PÚBLICOS (CNPJ da Setes, contato, e-mail, fone) vêm do `AppContext.technicalResponsible`, conferidos no boot pelo núcleo;
 *  - o CSRT mora na estrutura por UF do núcleo. Quem compõe a transmissão (NFE.E6.P1) chama `requiredFiscalCredentialsFor`, calcula o hash
 *    com `hashCsrt` e entrega ao builder SÓ `{ idCSRT, hashCSRT }` — ou nada, quando a UF × modelo × ambiente não exige o código (S12 da
 *    ficha). O VALOR do CSRT nunca aparece em XML, log, mensagem de erro nem teste (o único valor em teste é o exemplo público da NT).
 */

export interface CsrtProof {
  /** Identificador do CSRT (2 dígitos). */
  idCSRT: string
  /** Base64 do SHA-1 de CSRT + chave de acesso (28 caracteres). */
  hashCSRT: string
}

/** hashCSRT = Base64(SHA-1(CSRT + chave de acesso)) — NT 2018.005 §2.2.10. Erros NUNCA citam o valor do CSRT. */
export function hashCsrt(csrt: string, accessKey: string): string {
  if (typeof csrt !== 'string' || csrt === '') throw new Error('hashCsrt: CSRT ausente')
  if (typeof accessKey !== 'string' || !/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/.test(accessKey)) throw new Error('hashCsrt: chave de acesso fora da forma')
  return crypto.createHash('sha1').update(csrt + accessKey, 'utf8').digest('base64')
}

/** O grupo `infRespTec`, na ordem do leiaute: CNPJ, xContato, email, fone e, quando houver, idCSRT + hashCSRT (os dois ou nenhum). */
export function infRespTecXml(responsible: TechnicalResponsible, proof?: CsrtProof | null): string {
  if (!isValidCnpj(responsible.cnpj)) throw new Error('infRespTec: CNPJ do responsável técnico inválido')
  let inner = xmlElement('CNPJ', responsible.cnpj)
    + xmlElement('xContato', nfeText(responsible.contactName, 2, 60))
    + xmlElement('email', nfeText(responsible.email, 6, 60))
    + xmlElement('fone', digits(responsible.phone, 6, 14))
  if (proof) {
    if (!/^[A-Za-z0-9+/]{27}=$/.test(proof.hashCSRT)) throw new Error('infRespTec: hashCSRT fora da forma (Base64 de 20 bytes)')
    inner += xmlElement('idCSRT', digits(proof.idCSRT, 2)) + xmlElement('hashCSRT', proof.hashCSRT)
  }
  return xmlGroup('infRespTec', inner)
}
