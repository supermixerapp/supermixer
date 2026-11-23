import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AddIcon } from '@/components/icons'
import { DatabasePage, SchemaPicker, SearchBox, schemaSearch, useCanChange, useDdl } from '@/components/database/catalog-page'
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
  type PolicyDef,
  type PolicyRow,
  type PolicyTableRow,
} from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'
import { setRls } from '@/lib/pg/table-sql'

export const Route = createFileRoute('/_app/project/$ref/database/policies')({
  validateSearch: schemaSearch,
  component: PoliciesPage,
})

function PoliciesPage() {
  const { ref } = Route.useParams()
  const { schema = 'public' } = Route.useSearch()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<PolicyRow | null>(null)
  const tables = usePg<PolicyTableRow>(ref, ['policy-tables', schema], POLICY_TABLES_SQL, [schema])
  const policies = usePg<PolicyRow>(ref, ['policies', schema], POLICIES_SQL, [schema])
  const canChange = useCanChange(schema)
  const ddl = useDdl(ref)
  const rows = (tables.data ?? []).filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <DatabasePage
      title="Policies"
      description="Row Level Security policies decide which rows each role can read and write through the API."
      toolbar={
        <>
          <SchemaPicker projectRef={ref} value={schema} onChange={(s) => void navigate({ to: '.', search: { schema: s } })} />
          <SearchBox value={search} onChange={setSearch} placeholder="Filter tables" />
        </>
      }
    >
      {tables.error || policies.error ? (
        // Never show "no policies" when we simply couldn't read them.
        <Alert variant="destructive" title={(tables.error ?? policies.error)!.message} />
      ) : tables.isPending || policies.isPending ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-foreground-lighter">{search ? 'No tables match your filter' : `No tables in ${schema}`}</p>
      ) : (
        rows.map((t) => {
          const own = (policies.data ?? []).filter((p) => p.table === t.name)
          return (
            <Card key={t.id}>
              <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                <span className="text-sm text-foreground">{t.name}</span>
                {!t.rls && <Badge variant="warning">RLS disabled</Badge>}
                <label className="ml-auto flex items-center gap-2 text-xs text-foreground-light">
                  Row Level Security
                  <Switch
                    aria-label={`Row Level Security on ${t.name}`}
                    checked={t.rls}
                    disabled={!canChange || ddl.isPending}
                    onCheckedChange={(on) => ddl.mutate({ sql: setRls(schema, t.name, on), done: `RLS ${on ? 'enabled' : 'disabled'} on ${t.name}` })}
                  />
                </label>
                <PermissionButton allowed={canChange} action="create policies here" variant="default" size="tiny" icon={<AddIcon />} onClick={() => setCreating(t.name)}>
                  Create policy
                </PermissionButton>
              </div>
              {own.length === 0 ? (
                <p className="px-4 py-4 text-xs text-foreground-lighter">
                  {t.rls ? 'No policies: the API can read or write nothing in this table.' : 'RLS is off: anyone with the anon key can read and write every row.'}
                </p>
              ) : (
                <ul className="divide-y">
                  {own.map((p) => (
                    <li key={p.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                      <Badge>{p.command}</Badge>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="text-foreground">{p.name}</span>
                        <span className="text-xs text-foreground-lighter">
                          {p.permissive ? 'Permissive' : 'Restrictive'} · to {p.roles.join(', ')}
                        </span>
                        {p.using && <code className="truncate font-mono text-xs text-foreground-light">using ({p.using})</code>}
                        {p.check && <code className="truncate font-mono text-xs text-foreground-light">with check ({p.check})</code>}
                      </div>
                      {canChange && (
                        <Button variant="text" size="tiny" onClick={() => setDeleting(p)}>
                          Delete
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
      {creating && <PolicySheet projectRef={ref} schema={schema} table={creating} onClose={() => setCreating(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete policy "${deleting?.name}"?`}
        description="Access it granted stops at once."
        confirmLabel="Delete policy"
        loading={ddl.isPending}
        onConfirm={() =>
          deleting && ddl.mutate({ sql: dropPolicy(schema, deleting.table, deleting.name), done: `Deleted ${deleting.name}` }, { onSettled: () => setDeleting(null) })
        }
      />
    </DatabasePage>
  )
}

const COMMON_ROLES = ['anon', 'authenticated', 'service_role']

function PolicySheet({ projectRef, schema, table, onClose }: { projectRef: string; schema: string; table: string; onClose: () => void }) {
  const [p, setP] = useState<PolicyDef>({ schema, table, name: '', command: 'SELECT', permissive: true, roles: [], using: '', check: '' })
  const ddl = useDdl(projectRef)
  const set = (patch: Partial<PolicyDef>) => setP((x) => ({ ...x, ...patch }))
  const sql = p.name.trim() ? createPolicy({ ...p, name: p.name.trim() }) : ''
  const showUsing = p.command !== 'INSERT'
  const showCheck = p.command !== 'SELECT' && p.command !== 'DELETE'
  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Create a policy on ${table}`}
      error={ddl.error}
      submitLabel="Save policy"
      submitting={ddl.isPending}
      disabled={!sql}
      onSubmit={() => ddl.mutate({ sql, done: `Created ${p.name}` }, { onSuccess: onClose })}
    >
      <FormField label="Start from a template">
        <div className="grid gap-1 sm:grid-cols-2">
          {POLICY_TEMPLATES.map((t) => (
            <button
              key={t.title}
              className="rounded-md border px-2 py-1.5 text-left text-xs text-foreground-light hover:bg-surface-200 hover:text-foreground"
              onClick={() => set({ name: t.title, command: t.command, roles: t.roles, using: t.using, check: t.check })}
            >
              {t.title}
            </button>
          ))}
        </div>
      </FormField>
      <FormField label="Policy name" htmlFor="pol-name">
        <Input id="pol-name" value={p.name} onChange={(e) => set({ name: e.target.value })} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Command">
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
        <FormField label="Behaviour">
          <Select value={p.permissive ? 'permissive' : 'restrictive'} onValueChange={(v) => set({ permissive: v === 'permissive' })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="permissive">Permissive (any matching policy allows)</SelectItem>
              <SelectItem value="restrictive">Restrictive (every one must allow)</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </div>
      <FormField label="Target roles" description="None ticked means every role (public).">
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
        <FormField label="USING expression" htmlFor="pol-using" description="Which existing rows the command can see, e.g. (select auth.uid()) = user_id">
          <Textarea id="pol-using" className="font-mono text-xs" value={p.using} onChange={(e) => set({ using: e.target.value })} />
        </FormField>
      )}
      {showCheck && (
        <FormField label="WITH CHECK expression" htmlFor="pol-check" description="Which new or changed rows are allowed.">
          <Textarea id="pol-check" className="font-mono text-xs" value={p.check} onChange={(e) => set({ check: e.target.value })} />
        </FormField>
      )}
      {sql && <SqlPreview sql={sql} />}
    </EditorSheet>
  )
}
