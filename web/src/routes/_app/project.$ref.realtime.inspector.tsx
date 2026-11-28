import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { DatabasePage, SchemaPicker, useCanChange } from '@/components/database/catalog-page'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { FormField } from '@/components/ui/form-field'
import { Input, Textarea } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { gatewaySocketUrl } from '@/lib/api/gateway'
import { TABLES_SQL, type TableListRow } from '@/lib/pg/catalog'
import { isJsonObject } from '@/lib/pg/cron'
import { usePg } from '@/lib/pg/run'
import { describe, InspectorSocket, type ChannelOptions, type LogEntry, type SocketState } from '@/lib/realtime'
import { cn } from '@/lib/utils'
import { localized, t as tr, Trans, language } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/realtime/inspector')({
  component: InspectorPage,
})

const MAX_ENTRIES = 500
const NONE = '__none__'

const PUBLISHED_SQL = `
select c.relname as name from pg_publication_tables t join pg_class c on c.relname = t.tablename
join pg_namespace n on n.oid = c.relnamespace and n.nspname = t.schemaname
where t.pubname = 'supabase_realtime' and t.schemaname = $1`

const STATE_LABEL = localized((): Record<SocketState, string> => ({
  idle: tr('realtime:realtimeInspector.notConnected'),
  connecting: tr('realtime:realtimeInspector.connecting'),
  joined: tr('realtime:realtimeInspector.listening'),
  closed: tr('realtime:realtimeInspector.disconnected'),
  error: tr('realtime:realtimeInspector.error'),
}))

