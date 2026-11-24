import { describe, expect, it } from 'vitest'

import { joinBytes, splitBytes } from './byte-units'

describe('byte units', () => {
  it('shows a size exactly, in the largest unit that keeps it whole', () => {
    expect(splitBytes(50 << 20)).toEqual({ amount: '50', unit: 'MB' })
    expect(splitBytes(2 * (1 << 30))).toEqual({ amount: '2', unit: 'GB' })
    expect(splitBytes(1024)).toEqual({ amount: '1', unit: 'KB' })
    expect(splitBytes(1293943)).toEqual({ amount: '1293943', unit: 'bytes' })
  })

  it('turns a shown size back into the same bytes', () => {
    for (const n of [1024, 1293943, 50 << 20, 1536 << 10, 500 * (1 << 30)]) {
      const { amount, unit } = splitBytes(n)
      expect(joinBytes(amount, unit)).toBe(n)
    }
  })

  it('reads typed amounts', () => {
    expect(joinBytes('1.5', 'MB')).toBe(1572864)
    expect(joinBytes('', 'MB')).toBeNaN()
    expect(joinBytes('abc', 'MB')).toBeNaN()
  })
})
