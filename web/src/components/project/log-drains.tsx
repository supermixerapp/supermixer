/*
 * Settings › Log Drains for stacks Supermixer created: extra
 * destinations for the stack's logs, as Vector sinks.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { LogsOffAlert } from '@/components/logs/logs-off'
import { MoreIcon } from '@/components/icons'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can } from '@/lib/api/hooks'
import { localized, t as tr, Trans } from '@/lib/i18n'

type Drain = Schemas['LogDrain']
type DrainInput = Schemas['LogDrainInput']
type DrainType = Drain['type']

const TYPES = localized((): Record<DrainType, { label: string; hint: string }> => ({
  http: { label: tr('project:logDrains.httpEndpoint'), hint: tr('project:logDrains.batchesOfJsonLogEventsPosted') },
  loki: { label: tr('project:logDrains.loki'), hint: tr('project:logDrains.pushedToLokiLabelledWithThe') },
  datadog: { label: tr('project:logDrains.datadog'), hint: tr('project:logDrains.sentToDatadogLogsWithYour') },
}))

const SITES = [
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ddog-gov.com',
]

const drainsKey = (ref: string) => ['projects', ref, 'log-drains']

export function LogDrains({ project }: { project: Schemas['Project'] }) {
  const ref = project.ref
  const allowed = can(project, 'project:update')
  const queryClient = useQueryClient()
  const drains = useQuery({
    queryKey: drainsKey(ref),
    queryFn: () => unwrap(api.GET('/projects/{ref}/log-drains', { params: { path: { ref } } })),
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: drainsKey(ref) })
  const [editing, setEditing] = useState<Drain | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Drain | null>(null)

  const toggle = useMutation({
    mutationFn: (d: Drain) =>
      unwrap(
        api.PATCH('/projects/{ref}/log-drains/{id}', {
          params: { path: { ref, id: d.id } },
          body: {
            name: d.name,
            type: d.type,
            enabled: !d.enabled,
            url: d.url,
            gzip: d.gzip,
            datadog_site: d.datadog_site,
            headers: d.headers.map((h) => ({ name: h.name })),
          },
        })
      ),
    onError: (e) => toast.error(e.message),
    onSettled: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/projects/{ref}/log-drains/{id}', { params: { path: { ref, id } } })),
    onSuccess: () => toast.success(tr('project:logDrains.logDrainRemoved')),
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      setDeleting(null)
      refresh()
    },
  })

  if (drains.error) return <Alert variant="destructive" title={drains.error.message} />
  if (!drains.data) return <Skeleton className="h-40" />
  const list = drains.data.drains
  const logsOff = project.stack?.logs === false

  return (
    <>
      {logsOff && (
        <LogsOffAlert projectRef={ref}>
          {tr('project:logDrains.thereAreNoLogsToSend')}
        </LogsOffAlert>
      )}
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-foreground-light">
          <Trans i18nKey="project:logDrains.logsFromTheApiGatewayAuth" components={{ code: <code className="font-mono text-xs" />, code2: <code className="font-mono text-xs" /> }} />
        </p>
        <PermissionButton
          allowed={allowed}
          action={tr('project:logDrains.addLogDrains')}
          variant="primary"
          disabled={logsOff}
          onClick={() => setEditing('new')}
        >
          {tr('project:logDrains.addDestination')}
        </PermissionButton>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{tr('project:logDrains.name')}</TableHead>
              <TableHead>{tr('project:logDrains.type')}</TableHead>
              <TableHead>{tr('project:logDrains.destination')}</TableHead>
              <TableHead>{tr('project:logDrains.enabled')}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-8 text-center text-foreground-lighter">
                  {tr('project:logDrains.noLogDrainsYet')}
                </TableCell>
              </TableRow>
            ) : (
              list.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="text-foreground">{d.name}</TableCell>
                  <TableCell>
                    <Badge>{TYPES()[d.type].label}</Badge>
                  </TableCell>
                  <TableCell className="max-w-72 truncate font-mono text-xs text-foreground-light">
                    {d.type === 'datadog' ? d.datadog_site : d.url}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={d.enabled}
                      disabled={!allowed || logsOff || toggle.isPending}
                      onCheckedChange={() => toggle.mutate(d)}
                      aria-label={`${d.enabled ? tr('common:actions.disable') : tr('common:actions.enable')} ${d.name}`}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="text" size="tiny" icon={<MoreIcon />} aria-label={tr('project:logDrains.actionsFor', { name: d.name })} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem disabled={!allowed || logsOff} onSelect={() => setEditing(d)}>
                          {tr('project:logDrains.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!allowed}
                          className="text-destructive"
                          onSelect={() => setDeleting(d)}
                        >
                          {tr('project:logDrains.remove')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
      <p className="text-xs text-foreground-lighter">
        {tr('project:logDrains.logsLeaveFromTheStackS')}
      </p>

      {editing && (
        <DrainDialog
          projectRef={ref}
          drain={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={tr('project:logDrains.remove2', { name: deleting?.name ?? tr('project:logDrains.thisDrain') })}
        description={tr('project:logDrains.logsStopGoingToThisDestination')}
        confirmLabel={tr('project:logDrains.remove3')}
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </>
  )
}

type HeaderRow = { name: string; value: string; set: boolean }

function DrainDialog({
  projectRef,
  drain,
  onClose,
  onSaved,
}: {
  projectRef: string
  drain: Drain | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(drain?.name ?? '')
  const [type, setType] = useState<DrainType>(drain?.type ?? 'http')
  const [url, setUrl] = useState(drain?.url ?? '')
  const [gzip, setGzip] = useState(drain?.gzip ?? false)
  const [site, setSite] = useState(drain?.datadog_site || 'datadoghq.com')
  const [apiKey, setApiKey] = useState('')
  const [headers, setHeaders] = useState<HeaderRow[]>(
    drain?.headers.map((h) => ({ name: h.name, value: '', set: h.value_set })) ?? []
  )

  const save = useMutation({
    mutationFn: () => {
      const body: DrainInput = {
        name,
        type,
        enabled: drain?.enabled ?? true,
        url: type === 'datadog' ? undefined : url,
        gzip: type === 'datadog' ? undefined : gzip,
        datadog_site: type === 'datadog' ? site : undefined,
        api_key: type === 'datadog' && apiKey ? apiKey : undefined,
        headers:
          type === 'datadog'
            ? []
            : headers
                .filter((h) => h.name.trim())
                // Left empty, a header that has a value keeps it.
                .map((h) => (h.set && !h.value ? { name: h.name } : { name: h.name, value: h.value })),
      }
      return drain
        ? unwrap(
            api.PATCH('/projects/{ref}/log-drains/{id}', {
              params: { path: { ref: projectRef, id: drain.id } },
              body,
            })
          )
        : unwrap(api.POST('/projects/{ref}/log-drains', { params: { path: { ref: projectRef } }, body }))
    },
    onSuccess: () => {
      toast.success(drain ? tr('project:logDrains.logDrainSaved') : tr('project:logDrains.logDrainAdded'))
      onSaved()
      onClose()
    },
  })
  const setHeader = (i: number, patch: Partial<HeaderRow>) =>
    setHeaders((hs) => hs.map((h, j) => (j === i ? { ...h, ...patch } : h)))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="medium">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{drain ? tr('project:logDrains.edit2', { name: drain.name }) : tr('project:logDrains.addALogDrain')}</DialogTitle>
            <DialogDescription>{TYPES()[type].hint}</DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4 border-t">
            <FormField label={tr('project:logDrains.name')} htmlFor="drain-name">
              <Input id="drain-name" value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <FormField label={tr('project:logDrains.type')} htmlFor="drain-type">
              <Select value={type} onValueChange={(v) => setType(v as DrainType)} disabled={!!drain}>
                <SelectTrigger id="drain-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPES()) as DrainType[]).map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPES()[t].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {type === 'datadog' ? (
              <>
                <FormField label={tr('project:logDrains.site')} htmlFor="drain-site">
                  <Select value={site} onValueChange={setSite}>
                    <SelectTrigger id="drain-site" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SITES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField label={tr('project:logDrains.apiKey')} htmlFor="drain-key">
                  <Input
                    id="drain-key"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    required={!drain?.api_key_set}
                    placeholder={drain?.api_key_set ? tr('project:logDrains.unchanged') : ''}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </FormField>
              </>
            ) : (
              <>
                <FormField
                  label={type === 'loki' ? tr('project:logDrains.lokiUrl') : 'URL'}
                  htmlFor="drain-url"
                  description={type === 'loki' ? tr('project:logDrains.lokiUrlHint') : undefined}
                >
                  <Input
                    id="drain-url"
                    type="url"
                    required
                    value={url}
                    placeholder="https://"
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </FormField>
                <label className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-foreground-light">{tr('project:logDrains.compressWithGzip')}</span>
                  <Switch checked={gzip} onCheckedChange={setGzip} />
                </label>
                <div className="flex flex-col gap-2">
                  <span className="text-sm text-foreground-light">{tr('project:logDrains.headers')}</span>
                  {headers.map((h, i) => (
                    <div key={i} className="flex gap-2">
                      <Input
                        aria-label={tr('project:logDrains.headerName')}
                        placeholder={tr('project:logDrains.authorization')}
                        value={h.name}
                        onChange={(e) => setHeader(i, { name: e.target.value })}
                      />
                      <Input
                        aria-label={tr('project:logDrains.headerValue')}
                        type="password"
                        autoComplete="off"
                        placeholder={h.set ? tr('project:logDrains.unchanged') : tr('project:logDrains.value')}
                        value={h.value}
                        onChange={(e) => setHeader(i, { value: e.target.value })}
                      />
                      <Button
                        type="button"
                        variant="default"
                        onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))}
                      >
                        {tr('project:logDrains.remove3')}
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button
                      type="button"
                      variant="default"
                      size="tiny"
                      onClick={() => setHeaders((hs) => [...hs, { name: '', value: '', set: false }])}
                    >
                      {tr('project:logDrains.addHeader')}
                    </Button>
                  </div>
                </div>
              </>
            )}
            {save.error && <Alert variant="destructive" title={save.error.message} />}
          </DialogSection>
          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>
              {tr('project:logDrains.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              {drain ? tr('project:logDrains.save') : tr('project:logDrains.addDestination')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
