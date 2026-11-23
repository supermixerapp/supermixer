/*
 * Regenerates src/lib/pg/wrapper-types.json from Supabase Studio's wrapper
 * definitions (apps/studio/components/interfaces/Integrations/Wrappers/
 * Wrappers.constants.ts, Apache-2.0; see NOTICE).
 *
 *   node scripts/import-wrappers.mjs <path to Wrappers.constants.ts> <studio commit>
 *
 * The file is parsed, never run: only literal values (strings, numbers,
 * booleans, arrays, objects) and the file's own constants are read, and
 * anything else stops the import. Only the fields Supermixer uses are kept,
 * and types Supermixer's form can't set up are left out (see usable below).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const [source, commit] = process.argv.slice(2)
if (!source || !/^[0-9a-f]{7,40}$/.test(commit ?? '')) {
  console.error('usage: node scripts/import-wrappers.mjs <Wrappers.constants.ts> <studio commit sha>')
  process.exit(2)
}

const file = ts.createSourceFile(source, readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true)

// Template parts Studio fills from its app config; icons aren't used.
const TEMPLATE_VALUES = { BASE_PATH: '', DOCS_URL: 'https://supabase.com/docs' }
const IGNORED_CALLS = new Set(['resolveLightIconSrc'])

const declarations = new Map()
for (const st of file.statements) {
  if (!ts.isVariableStatement(st)) continue
  for (const d of st.declarationList.declarations) {
    if (ts.isIdentifier(d.name) && d.initializer) declarations.set(d.name.text, d.initializer)
  }
}

function fail(node, why) {
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart())
  throw new Error(`${source}:${line + 1}:${character + 1}: ${why}: ${node.getText().slice(0, 80)}`)
}

const cache = new Map()
function constant(name, node) {
  if (name in TEMPLATE_VALUES) return TEMPLATE_VALUES[name]
  if (!declarations.has(name)) fail(node, `unknown name ${name}`)
  if (!cache.has(name)) cache.set(name, value(declarations.get(name)))
  return cache.get(name)
}

function propName(n) {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text
  fail(n, 'computed property name')
}

function value(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isNumericLiteral(n)) return Number(n.text)
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false
  if (n.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) return value(n.expression)
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(value)
  if (ts.isObjectLiteralExpression(n)) {
    const out = {}
    for (const p of n.properties) {
      if (ts.isPropertyAssignment(p)) out[propName(p.name)] = value(p.initializer)
      else if (ts.isSpreadAssignment(p)) Object.assign(out, value(p.expression))
      else fail(p, 'unsupported property')
    }
    return out
  }
  if (ts.isTemplateExpression(n)) {
    let s = n.head.text
    for (const span of n.templateSpans) s += String(value(span.expression)) + span.literal.text
    return s
  }
  if (ts.isIdentifier(n)) return constant(n.text, n)
  if (ts.isPropertyAccessExpression(n)) {
    const obj = value(n.expression)
    if (obj === null || typeof obj !== 'object' || !(n.name.text in obj)) fail(n, 'unknown property')
    return obj[n.name.text]
  }
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && IGNORED_CALLS.has(n.expression.text)) return ''
  fail(n, 'not a literal value')
}

if (!declarations.has('WRAPPERS')) throw new Error(`${source}: no WRAPPERS constant`)
const WRAPPERS = value(declarations.get('WRAPPERS'))

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
const OPTION_KEYS = ['name', 'label', 'description', 'required', 'encrypted', 'secureEntry', 'hidden', 'isTextArea', 'urlHelper', 'defaultValue', 'readOnly']

// Left out: types Studio gives a custom form (Iceberg), and types with no
// table templates and no schema to import (S3 Vectors), which would create a
// server with nothing to query.
const usable = (w) => !w.customComponent && (w.tables.length > 0 || !!w.sourceSchemaOption)

const wrappers = WRAPPERS.filter(usable).map((w) => ({
  ...pick(w, ['name', 'label', 'description', 'handlerName', 'validatorName', 'docsUrl', 'minimumExtensionVersion', 'canTargetSchema']),
  ...(w.sourceSchemaOption && { sourceSchemaOption: pick(w.sourceSchemaOption, OPTION_KEYS) }),
  categories: w.categories ?? [],
  server: { options: w.server.options.map((o) => pick(o, OPTION_KEYS)) },
  tables: w.tables.map((t) => ({
    ...pick(t, ['label', 'description', 'availableColumns']),
    options: t.options.map((o) => pick(o, ['name', 'label', 'placeholder', 'defaultValue', 'editable', 'required', 'type', 'options'])),
  })),
}))

const out = join(dirname(fileURLToPath(import.meta.url)), '../src/lib/pg/wrapper-types.json')
writeFileSync(out, JSON.stringify({ source: `supabase/supabase@${commit}`, wrappers }, null, 1) + '\n')
console.log(`${wrappers.length} wrappers → ${out}`)
