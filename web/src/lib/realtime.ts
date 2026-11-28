import { t } from '@/lib/i18n'

/*
 * A small client for Supabase Realtime's Phoenix socket (protocol 1.0.0:
 * JSON objects {topic, event, payload, ref}), for the Realtime Inspector.
 * The socket goes through Supermixer's gateway, which adds the stack's key.
 */

export interface ChannelOptions {
  /** Channel name; the topic is realtime:<name>. */
  name: string
  /** Use Realtime Authorization (policies on realtime.messages). */
  private: boolean
  /** Postgres changes to listen to: a schema, and a table or '*' for all. */
  changes: { schema: string; table: string } | null
}

export interface Message {
  topic: string
  event: string
  payload: unknown
  ref: string | null
}

export function joinMessage(o: ChannelOptions, ref: string): Message {
  return {
    topic: `realtime:${o.name}`,
    event: 'phx_join',
    payload: {
      config: {
        broadcast: { self: true, ack: false },
        presence: { key: '' },
        postgres_changes: o.changes ? [{ event: '*', schema: o.changes.schema, ...(o.changes.table !== '*' && { table: o.changes.table }) }] : [],
        private: o.private,
      },
    },
    ref,
  }
}

export function broadcastMessage(channel: string, event: string, payload: unknown, ref: string): Message {
  return { topic: `realtime:${channel}`, event: 'broadcast', payload: { type: 'broadcast', event, payload }, ref }
}

/** The inspector's view of an incoming message. */
export interface LogEntry {
  id: number
  at: number
  kind: 'postgres' | 'broadcast' | 'presence' | 'system' | 'reply' | 'error'
  title: string
  payload: unknown
}

/** Turn a socket message into a log line; heartbeats and other noise give null. */
export function describe(m: Message, id: number, at: number): LogEntry | null {
  if (m.topic === 'phoenix') return null
  const p = (m.payload ?? {}) as Record<string, unknown>
  switch (m.event) {
    case 'postgres_changes': {
      const d = (p.data ?? {}) as Record<string, unknown>
      return { id, at, kind: 'postgres', title: t('realtime:realtime.postgresChange', { type: String(d.type ?? t('realtime:realtime.change')), table: `${String(d.schema ?? '')}.${String(d.table ?? '')}` }), payload: d }
    }
    case 'broadcast':
      return { id, at, kind: 'broadcast', title: `Broadcast: ${String(p.event ?? '')}`, payload: p.payload }
    case 'presence_state':
    case 'presence_diff':
      return { id, at, kind: 'presence', title: m.event === 'presence_state' ? t('realtime:realtime.presenceState') : t('realtime:realtime.presenceChange'), payload: p }
    case 'system':
      return { id, at, kind: p.status === 'error' ? 'error' : 'system', title: String(p.message ?? t('realtime:realtime.systemMessage')), payload: p }
    case 'phx_reply':
      return p.status === 'ok' ? { id, at, kind: 'reply', title: t('realtime:realtime.joined'), payload: p.response } : { id, at, kind: 'error', title: t('realtime:realtime.joinRefused'), payload: p.response }
    case 'phx_error':
      return { id, at, kind: 'error', title: t('realtime:realtime.channelError'), payload: p }
    case 'phx_close':
      return { id, at, kind: 'system', title: t('realtime:realtime.channelClosed'), payload: p }
    default:
      return { id, at, kind: 'system', title: m.event, payload: p }
  }
}

export type SocketState = 'idle' | 'connecting' | 'joined' | 'closed' | 'error'

/** One socket with one channel, heartbeating every 25 s as Phoenix expects. */
export class InspectorSocket {
  private ws: WebSocket | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private ref = 0

  constructor(
    private readonly url: string,
    private readonly options: ChannelOptions,
    private readonly onMessage: (m: Message) => void,
    private readonly onState: (s: SocketState, detail?: string) => void
  ) {}

  open() {
    this.onState('connecting')
    const ws = new WebSocket(this.url)
    this.ws = ws
    // Events from a socket this object has let go of (Leave, rejoin) are stale.
    const current = () => this.ws === ws
    ws.onopen = () => {
      if (!current()) return
      this.send(joinMessage(this.options, this.nextRef()))
      this.heartbeat = setInterval(() => this.send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: this.nextRef() }), 25_000)
    }
    ws.onmessage = (e) => {
      if (!current()) return
      let m: Message
      try {
        m = JSON.parse(String(e.data)) as Message
      } catch {
        return
      }
      if (m.event === 'phx_reply' && m.topic.startsWith('realtime:')) {
        const status = (m.payload as { status?: string } | null)?.status
        this.onState(status === 'ok' ? 'joined' : 'error')
      }
      this.onMessage(m)
    }
    let failed = false
    ws.onerror = () => {
      if (!current()) return
      failed = true
      this.onState('error', t('realtime:realtime.theSocketFailedCheckThatThe'))
    }
    ws.onclose = (e) => {
      if (!current()) return
      this.stopHeartbeat()
      // A failed socket closes right after its error; keep the error showing.
      if (!failed) this.onState('closed', e.reason || undefined)
    }
  }

  broadcast(event: string, payload: unknown) {
    this.send(broadcastMessage(this.options.name, event, payload, this.nextRef()))
  }

  /** Close without reporting anything: the caller has moved on (Leave, rejoin). */
  close() {
    this.stopHeartbeat()
    const ws = this.ws
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      ws.close()
    }
    this.ws = null
  }

  private send(m: Message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m))
  }

  private nextRef() {
    this.ref += 1
    return String(this.ref)
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }
}
