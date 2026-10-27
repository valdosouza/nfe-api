/**
 * CERCA da família NF-e por AST — D-NE167 (= Q-NE167 (a), Valdo 2026-10-20; NE-2): "um descritor só" e "escritor único" da voz da NF-e,
 * a MESMA cerca da nfse-api (`nfse-api/src/__tests__/voice-kind-fence.ts` — gêmea em forma; o que muda são as CONSTANTES da família e o
 * ESCOPO). CONHECIMENTO NEGATIVO (a D-NE82 (c) está REJEITADA): um registro de descritores EM EXECUÇÃO no núcleo não cobre o OUTRO serviço
 * (processos distintos sobre o mesmo banco); a defesa em execução contra um 2º descritor da mesma tabela com outra lista é o CHECK BINÁRIO
 * da tabela da família (migration 001 — D-F107), provado no boot; a cerca aqui fecha a porta no CÓDIGO deste serviço.
 *
 * O que ela pega (`writerCallFlags`): o nome `defineVoiceFamily` em QUALQUER grafia fora do descritor autorizado (identificador, alias,
 * namespace, texto); chamada ao escritor (`insertTransmissionEvent`) cujo objeto da voz não é literal sem cast/spread ou cujo `kind` não é
 * literal da LISTA da família (ou `OUTCOME_KIND[…]`); o escritor ou o descritor (`MERCHANDISE_VOICE_FAMILY`) como VALOR fora de
 * `DESCRITOR.prop`/import/export/declaração; reflexão/espalhamento sobre o namespace de um módulo que exporta o escritor; mutação do
 * `OUTCOME_KIND`; SQL de escrita na tabela da voz da NF-e fora dos escritores autorizados (ESCRITOR ÚNICO — o escritor é o genérico do núcleo).
 * NÃO existe aqui a cerca da voz S da NFS-e (D-F102/D-F105): a NF-e PODE produzir S, desde que dê a saída dela na mesma entrega (D-NE107: a
 * lista da família não o tem hoje — o TIPO e o FUNIL do núcleo recusam; o CHECK fecha o que passa por fora).
 *
 * Por AST do TypeScript, nunca por regex sobre o texto (lição ADV-R8-06 do núcleo). LIMITE CONHECIDO: produtor SEMÂNTICO (constante
 * nomeada, shorthand, mapa, parâmetro) não tem o literal ao lado do `kind` — quem o pega é o TIPO do escritor (`MerchandiseVoiceWriteKind`).
 * ESCOPO = nfe-api (src, scripts); o núcleo tem a própria cerca (`fiscal-api/src/__tests__/fence.ts` — escritor genérico como exceção nomeada).
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { MERCHANDISE_VOICE_WRITE_KINDS } from '../nfe/voice-family'

const SRC_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..')
export const WORKSPACE = path.resolve(PROJECT_ROOT, '..')

/** Nome relativo ao workspace, barras normais — `nfe-api/src/…` em qualquer pasta (worktree ou árvore viva). */
export function relWorkspace(file: string): string {
  return path.relative(WORKSPACE, path.resolve(file)).replace(/\\/g, '/')
}
/** `.ts` de uma pasta, recursivo, sem `__tests__` nem `node_modules`. */
export const walkTs = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walkTs(path.join(dir, d.name))) : /\.(?:ts|mts|cts)$/.test(d.name) ? [path.join(dir, d.name)] : []))

const VOICE_TABLE = 'invoice_merchandise_transmission_event'
const INSERT_HEAD = String.raw`\b(?:INSERT|REPLACE)\b(?:\s+(?:LOW_PRIORITY|HIGH_PRIORITY|DELAYED|IGNORE))*(?:\s+INTO)?\s`
/** SQL de ESCRITA na voz DA NF-e — qualquer verbo (escritor único). */
function sqlWritesVoice(statement: string): boolean {
  const s = statement.replace(/\s+/g, ' ')
  const table = String.raw`(?:\x60?[\w?]+\x60?\.)?\x60?(?:tb_)?${VOICE_TABLE}\b`
  return new RegExp(String.raw`${INSERT_HEAD}\s*${table}`, 'i').test(s)
    || new RegExp(String.raw`\bUPDATE\b(?:(?!\bSET\b)[^;])*${VOICE_TABLE}\b(?:(?!\bWHERE\b)[^;])*\bSET\b`, 'i').test(s)
    || new RegExp(String.raw`\bDELETE\b(?:(?!\bWHERE\b)[^;])*${VOICE_TABLE}\b`, 'i').test(s)
}
/**
 * TEXTO que uma expressão produz quando é só literal: string/template, `${X}` com X constante string do mesmo arquivo ou literal, CONCATENAÇÃO
 * de literais (`'INSERT INTO tb_' + '…'`), `[…].join(sep)` de literais; o que não se resolve vira `?`. Gate adversarial da NE-2 (FENCE_BYPASS):
 * `${'tb_…event'}`, `'…' + '…'` e `join` escapavam da cerca do escritor único.
 */
