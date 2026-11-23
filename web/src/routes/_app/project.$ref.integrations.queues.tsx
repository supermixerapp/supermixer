import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { CatalogTable, useCanChange, useDdl } from '@/components/database/catalog-page'
import { AddIcon, RefreshIcon } from '@/components/icons'
import { IntegrationPage, useExtension } from '@/components/integrations/integration-page'
import { PermissionButton } from '@/components/permission-button'
import { EditorSheet, SqlPreview } from '@/components/table-editor/sheets'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input, Textarea } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { relativeTime } from '@/lib/auth-users'
import { isJsonObject } from '@/lib/pg/cron'
import {
  archiveMessage,
  createQueue,
  deleteMessage,
  dropQueue,
  purgeQueue,
  QUEUES_SQL,
  queueMessagesSql,
  queueNameProblem,
  sendMessage,
  type QueueMessage,
  type QueueRow,
  type QueueType,
} from '@/lib/pg/queues'
import { pgQuery } from '@/lib/pg/run'

export const Route = createFileRoute('/_app/project/$ref/integrations/queues')({
  component: QueuesPage,
})

function QueuesPage() {
  const { ref } = Route.useParams()
  const ext = useExtension(ref, 'pgmq')
  const queues = useQuery({ ...pgQuery<QueueRow>(ref, ['queues'], QUEUES_SQL), enabled: !!ext.state?.installed_version })
  const canChange = useCanChange()
  const ddl = useDdl(ref)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  return (
    <IntegrationPage
      projectRef={ref}
      title="Queues"
      description="Durable message queues in Postgres with pgmq: send, read and archive messages from SQL or the API."
      extension={{ name: 'pgmq', schema: null }}
      about="Creates the pgmq schema. Each queue becomes a table of messages, plus an archive table."
      actions={
        <>
          <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={queues.isFetching && !queues.isPending} onClick={() => void queues.refetch()}>
            Refresh
          </Button>
          <PermissionButton allowed={canChange} action="create queues" variant="primary" icon={<AddIcon />} onClick={() => setCreating(true)}>
            Create queue
          </PermissionButton>
        </>
      }
    >
      <CatalogTable
        rows={queues.data}
        loading={queues.isPending}
        error={queues.error}
        rowKey={(q) => q.name}
        empty="No queues yet"
        columns={[
          {
            header: 'Name',
            cell: (q) => (
              <button className="flex items-center gap-2 text-left text-foreground underline-offset-2 hover:underline" onClick={() => setOpen(q.name)}>
                {q.name}
                {q.is_unlogged && <Badge>Unlogged</Badge>}
                {q.is_partitioned && <Badge>Partitioned</Badge>}
              </button>
            ),
          },
          { header: 'Messages', className: 'text-right', cell: (q) => <span className="tabular-nums text-foreground-light">{q.length.toLocaleString()}</span> },
          {
            header: 'Oldest message',
            cell: (q) => <span className="text-foreground-light">{q.oldest_age === null ? '—' : age(q.oldest_age)}</span>,
          },
          { header: 'Sent in total', className: 'text-right', cell: (q) => <span className="tabular-nums text-foreground-light">{q.total.toLocaleString()}</span> },
          { header: 'Created', cell: (q) => <span className="text-foreground-light">{relativeTime(q.created_at)}</span> },
        ]}
        actions={[
          { label: 'Open', onSelect: (q) => setOpen(q.name) },
          {
            label: 'Purge messages',
            hidden: () => !canChange,
            confirm: (q) => ({ title: `Purge ${q.name}?`, description: `Deletes all ${q.length.toLocaleString()} messages waiting in it. The archive is kept.` }),
            onSelect: (q) => ddl.mutate({ sql: purgeQueue(q.name), done: `Purged ${q.name}` }),
          },
          {
            label: 'Delete queue',
            hidden: () => !canChange,
            confirm: (q) => ({
              title: `Delete queue ${q.name}?`,
              description: 'Drops the queue, its messages and its archive. This can’t be undone.',
              confirmText: q.name,
            }),
            onSelect: (q) => ddl.mutate({ sql: dropQueue(q.name), done: `Deleted ${q.name}` }),
          },
        ]}
      />
      {creating && <CreateQueueSheet projectRef={ref} onClose={() => setCreating(false)} />}
      {open && <QueueSheet projectRef={ref} queue={open} canChange={canChange} onClose={() => setOpen(null)} />}
    </IntegrationPage>
  )
}

