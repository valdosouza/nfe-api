// nfe-api:NFE.E4.P4 (ficha do smoke, mudança 1): par AUTOASSINADO de TESTE para assinar mensagens nas suítes — sem valor fiscal, gerado na hora
// (molde: fiscal-api/src/__tests__/familia-e5-p1.test.ts:21-34). Sem `.test.ts`: fora do `testMatch`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const forge: any = require('node-forge')

export interface TestA1 { cert: Buffer; key: Buffer; certPem: string }

let cached: TestA1 | null = null

/** Um par por processo de teste (gerar RSA 2048 custa); CN com o CNPJ dado no padrão ICP (`NOME:CNPJ`). */
export function testA1(cnpj = '07742094000113'): TestA1 {
  if (cached) return cached
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '0b'
  cert.validity.notBefore = new Date(Date.now() - 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 86_400_000)
  const attrs = [{ name: 'commonName', value: `TESTE SEM VALOR:${cnpj}` }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const certPem = forge.pki.certificateToPem(cert)
  cached = { cert: Buffer.from(certPem), key: Buffer.from(forge.pki.privateKeyToPem(keys.privateKey)), certPem }
  return cached
}
