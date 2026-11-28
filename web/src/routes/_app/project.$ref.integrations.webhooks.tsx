import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { CatalogTable, Code, SchemaPicker, useCanChange, useDdl } from '@/components/database/catalog-page'
import { AddIcon, RefreshIcon } from '@/components/icons'
import { IntegrationPage, useExtension } from '@/components/integrations/integration-page'
import { PermissionButton } from '@/components/permission-button'
import { EditorSheet, SqlPreview } from '@/components/table-editor/sheets'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FormField } from '@/components/ui/form-field'
import { Input, Textarea } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { relativeTime } from '@/lib/auth-users'
import { TABLES_SQL, type TableListRow } from '@/lib/pg/catalog'
import { isJsonObject } from '@/lib/pg/cron'
import { setTriggerEnabled } from '@/lib/pg/database'
import { pgQuery, usePg } from '@/lib/pg/run'
import { qualified } from '@/lib/pg/sql'
import {
  createWebhook,
  dropWebhook,
  HAS_WEBHOOKS_SQL,
  parseWebhook,
  replaceWebhook,
  WEBHOOK_CALLS_SQL,
  WEBHOOK_EVENTS,
  WEBHOOKS_SQL,
  type WebhookCall,
  type WebhookDef,
  type WebhookRow,
} from '@/lib/pg/webhooks'
import { t as tr, language } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/integrations/webhooks')({
  component: WebhooksPage,
})

