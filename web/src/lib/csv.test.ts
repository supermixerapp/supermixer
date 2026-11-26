import { describe, expect, it } from 'vitest'

import { toCsv } from './csv'

describe('toCsv', () => {
  it('quotes cells with commas, quotes and line breaks', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line\nbreak', null]])).toBe(
      'a,b\n"x,y","say ""hi"""\n"line\nbreak",'
    )
  })

  it('keeps names that look like formulas as text when guarded', () => {
    const rows = [['=HYPERLINK("x")', '+1', '-2', '@a', 'plain', -3]]
    expect(toCsv(['n'], rows, { guard: true })).toBe(`n\n"'=HYPERLINK(""x"")",'+1,'-2,'@a,plain,-3`)
    expect(toCsv(['n'], [['=1']])).toBe('n\n=1')
  })
})
