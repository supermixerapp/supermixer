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
import { t, language } from '@/lib/i18n'

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
      title={t('integrations:integrationsQueues.queues')}
      description={t('integrations:integrationsQueues.durableMessageQueuesInPostgresWith')}
      extension={{ name: 'pgmq', schema: null }}
      about={t('integrations:integrationsQueues.createsThePgmqSchemaEachQueue')}
      actions={
        <>
          <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={queues.isFetching && !queues.isPending} onClick={() => void queues.refetch()}>
            {t('integrations:integrationsQueues.refresh')}
          </Button>
          <PermissionButton allowed={canChange} action={t('integrations:integrationsQueues.createQueues')} variant="primary" icon={<AddIcon />} onClick={() => setCreating(true)}>
            {t('integrations:integrationsQueues.createQueue')}
          </PermissionButton>
        </>
      }
    >
      <CatalogTable
        rows={queues.data}
        loading={queues.isPending}
        error={queues.error}
        rowKey={(q) => q.name}
        empty={t('integrations:integrationsQueues.noQueuesYet')}
        columns={[
          {
            header: t('integrations:integrationsQueues.name'),
            cell: (q) => (
              <button className="flex items-center gap-2 text-left text-foreground underline-offset-2 hover:underline" onClick={() => setOpen(q.name)}>
                {q.name}
                {q.is_unlogged && <Badge>{t('integrations:integrationsQueues.unlogged')}</Badge>}
                {q.is_partitioned && <Badge>{t('integrations:integrationsQueues.partitioned')}</Badge>}
              </button>
            ),
          },
          { header: t('integrations:integrationsQueues.messages'), className: 'text-right', cell: (q) => <span className="tabular-nums text-foreground-light">{q.length.toLocaleString(language())}</span> },
          {
            header: t('integrations:integrationsQueues.oldestMessage'),
            cell: (q) => <span className="text-foreground-light">{q.oldest_age === null ? '—' : age(q.oldest_age)}</span>,
          },
          { header: t('integrations:integrationsQueues.sentInTotal'), className: 'text-right', cell: (q) => <span className="tabular-nums text-foreground-light">{q.total.toLocaleString(language())}</span> },
          { header: t('integrations:integrationsQueues.created'), cell: (q) => <span className="text-foreground-light">{relativeTime(q.created_at)}</span> },
        ]}
        actions={[
          { label: t('integrations:integrationsQueues.open'), onSelect: (q) => setOpen(q.name) },
          {
            label: t('integrations:integrationsQueues.purgeMessages'),
            hidden: () => !canChange,
            confirm: (q) => ({ title: t('integrations:integrationsQueues.purge', { name: q.name }), description: t('integrations:integrationsQueues.deletesAllMessagesWaitingInIt', { value: q.length.toLocaleString(language()) }) }),
            onSelect: (q) => ddl.mutate({ sql: purgeQueue(q.name), done: t('integrations:integrationsQueues.purged', { name: q.name }) }),
          },
          {
            label: t('integrations:integrationsQueues.deleteQueue'),
            hidden: () => !canChange,
            confirm: (q) => ({
              title: t('integrations:integrationsQueues.deleteQueue2', { name: q.name }),
              description: t('integrations:integrationsQueues.dropsTheQueueItsMessagesAnd'),
              confirmText: q.name,
            }),
            onSelect: (q) => ddl.mutate({ sql: dropQueue(q.name), done: t('integrations:integrationsQueues.deleted', { name: q.name }) }),
          },
        ]}
      />
      {creating && <CreateQueueSheet projectRef={ref} onClose={() => setCreating(false)} />}
      {open && <QueueSheet projectRef={ref} queue={open} canChange={canChange} onClose={() => setOpen(null)} />}
    </IntegrationPage>
  )
}

