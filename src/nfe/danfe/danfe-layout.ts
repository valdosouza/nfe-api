/**
 * LEIAUTE DO DANFE A4 RETRATO (NFE.E6.P3 — NT 2026.010 sobre o Anexo II do MOC 7.00; D-NE100; ficha `ficha-nfe-e6-p3-danfe.md` §4). SÓ DADO:
 * medidas em cm, papéis de fonte, os TRECHOS DE TEXTO (corpo + opções de cada um — D-NE157) e as colunas dos itens. O desenho está em `danfe.ts`.
 *
 * D-NE157 (regra da família): cada trecho com texto diz o seu corpo e as suas opções de leiaute, nunca os herda de outro trecho que pode vir
 * vazio. Por isso TODO texto do DANFE passa por UMA função (`put`, em `danfe.ts`) que recebe o trecho (`DanfeTextPart`) da tabela abaixo e
 * escreve em linha única, com `sizePt`, `align`, `width` e `lineBreak: false` sempre explícitos; texto vazio não chama o desenho.
 *
 * Corpos (AII 3.7: Times New Roman ou Courier New; descritivo de bloco 5 pt em negrito e caixa alta; descritivo de coluna de itens 5 pt;
 * demais descritivos 6 pt; "DANFE" 12 pt em negrito; série, número, folha e tpNF 10 pt em negrito; "DOCUMENTO AUXILIAR…" e ENTRADA/SAÍDA 8 pt;
 * razão social do emitente 12 pt em negrito; demais dados do emitente 8 pt em negrito; conteúdo dos itens e informações complementares 6 pt;
 * demais campos 10 pt). Leitura L da ficha (S-5): descritivo = 6 pt e conteúdo = 10 pt nos "demais campos"; aqui o conteúdo dos quadros usa o
 * corpo MÁXIMO que cabe (de 10 pt até o piso de 6 pt, `FIT_MIN_PT`) para o valor não ser cortado.
 */

export const CM = Object.freeze({
  /** A4 retrato; margens de 0,25 cm (AII: de 0,2 a 0,8 cm em cada lado). */
  page: Object.freeze({ width: 21, height: 29.7 }),
  margin: 0.25,
  /** Largura útil: 21 − 2 × 0,25. */
  width: 20.5,
  /**
   * Cabeçalho repetido em TODA folha (AII L645-668): emitente + identificação + chave, natureza + protocolo, IE + IE ST + CNPJ. Medidas da tabela
   * de dimensões do AII 3.8 para impressora de NÃO impacto (emitente 10,00; "DANFE" 2,54; chave 8,00 — a tabela é sugestão, os mínimos são do
   * código de barras: 6 cm de largura total, barra de 0,8 cm de altura e 0,02 cm de módulo — AII 2).
   */
  header: Object.freeze({ top: 3.9, emitW: 10, identW: 2.5, keyW: 8, rowB: 0.85, natW: 12.5, protW: 8, rowC: 0.85, barsHeight: 1.0 }),
  /** Folga entre o cabeçalho e o conteúdo, e entre quadros. */
  gap: 0.15,
  /** Altura de uma linha de campos (rótulo + valor). */
  cell: 0.85,
  /** Folga do texto dentro de uma caixa, em pontos. */
  padPt: 2,
})

/** Piso do corpo do texto ao encolher para caber (AII: 6 pt é o menor corpo de conteúdo). */
export const FIT_MIN_PT = 6

/** Papéis de fonte registrados na 1ª folha (fontes-padrão, sem embutir — D-NE120). */
export const DANFE_FONT_ROLES = Object.freeze({
  label: 'Times-Roman', labelBold: 'Times-Bold', value: 'Times-Roman', valueBold: 'Times-Bold',
} as const)
export type DanfeRole = keyof typeof DANFE_FONT_ROLES

export interface DanfeTextPart {
  readonly role: DanfeRole
  readonly sizePt: number
  readonly align: 'left' | 'center' | 'right'
}

/**
 * TODOS os trechos com texto do DANFE: o papel, o corpo e o alinhamento de cada um. `fit` (valor que encolhe até `FIT_MIN_PT`) usa o `sizePt`
 * como corpo máximo. Nenhum trecho herda opção de outro (D-NE157): o teste `danfe-text-parts.test.ts` confere a tabela e que o desenho só escreve por ela.
 */
