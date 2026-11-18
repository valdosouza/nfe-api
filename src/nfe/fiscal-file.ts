import { FiscalDocumentKind, FiscalFileEnvironment, FiscalFileKey, IssuerModel, modelsOf } from 'fiscal-api'

/**
 * Onde o XML da família de mercadoria mora no arquivo fiscal — layout D-F241 do núcleo 2.0.0:
 * `<raiz>/<CNPJ>/[H/]<nfe|nfce>/<série>/<ano>/<mês>/<dia>/<arquivo>.xml` (substitui o `<cnpj>/<H|P>/<ano>/<mês>` da D-NE50).
 * Este é o ÚNICO lugar que liga o MODELO ao TIPO da pasta (cerca por AST em `deploy-e1-p5.test.ts`: nenhum literal `nfe`/`nfce` nem
 * `FISCAL_DOCUMENT_KINDS` fora daqui, em `src/` e `scripts/`): 55 = `nfe`, 65 = `nfce`. A série é a da CHAVE (0–999 — D-F241).
 * Sem consumidor na NE-2: quem gravar XML (NE-3 em diante) monta a chave do arquivo por aqui. DEPLOY.E1.P5 (D-F237, por acompanhamento).
 * O modelo entra como TEXTO (vem do ERP e da chave); o domínio é o `modelsOf('merchandise')` do núcleo, conferido em tempo de execução.
 */
type MerchandiseModel = Extract<IssuerModel, '55' | '65'>
const KIND_BY_MODEL = Object.freeze({ '55': 'nfe', '65': 'nfce' } as const satisfies Record<MerchandiseModel, FiscalDocumentKind>)

/** Modelo do ramo de mercadoria → tipo da pasta. Modelo fora do ramo (`modelsOf('merchandise')` do núcleo) = erro, nunca outra pasta. */
export function merchandiseDocumentKind(model: string): FiscalDocumentKind {
  const merchandise = modelsOf('merchandise') as readonly string[]
  if (!merchandise.includes(model) || !Object.prototype.hasOwnProperty.call(KIND_BY_MODEL, model)) {
    throw new Error(`merchandiseDocumentKind: modelo ${JSON.stringify(model)} fora do ramo de mercadoria (${merchandise.join('/')})`)
  }
  return KIND_BY_MODEL[model as MerchandiseModel]
}

/** Série da chave da NF-e/NFC-e: 0–999 (3 posições na chave). O núcleo aceita até 5 dígitos (a série da DPS); aqui o limite é o da chave. */
function merchandiseSerie(serie: string | number): string | number {
  const ok = typeof serie === 'number' ? Number.isInteger(serie) && serie >= 0 && serie <= 999 : /^\d{1,3}$/.test(serie)
  if (!ok) throw new Error(`merchandiseFileKey: série ${JSON.stringify(serie)} fora de 0–999 (a série da chave da NF-e/NFC-e)`)
  return serie
}

export interface MerchandiseFileKeyInput {
  cnpj:        string
  model:       string
  /** A série da chave de acesso (0–999). */
  serie:       string | number
  environment: FiscalFileEnvironment
  /** Zona do estabelecimento (Q-TZ7): o dia da pasta é o dia NELA. */
  zone:        string
}

export function merchandiseFileKey(p: MerchandiseFileKeyInput): FiscalFileKey {
  return { cnpj: p.cnpj, kind: merchandiseDocumentKind(String(p.model)), serie: merchandiseSerie(p.serie), environment: p.environment, zone: p.zone }
}
