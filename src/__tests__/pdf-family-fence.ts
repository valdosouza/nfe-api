// CÓPIA para a nfe-api (nfe-api:NFE.E6.P3.T3 — D-GP88, D-NE228, Valdo 2026-11-21 "Na nfe-api (cópia)"). ORIGEM: `fiscal-api/src/__tests__/pdf-family-fence.ts`
// no commit 936f88b (fiscal-api:PDF.E2.P1). A REGRA mora no núcleo; esta cópia roda sobre a pasta do DANFE (`src/nfe/danfe/**`) e sobre o
// resto de `src/` pelo `isPdfFamilyFile` (`danfe-family-fence.test.ts`). DIFERENÇAS da origem, e só elas (D-NE228, gate A6 do núcleo; gate adversarial da
// NFE.E6.P3, M1):
//  1. `addContent`, `formText`, `note` e `textAnnotation` (D-NE228) mais o resto das APIs do pdfkit que escrevem texto ou conteúdo fora das portas —
//     `annotate`, `formAnnotation`, `formField`, `formCombo`, `formList`, `formPushButton`, `formRadioButton`, `formCheckbox`, `continueOnNewPage`,
//     `_fragment`, `_text`, `_line` — como CHAMADA (CALL_BANNED);
//  2. `addPage` em QUALQUER referência de propriedade (PROPERTY_BANNED): o embrulho (`const o = doc.addPage; doc.addPage = …`) e a chamada direta
//     (a família não abre folha: o pdfkit abre no transbordo e o `sheetStart` da base não pode abri-la); o texto `'addPage'` solto também é
//     acusado (regra d, como o `'pageAdded'`);
//  3. `write` chamado sobre `.page` ou `.content` (é o que o `addContent` faz por dentro: `doc.page.write('BT … Tj ET')`) — regra b;
//  4. `doc[chave]` com chave que NÃO é texto literal (`const k = 'text'; doc[k](…)`) — regra c; só o objeto chamado `doc` (a convenção da família).
// LIMITES: a desestruturação de `note` de um objeto que não é resultado de chamada é acusada — a pasta do DANFE não usa campo com esse nome; nome
// montado em execução em outro objeto, `eval`, `Object(doc)` e `doc.on('page' + 'Added')` seguem como os limites do cabeçalho abaixo (a cerca
// protege contra ENGANO, não contra fraude).
// Mudou a regra no núcleo? Refaça esta cópia a partir dele e reaplique as diferenças acima.
// CERCA DA FAMÍLIA DO DANFE (fiscal-api:PDF.E2.P1 — D-NE126, D-NE129, D-NE130, D-NE142; prompt da NF-e §14.9 a §14.19) — peça de TESTE pura,
// por AST. A família escreve e mede texto SÓ pelas portas da base (`writeText`/`measureText` — WinAnsi, papel do registro DA BASE, linha
// única, cadeia aberta, texto vazio) e desenha sem quebrar o contrato do `sheetStart` e da passada por folha. O que ela barra:
//   (a) `doc.text`, `doc.list`, `doc.table` e `doc.font` como CHAMADA — direta, embrulhada (`(doc.text as F)(…)`, `(0, doc.text)(…)`, `doc.text!(…)`), por
//       template marcado, por `.call`/`.apply`/`.bind` ou como callback com o próprio dono (`forEach(doc.text, doc)`) (D-NE126/D-NE129). TODO
//       `doc.font(…)`, inclusive com o nome de um papel — a família não precisa dele: as portas põem a fonte do papel (Valdo 2026-11-21:
//       "Barrar todo doc.font", e "Só a chamada": ler o campo `font` de um dado, como o `WatermarkStyle.font` da base, passa);
//   (b) as medidas cruas (`heightOfString`/`widthOfString`) e `registerFont` em QUALQUER referência de propriedade (papel só por
//       `registerFontRoles`/`fontRoles` — o `registerFont` direto põe até a Symbol, achado D14); e `clip` como referência que NÃO é a chamada
//       direta (`const c = doc.clip`) — a chamada é da regra (e);
//   (c) esses nomes (e `text`, `list`, `table`, `clip`, `rotate`, `translate`, `scale`, `transform`, `pageAdded`) como TEXTO num acesso por colchete (`doc['text']`), numa chave computada
//       de desestruturação ou num argumento de `Reflect.*` — e `Reflect.apply(doc.text, …)`. A desestruturação (declaração ou atribuição) de
//       `text`/`list`/`table`/`font` é barrada quando a fonte não é o resultado de uma chamada (`const { text: t } = doc`; o `toWinAnsi(x)` passa);
//   (d) o texto `'pageAdded'` em qualquer lugar — um ouvinte da família desenharia fora do contrato do `sheetStart` (sem isolamento, D-NE134,
//       D-NE144; nota do gate socrático do delta 2e16ea6..15f3373);
//   (e) `.clip(` — e a mudança de MATRIZ `.rotate(`/`.translate(`/`.scale(`/`.transform(` (gate adversarial A1, MEDIUM; Valdo 2026-11-21:
//       "Entram na cerca" — fora de `save()` a matriz vale até o fim da folha e desloca o "Folha n/N" da passada; a base não a desfaz) — fora
//       de `save()` aberto NA MESMA FUNÇÃO, em ordem de texto (D-NE142): `save` menos `restore` antes da chamada > 0 e a função
//       fecha tantos `restore` quantos `save`. Funções aninhadas contam à parte — um auxiliar que recorta dentro do `save()` de quem o chama é
//       BARRADO (o par `save`/`restore` fica junto do `clip`). A matriz entra só por chamada direta: `opcoes.scale` é dado comum e não é
//       acusado em (b).
// PERMITIDO: o texto girado da D-NE130 (`save()` → `rotate()` → `writeText` → `restore()`), o recorte dentro de `save()`/`restore()` (inclusive
// com o `restore()` no `finally`), ler o `.text` de outro objeto (o `toWinAnsi(...).text`) e um campo `list`/`table` de outro objeto.
//
// LIMITES ASSUMIDOS (a mesma postura da `src/pdf/base-document.ts:34`): a cerca protege contra ENGANO, não contra fraude — nome montado em
// execução (`doc['te' + 'xt']`) e `const t = doc.text` sem chamar não são vistos; a regra (e) conta em ORDEM DE TEXTO, sem fluxo nem dono
// (o `save()` condicional ou de outro objeto passa — o que fica aberto a base recusa em execução, D-NE134); o escopo (`isPdfFamilyFile`) é o arquivo que importa
// `fiscal-api/pdf` ou `pdfkit` ou cita o tipo `PDFKit` — um auxiliar que recebe `doc` sem nada disso fica fora.
//
// ONDE RODA (Valdo 2026-11-21: "Na nfe-api (cópia)"): o núcleo guarda a REGRA e os testes dela (`pdf-family-fence.test.ts`); a cerca que roda
// sobre o DANFE é uma CÓPIA desta peça na suíte da nfe-api (nfe-api:NFE.E6.P3), como na Q-NE167. O núcleo não varre a pasta irmã.
import ts from 'typescript'

