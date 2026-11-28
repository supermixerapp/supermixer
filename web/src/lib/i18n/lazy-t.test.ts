/*
 * The language can change without a reload, so no text may be translated
 * when a module loads: it would stay in the language the page opened in.
 * Lists kept outside components use localized() (see index.ts) instead.
 */
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Every source file of the app, as text.
const SOURCES = import.meta.glob<string>(['../../**/*.{ts,tsx}', '!../../**/*.test.*', '!../../**/*.gen.*', '!../../**/*.d.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
})
// t and tr translate; language() reads the language (e.g. for Intl).
const AT_LOAD = new Set(['t', 'tr', 'language'])

/** Calls to t(), tr() or language() that run when the file loads. */
function loadTimeCalls(file: string, text: string) {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node, inFunction: boolean) => {
    const deferred = inFunction || ts.isFunctionLike(node)
    if (!inFunction && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && AT_LOAD.has(node.expression.text)) {
      const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
      found.push(`${new URL(file, 'file:///src/lib/i18n/').pathname.slice(1)}:${line} ${node.expression.text}()`)
    }
    ts.forEachChild(node, (c) => visit(c, deferred))
  }
  visit(src, false)
  return found
}

describe('translations', () => {
  it('are never made when a module loads', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100)
    expect(Object.entries(SOURCES).flatMap(([file, text]) => loadTimeCalls(file, text))).toEqual([])
  })
})
