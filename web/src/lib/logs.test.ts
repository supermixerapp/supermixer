import { describe, expect, it } from 'vitest'

import { levelOf, requestOf, type LogEntry } from './logs'

const entry = (message: string, metadata: Record<string, unknown> = {}): LogEntry => ({ id: '1', timestamp: '2026-01-01T00:00:00Z', message, metadata })

describe('log entries', () => {
  it('reads gateway requests', () => {
    expect(requestOf(entry('…', { request: { method: 'GET', path: '/rest/v1/todos' }, response: { status_code: 200 } }))).toEqual({
      method: 'GET',
      path: '/rest/v1/todos',
      status: 200,
    })
    expect(requestOf(entry('plain'))).toBeNull()
  })

  it('finds levels', () => {
    expect(levelOf(entry('x', { level: 'INFO' }))).toBe('info')
    expect(levelOf(entry('16:00:20.335 [error] boom'))).toBe('error')
    expect(levelOf(entry('nothing here'))).toBeNull()
  })
})