/** (a) Barrados como CHAMADA. */
export const CALL_BANNED = Object.freeze([
  'text', 'list', 'table', 'font', 'addContent', 'formText', 'note', 'textAnnotation',
  'annotate', 'formAnnotation', 'formField', 'formCombo', 'formList', 'formPushButton', 'formRadioButton', 'formCheckbox',
  'continueOnNewPage', '_fragment', '_text', '_line',
] as const)
/** (b) Barrados em qualquer referência de propriedade. */
export const PROPERTY_BANNED = Object.freeze(['heightOfString', 'widthOfString', 'registerFont', 'addPage'] as const)
/** (c) Barrados como TEXTO em colchete, chave computada ou `Reflect.*`. */
/** (e) Só com `save()` aberto na mesma função: o recorte (D-NE142) e a mudança de matriz (A1). */
export const SAVE_GUARDED = Object.freeze(['clip', 'rotate', 'translate', 'scale', 'transform'] as const)
export const NAME_BANNED = Object.freeze([...CALL_BANNED, ...PROPERTY_BANNED, ...SAVE_GUARDED, 'pageAdded'] as const)

export type FenceRule = 'a' | 'b' | 'c' | 'd' | 'e'
export interface FenceViolation {
  readonly rule: FenceRule
  readonly line: number
  readonly snippet: string
}

