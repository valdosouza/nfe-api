/// <reference types="jest" />
// nfe-api:NFE.E4.P2.T2 — `src/authority/authorizers.ts` contra a cópia do acervo (`acervo/autorizadores-2026-10-15.json`) e os CHECKs de
// `authorizer` da migration 001 (D-NE162; ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e4-p2-soap-e-autorizadores.md`, mudança 3).
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import {
  AUTHORIZERS_SOURCE, ENDPOINT_CODES, EXCLUDED_FROM_SOURCE, UFS, assertDatedEntries, endpointOf, registryEndpoint, resolveAuthorizer,
  ufRoute, voidEndpoint, SOAP_BINDINGS_SOURCE, soapBindingEntries, soapBindingOf,
  type Endpoint, type Environment, type NfeService, type ResolveInput, type Uf,
} from '../authority/authorizers'
import { readWsdlOperation } from '../authority/wsdl'

const ROOT = path.resolve(__dirname, '..', '..')
const RAW = fs.readFileSync(path.join(ROOT, 'acervo', AUTHORIZERS_SOURCE.file))
const SOURCE = JSON.parse(RAW.toString('utf8')) as {
  uf_por_autorizador_virtual: Record<Environment, Record<string, string[]>>
} & Record<Environment, Record<string, Record<string, { versao: string; url: string }>>>
const SQL_001 = fs.readFileSync(path.join(ROOT, 'src', 'migrations', 'sql', '001_nfe_baseline.sql'), 'utf8')
const ENVS: Environment[] = ['H', 'P']
const OWN = ['AM', 'BA', 'GO', 'MG', 'MS', 'MT', 'PE', 'PR', 'RS', 'SP']
const ALL_SERVICES: NfeService[] = ['NfeStatusServico', 'NFeAutorizacao', 'NFeRetAutorizacao', 'NfeConsultaProtocolo', 'NfeInutilizacao',
  'RecepcaoEvento', 'NfeConsultaCadastro', 'NFeDistribuicaoDFe']

const at = (iso: string) => new Date(iso)
const excluded = (e: string, s: string) => EXCLUDED_FROM_SOURCE.some(x => x.endpoint === e && x.service === s)

/** Os códigos de um CHECK de `authorizer` da 001, pelo NOME da constraint (todas as listas `IN (...)` do corpo dela). */
function checkCodes(name: string): string[] {
  const start = SQL_001.indexOf(`CONSTRAINT \`${name}\``)
  expect(start).toBeGreaterThan(-1)
  const next = SQL_001.indexOf('CONSTRAINT `', start + 1)
  const body = SQL_001.slice(start, next === -1 ? undefined : next)
  return [...body.matchAll(/IN \(([^)]*)\)/g)].flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])).sort()
}

describe('(a) proveniência — a cópia do acervo é a que a constante cita (D-NE162)', () => {
  it('SHA-256 da cópia = AUTHORIZERS_SOURCE.sha256', () => {
    expect(crypto.createHash('sha256').update(RAW).digest('hex')).toBe(AUTHORIZERS_SOURCE.sha256)
    expect(SOURCE).toHaveProperty('fonte.lido_em', AUTHORIZERS_SOURCE.readAt)
  })
})

describe('(b) grão (i) — UF × ambiente bate com a relação de 15/10', () => {
  it('27 UF', () => expect(UFS).toHaveLength(27))
  for (const env of ENVS) {
    it(`autorizador normal, SVC e consulta cadastro de cada UF em ${env}`, () => {
      const v = SOURCE.uf_por_autorizador_virtual[env]
      for (const uf of UFS) {
        const r = ufRoute(uf, env)
        const normal = v.SVAN.includes(uf) ? 'SVAN' : v.SVRS_demais.includes(uf) ? 'SVRS' : uf
        expect([uf, r.normal]).toEqual([uf, normal])
        expect([uf, r.svc]).toEqual([uf, v['SVC-AN'].includes(uf) ? 'SVC-AN' : 'SVC-RS'])
        expect(v['SVC-AN'].includes(uf)).not.toBe(v['SVC-RS'].includes(uf))
        const registry = OWN.includes(uf) ? uf : v.SVRS_consulta_cadastro.includes(uf) ? 'SVRS' : null
        expect([uf, r.registry]).toEqual([uf, registry])
      }
    })
  }
})

