import { describe, expect, it } from 'vitest'

import { parseEnv } from './env'

describe('parseEnv', () => {
  it('reads .env lines', () => {
    expect(
      parseEnv('# comment\nA=1\nexport B = "two words"\nC=\'raw $x\'\nD=plain # trailing\nE="line\\nbreak"\n\nnot a line')
    ).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: 'two words' },
      { name: 'C', value: 'raw $x' },
      { name: 'D', value: 'plain' },
      { name: 'E', value: 'line\nbreak' },
    ])
  })

  it('decodes escapes in one pass', () => {
    expect(parseEnv('P="C:\\\\new"\nT="a\\tb"\nQ="say \\"hi\\""')).toEqual([
      { name: 'P', value: 'C:\\new' },
      { name: 'T', value: 'a\tb' },
      { name: 'Q', value: 'say "hi"' },
    ])
  })

  it('leaves a plain name alone', () => {
    expect(parseEnv('STRIPE_KEY')).toEqual([])
  })
})