const parse = (code: string): ts.SourceFile => ts.createSourceFile('familia.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const isText = (n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
const has = (list: readonly string[], s: string): boolean => list.includes(s)
const isFunctionLike = (n: ts.Node): boolean => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
  || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
/**
 * O ALVO de uma chamada sem os embrulhos que não mudam o que é chamado (gate adversarial A2 / socrático 5): parênteses, `as`, `<T>x`,
 * `satisfies`, `!` e a vírgula (`(0, doc.text)(…)` chama o último operando).
 */
function unwrapCallee(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)
      || ts.isSatisfiesExpression(e)) e = e.expression
    else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) e = e.right
    else return e
  }
}
/** O acesso de propriedade chamado (`x.nome(…)`, `x?.nome(…)`, `(x.nome as F)(…)`…), ou null. */
const calledAccess = (call: ts.CallExpression | ts.TaggedTemplateExpression): ts.PropertyAccessExpression | null => {
  const target = unwrapCallee(ts.isCallExpression(call) ? call.expression : call.tag)
  return ts.isPropertyAccessExpression(target) ? target : null
}
const calledName = (call: ts.CallExpression | ts.TaggedTemplateExpression): string | null => calledAccess(call)?.name.text ?? null
/** O acesso `x.nome` é o ALVO direto de uma chamada (mesmo embrulhado)? */
const isDirectCallee = (n: ts.PropertyAccessExpression): boolean => {
  let p: ts.Node = n
  while (p.parent && (ts.isParenthesizedExpression(p.parent) || ts.isAsExpression(p.parent) || ts.isTypeAssertionExpression(p.parent)
    || ts.isNonNullExpression(p.parent) || ts.isSatisfiesExpression(p.parent)
    || (ts.isBinaryExpression(p.parent) && p.parent.operatorToken.kind === ts.SyntaxKind.CommaToken && p.parent.right === p))) p = p.parent
  return !!p.parent && ((ts.isCallExpression(p.parent) && p.parent.expression === p) || (ts.isTaggedTemplateExpression(p.parent) && p.parent.tag === p))
}
/** A fonte de uma desestruturação (o `= x` da declaração ou da atribuição), ou undefined. */
function destructuringSource(pattern: ts.Node): ts.Expression | undefined {
  if (ts.isVariableDeclaration(pattern.parent)) return pattern.parent.initializer
  if (ts.isBinaryExpression(pattern.parent) && pattern.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && pattern.parent.left === pattern) return pattern.parent.right
  return undefined
}
/**
 * Uma chave de desestruturação é barrada? As de (b) e o `clip` sempre; as de (a) (`text`, `list`, `table`, `font`) só quando a FONTE não é o
 * resultado de uma chamada — `const { text: t } = doc` é o método solto; `const { text, replaced } = toWinAnsi(x)` é dado.
 */
function bannedKey(key: string, source: ts.Expression | undefined): boolean {
  if (has(PROPERTY_BANNED, key) || key === 'clip') return true
  return has(CALL_BANNED, key) && !(source && ts.isCallExpression(unwrapCallee(source)))
}

/** O arquivo é da família de PDF: importa `fiscal-api/pdf` (ou um subcaminho dele) ou `pdfkit`, ou cita o tipo `PDFKit`. */
export function isPdfFamilyFile(code: string): boolean {
  const sf = parse(code)
  const pdfModule = (s: string): boolean => s === 'pdfkit' || s.startsWith('pdfkit/') || s === 'fiscal-api/pdf' || s.startsWith('fiscal-api/pdf/')
  let hit = false
  const visit = (n: ts.Node): void => {
    if (hit) return
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && isText(n.moduleSpecifier) && pdfModule(n.moduleSpecifier.text)) hit = true
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && isText(n.moduleReference.expression)
      && pdfModule(n.moduleReference.expression.text)) hit = true
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
      && isText(n.arguments[0]) && pdfModule(n.arguments[0].text)) hit = true
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && isText(n.argument.literal) && pdfModule(n.argument.literal.text)) hit = true
    else if (ts.isQualifiedName(n) && ts.isIdentifier(n.left) && n.left.text === 'PDFKit') hit = true
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hit
}

/** (e) Cada chamada de `SAVE_GUARDED` da função `body` (sem descer em funções aninhadas) fora de `save()` aberto, ou na função desbalanceada. */
function guardedOutsideSave(body: ts.Node): ts.CallExpression[] {
  const events: { at: number; kind: 'save' | 'restore' | 'guarded'; call: ts.CallExpression }[] = []
  const visit = (n: ts.Node): void => {
    if (n !== body && isFunctionLike(n)) return
    if (ts.isCallExpression(n)) {
      const name = calledName(n)
      // a ordem é a do NOME chamado: em `doc.save().rect(…).clip()` todas as chamadas começam em `doc`, mas os nomes vêm em ordem
      if (name === 'save' || name === 'restore') events.push({ at: calledAccess(n)!.name.end, kind: name, call: n })
      else if (name !== null && has(SAVE_GUARDED, name)) events.push({ at: calledAccess(n)!.name.end, kind: 'guarded', call: n })
    }
    ts.forEachChild(n, visit)
  }
  visit(body)
  if (!events.some(e => e.kind === 'guarded')) return []
  events.sort((x, y) => x.at - y.at)
  const saves = events.filter(e => e.kind === 'save').length
  const restores = events.filter(e => e.kind === 'restore').length
  const out: ts.CallExpression[] = []
  let depth = 0
  for (const e of events) {
    if (e.kind === 'save') depth++
    else if (e.kind === 'restore') depth--
    else if (depth <= 0 || saves !== restores) out.push(e.call)
  }
  return out
}

