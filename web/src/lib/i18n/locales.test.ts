/*
 * Keeps the five languages in step: every language has exactly English's
 * namespaces and keys, no empty text, the same {{variables}} and <tags>,
 * and the plural forms its grammar needs.
 */
import { describe, expect, test } from 'vitest'

import { LANGUAGES } from '.'
import types from './resources.gen.d.ts?raw'

type Tree = { [key: string]: string | Tree }

const files = import.meta.glob<{ default: Tree }>('../../locales/*/*.json', { eager: true })

function catalogs(lng: string) {
  const out: Record<string, Tree> = {}
  for (const [path, mod] of Object.entries(files)) {
    const m = path.match(/locales\/([^/]+)\/([^/]+)\.json$/)
    if (m && m[1] === lng) out[m[2]!] = mod.default
  }
  return out
}

function flatten(tree: Tree, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out[key] = v
    else flatten(v, key, out)
  }
  return out
}

const PLURALS = ['_zero', '_one', '_two', '_few', '_many', '_other']
const pluralBase = (key: string) => {
  const s = PLURALS.find((p) => key.endsWith(p))
  return s ? key.slice(0, -s.length) : null
}

const vars = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort()
const tags = (s: string) => [...s.matchAll(/<\/?([\w-]+)\s*\/?>/g)].map((m) => m[0].replace(/\s/g, '')).sort()

const english = catalogs('en')
const englishKeys = Object.fromEntries(Object.entries(english).map(([ns, tree]) => [ns, flatten(tree)]))

describe.each(LANGUAGES.map((l) => l.code))('%s', (lng) => {
  const mine = catalogs(lng)
  const forms = new Intl.PluralRules(lng).resolvedOptions().pluralCategories

  test('has every namespace, and no others', () => {
    expect(Object.keys(mine).sort()).toEqual(Object.keys(english).sort())
  })

  for (const ns of Object.keys(english)) {
    test(`${ns}: same keys, text, variables, tags and plural forms as English`, () => {
      const en = englishKeys[ns]!
      const keys = flatten(mine[ns] ?? {})
      const problems: string[] = []

      // Plural keys are compared by their base: Japanese has only _other,
      // English _one and _other, and so on.
      const bases = (k: Record<string, string>) =>
        new Set(Object.keys(k).map((key) => pluralBase(key) ?? key))
      for (const b of bases(en)) if (!bases(keys).has(b)) problems.push(`missing ${b}`)
      for (const b of bases(keys)) if (!bases(en).has(b)) problems.push(`not in English: ${b}`)

      for (const [key, text] of Object.entries(keys)) {
        if (!text.trim()) problems.push(`empty: ${key}`)
        const base = pluralBase(key)
        const source = en[key] ?? (base ? en[`${base}_other`] : undefined)
        if (source === undefined) continue
        if (vars(text).join() !== vars(source).join()) problems.push(`variables differ in ${key}: [${vars(text)}] vs [${vars(source)}]`)
        if (tags(text).join() !== tags(source).join()) problems.push(`tags differ in ${key}: [${tags(text)}] vs [${tags(source)}]`)
      }

      // Each plural in English has every form this language's grammar
      // uses (Intl.PluralRules): ja other; en and de one, other; fr and es
      // one, many, other.
      const plurals = new Set(Object.keys(en).map(pluralBase).filter((b): b is string => !!b))
      for (const b of plurals) for (const f of forms) if (keys[`${b}_${f}`] === undefined) problems.push(`missing ${b}_${f}`)
      expect(problems).toEqual([])
    })
  }
})

test('the key types list every namespace (pnpm generate:i18n)', () => {
  const declared = Object.keys(import.meta.glob('../../locales/en/*.json'))
    .map((p) => p.slice(p.lastIndexOf('/') + 1, -'.json'.length))
    .every((ns) => types.includes(`${JSON.stringify(ns)}: typeof`))
  expect(declared).toBe(true)
})

test('no key is both plain text and a plural (t() without count would miss it)', () => {
  const clashes: string[] = []
  for (const [ns, keys] of Object.entries(englishKeys))
    for (const key of Object.keys(keys)) if (keys[`${key}_one`] !== undefined || keys[`${key}_other`] !== undefined) clashes.push(`${ns}:${key}`)
  expect(clashes).toEqual([])
})