describe('(c) grão (ii) — URL e versão iguais às da relação, com a exceção nomeada', () => {
  for (const env of ENVS) {
    it(`toda entrada da constante está no JSON (${env})`, () => {
      for (const e of ENDPOINT_CODES) {
        for (const s of ALL_SERVICES) {
          const r = endpointOf(e, env, s)
          if (!r.ok) continue
          expect([env, e, s, r.url, r.version]).toEqual([env, e, s, SOURCE[env][e]?.[s]?.url, SOURCE[env][e]?.[s]?.versao])
        }
      }
    })
    it(`todo par do JSON (inclusive o AN) está na constante, menos a exceção nomeada (${env})`, () => {
      expect(Object.keys(SOURCE[env]).sort()).toEqual([...ENDPOINT_CODES].sort())
      for (const [e, services] of Object.entries(SOURCE[env])) {
        for (const s of Object.keys(services)) {
          const r = endpointOf(e as Endpoint, env, s as NfeService)
          expect([env, e, s, r.ok]).toEqual([env, e, s, !excluded(e, s)])
        }
      }
    })
  }
  it('a exceção é a inutilização da SVC-AN, que a relação lista e o MOC recusa (586)', () => {
    expect(EXCLUDED_FROM_SOURCE.map(x => `${x.endpoint}|${x.service}`)).toEqual(['SVC-AN|NfeInutilizacao'])
    for (const env of ENVS) {
      expect(SOURCE[env]['SVC-AN'].NfeInutilizacao).toBeDefined()
      expect(endpointOf('SVC-AN', env, 'NfeInutilizacao')).toEqual({ ok: false, reason: 'service-not-offered' })
    }
  })
})

describe('(d) os CHECKs de `authorizer` da 001 = a união sobre todas as datas', () => {
  const offering = (service: NfeService) =>
    [...new Set(ENVS.flatMap(env => ENDPOINT_CODES.filter(e => endpointOf(e, env, service).ok)))].sort()

  it('tentativa: os autorizadores com NFeAutorizacao (o AN não autoriza)', () => {
    expect(checkCodes('ck_invoice_merchandise_transmission_authorizer')).toEqual(offering('NFeAutorizacao'))
  })
  it('inutilização: os que têm URL de NfeInutilizacao — sem SVC; BA e SP seguem pelas linhas anteriores a 11/11', () => {
    expect(checkCodes('ck_invoice_number_void_authorizer')).toEqual(offering('NfeInutilizacao'))
    expect(offering('NfeInutilizacao')).toEqual(expect.arrayContaining(['BA', 'SP']))
  })
})