/** O que a cerca barra no código (comentários não contam — AST). */
export function pdfFamilyViolations(code: string): FenceViolation[] {
  const sf = parse(code)
  const out: FenceViolation[] = []
  const add = (rule: FenceRule, n: ts.Node): void => {
    out.push(Object.freeze({ rule, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, snippet: n.getText(sf).replace(/\s+/g, ' ').slice(0, 80) }))
  }
  const bodies: ts.Node[] = [sf]
  const visit = (n: ts.Node): void => {
    if (isFunctionLike(n)) bodies.push(n)
    if (ts.isCallExpression(n)) {
      const name = calledName(n)
      // (a) x.text(…) — e x.text.call/apply/bind(…), também embrulhados (`(doc.text as F)(…)`, `(0, doc.text)(…)`, `doc.text!(…)`)
      if (name !== null && has(CALL_BANNED, name)) add('a', n)
      else if (name !== null && ['call', 'apply', 'bind'].includes(name)) {
        const target = unwrapCallee(calledAccess(n)!.expression)
        if (ts.isPropertyAccessExpression(target) && has(CALL_BANNED, target.name.text)) add('a', n)
      }
      // (a) o método como CALLBACK com o próprio dono de `this` (`linhas.forEach(doc.text, doc)` — gate adversarial A3)
      const args = n.arguments.map(unwrapCallee)
      if (args.some(a => ts.isPropertyAccessExpression(a) && has(CALL_BANNED, a.name.text) && ts.isIdentifier(a.expression)
        && args.some(b => ts.isIdentifier(b) && b.text === (a.expression as ts.Identifier).text))) add('a', n)
      // (c) Reflect.get/apply/…(…, 'text') — e Reflect.apply(doc.text, …)
      const reflect = unwrapCallee(n.expression)
      if (ts.isPropertyAccessExpression(reflect) && ts.isIdentifier(reflect.expression) && reflect.expression.text === 'Reflect'
        && args.some(a => (isText(a) && has(NAME_BANNED, a.text)) || (ts.isPropertyAccessExpression(a) && has(CALL_BANNED, a.name.text)))) add('c', n)
    }
    // (a) template marcado: doc.text`x`
    if (ts.isTaggedTemplateExpression(n)) {
      const name = calledName(n)
      if (name !== null && has(CALL_BANNED, name)) add('a', n)
    }
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text
      // (b) qualquer referência às medidas cruas e a `registerFont`
      if (has(PROPERTY_BANNED, name)) add('b', n)
      // `doc.page.write(…)` / `doc.page.content.write(…)`: o que o `addContent` faz por dentro (gate adversarial M1)
      else if (name === 'write' && ts.isPropertyAccessExpression(n.expression) && ['page', 'content'].includes(n.expression.name.text)) add('b', n)
      // (b) `clip` que NÃO é a chamada direta (a chamada é da regra (e))
      else if (name === 'clip' && !isDirectCallee(n)) add('b', n)
    }
    // (b)/(c) desestruturação na declaração E na atribuição: `const { font } = doc`, `const { clip: c } = doc`, `({ font: f } = doc)`,
    // `const { ['font']: f } = doc`; `text`/`list`/`table` só quando a fonte não é resultado de chamada (`bannedKey`)
    const destructured = ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) ? { key: n.propertyName ?? n.name, pattern: n.parent }
      : (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isObjectLiteralExpression(n.parent)
        && ts.isBinaryExpression(n.parent.parent) && n.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.parent.parent.left === n.parent
        ? { key: n.name, pattern: n.parent } : null
    if (destructured) {
      const { key, pattern } = destructured
      const source = destructuringSource(pattern)
      if ((ts.isIdentifier(key) || isText(key)) && bannedKey(key.text, source)) add('b', n)
      else if (ts.isComputedPropertyName(key) && isText(key.expression) && has(NAME_BANNED, key.expression.text)) add('c', n)
    }
    // (c) doc['text'], doc[`font`]
    if (ts.isElementAccessExpression(n) && isText(n.argumentExpression) && has(NAME_BANNED, n.argumentExpression.text)) add('c', n)
    // (c) doc[chave] com chave que não é texto literal: `const k = 'text'; doc[k]('x')` (gate adversarial M1)
    else if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'doc' && !isText(n.argumentExpression)) add('c', n)
    // (d) 'pageAdded' em qualquer lugar
    if (isText(n) && (n.text === 'pageAdded' || n.text === 'addPage')) add('d', n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  for (const body of bodies) for (const call of guardedOutsideSave(body)) add('e', call)
  return out.sort((x, y) => x.line - y.line || x.rule.localeCompare(y.rule))
}