function literalText(n: ts.Node, consts: Map<string, string>): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) return n.text
  if (ts.isParenthesizedExpression(n)) return literalText(n.expression, consts)
  if (ts.isIdentifier(n)) return consts.get(n.text) ?? null
  if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map(sp => (literalText(sp.expression, consts) ?? '?') + sp.literal.text)].join('')
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = literalText(n.left, consts), r = literalText(n.right, consts)
    return l === null && r === null ? null : `${l ?? '?'}${r ?? '?'}`
  }
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'join' && ts.isArrayLiteralExpression(n.expression.expression)) {
    const sep = n.arguments[0] ? (literalText(n.arguments[0], consts) ?? ',') : ','
    return n.expression.expression.elements.map(e => literalText(e, consts) ?? '?').join(sep)
  }
  return null
}
const sqlTextOf = literalText
function stringConsts(sf: ts.SourceFile): Map<string, string> {
  const m = new Map<string, string>()
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer))) m.set(n.name.text, n.initializer.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return m
}

const WRITER = 'insertTransmissionEvent'
const DESCRIBE = 'defineVoiceFamily'
/** O descritor da família NF-e (exportado por `nfe/voice-family.ts`) e os módulos que exportam o escritor. */
const FAMILY_DESCRIPTOR = 'MERCHANDISE_VOICE_FAMILY'
const WRITER_MODULE = /(?:^|\/)(?:repository|voice-family|transmission\.repository)$/
/** O núcleo exporta a fábrica do descritor e o escritor chega por ele: o NAMESPACE de `fiscal-api` também é módulo do escritor (reflexão sobre ele = violação). */
const isWriterModuleSpec = (spec: string) => WRITER_MODULE.test(spec) || spec === 'fiscal-api'
/** Nome de propriedade como TEXTO — identificador, string, ou computado com string (`{ "lock": x }` e `{ ['lock']: x }` escapavam — gate adversarial). */
const propName = (name: ts.PropertyName, sf: ts.SourceFile): string =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text
    : ts.isComputedPropertyName(name) && (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression)) ? name.expression.text : name.getText(sf)
const FAMILY = new Set<string>(MERCHANDISE_VOICE_WRITE_KINDS)

/** D-NE80: a TRAVA do `withInvoiceTx` do núcleo numa família é só `erp.lockInvoice` (ou ausente). true = violação. */
export function lockFlags(code: string): boolean {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let bad = false
  const visit = (n: ts.Node): void => {
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && propName(n.name, sf) === 'lock' && ts.isObjectLiteralExpression(n.parent)) {
      if (!ts.isPropertyAssignment(n) || n.initializer.getText(sf) !== 'erp.lockInvoice') bad = true
    }
    // `erp` só pode ser o do núcleo: uma declaração local/parâmetro/alias com esse nome faria `erp.lockInvoice` apontar para outro "travante"
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === 'erp') bad = true
    if ((ts.isImportSpecifier(n) || ts.isNamespaceImport(n)) && n.name.text === 'erp') {
      const decl = ts.isImportSpecifier(n) ? n.parent.parent.parent : n.parent.parent
      if (!(ts.isImportDeclaration(decl) && ts.isStringLiteral(decl.moduleSpecifier) && decl.moduleSpecifier.text === 'fiscal-api' && (!ts.isImportSpecifier(n) || !n.propertyName || n.propertyName.text === 'erp'))) bad = true
    }
    if (ts.isObjectLiteralExpression(n) && n.properties.some(ts.isSpreadAssignment) && ts.isCallExpression(n.parent)
      && /withInvoiceTx|withLockedInvoice/.test(n.parent.expression.getText(sf))) bad = true
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return bad
}
const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isTypeAssertionExpression(x) || ts.isNonNullExpression(x)
    || ts.isSatisfiesExpression(x)) x = x.expression
  return x
}
const isCast = (e: ts.Expression): boolean => ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)
  || (ts.isParenthesizedExpression(e) && isCast(e.expression))

