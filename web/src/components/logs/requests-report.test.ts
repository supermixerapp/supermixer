import { describe, expect, it } from 'vitest'

import { hourlySeries } from './requests-report'

describe('hourlySeries', () => {
  it('fills every hour of the window, zero where nothing was logged', () => {
    const start = Date.UTC(2026, 0, 1, 10)
    const s = hourlySeries([{ hour: '2026-01-01T11:00:00Z', count: 5, errors: 1 }], start, 3)
    expect(s.map((h) => [new Date(h.at).toISOString(), h.count, h.errors])).toEqual([
      ['2026-01-01T10:00:00.000Z', 0, 0],
      ['2026-01-01T11:00:00.000Z', 5, 1],
      ['2026-01-01T12:00:00.000Z', 0, 0],
    ])
  })
})