describe('(e) derivação — casos com a tupla completa', () => {
  const base = { model: '55', emissionType: 1, hasStateRegistration: true } as const
  const cases: [string, ResolveInput, ReturnType<typeof resolveAuthorizer>][] = [
    ['PR, H, com IE', { ...base, uf: 'PR', environment: 'H', at: at('2026-11-20T12:00:00Z') }, { ok: true, authorizer: 'PR' }],
    ['MA → SVAN', { ...base, uf: 'MA', environment: 'P', at: at('2026-11-20T12:00:00Z') }, { ok: true, authorizer: 'SVAN' }],
    ['SC → SVRS', { ...base, uf: 'SC', environment: 'P', at: at('2026-11-20T12:00:00Z') }, { ok: true, authorizer: 'SVRS' }],
    ['PR sem IE em P depois de 16/11', { ...base, uf: 'PR', environment: 'P', hasStateRegistration: false, at: at('2026-11-20T12:00:00Z') }, { ok: true, authorizer: 'SVRS' }],
    ['PR sem IE em P antes de 16/11', { ...base, uf: 'PR', environment: 'P', hasStateRegistration: false, at: at('2026-11-15T12:00:00Z') }, { ok: false, reason: 'no-ie-not-yet' }],
    ['PR sem IE em H depois de 26/10', { ...base, uf: 'PR', environment: 'H', hasStateRegistration: false, at: at('2026-10-27T12:00:00Z') }, { ok: true, authorizer: 'SVRS' }],
    ['sem IE em contingência (D-NE200)', { ...base, uf: 'PR', environment: 'P', emissionType: 6, hasStateRegistration: false, at: at('2026-11-20T12:00:00Z') }, { ok: false, reason: 'no-ie-unsupported' }],
    ['PR tpEmis 7 → SVC-RS', { ...base, uf: 'PR', environment: 'P', emissionType: 7, at: at('2026-11-20T12:00:00Z') }, { ok: true, authorizer: 'SVC-RS' }],
    ['PR tpEmis 6 → não é a SVC do PR', { ...base, uf: 'PR', environment: 'P', emissionType: 6, at: at('2026-11-20T12:00:00Z') }, { ok: false, reason: 'svc-not-of-uf' }],
    ['PI tpEmis 6 em P → SVC-AN', { ...base, uf: 'PI', environment: 'P', emissionType: 6, at: at('2026-11-20T12:00:00Z') }, { ok: true, authorizer: 'SVC-AN' }],
    ['PI tpEmis 6 em H → recusa (diverge de P)', { ...base, uf: 'PI', environment: 'H', emissionType: 6, at: at('2026-11-20T12:00:00Z') }, { ok: false, reason: 'svc-not-of-uf' }],
    ['PI tpEmis 7 em H → SVC-RS', { ...base, uf: 'PI', environment: 'H', emissionType: 7, at: at('2026-11-20T12:00:00Z') }, { ok: true, authorizer: 'SVC-RS' }],
    ['modelo 65 (D-NE2)', { ...base, uf: 'PR', model: '65', environment: 'P', at: at('2026-11-20T12:00:00Z') }, { ok: false, reason: 'model-not-supported' }],
  ]
  it.each(cases)('%s', (_label, input, expected) => expect(resolveAuthorizer(input)).toEqual(expected))

  const url = (e: Endpoint, env: Environment, s: NfeService) => SOURCE[env][e][s].url
  const voidCases: [string, Uf, '55' | '65', Environment, boolean, string, unknown][] = [
    ['BA um segundo antes', 'BA', '55', 'P', true, '2026-11-11T02:59:59Z', { ok: true, endpoint: 'BA', url: url('BA', 'P', 'NfeInutilizacao'), version: '4.00' }],
    ['BA na virada (RF-CAL-08)', 'BA', '55', 'P', true, '2026-11-11T03:00:00Z', { ok: false, reason: 'service-deactivated' }],
    ['AC em H na virada (pela UF, servida pela SVRS)', 'AC', '55', 'H', true, '2026-11-11T03:00:00Z', { ok: false, reason: 'service-deactivated' }],
    ['AC em H antes', 'AC', '55', 'H', true, '2026-11-10T12:00:00Z', { ok: true, endpoint: 'SVRS', url: url('SVRS', 'H', 'NfeInutilizacao'), version: '4.00' }],
    ['PR', 'PR', '55', 'P', true, '2026-11-20T12:00:00Z', { ok: true, endpoint: 'PR', url: url('PR', 'P', 'NfeInutilizacao'), version: '4.00' }],
    ['PR sem IE (D-NE200)', 'PR', '55', 'P', false, '2026-11-20T12:00:00Z', { ok: false, reason: 'no-ie-unsupported' }],
    ['PR modelo 65', 'PR', '65', 'P', true, '2026-11-20T12:00:00Z', { ok: false, reason: 'model-not-supported' }],
  ]
  it.each(voidCases)('inutilização: %s', (_label, uf, model, environment, hasStateRegistration, iso, expected) =>
    expect(voidEndpoint({ uf, model, environment, hasStateRegistration, at: at(iso) })).toEqual(expected))

  it('endpoint cru, AN e consulta cadastro', () => {
    expect(endpointOf('SVC-AN', 'P', 'NfeInutilizacao')).toEqual({ ok: false, reason: 'service-not-offered' })
    expect(endpointOf('AN', 'P', 'NFeDistribuicaoDFe')).toEqual({ ok: true, endpoint: 'AN', url: url('AN', 'P', 'NFeDistribuicaoDFe'), version: '1.00' })
    expect(registryEndpoint('AL', 'P')).toEqual({ ok: false, reason: 'service-not-offered' })
    expect(registryEndpoint('AC', 'H')).toEqual({ ok: true, endpoint: 'SVRS', url: url('SVRS', 'H', 'NfeConsultaCadastro'), version: '4.00' })
    expect(registryEndpoint('PR', 'H')).toEqual({ ok: true, endpoint: 'PR', url: url('PR', 'H', 'NfeConsultaCadastro'), version: '4.00' })
  })
})

