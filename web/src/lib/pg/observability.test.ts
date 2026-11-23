import { describe, expect, it } from 'vitest'

import { commitRate, type DatabaseStats } from './observability'

const sample = (at: string, commits: number, rollbacks = 0) => ({ at, commits, rollbacks }) as DatabaseStats

describe('commitRate', () => {
  it('measures transactions per second between samples', () => {
    expect(commitRate(undefined, sample('2026-01-01T00:00:10Z', 100))).toBeNull()
    expect(commitRate(sample('2026-01-01T00:00:00Z', 100), sample('2026-01-01T00:00:10Z', 150, 10))).toBe(6)
    // Statistics were reset in between.
    expect(commitRate(sample('2026-01-01T00:00:00Z', 100), sample('2026-01-01T00:00:10Z', 5))).toBeNull()
  })
})