function WebhooksPage() {
  const { ref } = Route.useParams()
  const net = useExtension(ref, 'pg_net')
  const ready = !!net.state?.installed_version
  const support = useQuery({ ...pgQuery<{ present: boolean }>(ref, ['webhooks-support'], HAS_WEBHOOKS_SQL), enabled: ready })
  const supported = support.data?.[0]?.present
  const hooks = useQuery({ ...pgQuery<WebhookRow>(ref, ['webhooks'], WEBHOOKS_SQL), enabled: ready && !!supported })
  const canChange = useCanChange()
  const ddl = useDdl(ref)
  const [editing, setEditing] = useState<WebhookRow | 'new' | null>(null)
  const [calls, setCalls] = useState<WebhookRow | null>(null)

  return (
    <IntegrationPage
      projectRef={ref}
      title={tr('integrations:integrationsWebhooks.databaseWebhooks')}
      description={tr('integrations:integrationsWebhooks.sendAnHttpRequestWhenRows')}
      extension={{ name: 'pg_net', schema: 'extensions' }}
      about="pg_net sends HTTP requests from Postgres in the background."
      actions={
        supported && (
          <>
            <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={hooks.isFetching && !hooks.isPending} onClick={() => void hooks.refetch()}>
              {tr('integrations:integrationsWebhooks.refresh')}
            </Button>
            <PermissionButton allowed={canChange} action={tr('integrations:integrationsWebhooks.createWebhooks')} variant="primary" icon={<AddIcon />} onClick={() => setEditing('new')}>
              {tr('integrations:integrationsWebhooks.createWebhook')}
            </PermissionButton>
          </>
        )
      }
    >
      {support.data && !supported ? (
        <Alert variant="warning" title={tr('integrations:integrationsWebhooks.thisDatabaseDoesnTHaveSupabase')}>
          {tr('integrations:integrationsWebhooks.supabaseSPostgresImageCreatesIt')}
        </Alert>
      ) : (
        <CatalogTable
          rows={hooks.data}
          loading={hooks.isPending}
          error={hooks.error ?? support.error}
          rowKey={(h) => `${h.schema}.${h.table}.${h.name}`}
          empty={tr('integrations:integrationsWebhooks.noWebhooksYet')}
          columns={[
            { header: tr('integrations:integrationsWebhooks.name'), cell: (h) => <span className="text-foreground">{h.name}</span> },
            {
              header: tr('integrations:integrationsWebhooks.table'),
              cell: (h) => (
                <span className="text-foreground-light">
                  {h.schema}.{h.table}
                </span>
              ),
            },
            {
              header: tr('integrations:integrationsWebhooks.events'),
              cell: (h) => (
                <span className="flex flex-wrap gap-1">
                  {h.events.map((e) => (
                    <Badge key={e}>{e}</Badge>
                  ))}
                </span>
              ),
            },
            {
              header: tr('integrations:integrationsWebhooks.request'),
              cell: (h) => {
                const d = parseWebhook(h)
                return <Code title={d.url}>{`${d.method} ${d.url}`}</Code>
              },
            },
            {
              header: tr('integrations:integrationsWebhooks.enabled'),
              cell: (h) => (
                <Switch
                  aria-label={tr('integrations:integrationsWebhooks.enable', { name: h.name })}
                  checked={h.enabled}
                  disabled={!canChange || ddl.isPending}
                  onCheckedChange={(on) => ddl.mutate({ sql: setTriggerEnabled(h.schema, h.table, h.name, on), done: on ? tr('integrations:integrationsWebhooks.enabledToast', { name: h.name }) : tr('integrations:integrationsWebhooks.disabledToast', { name: h.name }) })}
                />
              ),
            },
          ]}
          actions={[
            { label: tr('integrations:integrationsWebhooks.recentCalls'), onSelect: (h) => setCalls(h) },
            { label: tr('integrations:integrationsWebhooks.editWebhook'), hidden: () => !canChange, onSelect: (h) => setEditing(h) },
            {
              label: tr('integrations:integrationsWebhooks.deleteWebhook'),
              hidden: () => !canChange,
              confirm: (h) => ({ title: tr('integrations:integrationsWebhooks.delete', { name: h.name }), description: tr('integrations:integrationsWebhooks.changesToStopSendingRequests', { schema: h.schema, table: h.table }) }),
              onSelect: (h) => ddl.mutate({ sql: dropWebhook(h), done: tr('integrations:integrationsWebhooks.deleted', { name: h.name }) }),
            },
          ]}
        />
      )}
      {editing && <WebhookSheet projectRef={ref} hook={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {calls && <CallsSheet projectRef={ref} hook={calls} onClose={() => setCalls(null)} />}
    </IntegrationPage>
  )
}

const NAME = /^[A-Za-z_][\w$-]*$/

function WebhookSheet({ projectRef, hook, onClose }: { projectRef: string; hook: WebhookRow | null; onClose: () => void }) {
  const ddl = useDdl(projectRef)
  const [w, setW] = useState<WebhookDef>(
    hook
      ? parseWebhook(hook)
      : { name: '', schema: 'public', table: '', events: ['INSERT'], method: 'POST', url: '', headers: '{"Content-Type": "application/json"}', params: '{}', timeoutMs: 5000 }
  )
  const set = (patch: Partial<WebhookDef>) => setW((x) => ({ ...x, ...patch }))
  const tables = usePg<TableListRow>(projectRef, ['tables', w.schema], TABLES_SQL, [w.schema])
  const name = w.name.trim()
  const problems = [
    !NAME.test(name) && tr('integrations:integrationsWebhooks.aNameOfLettersDigitsAnd'),
    !w.table && tr('integrations:integrationsWebhooks.aTable'),
    w.events.length === 0 && tr('integrations:integrationsWebhooks.atLeastOneEvent'),
    !/^https?:\/\/\S+$/.test(w.url.trim()) && tr('integrations:integrationsWebhooks.anHttpSUrl'),
    !isJsonObject(w.headers) && tr('integrations:integrationsWebhooks.headersAsAJsonObject'),
    !isJsonObject(w.params) && tr('integrations:integrationsWebhooks.parametersAsAJsonObject'),
    !(w.timeoutMs >= 1000 && w.timeoutMs <= 10000) && tr('integrations:integrationsWebhooks.aTimeoutBetween1000And10000'),
  ].filter(Boolean)
  const def = { ...w, name, url: w.url.trim() }
  const sql = problems.length ? '' : hook ? replaceWebhook(hook, def) : createWebhook(def)

  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={hook ? tr('integrations:integrationsWebhooks.edit', { name: hook.name }) : tr('integrations:integrationsWebhooks.createAWebhook')}
      description={
        w.method === 'POST'
          ? tr('integrations:integrationsWebhooks.postSendsTypeTableSchemaRecord')
          : tr('integrations:integrationsWebhooks.getSendsOnlyTheUrlThe')
      }
      error={ddl.error}
      submitLabel={hook ? tr('integrations:integrationsWebhooks.saveWebhook') : tr('integrations:integrationsWebhooks.createWebhook')}
      submitting={ddl.isPending}
      disabled={!sql}
      onSubmit={() => ddl.mutate({ sql, done: hook ? tr('integrations:integrationsWebhooks.saved', { name }) : tr('integrations:integrationsWebhooks.created', { name }) }, { onSuccess: onClose })}
    >
      <FormField label={tr('integrations:integrationsWebhooks.name')} htmlFor="hook-name">
        <Input id="hook-name" autoFocus autoComplete="off" value={w.name} onChange={(e) => set({ name: e.target.value })} placeholder="notify_new_order" />
      </FormField>
      <FormField label={tr('integrations:integrationsWebhooks.table')}>
        <div className="flex gap-2">
          <SchemaPicker projectRef={projectRef} value={w.schema} onChange={(schema) => set({ schema, table: '' })} />
          <Select value={w.table} onValueChange={(table) => set({ table })}>
            <SelectTrigger size="tiny" className="w-56" aria-label={tr('integrations:integrationsWebhooks.table')}>
              <SelectValue placeholder={tables.isPending ? tr('integrations:integrationsWebhooks.loading') : tr('integrations:integrationsWebhooks.chooseATable')} />
            </SelectTrigger>
            <SelectContent>
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
      <FormField label={tr('integrations:integrationsWebhooks.events')}>
        <div className="flex gap-5">
          {WEBHOOK_EVENTS.map((e) => (
            <label key={e} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={w.events.includes(e)}
                onCheckedChange={(c) => set({ events: WEBHOOK_EVENTS.filter((x) => (x === e ? c === true : w.events.includes(x))) })}
              />
              {e[0] + e.slice(1).toLowerCase()}
            </label>
          ))}
        </div>
      </FormField>
      <div className="flex gap-2">
        <FormField label={tr('integrations:integrationsWebhooks.method')}>
          <Select value={w.method} onValueChange={(v) => set({ method: v as WebhookDef['method'] })}>
            <SelectTrigger className="w-28" aria-label={tr('integrations:integrationsWebhooks.method')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="POST">{tr('integrations:integrationsWebhooks.post')}</SelectItem>
              <SelectItem value="GET">{tr('integrations:integrationsWebhooks.get')}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <div className="flex-1">
          <FormField label={tr('integrations:integrationsWebhooks.url')} htmlFor="hook-url" description={tr('integrations:integrationsWebhooks.reachedFromTheDatabaseContainerSo')}>
            <Input id="hook-url" value={w.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/webhook" />
          </FormField>
        </div>
      </div>
      <FormField
        label={tr('integrations:integrationsWebhooks.headers')}
        htmlFor="hook-headers"
        description={
          isJsonObject(w.headers) ? (
            tr('integrations:integrationsWebhooks.aJsonObjectStoredInPlain')
          ) : (
            <span className="text-destructive">{tr('integrations:integrationsWebhooks.mustBeAJsonObject')}</span>
          )
        }
      >
        <Textarea id="hook-headers" rows={3} className="font-mono text-xs" value={w.headers} onChange={(e) => set({ headers: e.target.value })} />
      </FormField>
      <FormField
        label={tr('integrations:integrationsWebhooks.urlParameters')}
        htmlFor="hook-params"
        description={isJsonObject(w.params) ? tr('integrations:integrationsWebhooks.aJsonObjectAddedToThe') : <span className="text-destructive">{tr('integrations:integrationsWebhooks.mustBeAJsonObject')}</span>}
      >
        <Textarea id="hook-params" rows={2} className="font-mono text-xs" value={w.params} onChange={(e) => set({ params: e.target.value })} />
      </FormField>
      <FormField label={tr('integrations:integrationsWebhooks.timeoutMs')} htmlFor="hook-timeout" description={tr('integrations:integrationsWebhooks.between1000And10000')}>
        <Input
          id="hook-timeout"
          inputMode="numeric"
          className="w-32"
          value={String(w.timeoutMs)}
          onChange={(e) => set({ timeoutMs: Number(e.target.value.replace(/\D/g, '')) || 0 })}
        />
      </FormField>
      {problems.length > 0 && (w.name || w.url) && <p className="text-xs text-foreground-lighter">{tr('integrations:integrationsWebhooks.stillNeeds', { join: problems.join(', ') })}</p>}
      {sql && <SqlPreview sql={sql} />}
    </EditorSheet>
  )
}

function CallsSheet({ projectRef, hook, onClose }: { projectRef: string; hook: WebhookRow; onClose: () => void }) {
  const calls = usePg<WebhookCall>(projectRef, ['webhook-calls', hook.schema, hook.table, hook.name], WEBHOOK_CALLS_SQL, [hook.name, qualified(hook.schema, hook.table)])
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="lg" className="flex flex-col">
        <SheetHeader>
          <SheetTitle>{tr('integrations:integrationsWebhooks.callsOf', { name: hook.name })}</SheetTitle>
          <SheetDescription>{tr('integrations:integrationsWebhooks.theLatest50PgNetKeeps')}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          <SheetSection>
            {calls.error ? (
              <Alert variant="destructive" title={calls.error.message} />
            ) : calls.isPending ? (
              <Skeleton className="h-32" />
            ) : calls.data.length === 0 ? (
              <p className="py-8 text-center text-sm text-foreground-lighter">{tr('integrations:integrationsWebhooks.noCallsYet')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{tr('integrations:integrationsWebhooks.when')}</TableHead>
                    <TableHead>{tr('integrations:integrationsWebhooks.result')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {calls.data.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="whitespace-nowrap text-foreground-light" title={new Date(c.created_at).toLocaleString(language())}>
                        {relativeTime(c.created_at)}
                      </TableCell>
                      <TableCell>
                        {c.status_code !== null ? (
                          <Badge variant={c.status_code < 400 ? 'success' : 'destructive'}>{c.status_code}</Badge>
                        ) : c.timed_out ? (
                          <Badge variant="destructive">{tr('integrations:integrationsWebhooks.timedOut')}</Badge>
                        ) : c.error ? (
                          <span className="text-xs text-destructive">{c.error}</span>
                        ) : (
                          <span className="text-xs text-foreground-lighter">{tr('integrations:integrationsWebhooks.pendingOrTheResponseHasExpired')}</span>
                        )}
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
