import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

import { AddIcon } from '@/components/icons'
import { DatabasePage, SchemaPicker, SearchBox, useCanChange, useDdl } from '@/components/database/catalog-page'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PermissionButton } from '@/components/permission-button'
import { EditorSheet, SqlPreview } from '@/components/table-editor/sheets'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { FormField } from '@/components/ui/form-field'
import { Input, Textarea } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  createPolicy,
  dropPolicy,
  POLICIES_SQL,
  POLICY_TABLES_SQL,
  POLICY_TEMPLATES,
  REALTIME_POLICY_TEMPLATES,
  storagePolicyTemplates,
  type PolicyDef,
  type PolicyRow,
  type PolicyTableRow,
} from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'
import { setRls } from '@/lib/pg/table-sql'
import { listBuckets } from '@/lib/storage-api'
import { localized, t as tr, Trans } from '@/lib/i18n'

/**
 * Row Level Security per table, shared by Database › Policies, Auth › Policies
 * Storage › Policies and Realtime › Policies. With `storage` or `realtime`, it
 * shows that service's own tables: their policies can be changed, but RLS
 * stays as the service set it.
 */
export function PoliciesView({
  projectRef: ref,
  schema,
  onSchemaChange,
  storage = false,
  realtime = false,
  description = tr('database:policiesView.rowLevelSecurityPoliciesDecideWhich'),
}: {
  projectRef: string
  schema: string
  onSchemaChange?: (s: string) => void
  storage?: boolean
  realtime?: boolean
  description?: ReactNode
}) {
  const managed = storage ? STORAGE_TABLE_HINTS() : realtime ? REALTIME_TABLE_HINTS() : null
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<PolicyRow | null>(null)
  const tables = usePg<PolicyTableRow>(ref, ['policy-tables', schema], POLICY_TABLES_SQL, [schema])
  const policies = usePg<PolicyRow>(ref, ['policies', schema], POLICIES_SQL, [schema])
  const canChangeSchema = useCanChange(schema)
  // Storage's and Realtime's schemas are Supabase's, but their policies are yours to write.
  const canWrite = useCanChange()
  const canChange = managed ? canWrite : canChangeSchema
  const ddl = useDdl(ref)
  const rows = (tables.data ?? [])
    .filter((t) => !managed || t.name in managed)
    .filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <DatabasePage
      title={tr('database:policiesView.policies')}
      description={description}
      toolbar={
        <>
          {onSchemaChange && <SchemaPicker projectRef={ref} value={schema} onChange={onSchemaChange} />}
          <SearchBox value={search} onChange={setSearch} placeholder={tr('database:policiesView.filterTables')} />
        </>
      }
    >
      {tables.error || policies.error ? (
        // Never show "no policies" when we simply couldn't read them.
        <Alert variant="destructive" title={(tables.error ?? policies.error)!.message} />
      ) : tables.isPending || policies.isPending ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-foreground-lighter">{search ? tr('database:policiesView.noTablesMatchYourFilter') : tr('database:policiesView.noTablesIn', { schema })}</p>
      ) : (
        rows.map((t) => {
          const own = (policies.data ?? []).filter((p) => p.table === t.name)
          return (
            <Card key={t.id}>
              <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                <span className="text-sm text-foreground">{t.name}</span>
                {!t.rls && <Badge variant="warning">{tr('database:policiesView.rlsDisabled')}</Badge>}
                {managed && <span className="text-xs text-foreground-lighter">{managed[t.name]}</span>}
                {managed ? (
                  <span className="ml-auto" />
                ) : (
                <label className="ml-auto flex items-center gap-2 text-xs text-foreground-light">
                  <Trans i18nKey="database:policiesView.rowLevelSecurity" components={{ switch: <Switch
                    aria-label={tr('database:policiesView.rlsOnTable', { name: t.name })}
                    checked={t.rls}
                    disabled={!canChange || ddl.isPending}
                    onCheckedChange={(on) => ddl.mutate({ sql: setRls(schema, t.name, on), done: on ? tr('database:policiesView.rlsEnabledOn', { name: t.name }) : tr('database:policiesView.rlsDisabledOn', { name: t.name }) })}
                  /> }} />
                </label>
                )}
                <PermissionButton allowed={canChange} action={tr('database:policiesView.createPoliciesHere')} variant="default" size="tiny" icon={<AddIcon />} onClick={() => setCreating(t.name)}>
                  {tr('database:policiesView.createPolicy')}
                </PermissionButton>
              </div>
              {own.length === 0 ? (
                <p className="px-4 py-4 text-xs text-foreground-lighter">
                  {realtime
                    ? tr('database:policiesView.noPoliciesOnlyTheServiceRole')
                    : t.rls
                      ? tr('database:policiesView.noPoliciesTheApiCanRead')
                      : tr('database:policiesView.rlsIsOffAnyoneWithThe')}
                </p>
              ) : (
                <ul className="divide-y">
                  {own.map((p) => (
                    <li key={p.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                      <Badge>{p.command}</Badge>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="text-foreground">{p.name}</span>
                        <span className="text-xs text-foreground-lighter">
                          {tr(p.permissive ? 'database:policiesView.permissiveTo' : 'database:policiesView.restrictiveTo', { roles: p.roles.join(', ') })}
                        </span>
                        {p.using && <code className="truncate font-mono text-xs text-foreground-light">{tr('database:policiesView.using', { using: p.using })}</code>}
                        {p.check && <code className="truncate font-mono text-xs text-foreground-light">{tr('database:policiesView.withCheck', { check: p.check })}</code>}
                      </div>
                      {canChange && (
                        <Button variant="text" size="tiny" onClick={() => setDeleting(p)}>
                          {tr('database:policiesView.delete')}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )
        })
      )}
      {creating && (
        <PolicySheet projectRef={ref} schema={schema} table={creating} storage={storage} realtime={realtime} onClose={() => setCreating(null)} />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={tr('database:policiesView.deletePolicy', { name: deleting?.name })}
        description={tr('database:policiesView.accessItGrantedStopsAtOnce')}
        confirmLabel={tr('database:policiesView.deletePolicy2')}
        loading={ddl.isPending}
        onConfirm={() =>
          deleting && ddl.mutate({ sql: dropPolicy(schema, deleting.table, deleting.name), done: tr('database:policiesView.deleted', { name: deleting.name }) }, { onSettled: () => setDeleting(null) })
        }
      />
    </DatabasePage>
  )
}

const COMMON_ROLES = ['anon', 'authenticated', 'service_role']

const STORAGE_TABLE_HINTS = localized((): Record<string, string> => ({
  objects: tr('database:policiesView.whoCanReadUploadChangeAnd'),
  buckets: tr('database:policiesView.whoCanListAndManageBuckets'),
}))

const REALTIME_TABLE_HINTS = localized((): Record<string, string> => ({
  messages: tr('database:policiesView.whoCanReceiveAndSendBroadcast'),
}))

function PolicySheet({
  projectRef,
  schema,
  table,
  storage,
  realtime,
  onClose,
}: {
  projectRef: string
  schema: string
  table: string
  storage: boolean
  realtime: boolean
  onClose: () => void
}) {
  const [p, setP] = useState<PolicyDef>({ schema, table, name: '', command: 'SELECT', permissive: true, roles: [], using: '', check: '' })
  const bucketTemplates = storage && table === 'objects'
  const buckets = useQuery({
    queryKey: ['projects', projectRef, 'storage', 'buckets'],
    queryFn: ({ signal }) => listBuckets(projectRef, signal),
    enabled: bucketTemplates,
  })
  const [bucket, setBucket] = useState<string | null>(null)
  const chosenBucket = bucket ?? buckets.data?.[0]?.name ?? null
  const templates = bucketTemplates
    ? chosenBucket
      ? storagePolicyTemplates(chosenBucket)
      : []
    : realtime
      ? REALTIME_POLICY_TEMPLATES()
      : POLICY_TEMPLATES()
  const ddl = useDdl(projectRef)
  const set = (patch: Partial<PolicyDef>) => setP((x) => ({ ...x, ...patch }))
  const sql = p.name.trim() ? createPolicy({ ...p, name: p.name.trim() }) : ''
  const showUsing = p.command !== 'INSERT'
  const showCheck = p.command !== 'SELECT' && p.command !== 'DELETE'
  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={tr('database:policiesView.createAPolicyOn', { table })}
      error={ddl.error}
      submitLabel={tr('database:policiesView.savePolicy')}
      submitting={ddl.isPending}
      disabled={!sql}
      onSubmit={() => ddl.mutate({ sql, done: tr('database:policiesView.created', { name: p.name }) }, { onSuccess: onClose })}
    >
      {bucketTemplates && (
        <FormField label={tr('database:policiesView.bucket')} description={buckets.data?.length === 0 ? tr('database:policiesView.noBucketsYetTemplatesNeedOne') : tr('database:policiesView.templatesBelowApplyToThisBucket')}>
          <Select value={chosenBucket ?? ''} onValueChange={setBucket}>
            <SelectTrigger aria-label={tr('database:policiesView.bucket')}>
              <SelectValue placeholder={tr('database:policiesView.chooseABucket')} />
            </SelectTrigger>
            <SelectContent>
              {(buckets.data ?? []).map((b) => (
                <SelectItem key={b.id} value={b.name}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      )}
      <FormField label={tr('database:policiesView.startFromATemplate')}>
        <div className="grid gap-1 sm:grid-cols-2">
          {templates.map((t) => (
            <button
              key={t.title}
              className="rounded-md border px-2 py-1.5 text-left text-xs text-foreground-light hover:bg-surface-200 hover:text-foreground"
              onClick={() => set({ name: t.name ?? t.title, command: t.command, roles: t.roles, using: t.using, check: t.check })}
            >
              {t.title}
            </button>
          ))}
        </div>
      </FormField>
      <FormField label={tr('database:policiesView.policyName')} htmlFor="pol-name">
        <Input id="pol-name" value={p.name} onChange={(e) => set({ name: e.target.value })} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={tr('database:policiesView.command')}>
          <Select value={p.command} onValueChange={(v) => set({ command: v as PolicyDef['command'] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'] as const).map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label={tr('database:policiesView.behaviour')}>
          <Select value={p.permissive ? 'permissive' : 'restrictive'} onValueChange={(v) => set({ permissive: v === 'permissive' })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="permissive">{tr('database:policiesView.permissiveAnyMatchingPolicyAllows')}</SelectItem>
              <SelectItem value="restrictive">{tr('database:policiesView.restrictiveEveryOneMustAllow')}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </div>
      <FormField label={tr('database:policiesView.targetRoles')} description={tr('database:policiesView.noneTickedMeansEveryRolePublic')}>
        <div className="flex gap-4 text-sm">
          {COMMON_ROLES.map((r) => (
            <label key={r} className="flex items-center gap-1.5">
              <Checkbox checked={p.roles.includes(r)} onCheckedChange={(on) => set({ roles: on ? [...p.roles, r] : p.roles.filter((x) => x !== r) })} />
              {r}
            </label>
          ))}
        </div>
      </FormField>
      {showUsing && (
        <FormField label={tr('database:policiesView.usingExpression')} htmlFor="pol-using" description={tr('database:policiesView.whichExistingRowsTheCommandCan')}>
          <Textarea id="pol-using" className="font-mono text-xs" value={p.using} onChange={(e) => set({ using: e.target.value })} />
        </FormField>
      )}
      {showCheck && (
        <FormField label={tr('database:policiesView.withCheckExpression')} htmlFor="pol-check" description={tr('database:policiesView.whichNewOrChangedRowsAre')}>
          <Textarea id="pol-check" className="font-mono text-xs" value={p.check} onChange={(e) => set({ check: e.target.value })} />
        </FormField>
      )}
      {sql && <SqlPreview sql={sql} />}
    </EditorSheet>
  )
}