function InspectorPage() {
  const { ref } = Route.useParams()
  const canUse = useCanChange()
  const [channel, setChannel] = useState('room-1')
  const [isPrivate, setPrivate] = useState(false)
  const [schema, setSchema] = useState('public')
  const [table, setTable] = useState('*')
  const [state, setState] = useState<SocketState>('idle')
  const [detail, setDetail] = useState<string | undefined>()
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [open, setOpen] = useState<number | null>(null)
  const [event, setEvent] = useState('ping')
  const [payload, setPayload] = useState('{"hello": "world"}')
  const socket = useRef<InspectorSocket | null>(null)
  const nextId = useRef(0)

  const tables = usePg<TableListRow>(ref, ['tables', schema], TABLES_SQL, [schema])
  const published = usePg<{ name: string }>(ref, ['realtime-published', schema], PUBLISHED_SQL, [schema])
  const publishedNames = new Set((published.data ?? []).map((p) => p.name))
  const watching = table !== NONE
  const notPublished = watching && published.data && (table === '*' ? publishedNames.size === 0 : !publishedNames.has(table))

  useEffect(() => () => socket.current?.close(), [])

  const connect = () => {
    socket.current?.close()
    setEntries([])
    setDetail(undefined)
    const options: ChannelOptions = { name: channel.trim(), private: isPrivate, changes: watching ? { schema, table } : null }
    const s = new InspectorSocket(
      gatewaySocketUrl(ref, 'realtime/v1/websocket', { vsn: '1.0.0' }),
      options,
      (m) => {
        const entry = describe(m, nextId.current++, Date.now())
        if (entry) setEntries((e) => [entry, ...e].slice(0, MAX_ENTRIES))
      },
      (st, d) => {
        setState(st)
        setDetail(d)
      }
    )
    socket.current = s
    s.open()
  }
  const disconnect = () => {
    socket.current?.close()
    socket.current = null
    setState('idle')
  }
  const live = state === 'connecting' || state === 'joined'
  const payloadOk = isJsonObject(payload) && payload.trim() !== ''

  return (
    <DatabasePage
      title={tr('realtime:realtimeInspector.realtimeInspector')}
      description={tr('realtime:realtimeInspector.joinAChannelToWatchBroadcast')}
    >
      {!canUse && <Alert title={tr('realtime:realtimeInspector.watchingRealtimeNeedsARoleThat')}>{tr('realtime:realtimeInspector.theSocketCanSendAsWell')}</Alert>}
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <FormField label={tr('realtime:realtimeInspector.channel')} htmlFor="rt-channel">
              <Input id="rt-channel" autoComplete="off" disabled={live} value={channel} onChange={(e) => setChannel(e.target.value)} />
            </FormField>
          </div>
          <FormField label={tr('realtime:realtimeInspector.postgresChanges')}>
            <div className="flex gap-2">
              <SchemaPicker projectRef={ref} value={schema} onChange={(s) => !live && (setSchema(s), setTable('*'))} />
              <Select value={table} onValueChange={setTable} disabled={live}>
                <SelectTrigger size="tiny" className="w-48" aria-label={tr('realtime:realtimeInspector.table')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{tr('realtime:realtimeInspector.donTListen')}</SelectItem>
                  <SelectItem value="*">{tr('realtime:realtimeInspector.allTables')}</SelectItem>
                  {(tables.data ?? [])
                    .filter((t) => t.kind === 'r' || t.kind === 'p')
                    .map((t) => (
                      <SelectItem key={t.id} value={t.name}>
                        {t.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </FormField>
          <label className="flex h-[34px] items-center gap-2 text-sm">
            <Trans i18nKey="realtime:realtimeInspector.privateChannel" components={{ checkbox: <Checkbox checked={isPrivate} disabled={live} onCheckedChange={(c) => setPrivate(c === true)} /> }} />
          </label>
          <div className="ml-auto flex items-center gap-3">
            <Badge variant={state === 'joined' ? 'success' : state === 'error' ? 'destructive' : 'default'}>{STATE_LABEL()[state]}</Badge>
            {live ? (
              <Button variant="default" onClick={disconnect}>
                {tr('realtime:realtimeInspector.leave')}
              </Button>
            ) : (
              <PermissionButton allowed={canUse} action={tr('realtime:realtimeInspector.watchRealtime')} variant="primary" disabled={!channel.trim()} onClick={connect}>
                {tr('realtime:realtimeInspector.joinChannel')}
              </PermissionButton>
            )}
          </div>
        </div>
        {detail && <p className="text-xs text-destructive">{detail}</p>}
        {notPublished && (
          <p className="text-xs text-foreground-lighter">
            <Trans
              i18nKey={table === '*' ? 'realtime:realtimeInspector.schemaNotPublished' : 'realtime:realtimeInspector.tableNotPublished'}
              values={{ schema, table }}
              components={{ link: <Link to="/project/$ref/database/publications" params={{ ref }} className="text-foreground underline-offset-2 hover:underline" /> }}
            />
          </p>
        )}
      </Card>
      {state === 'joined' && (
        <Card className="flex flex-wrap items-end gap-3 p-5">
          <div className="w-48">
            <FormField label={tr('realtime:realtimeInspector.broadcastEvent')} htmlFor="rt-event">
              <Input id="rt-event" autoComplete="off" value={event} onChange={(e) => setEvent(e.target.value)} />
            </FormField>
          </div>
          <div className="min-w-64 flex-1">
            <FormField label={tr('realtime:realtimeInspector.payload')} htmlFor="rt-payload" description={payloadOk ? undefined : <span className="text-destructive">{tr('realtime:realtimeInspector.mustBeAJsonObject')}</span>}>
              <Textarea id="rt-payload" rows={1} className="font-mono text-xs" value={payload} onChange={(e) => setPayload(e.target.value)} />
            </FormField>
          </div>
          <Button variant="default" disabled={!event.trim() || !payloadOk} onClick={() => socket.current?.broadcast(event.trim(), JSON.parse(payload))}>
            {tr('realtime:realtimeInspector.sendBroadcast')}
          </Button>
        </Card>
      )}
      <Card>
        <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-foreground-lighter">
          <span>
            {tr('realtime:realtimeInspector.messages', { count: entries.length })}
            {entries.length === MAX_ENTRIES && tr('realtime:realtimeInspector.theLatest500')}
          </span>
          <Button variant="text" size="tiny" className="ml-auto" disabled={entries.length === 0} onClick={() => setEntries([])}>
            {tr('realtime:realtimeInspector.clear')}
          </Button>
        </div>
        {entries.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-foreground-lighter">{live ? tr('realtime:realtimeInspector.waitingForMessages') : tr('realtime:realtimeInspector.joinAChannelToSeeMessages')}</p>
        ) : (
          <ul className="max-h-[32rem] divide-y overflow-y-auto">
            {entries.map((e) => (
              <li key={e.id}>
                <button className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-surface-200" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <span className="w-20 shrink-0 font-mono text-xs text-foreground-lighter tabular-nums">{new Date(e.at).toLocaleTimeString(language())}</span>
                  <Badge variant={e.kind === 'error' ? 'destructive' : e.kind === 'postgres' ? 'success' : 'default'}>{e.kind}</Badge>
                  <span className={cn('truncate', e.kind === 'error' ? 'text-destructive' : 'text-foreground')}>{e.title}</span>
                </button>
                {open === e.id && (
                  <pre className="overflow-x-auto bg-surface-100 px-4 py-3 font-mono text-xs text-foreground">{JSON.stringify(e.payload, null, 2)}</pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </DatabasePage>
  )
}