function age(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`
  return `${(seconds / 86_400).toFixed(1)} days`
}

function CreateQueueSheet({ projectRef, onClose }: { projectRef: string; onClose: () => void }) {
  const ddl = useDdl(projectRef)
  const [name, setName] = useState('')
  const [type, setType] = useState<QueueType>('basic')
  const problem = queueNameProblem(name)
  const sql = problem ? '' : createQueue(name, type)
  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="Create a queue"
      error={ddl.error}
      submitLabel="Create queue"
      submitting={ddl.isPending}
      disabled={!!problem}
      onSubmit={() => ddl.mutate({ sql, done: `Created ${name}` }, { onSuccess: onClose })}
    >
      <FormField label="Name" htmlFor="queue-name" description={problem && name ? <span className="text-destructive">{problem}</span> : "Can't be changed later."}>
        <Input id="queue-name" autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} placeholder="emails" />
      </FormField>
      <FormField
        label="Type"
        description={
          type === 'unlogged'
            ? 'Faster, but messages are lost if Postgres crashes, and not copied to replicas.'
            : 'Messages are written to the WAL and survive crashes.'
        }
      >
        <Select value={type} onValueChange={(v) => setType(v as QueueType)}>
          <SelectTrigger aria-label="Queue type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="basic">Basic</SelectItem>
            <SelectItem value="unlogged">Unlogged</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
      {sql && <SqlPreview sql={sql} />}
    </EditorSheet>
  )
}

function QueueSheet({ projectRef, queue, canChange, onClose }: { projectRef: string; queue: string; canChange: boolean; onClose: () => void }) {
  const [view, setView] = useState<'queue' | 'archive'>('queue')
  const messages = useQuery(pgQuery<QueueMessage>(projectRef, ['queue-messages', queue, view], queueMessagesSql(queue, view === 'archive')))
  const ddl = useDdl(projectRef)
  const [json, setJson] = useState('{\n  "hello": "world"\n}')
  const [delay, setDelay] = useState('0')
  const jsonOk = json.trim() !== '' && isJsonObject(json)

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="xl" className="flex flex-col">
        <SheetHeader>
          <SheetTitle>{queue}</SheetTitle>
          <SheetDescription>The first 100 messages, oldest first. Viewing them here doesn&apos;t read or hide them.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          {canChange && (
            <SheetSection className="flex flex-col gap-3 border-b">
              <FormField label="Send a message" htmlFor="queue-message" description={jsonOk ? 'A JSON object.' : <span className="text-destructive">Must be a JSON object</span>}>
                <Textarea id="queue-message" rows={4} className="font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} />
              </FormField>
              <div className="flex items-end gap-2">
                <FormField label="Delay (seconds)" htmlFor="queue-delay">
                  <Input id="queue-delay" inputMode="numeric" className="w-32" value={delay} onChange={(e) => setDelay(e.target.value.replace(/\D/g, ''))} />
                </FormField>
                <Button
                  variant="primary"
                  disabled={!jsonOk}
                  loading={ddl.isPending}
                  onClick={() => ddl.mutate({ sql: sendMessage(queue, json, Number(delay) || 0), done: `Sent to ${queue}` })}
                >
                  Send message
                </Button>
              </div>
            </SheetSection>
          )}
          <SheetSection className="flex flex-col gap-3">
            <Tabs value={view} onValueChange={(v) => setView(v as 'queue' | 'archive')}>
              <TabsList>
                <TabsTrigger value="queue">Messages</TabsTrigger>
                <TabsTrigger value="archive">Archive</TabsTrigger>
              </TabsList>
            </Tabs>
            {messages.error ? (
              <Alert variant="destructive" title={messages.error.message} />
            ) : messages.isPending ? (
              <Skeleton className="h-32" />
            ) : messages.data.length === 0 ? (
              <p className="py-8 text-center text-sm text-foreground-lighter">{view === 'archive' ? 'Nothing archived' : 'The queue is empty'}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>ID</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead className="text-right">Reads</TableHead>
                    <TableHead className="whitespace-nowrap">Sent</TableHead>
                    <TableHead className="whitespace-nowrap">Visible</TableHead>
                    {canChange && view === 'queue' && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {messages.data.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="tabular-nums text-foreground-light">{m.id}</TableCell>
                      <TableCell className="max-w-xs">
                        <code className="block truncate font-mono text-xs text-foreground" title={JSON.stringify(m.message, null, 2)}>
                          {JSON.stringify(m.message)}
                        </code>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-foreground-light">{m.read_count}</TableCell>
                      <TableCell className="whitespace-nowrap text-foreground-light">{relativeTime(m.enqueued_at)}</TableCell>
                      <TableCell className="whitespace-nowrap text-foreground-light">
                        {/* Measured from when the list was read. */}
                        {new Date(m.visible_at).getTime() > messages.dataUpdatedAt ? relativeTime(m.visible_at, messages.dataUpdatedAt) : 'now'}
                      </TableCell>
                      {canChange && view === 'queue' && (
                        <TableCell className="text-right whitespace-nowrap">
                          <Button variant="text" size="tiny" disabled={ddl.isPending} onClick={() => ddl.mutate({ sql: archiveMessage(queue, m.id), done: `Archived ${m.id}` })}>
                            Archive
                          </Button>
                          <Button variant="text" size="tiny" disabled={ddl.isPending} onClick={() => ddl.mutate({ sql: deleteMessage(queue, m.id), done: `Deleted ${m.id}` })}>
                            Delete
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SheetSection>
        </div>
      </SheetContent>
    </Sheet>
  )
}
