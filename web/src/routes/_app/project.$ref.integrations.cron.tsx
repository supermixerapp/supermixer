import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { CatalogTable, Code, useCanChange, useDdl } from '@/components/database/catalog-page'
import { AddIcon, RefreshIcon } from '@/components/icons'
import { IntegrationPage, useExtension } from '@/components/integrations/integration-page'
import { PermissionButton } from '@/components/permission-button'
import { CodeEditor } from '@/components/sql/code-editor'
import { EditorSheet, SqlPreview } from '@/components/table-editor/sheets'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import { Input, Textarea } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { relativeTime } from '@/lib/auth-users'
import {
  alterJob,
  CRON_JOBS_SQL,
  CRON_RUNS_SQL,
  describeSchedule,
  functionCommand,
  httpCommand,
  isJsonObject,
  saveJob,
  SCHEDULE_PRESETS,
  scheduleProblem,
  unscheduleJob,
  type CronJob,
  type CronRun,
  type HttpJob,
} from '@/lib/pg/cron'
import { PROTECTED_SCHEMAS } from '@/lib/pg/catalog'
import { pgQuery, usePg } from '@/lib/pg/run'

export const Route = createFileRoute('/_app/project/$ref/integrations/cron')({
  component: CronPage,
})

function CronPage() {
  const { ref } = Route.useParams()
  const ext = useExtension(ref, 'pg_cron')
  const installed = !!ext.state?.installed_version
  const jobs = useQuery({ ...pgQuery<CronJob>(ref, ['cron-jobs'], CRON_JOBS_SQL), enabled: installed })
  const canChange = useCanChange()
  const ddl = useDdl(ref)
  const [editing, setEditing] = useState<CronJob | 'new' | null>(null)
  const [history, setHistory] = useState<CronJob | null>(null)

  return (
    <IntegrationPage
      projectRef={ref}
      title="Cron"
      description="Recurring jobs run by pg_cron inside Postgres. Schedules use GMT unless cron.timezone says otherwise."
      extension={{ name: 'pg_cron', schema: null }}
      about="Creates the cron schema, where jobs and their run history live. pg_cron must be in shared_preload_libraries, as it is on Supabase's images."
      actions={
        <>
          <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={jobs.isFetching && !jobs.isPending} onClick={() => void jobs.refetch()}>
            Refresh
          </Button>
          <PermissionButton allowed={canChange} action="create cron jobs" variant="primary" icon={<AddIcon />} onClick={() => setEditing('new')}>
            Create job
          </PermissionButton>
        </>
      }
    >
      <CatalogTable
        rows={jobs.data}
        loading={jobs.isPending}
        error={jobs.error}
        rowKey={(j) => String(j.id)}
        empty="No cron jobs yet"
        columns={[
          {
            header: 'Name',
            cell: (j) => (
              <span className="flex flex-col">
                <span className="text-foreground">{j.name ?? `Job ${j.id}`}</span>
                <Code title={j.command}>{j.command}</Code>
              </span>
            ),
          },
          {
            header: 'Schedule',
            cell: (j) => (
              <span className="flex flex-col">
                <code className="font-mono text-xs text-foreground">{j.schedule}</code>
                <span className="text-xs text-foreground-lighter">{describeSchedule(j.schedule) ?? ''}</span>
              </span>
            ),
          },
          {
            header: 'Last run',
            cell: (j) =>
              j.last_status ? (
                <span className="flex items-center gap-2" title={j.last_message ?? undefined}>
                  <StatusBadge status={j.last_status} />
                  <span className="text-xs text-foreground-lighter">{relativeTime(j.last_start)}</span>
                </span>
              ) : (
                <span className="text-xs text-foreground-lighter">Not run yet</span>
              ),
          },
          {
            header: 'Active',
            cell: (j) => (
              <Switch
                aria-label={`Run ${j.name ?? j.id}`}
                checked={j.active}
                disabled={!canChange || ddl.isPending}
                onCheckedChange={(on) => ddl.mutate({ sql: alterJob(j.id, { active: on }), done: `${on ? 'Resumed' : 'Paused'} ${j.name ?? `job ${j.id}`}` })}
              />
            ),
          },
        ]}
        actions={[
          { label: 'History', onSelect: (j) => setHistory(j) },
          { label: 'Edit job', onSelect: (j) => setEditing(j), hidden: () => !canChange },
          {
            label: 'Delete job',
            hidden: () => !canChange,
            confirm: (j) => ({ title: `Delete ${j.name ?? `job ${j.id}`}?`, description: 'It stops running. Its run history stays in cron.job_run_details.' }),
            onSelect: (j) => ddl.mutate({ sql: unscheduleJob(j.id), done: `Deleted ${j.name ?? `job ${j.id}`}` }),
          },
        ]}
      />
      {editing && <JobSheet projectRef={ref} job={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {history && <HistorySheet projectRef={ref} job={history} onClose={() => setHistory(null)} />}
    </IntegrationPage>
  )
}

function StatusBadge({ status }: { status: string }) {
  const variant = status === 'succeeded' ? 'success' : status === 'failed' ? 'destructive' : 'default'
  return <Badge variant={variant}>{status}</Badge>
}

type JobKind = 'sql' | 'function' | 'http'

const FUNCTIONS_SQL = `
select n.nspname as schema, p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prokind = 'f' and p.pronargs = 0 and n.nspname <> all($1::text[])
  and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_%'
order by 1, 2`

function JobSheet({ projectRef, job, onClose }: { projectRef: string; job: CronJob | null; onClose: () => void }) {
  const ddl = useDdl(projectRef)
  const net = useExtension(projectRef, 'pg_net')
  const [name, setName] = useState(job?.name ?? '')
  const [schedule, setSchedule] = useState(job?.schedule ?? '*/5 * * * *')
  const [kind, setKind] = useState<JobKind>('sql')
  const [sql, setSql] = useState(job?.command ?? '')
  const [fn, setFn] = useState('')
  const [http, setHttp] = useState<HttpJob>({ method: 'POST', url: '', headers: '{"Content-Type": "application/json"}', body: '{}', timeoutMs: 5000 })
  const functions = useQuery({
    ...pgQuery<{ schema: string; name: string }>(projectRef, ['cron-functions'], FUNCTIONS_SQL, [`{${PROTECTED_SCHEMAS.join(',')}}`]),
    enabled: kind === 'function',
  })

  const problem = scheduleProblem(schedule)
  const [fnSchema, fnName] = fn ? (JSON.parse(fn) as [string, string]) : ['', '']
  const urlOk = /^https?:\/\/\S+$/.test(http.url.trim())
  const command =
    kind === 'sql' ? sql.trim() : kind === 'function' ? (fn ? functionCommand(fnSchema, fnName) : '') : urlOk ? httpCommand({ ...http, url: http.url.trim() }) : ''
  const httpOk = kind !== 'http' || (urlOk && isJsonObject(http.headers) && (http.method === 'GET' || isJsonObject(http.body)) && http.timeoutMs > 0)
  const ready = !!name.trim() && !problem && !!command && httpOk
  const statement = ready ? saveJob(job, name.trim(), schedule.trim(), command) : ''
  const preset = SCHEDULE_PRESETS.find((p) => p.value === schedule.trim())?.value ?? 'custom'

  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={job ? `Edit ${job.name ?? `job ${job.id}`}` : 'Create a cron job'}
      description="Jobs run inside Postgres as the user that scheduled them."
      error={ddl.error}
      submitLabel={job ? 'Save job' : 'Create job'}
      submitting={ddl.isPending}
      disabled={!ready}
      onSubmit={() => ddl.mutate({ sql: statement, done: job ? `Saved ${name.trim()}` : `Created ${name.trim()}` }, { onSuccess: onClose })}
    >
      <FormField label="Name" htmlFor="cron-name" description={job && job.name !== name.trim() ? 'Renaming replaces the job with a new one.' : undefined}>
        <Input id="cron-name" autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly-cleanup" />
      </FormField>
      <FormField
        label="Schedule"
        htmlFor="cron-schedule"
        description={problem && schedule ? <span className="text-destructive">{problem}</span> : (describeSchedule(schedule) ?? 'A cron expression: minute hour day month weekday.')}
      >
        <div className="flex gap-2">
          <Select value={preset} onValueChange={(v) => v !== 'custom' && setSchedule(v)}>
            <SelectTrigger className="w-56" aria-label="Schedule preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
          <Input id="cron-schedule" className="font-mono" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
        </div>
      </FormField>
      <FormField label="Type">
        <Select value={kind} onValueChange={(v) => setKind(v as JobKind)}>
          <SelectTrigger aria-label="Job type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sql">SQL snippet</SelectItem>
            <SelectItem value="function">Database function</SelectItem>
            <SelectItem value="http">HTTP request</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
      {kind === 'sql' && (
        <FormField label="SQL">
          <div className="h-48 overflow-hidden rounded-md border">
            <CodeEditor value={sql} onChange={setSql} />
          </div>
        </FormField>
      )}
      {kind === 'function' && (
        <FormField label="Function" description="Functions without arguments, outside Supabase's schemas.">
          <Select value={fn} onValueChange={setFn}>
            <SelectTrigger aria-label="Function">
              <SelectValue placeholder={functions.isPending ? 'Loading…' : 'Choose a function'} />
            </SelectTrigger>
            <SelectContent>
              {(functions.data ?? []).map((f) => (
                <SelectItem key={`${f.schema}.${f.name}`} value={JSON.stringify([f.schema, f.name])}>
                  {f.schema}.{f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}
      {kind === 'http' && (
        <>
          {net.state && !net.state.installed_version && (
            <Alert variant="warning" title="HTTP jobs need the pg_net extension">
              Enable it under Database › Extensions first.
            </Alert>
          )}
          <div className="flex gap-2">
            <FormField label="Method">
              <Select value={http.method} onValueChange={(v) => setHttp({ ...http, method: v as HttpJob['method'] })}>
                <SelectTrigger className="w-28" aria-label="Method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            <div className="flex-1">
              <FormField label="URL" htmlFor="cron-url">
                <Input id="cron-url" value={http.url} onChange={(e) => setHttp({ ...http, url: e.target.value })} placeholder="https://example.com/hook" />
              </FormField>
            </div>
          </div>
          <FormField
            label="Headers"
            htmlFor="cron-headers"
            description={
              isJsonObject(http.headers) ? (
                'A JSON object. Jobs are stored in plain text in cron.job, so avoid putting secrets here; read them from Vault in a SQL job instead.'
              ) : (
                <span className="text-destructive">Must be a JSON object</span>
              )
            }
          >
            <Textarea id="cron-headers" className="font-mono text-xs" rows={3} value={http.headers} onChange={(e) => setHttp({ ...http, headers: e.target.value })} />
          </FormField>
          {http.method === 'POST' && (
            <FormField label="Body" htmlFor="cron-body" description={isJsonObject(http.body) ? 'A JSON object.' : <span className="text-destructive">Must be a JSON object</span>}>
              <Textarea id="cron-body" className="font-mono text-xs" rows={4} value={http.body} onChange={(e) => setHttp({ ...http, body: e.target.value })} />
            </FormField>
          )}
          <FormField label="Timeout (ms)" htmlFor="cron-timeout">
            <Input
              id="cron-timeout"
              inputMode="numeric"
              className="w-32"
              value={String(http.timeoutMs)}
              onChange={(e) => setHttp({ ...http, timeoutMs: Number(e.target.value.replace(/\D/g, '')) || 0 })}
            />
          </FormField>
        </>
      )}
      {statement && <SqlPreview sql={statement} />}
    </EditorSheet>
  )
}

function HistorySheet({ projectRef, job, onClose }: { projectRef: string; job: CronJob; onClose: () => void }) {
  const runs = usePg<CronRun>(projectRef, ['cron-runs', job.id], CRON_RUNS_SQL, [String(job.id)])
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="xl" className="flex flex-col">
        <SheetHeader>
          <SheetTitle>Runs of {job.name ?? `job ${job.id}`}</SheetTitle>
          <SheetDescription>The latest 100, newest first.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          <SheetSection>
            {runs.error ? (
              <Alert variant="destructive" title={runs.error.message} />
            ) : runs.isPending ? (
              <Skeleton className="h-32" />
            ) : runs.data.length === 0 ? (
              <p className="py-8 text-center text-sm text-foreground-lighter">No runs yet</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="whitespace-nowrap">Started</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.data.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-foreground-light" title={r.start_time ? new Date(r.start_time).toLocaleString() : undefined}>
                        {r.start_time ? new Date(r.start_time).toLocaleString() : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums text-foreground-light">{duration(r.start_time, r.end_time)}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="max-w-sm">
                        <code className="block truncate font-mono text-xs text-foreground-light" title={r.message ?? undefined}>
                          {r.message || '—'}
                        </code>
                      </TableCell>
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

function duration(start: string | null, end: string | null): string {
  if (!start || !end) return '—'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}