export const DANFE_TEXT_PARTS = Object.freeze({
  /** Descritivo (rótulo) de campo, 6 pt caixa alta. */
  fieldLabel: { role: 'label', sizePt: 6, align: 'left' },
  /** Título de bloco (DESTINATÁRIO/REMETENTE…), 5 pt negrito caixa alta. */
  blockTitle: { role: 'labelBold', sizePt: 5, align: 'left' },
  /** Cabeçalho de coluna dos itens, 5 pt caixa alta. */
  columnTitle: { role: 'label', sizePt: 5, align: 'center' },
  /** Valor de campo de texto. */
  fieldValue: { role: 'value', sizePt: 10, align: 'left' },
  /** Valor de campo numérico/monetário (à direita). */
  fieldNumber: { role: 'value', sizePt: 10, align: 'right' },
  /** Valor de campo centrado (UF, código). */
  fieldCentered: { role: 'value', sizePt: 10, align: 'center' },
  /** Conteúdo de uma linha de item e de informações complementares, 6 pt. */
  itemText: { role: 'value', sizePt: 6, align: 'left' },
  itemNumber: { role: 'value', sizePt: 6, align: 'right' },
  itemCentered: { role: 'value', sizePt: 6, align: 'center' },
  /** "DANFE", 12 pt negrito. */
  documentName: { role: 'valueBold', sizePt: 12, align: 'center' },
  /** "DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRÔNICA" e ENTRADA/SAÍDA, 8 pt. */
  documentSubtitle: { role: 'value', sizePt: 8, align: 'center' },
  /** Série, número, folha e tpNF, 10 pt negrito. */
  identification: { role: 'valueBold', sizePt: 10, align: 'center' },
  /** Razão social do emitente, 12 pt negrito. */
  issuerName: { role: 'valueBold', sizePt: 12, align: 'center' },
  /** Demais dados do emitente, 8 pt negrito. */
  issuerData: { role: 'valueBold', sizePt: 8, align: 'center' },
  /** A chave de acesso em blocos (negrito) e a mensagem de consulta. */
  accessKey: { role: 'valueBold', sizePt: 9, align: 'center' },
  consultMessage: { role: 'value', sizePt: 6, align: 'center' },
} as const satisfies Readonly<Record<string, DanfeTextPart>>)
export type DanfePartName = keyof typeof DANFE_TEXT_PARTS

/** Textos fixos do leiaute (Anexo II). */
export const DANFE_TEXTS = Object.freeze({
  title: 'DANFE',
  subtitle: 'DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRÔNICA',
  entry: '0 - ENTRADA',
  exit: '1 - SAÍDA',
  accessKey: 'CHAVE DE ACESSO',
  consult: 'Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora',
  protocol: 'PROTOCOLO DE AUTORIZAÇÃO DE USO',
  natOp: 'NATUREZA DA OPERAÇÃO',
  ie: 'INSCRIÇÃO ESTADUAL',
  iest: 'INSCRIÇÃO ESTADUAL DO SUBST. TRIBUT.',
  cnpj: 'CNPJ',
  recipient: 'DESTINATÁRIO / REMETENTE',
  invoice: 'FATURA / DUPLICATAS',
  tax: 'CÁLCULO DO IMPOSTO',
  carrier: 'TRANSPORTADOR / VOLUMES TRANSPORTADOS',
  items: 'DADOS DOS PRODUTOS / SERVIÇOS',
  issqn: 'CÁLCULO DO ISSQN',
  additional: 'DADOS ADICIONAIS',
  complementary: 'INFORMAÇÕES COMPLEMENTARES',
  reserved: 'RESERVADO AO FISCO',
  watermarkHomologation: 'SEM VALOR FISCAL',
  stampCancelled: 'CANCELADA',
} as const)

/** Código do CRT impresso no quadro do emitente (NT 2026.010 L131): só os que o acervo mostra; outro código sai como o próprio número (nada inventado). */
export const CRT_LABELS: Readonly<Record<string, string>> = Object.freeze({ '1': '1 - SIMPLES NACIONAL', '3': '3 - REGIME NORMAL' })

/** `modFrete` (Anexo II 3.1.10 / X02). */
export const MOD_FRETE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  '0': '0 - Contratação do Frete por conta do Remetente (CIF)',
  '1': '1 - Contratação do Frete por conta do Destinatário (FOB)',
  '2': '2 - Contratação do Frete por conta de Terceiros',
  '3': '3 - Transporte Próprio por conta do Remetente',
  '4': '4 - Transporte Próprio por conta do Destinatário',
  '9': '9 - Sem Ocorrência de Transporte',
})

/** Colunas dos itens (cm; a soma é a largura útil). A coluna do imposto diz CSOSN para o Simples (grupo ICMSSN*) e CST para os demais. */
export const ITEM_COLUMNS = Object.freeze([
  { key: 'code', title: 'CÓDIGO', widthCm: 2.0, part: 'itemText' },
  { key: 'description', title: 'DESCRIÇÃO DO PRODUTO / SERVIÇO', widthCm: 5.9, part: 'itemText' },
  { key: 'ncm', title: 'NCM/SH', widthCm: 1.4, part: 'itemCentered' },
  { key: 'tax', title: 'CST', widthCm: 1.0, part: 'itemCentered' },
  { key: 'cfop', title: 'CFOP', widthCm: 1.0, part: 'itemCentered' },
  { key: 'unit', title: 'UN', widthCm: 0.8, part: 'itemCentered' },
  { key: 'qty', title: 'QUANT.', widthCm: 1.5, part: 'itemNumber' },
  { key: 'unitValue', title: 'VALOR UNIT.', widthCm: 1.7, part: 'itemNumber' },
  { key: 'total', title: 'VALOR TOTAL', widthCm: 1.8, part: 'itemNumber' },
  { key: 'bc', title: 'BC ICMS', widthCm: 1.3, part: 'itemNumber' },
  { key: 'icms', title: 'VALOR ICMS', widthCm: 1.2, part: 'itemNumber' },
  { key: 'rate', title: 'ALÍQ.', widthCm: 0.9, part: 'itemNumber' },
] as const satisfies readonly { key: string; title: string; widthCm: number; part: DanfePartName }[])