function age(seconds: number): string {
  if (seconds < 60) return t('integrations:integrationsQueues.s', { round: Math.round(seconds) })
  if (seconds < 3600) return t('integrations:integrationsQueues.min', { round: Math.round(seconds / 60) })
  if (seconds < 86_400) return t('integrations:integrationsQueues.h', { fixed: (seconds / 3600).toFixed(1) })
  return t('integrations:integrationsQueues.days', { fixed: (seconds / 86_400).toFixed(1) })
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
      title={t('integrations:integrationsQueues.createAQueue')}
      error={ddl.error}
      submitLabel={t('integrations:integrationsQueues.createQueue')}
      submitting={ddl.isPending}
      disabled={!!problem}
      onSubmit={() => ddl.mutate({ sql, done: t('integrations:integrationsQueues.created2', { name }) }, { onSuccess: onClose })}
    >
      <FormField label={t('integrations:integrationsQueues.name')} htmlFor="queue-name" description={problem && name ? <span className="text-destructive">{problem}</span> : t('integrations:integrationsQueues.canTBeChangedLater')}>
        <Input id="queue-name" autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} placeholder="emails" />
      </FormField>
      <FormField
        label={t('integrations:integrationsQueues.type')}
        description={
          type === 'unlogged'
            ? t('integrations:integrationsQueues.fasterButMessagesAreLostIf')
            : t('integrations:integrationsQueues.messagesAreWrittenToTheWal')
        }
      >
        <Select value={type} onValueChange={(v) => setType(v as QueueType)}>
          <SelectTrigger aria-label={t('integrations:integrationsQueues.queueType')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="basic">{t('integrations:integrationsQueues.basic')}</SelectItem>
            <SelectItem value="unlogged">{t('integrations:integrationsQueues.unlogged')}</SelectItem>
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
          <SheetDescription>{t('integrations:integrationsQueues.theFirst100MessagesOldestFirst')}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          {canChange && (
            <SheetSection className="flex flex-col gap-3 border-b">
              <FormField label={t('integrations:integrationsQueues.sendAMessage')} htmlFor="queue-message" description={jsonOk ? t('integrations:integrationsQueues.aJsonObject') : <span className="text-destructive">{t('integrations:integrationsQueues.mustBeAJsonObject')}</span>}>
                <Textarea id="queue-message" rows={4} className="font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} />
              </FormField>
              <div className="flex items-end gap-2">
                <FormField label={t('integrations:integrationsQueues.delaySeconds')} htmlFor="queue-delay">
                  <Input id="queue-delay" inputMode="numeric" className="w-32" value={delay} onChange={(e) => setDelay(e.target.value.replace(/\D/g, ''))} />
                </FormField>
                <Button
                  variant="primary"
                  disabled={!jsonOk}
                  loading={ddl.isPending}
                  onClick={() => ddl.mutate({ sql: sendMessage(queue, json, Number(delay) || 0), done: t('integrations:integrationsQueues.sentTo', { queue }) })}
                >
                  {t('integrations:integrationsQueues.sendMessage')}
                </Button>
              </div>
            </SheetSection>
          )}
          <SheetSection className="flex flex-col gap-3">
            <Tabs value={view} onValueChange={(v) => setView(v as 'queue' | 'archive')}>
              <TabsList>
                <TabsTrigger value="queue">{t('integrations:integrationsQueues.messages')}</TabsTrigger>
                <TabsTrigger value="archive">{t('integrations:integrationsQueues.archive')}</TabsTrigger>
              </TabsList>
            </Tabs>
            {messages.error ? (
              <Alert variant="destructive" title={messages.error.message} />
            ) : messages.isPending ? (
              <Skeleton className="h-32" />
            ) : messages.data.length === 0 ? (
              <p className="py-8 text-center text-sm text-foreground-lighter">{view === 'archive' ? t('integrations:integrationsQueues.nothingArchived') : t('integrations:integrationsQueues.theQueueIsEmpty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('integrations:integrationsQueues.id')}</TableHead>
                    <TableHead>{t('integrations:integrationsQueues.message')}</TableHead>
                    <TableHead className="text-right">{t('integrations:integrationsQueues.reads')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('integrations:integrationsQueues.sent')}</TableHead>
                    <TableHead className="whitespace-nowrap">{t('integrations:integrationsQueues.visible')}</TableHead>
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
                          <Button variant="text" size="tiny" disabled={ddl.isPending} onClick={() => ddl.mutate({ sql: archiveMessage(queue, m.id), done: t('integrations:integrationsQueues.archived', { id: m.id }) })}>
                            {t('integrations:integrationsQueues.archive')}
                          </Button>
                          <Button variant="text" size="tiny" disabled={ddl.isPending} onClick={() => ddl.mutate({ sql: deleteMessage(queue, m.id), done: t('integrations:integrationsQueues.deleted2', { id: m.id }) })}>
                            {t('integrations:integrationsQueues.delete')}
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
