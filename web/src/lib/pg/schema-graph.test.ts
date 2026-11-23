import { describe, expect, it } from 'vitest'

import { layoutGraph, NODE_WIDTH } from './schema-graph'

describe('layoutGraph', () => {
  it('puts referenced tables to the left of the tables that use them', () => {
    const pos = layoutGraph(
      [
        { id: 'orders', columns: 3 },
        { id: 'users', columns: 2 },
        { id: 'items', columns: 2 },
        { id: 'loose', columns: 1 },
      ],
      [
        { from: 'orders', to: 'users' },
        { from: 'items', to: 'orders' },
      ]
    )
    expect(pos.users!.x).toBe(0)
    expect(pos.orders!.x).toBeGreaterThan(pos.users!.x)
    expect(pos.items!.x).toBeGreaterThan(pos.orders!.x)
    expect(pos.loose!.x).toBeGreaterThan(pos.items!.x + NODE_WIDTH - 1)
  })

  it('survives cycles and self references', () => {
    const pos = layoutGraph(
      [
        { id: 'a', columns: 1 },
        { id: 'b', columns: 1 },
      ],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
        { from: 'a', to: 'a' },
      ]
    )
    expect(Object.keys(pos)).toHaveLength(2)
  })
})