/** CERCA DE CHAMADA/DESCRITOR/ESCRITOR ÚNICO da voz da NF-e (gêmea da nfse-api). true = violação. */
export function writerCallFlags(code: string, opts: { allowSqlWriter?: boolean; allowFamilyDescriptor?: boolean } = {}): boolean {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const consts = stringConsts(sf)
  const aliases = new Set([WRITER])
  const familyAliases = new Set([DESCRIBE])
  const descriptors = new Set([FAMILY_DESCRIPTOR])
  const writerModules = new Set<string>()
  const collect = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === WRITER) aliases.add(n.name.text)
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === DESCRIBE) familyAliases.add(n.name.text)
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === FAMILY_DESCRIPTOR) descriptors.add(n.name.text)
    if (ts.isNamespaceImport(n) && ts.isImportClause(n.parent) && ts.isImportDeclaration(n.parent.parent)
      && ts.isStringLiteral(n.parent.parent.moduleSpecifier) && isWriterModuleSpec(n.parent.parent.moduleSpecifier.text)) writerModules.add(n.name.text)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const v = unwrap(n.initializer)
      if ((ts.isIdentifier(v) && v.text === WRITER) || (ts.isPropertyAccessExpression(v) && v.name.text === WRITER)) aliases.add(n.name.text)
    }
    ts.forEachChild(n, collect)
  }
  collect(sf)
  const isWriter = (callee: ts.Expression) => {
    const c = unwrap(callee)
    return (ts.isIdentifier(c) && aliases.has(c.text)) || (ts.isPropertyAccessExpression(c) && c.name.text === WRITER)
  }
  const isOutcomeKind = (e: ts.Expression) => {
    const x = unwrap(e)
    return (ts.isIdentifier(x) && x.text === 'OUTCOME_KIND') || (ts.isPropertyAccessExpression(x) && x.name.text === 'OUTCOME_KIND')
  }
  const kindOk = (obj: ts.ObjectLiteralExpression): boolean => {
    if (obj.properties.some(ts.isSpreadAssignment)) return false
    const p = obj.properties.find(q => (ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) && q.name.getText(sf) === 'kind')
    if (!p || !ts.isPropertyAssignment(p)) return false
    const init = p.initializer
    if (ts.isStringLiteral(init)) return FAMILY.has(init.text)
    return ts.isElementAccessExpression(init) && isOutcomeKind(init.expression)
  }
  const hasKindProp = (o: ts.ObjectLiteralExpression) => o.properties.some(q =>
    (ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) && q.name.getText(sf) === 'kind')
  const calleeName = (c: ts.CallExpression): string | null => {
    const x = unwrap(c.expression)
    return ts.isIdentifier(x) ? x.text : ts.isPropertyAccessExpression(x) ? x.name.text : null
  }
  const isBindingInit = (pa: ts.PropertyAccessExpression): boolean =>
    ts.isVariableDeclaration(pa.parent) && pa.parent.initializer === pa && ts.isIdentifier(pa.parent.name) && pa.parent.name.text === WRITER
  const writerAsValueOk = (id: ts.Identifier): boolean => {
    const p = id.parent
    if (ts.isCallExpression(p) && p.expression === id) return true
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isTypeQueryNode(p)) return true
    if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name === id) return true
    if (ts.isPropertyAccessExpression(p) && p.name === id) return (ts.isCallExpression(p.parent) && p.parent.expression === p) || isBindingInit(p)
    if (ts.isCallExpression(p) && p.arguments[0] === id && /^(?:reserveCancelRequest|releaseCancelRequest)$/.test(calleeName(p) ?? '')) return true
    const prop = (ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && p.initializer === id)) ? p : null
    const obj = prop && ts.isObjectLiteralExpression(prop.parent) ? prop.parent : null
    return !!obj && ts.isCallExpression(obj.parent) && obj.parent.arguments[0] === obj && /^(?:recordVoiceOnce|recordKindOnce)$/.test(calleeName(obj.parent) ?? '')
  }
  const descriptorOk = (id: ts.Identifier): boolean => {
    const p = id.parent
    if (ts.isPropertyAccessExpression(p)) return p.expression === id ? p.name.text !== WRITER || ts.isCallExpression(p.parent) && p.parent.expression === p || isBindingInit(p) : true
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isTypeQueryNode(p)) return true
    return ts.isVariableDeclaration(p) && p.name === id
  }
  const isStr = (n: ts.Node, v: string) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === v
  /** Texto MONTADO (concatenação, template, join) igual ao nome vigiado — `'define' + 'VoiceFamily'` escapava (gate adversarial). */
  const builtText = (n: ts.Node): string | null => (ts.isBinaryExpression(n) || ts.isTemplateExpression(n) || ts.isCallExpression(n)) ? literalText(n, consts) : null
  const isDynamicCode = (n: ts.Node) => ts.isIdentifier(n) && (n.text === 'eval' || n.text === 'Function')
    && !ts.isTypeReferenceNode(n.parent) && !ts.isTypeQueryNode(n.parent) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n && !/^(?:globalThis|global|window|self)$/.test(n.parent.expression.getText(sf)))
  let bad = false
  const visit = (n: ts.Node): void => {
    if (bad) return
    // código DINÂMICO (`eval`, `new Function`, `Function(...)`): nenhuma cerca por AST enxerga o que ele monta — proibido no escopo da família
    if (isDynamicCode(n)) bad = true
    const built = builtText(n)
    if (built === DESCRIBE || built === WRITER) bad = true
    if (ts.isIdentifier(n) && aliases.has(n.text) && !writerAsValueOk(n)) bad = true
    if (!opts.allowFamilyDescriptor && ((ts.isIdentifier(n) && (n.text === DESCRIBE || familyAliases.has(n.text))) || isStr(n, DESCRIBE))) bad = true
    if (isStr(n, WRITER)) bad = true
    if (ts.isIdentifier(n) && descriptors.has(n.text) && !descriptorOk(n)) bad = true
    if (ts.isIdentifier(n) && writerModules.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)
      && !ts.isNamespaceImport(n.parent)) bad = true
    if (ts.isCallExpression(n)) {
      if (isWriter(n.expression)) {
        const arg = n.arguments[n.arguments.length - 1]
        if (!arg || isCast(arg) || !ts.isObjectLiteralExpression(unwrap(arg)) || !kindOk(unwrap(arg) as ts.ObjectLiteralExpression)) bad = true
      }
      for (const a of n.arguments) if (isCast(a) && ts.isObjectLiteralExpression(unwrap(a)) && hasKindProp(unwrap(a) as ts.ObjectLiteralExpression)) bad = true
      const callee = unwrap(n.expression)
      if (!opts.allowFamilyDescriptor && ((ts.isIdentifier(callee) && familyAliases.has(callee.text))
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === DESCRIBE))) bad = true
      if (ts.isPropertyAccessExpression(callee) && /^(?:Object|Reflect)$/.test(callee.expression.getText(sf))
        && /^(?:assign|defineProperty|defineProperties|set|deleteProperty|setPrototypeOf)$/.test(callee.name.text)
        && n.arguments[0] && isOutcomeKind(n.arguments[0])) bad = true
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = unwrap(n.left)
      if ((ts.isPropertyAccessExpression(l) || ts.isElementAccessExpression(l)) && isOutcomeKind(l.expression)) bad = true
    }
    if (ts.isDeleteExpression(n)) {
      const x = unwrap(n.expression)
      if ((ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) && isOutcomeKind(x.expression)) bad = true
    }
    if (!opts.allowSqlWriter) {
      const sql = sqlTextOf(n, consts)
      if (sql && sqlWritesVoice(sql)) bad = true
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return bad
}

