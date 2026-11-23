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

  it('wraps a tall layer into more columns, still left of its dependents', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, columns: 8 }))
    const pos = layoutGraph([{ id: 'users', columns: 2 }, ...many], many.map((m) => ({ from: m.id, to: 'users' })))
    const xs = new Set(many.map((m) => pos[m.id]!.x))
    expect(xs.size).toBeGreaterThan(1)
    for (const m of many) expect(pos[m.id]!.x).toBeGreaterThan(pos.users!.x)
    expect(Math.max(...many.map((m) => pos[m.id]!.y))).toBeLessThan(1400)
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
