import { afterEach, describe as group, expect, it, vi } from 'vitest'

import { broadcastMessage, describe, InspectorSocket, joinMessage } from './realtime'

group('realtime messages', () => {
  it('joins with the channel config', () => {
    expect(joinMessage({ name: 'room-1', private: true, changes: { schema: 'public', table: 'todos' } }, '1')).toEqual({
      topic: 'realtime:room-1',
      event: 'phx_join',
      payload: {
        config: {
          broadcast: { self: true, ack: false },
          presence: { key: '' },
          postgres_changes: [{ event: '*', schema: 'public', table: 'todos' }],
          private: true,
        },
      },
      ref: '1',
    })
    const all = joinMessage({ name: 'x', private: false, changes: { schema: 'public', table: '*' } }, '2')
    expect((all.payload as { config: { postgres_changes: unknown[] } }).config.postgres_changes).toEqual([{ event: '*', schema: 'public' }])
  })

  it('sends broadcasts', () => {
    expect(broadcastMessage('room-1', 'ping', { a: 1 }, '3')).toEqual({
      topic: 'realtime:room-1',
      event: 'broadcast',
      payload: { type: 'broadcast', event: 'ping', payload: { a: 1 } },
      ref: '3',
    })
  })

  it('describes what arrives and drops heartbeats', () => {
    expect(describe({ topic: 'phoenix', event: 'phx_reply', payload: {}, ref: '9' }, 1, 0)).toBeNull()
    expect(
      describe({ topic: 'realtime:r', event: 'postgres_changes', payload: { data: { type: 'INSERT', schema: 'public', table: 'todos', record: {} } }, ref: null }, 2, 0)
    ).toMatchObject({ kind: 'postgres', title: 'INSERT on public.todos' })
    expect(describe({ topic: 'realtime:r', event: 'system', payload: { status: 'error', message: 'nope' }, ref: null }, 3, 0)).toMatchObject({
      kind: 'error',
      title: 'nope',
    })
    expect(describe({ topic: 'realtime:r', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: '1' }, 4, 0)).toMatchObject({ kind: 'reply' })
  })
})

group('InspectorSocket state', () => {
  class FakeSocket {
    static OPEN = 1
    static last: FakeSocket
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onclose: ((e: { reason: string }) => void) | null = null
    constructor() {
      FakeSocket.last = this
    }
    send() {}
    close() {}
  }
  afterEach(() => vi.unstubAllGlobals())

  const open = () => {
    vi.stubGlobal('WebSocket', FakeSocket)
    const states: string[] = []
    const s = new InspectorSocket('ws://x', { name: 'r', private: false, changes: null }, () => {}, (st, detail) => states.push(detail ? `${st}: ${detail}` : st))
    s.open()
    return { s, states, ws: FakeSocket.last }
  }

  it('keeps an error showing when the failed socket closes', () => {
    const { states, ws } = open()
    ws.onerror!()
    ws.onclose!({ reason: '' })
    expect(states.at(-1)).toMatch(/^error: /)
  })

  it('reports nothing after the caller closes it', () => {
    const { s, states, ws } = open()
    const handler = ws.onclose
    s.close()
    expect(ws.onclose).toBeNull()
    handler?.call(ws, { reason: '' })
    expect(states).toEqual(['connecting'])
  })
})