/**
 * Escritores AUTORIZADOS do SQL na voz da NF-e fora do núcleo (ESCRITOR ÚNICO): hoje só a PROVA no banco DESCARTÁVEL (D-F53 — o script
 * recusa qualquer banco que não seja `fiscal_api_adv*`). O escritor de produção é o GENÉRICO do núcleo (`fiscal-api/src/voice/event-table.ts`)
 * pela tabela do DESCRITOR — e o único descritor é `VOICE_FAMILY_DESCRIPTORS`.
 */
export const VOICE_SQL_WRITERS = ['nfe-api/scripts/prove-001-descartavel.ts']
/** O ÚNICO lugar fora do núcleo que declara a família da voz da NF-e (`defineVoiceFamily`) — D-NE167. */
export const VOICE_FAMILY_DESCRIPTORS = ['nfe-api/src/nfe/voice-family.ts']

/** O CONJUNTO que a cerca varre — todo lugar desta API que poderia escrever na voz da NF-e. */
export function voiceFenceScope(): string[] {
  return [...new Set([...walkTs(path.join(PROJECT_ROOT, 'src')), ...walkTs(path.join(PROJECT_ROOT, 'scripts'))].map(f => path.resolve(f)))]
}

/** Violações da cerca de chamada/descritor/escritor único no escopo. */
export function voiceWriterViolations(files: string[] = voiceFenceScope()): string[] {
  return files.filter(f => fs.existsSync(f) && f.endsWith('.ts'))
    .filter(f => {
      const r = relWorkspace(f)
      return writerCallFlags(fs.readFileSync(f, 'utf8'), { allowSqlWriter: VOICE_SQL_WRITERS.includes(r), allowFamilyDescriptor: VOICE_FAMILY_DESCRIPTORS.includes(r) })
    })
    .map(f => relWorkspace(f))
}