describe('(f) cerca das entradas datadas', () => {
  it('recusa instante fora da forma ou inexistente', () => {
    expect(() => assertDatedEntries([{ key: 'x', environment: 'H', validFrom: '2026-11-11' }])).toThrow(/fora da forma/)
    expect(() => assertDatedEntries([{ key: 'x', environment: 'H', validFrom: '2026-02-30T03:00:00Z' }])).toThrow(/inexistente/)
    expect(() => assertDatedEntries([{ key: 'x', environment: 'H', validFrom: '2026-11-11T03:00:00.000Z' }])).toThrow(/fora da forma/)
  })
  it('recusa linha repetida e aceita a forma canônica', () => {
    const e = { key: 'x', environment: 'P', validFrom: '2026-11-11T03:00:00Z' } as const
    expect(() => assertDatedEntries([e, e])).toThrow(/repetida/)
    expect(() => assertDatedEntries([e, { ...e, environment: 'H' }])).not.toThrow()
  })
})

describe('(g) parte SOAP do grão (ii) = os WSDL arquivados (D-NE182/D-NE199; NFE.E4.P4, mudança 5)', () => {
  const DIR = path.join(ROOT, 'acervo', SOAP_BINDINGS_SOURCE.dir)
  const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, 'MANIFESTO.json'), 'utf8')) as { ambiente: string; files: Record<string, string> }
  it('o manifesto confere com o disco, arquivo a arquivo (SHA-256)', () => {
    const onDisk = fs.readdirSync(DIR).filter(f => f.endsWith('.wsdl')).sort()
    expect(onDisk).toEqual(Object.keys(MANIFEST.files).sort())
    for (const [f, hash] of Object.entries(MANIFEST.files)) {
      expect([f, crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, f))).digest('hex')]).toEqual([f, hash])
    }
    expect(MANIFEST.ambiente).toBe('H')
  })
  it('o manifesto é o que a constante ancora, e a extração da fase 1 (hash do que veio do fisco) bate com ele', () => {
    expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, 'MANIFESTO.json'))).digest('hex')).toBe(SOAP_BINDINGS_SOURCE.manifestSha256)
    const ext = JSON.parse(fs.readFileSync(path.join(DIR, SOAP_BINDINGS_SOURCE.extraction), 'utf8')) as { ambiente: string; itens: { endpoint: string; service: string; status: number; sha256: string }[] }
    expect(ext.ambiente).toBe('H')
    expect(ext.itens).toHaveLength(14)
    for (const i of ext.itens) expect([i.endpoint, i.service, i.status, i.sha256]).toEqual([i.endpoint, i.service, 200, MANIFEST.files[`${i.endpoint}-${i.service}.wsdl`]])
  })
  it('cada entrada da constante é a re-extração do WSDL arquivado (operação, ação, namespace, saída)', () => {
    const entries = soapBindingEntries('H')
    expect(entries).toHaveLength(14)
    for (const { endpoint, service, binding } of entries) {
      const file = `${endpoint}-${service}.wsdl`
      expect(MANIFEST.files[file]).toBeDefined()
      const r = readWsdlOperation(fs.readFileSync(path.join(DIR, file), 'utf8'), binding.operation)
      expect([file, r]).toEqual([file, { ok: true, op: { operation: binding.operation, action: binding.action, namespace: binding.namespace, inputElement: 'nfeDadosMsg', outputElement: binding.outputElement } }])
    }
  })
  it('todo serviço do PR e da SVRS em H com URL tem parte SOAP; produção ainda não (null = nada enviado)', () => {
    for (const e of ['PR', 'SVRS'] as Endpoint[]) {
      for (const s of ['NfeStatusServico', 'NFeAutorizacao', 'NFeRetAutorizacao', 'NfeConsultaProtocolo', 'NfeConsultaCadastro', 'NfeInutilizacao', 'RecepcaoEvento'] as NfeService[]) {
        expect([e, s, endpointOf(e, 'H', s).ok, soapBindingOf(e, 'H', s) !== null]).toEqual([e, s, true, true])
      }
    }
    expect(soapBindingOf('PR', 'P', 'NfeStatusServico')).toBeNull()
    expect(soapBindingOf('SP', 'H', 'NfeStatusServico')).toBeNull()
  })
})
