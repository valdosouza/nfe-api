/// <reference types="jest" />
// nfe-api DEPLOY.E1.P7.T1 (D-NE193, D-NE201, D-F237 — 2026-11-21; ficha `projetos/nfe-api/GERAL/ficha-deploy-e1-p7-adocao-pacote-4-0-0.md`
// no Vault): o núcleo 4.0.0 entra por acompanhamento da nfse-api (f6682a3). Nenhum código de produto da nfe-api chama o transporte nem o
// `verifyXml` ainda — quem os usa é o envelope SOAP (NFE.E4.P2.T1, D-NE184). Este arquivo fixa a superfície que ele vai usar: o teto de
// 2 MB vira o AMBÍGUO da causa `envelope-ilegivel` (D-NE93/D-NE164 — nunca recusa) e o `verifyXml` é pelo elemento (D-NE194/D-NE195).
import {
  MAX_RESPONSE_BYTES,
  ResponseTooLargeError,
  isResponseTooLarge,
  responseTooLargeAmbiguous,
  ambiguousCauseOf,
  ErrorCodes,
  logger,
  verifyXml,
} from 'fiscal-api'
import type { SignedPart } from 'fiscal-api'

describe('núcleo 4.0.0 — a superfície que o envelope SOAP da NF-e vai usar (DEPLOY.E1.P7, D-NE193)', () => {
  it('o teto do corpo da resposta do fisco no transporte comum é 2 MiB (D-NE164)', () => {
    expect(MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024)
  })

  it('isResponseTooLarge reconhece pelo `code` (erro de outra cópia do pacote) e não confunde erro comum', () => {
    expect(isResponseTooLarge(new ResponseTooLargeError(200))).toBe(true)
    expect(isResponseTooLarge({ code: 'FISCAL_RESPONSE_TOO_LARGE' })).toBe(true)
    expect(isResponseTooLarge(new Error('x'))).toBe(false)
    expect(isResponseTooLarge(undefined)).toBe(false)
  })

  it('responseTooLargeAmbiguous = 502 ambíguo, causa envelope-ilegivel, corpo VAZIO, status real do fisco — nunca recusa (D-NE93)', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    try {
      const err = responseTooLargeAmbiguous(new ResponseTooLargeError(404), 'NFeAutorizacao4')
      expect(err.statusCode).toBe(502)
      expect(err.code).toBe(ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
      expect(err.body).toBe('')
      expect(err.authorityStatus).toBe(404)
      expect(ambiguousCauseOf(err)).toBe('envelope-ilegivel')
    } finally {
      warn.mockRestore()
    }
  })

  it('verifyXml é pelo elemento: 3º argumento obrigatório e retorno SignedPart | null (D-NE194; as C14N da D-NE195 são da suíte do núcleo)', () => {
    // Aridade (gate socrático LOW-1): com o `opts` opcional, `Parameters<…>['length']` vira `2 | 3` e esta linha não compila.
    const arity: 3 = 3 as Parameters<typeof verifyXml>['length']
    expect(arity).toBe(3)
    // O `tsc` (npm run typecheck) reprova esta atribuição se o pacote voltar à forma antiga (2 argumentos, boolean). Sem certificado de
    // teste na nfe-api, um `null` em tempo de execução viria do PEM ausente e não provaria nada — por isso só o tipo.
    const byElement: (xml: string, cert: string, opts: { element: string }) => SignedPart | null = verifyXml
    // @ts-expect-error — a forma antiga, sem o elemento, não compila mais
    const legacy: (xml: string, cert: string) => boolean = verifyXml
    expect(typeof byElement).toBe('function')
    expect(legacy).toBe(byElement)
    // Em tempo de execução (gate adversarial LOW-3: `.d.ts` novo com `.js` antigo passaria só pelo tipo): a recusa é `null`, nunca
    // exceção — o 3.0.0 devolvia `false` aqui.
    expect(verifyXml('<a/>', '', { element: 'x' })).toBeNull()
    expect((verifyXml as unknown as (x: string, c: string) => unknown)('<a/>', '')).toBeNull()
  })
})
