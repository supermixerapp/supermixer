import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { CatalogTable, SearchBox, useCanChange, useDdl } from '@/components/database/catalog-page'
import { AddIcon, CloseIcon, ExternalLinkIcon } from '@/components/icons'
import { IntegrationPage, useExtension } from '@/components/integrations/integration-page'
import { PermissionButton } from '@/components/permission-button'
import { EditorSheet } from '@/components/table-editor/sheets'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogSection, DialogTitle } from '@/components/ui/dialog'
import { FormField } from '@/components/ui/form-field'
import { Input, Textarea } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'
import { enableExtension } from '@/lib/pg/database'
import { pgQuery, rowsOf, runSql } from '@/lib/pg/run'
import {
  CREATE_WRAPPER_SECRET_SQL,
  DELETE_SECRETS_SQL,
  WRAPPER_SERVERS_SQL,
  WRAPPER_TYPES,
  canImportSchema,
  createWrapperSql,
  draftProblems,
  draftSecrets,
  displayOptions,
  dropWrapperSql,
  importedSchema,
  tableFromTemplate,
  typeOf,
  versionAtLeast,
  wrapperSecretIds,
  type TableDraft,
  type WrapperDraft,
  type WrapperServer,
  type WrapperType,
} from '@/lib/pg/wrappers'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/project/$ref/integrations/wrappers')({
  component: WrappersPage,
})

const SCHEMAS_SQL = `select nspname as name from pg_namespace
where nspname !~ '^pg_' and nspname <> 'information_schema' order by 1`
const SECRET_NAMES_SQL = `select name from vault.secrets where name is not null`
const SERVER_NAMES_SQL = `select srvname as name from pg_foreign_server`
const RELATIONS_SQL = `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'i', 'I', 'c') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`

function WrappersPage() {
  const { ref } = Route.useParams()
  const ext = useExtension(ref, 'wrappers')
  const installed = ext.state?.installed_version ?? null
  const canChange = useCanChange()
  const ddl = useDdl(ref)
  const servers = useQuery({ ...pgQuery<WrapperServer>(ref, ['wrapper-servers'], WRAPPER_SERVERS_SQL), enabled: !!installed })
  // Every wrapper keeps its credentials in Vault.
  const vault = useExtension(ref, 'supabase_vault')
  const vaultReady = !!vault.state?.installed_version
  const [choosing, setChoosing] = useState(false)
  const [type, setType] = useState<WrapperType | null>(null)

  return (
    <IntegrationPage
      projectRef={ref}
      title="Wrappers"
      description="Query Stripe, S3, BigQuery, ClickHouse and other services as Postgres tables, with Supabase's foreign data wrappers."
      extension={{ name: 'wrappers', schema: 'extensions' }}
      about="Adds Supabase's foreign data wrappers to the extensions schema. Each wrapper's credentials are kept in Vault."
      actions={
        <PermissionButton
          allowed={canChange}
          action="add wrappers"
          variant="primary"
          icon={<AddIcon />}
          disabled={!vaultReady}
          title={vaultReady ? undefined : 'Wrappers need Vault for their credentials'}
          onClick={() => setChoosing(true)}
        >
          Add wrapper
        </PermissionButton>
      }
    >
      {vault.state && !vaultReady && (
        <Alert variant="warning" title="Wrappers keep their credentials in Vault, which isn't enabled">
          <span className="flex flex-col items-start gap-2">
            {vault.state.default_version
              ? 'Enable the supabase_vault extension to add wrappers.'
              : "This database doesn't have the supabase_vault extension; Supabase's own Postgres images do."}
            {vault.state.default_version && (
              <PermissionButton
                allowed={canChange}
                action="enable extensions"
                size="tiny"
                loading={ddl.isPending}
                onClick={() => ddl.mutate({ sql: enableExtension('supabase_vault', 'vault'), done: 'Enabled supabase_vault' })}
              >
                Enable Vault
              </PermissionButton>
            )}
          </span>
        </Alert>
      )}
      <CatalogTable
        rows={servers.data}
        loading={servers.isPending}
        error={servers.error}
        rowKey={(s) => s.server}
        empty="No wrappers yet"
        columns={[
          {
            header: 'Name',
            cell: (s) => <span className="font-mono text-xs text-foreground">{s.server}</span>,
          },
          {
            header: 'Type',
            cell: (s) => {
              const t = typeOf(s)
              return t ? (
                <a href={t.docsUrl} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1 text-foreground-light hover:text-foreground">
                  {t.label} <ExternalLinkIcon size={12} />
                </a>
              ) : (
                <span className="font-mono text-xs text-foreground-lighter">{s.fdw}</span>
              )
            },
          },
          {
            header: 'Foreign tables',
            cell: (s) =>
              s.tables.length === 0 ? (
                <span className="text-foreground-lighter">—</span>
              ) : (
                <span className="flex flex-col gap-0.5">
                  {s.tables.slice(0, 4).map((t) => (
                    <span key={`${t.schema}.${t.name}`} className="font-mono text-xs text-foreground-light">
                      {t.schema}.{t.name}
                    </span>
                  ))}
                  {s.tables.length > 4 && <span className="text-xs text-foreground-lighter">and {s.tables.length - 4} more</span>}
                </span>
              ),
          },
          {
            header: 'Settings',
            cell: (s) => <ServerSettings server={s} />,
          },
        ]}
        actions={[
          {
            label: 'Delete wrapper',
            hidden: () => !canChange,
            confirm: (s) => ({
              title: `Delete ${s.server}?`,
              description: deleteDescription(s),
            }),
            onSelect: (s) => ddl.mutate({ sql: dropWrapperSql(s), done: `Deleted ${s.server}` }),
          },
        ]}
      />
      <TypeDialog
        open={choosing}
        installed={installed}
        onOpenChange={setChoosing}
        onPick={(t) => {
          setChoosing(false)
          setType(t)
        }}
      />
      {type && <WrapperSheet key={type.name} projectRef={ref} type={type} onClose={() => setType(null)} />}
    </IntegrationPage>
  )
}

/** What deleting a server does, as the confirmation should say it. */
function deleteDescription(s: WrapperServer): string {
  const tables = s.tables.length === 0 ? 'Drops the wrapper' : s.tables.length === 1 ? 'Drops it and its foreign table' : `Drops it and its ${s.tables.length} foreign tables`
  const schema = importedSchema(s)
  const extras = [
    schema && `removes the ${schema} schema if nothing else is in it`,
    wrapperSecretIds(s).length > 0 && 'deletes its credentials from Vault unless another wrapper uses them',
  ].filter(Boolean)
  const what = extras.length === 0 ? `${tables}.` : extras.length === 1 ? `${tables} and ${extras[0]}.` : `${tables}, ${extras[0]}, and ${extras[1]}.`
  return `${what} The data stays in ${typeOf(s)?.label ?? 'the remote service'}. This can’t be undone.`
}

/** Plain settings show their values; secrets and anything unknown stay masked. */
function ServerSettings({ server }: { server: WrapperServer }) {
  const shown = displayOptions(server)
  if (shown.length === 0) return <span className="text-foreground-lighter">—</span>
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      {shown.map((o) => (
        <span key={o.name} className="flex gap-2">
          <span className="text-foreground-lighter">{o.name}</span>
          <span className={cn('truncate font-mono', o.value === null ? 'text-foreground-lighter' : 'text-foreground-light')} title={o.value ?? undefined}>
            {o.vault ? 'in Vault' : (o.value ?? '••••••••')}
          </span>
        </span>
      ))}
    </span>
  )
}

function TypeDialog({
  open,
  installed,
  onOpenChange,
  onPick,
}: {
  open: boolean
  installed: string | null
  onOpenChange: (o: boolean) => void
  onPick: (t: WrapperType) => void
}) {
  const [q, setQ] = useState('')
  const shown = WRAPPER_TYPES.filter((t) => `${t.label} ${t.description} ${t.categories.join(' ')}`.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xlarge">
        <DialogHeader>
          <DialogTitle>Add a wrapper</DialogTitle>
          <DialogDescription>Pick the service to query from Postgres.</DialogDescription>
        </DialogHeader>
        <DialogSection className="flex flex-col gap-3">
          <SearchBox value={q} onChange={setQ} placeholder="Search wrappers" />
          <div className="grid max-h-[60vh] grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
            {shown.map((t) => {
              const ok = versionAtLeast(installed, t.minimumExtensionVersion)
              return (
                <button
                  key={t.name}
                  type="button"
                  disabled={!ok}
                  onClick={() => onPick(t)}
                  className="flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left hover:border-strong hover:bg-surface-200 focus-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="flex items-center gap-2 text-sm text-foreground">
                    {t.label}
                    {t.handlerName === 'wasm_fdw_handler' && <Badge>Wasm</Badge>}
                  </span>
                  <span className="text-xs text-foreground-lighter">
                    {ok ? t.description : `Needs wrappers ${t.minimumExtensionVersion} or later; this database has ${installed ?? 'none'}.`}
                  </span>
                </button>
              )
            })}
            {shown.length === 0 && <p className="py-6 text-center text-sm text-foreground-lighter sm:col-span-2">No wrappers match</p>}
          </div>
        </DialogSection>
      </DialogContent>
    </Dialog>
  )
}

function WrapperSheet({ projectRef, type, onClose }: { projectRef: string; type: WrapperType; onClose: () => void }) {
  const queryClient = useQueryClient()
  const schemas = useQuery(pgQuery<{ name: string }>(projectRef, ['schemas-all'], SCHEMAS_SQL))
  // Only members who can change data get here, so read Vault as the admin user.
  const secrets = useQuery(pgQuery<{ name: string }>(projectRef, ['vault-secret-names'], SECRET_NAMES_SQL, undefined, { readOnly: false }))
  const relations = useQuery(pgQuery<{ name: string }>(projectRef, ['relation-names'], RELATIONS_SQL))
  // Every foreign server, not only wrappers: names are shared with postgres_fdw and others.
  const serverNames = useQuery(pgQuery<{ name: string }>(projectRef, ['foreign-server-names'], SERVER_NAMES_SQL))
  const lookups = [schemas, secrets, relations, serverNames]
  const lookupError = lookups.find((q) => q.error)?.error ?? null
  const short = type.name.replace(/_wrapper$/, '')
  const [draft, setDraft] = useState<WrapperDraft>(() => ({
    type,
    server: `${short}_server`,
    values: Object.fromEntries(type.server.options.filter((o) => o.defaultValue !== undefined).map((o) => [o.name, o.defaultValue!])),
    mode: type.tables.length > 0 || !canImportSchema(type) ? 'tables' : 'schema',
    tables: type.tables.length > 0 ? [tableFromTemplate(type, 0)] : [],
    targetSchema: type.tables.length > 0 ? '' : short,
    sourceSchema: type.sourceSchemaOption?.defaultValue ?? '',
  }))
  const set = (patch: Partial<WrapperDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const schemaNames = useMemo(() => (schemas.data ?? []).map((s) => s.name), [schemas.data])
  const problems = draftProblems(draft, {
    servers: (serverNames.data ?? []).map((s) => s.name),
    schemas: schemaNames,
    secrets: (secrets.data ?? []).map((s) => s.name),
    relations: (relations.data ?? []).map((r) => r.name),
  })
  const canImport = canImportSchema(type)

  const create = useMutation<void, Error>({
    mutationFn: async () => {
      const ids: Record<string, string> = {}
      const created: string[] = []
      try {
        // 1. Secrets into Vault, as bound parameters: never in statement text.
        for (const s of draftSecrets(draft)) {
          const row = rowsOf<{ id: string }>(await runSql(projectRef, CREATE_WRAPPER_SECRET_SQL, { params: [s.value, s.name, `Used by the ${draft.server} wrapper`] }))[0]
          if (!row) throw new Error(`Vault didn't return an id for ${s.name}`)
          ids[s.option] = row.id
          created.push(s.name)
        }
        // 2. Wrapper, server and tables: one script, one transaction.
        const tables = draft.tables.map((t) => ({ ...t, newSchema: !schemaNames.includes(t.schema) }))
        await runSql(projectRef, createWrapperSql({ ...draft, tables }, ids))
      } catch (e) {
        // Don't leave credentials behind for a wrapper that doesn't exist.
        const left = Object.values(ids)
        if (left.length) {
          try {
            await runSql(projectRef, DELETE_SECRETS_SQL, { params: [JSON.stringify(left)] })
          } catch (cleanup) {
            throw new Error(
              `${e instanceof Error ? e.message : String(e)}. Removing the secrets it had saved also failed (${cleanup instanceof Error ? cleanup.message : String(cleanup)}); delete ${created.join(', ')} under Integrations › Vault.`,
              { cause: cleanup }
            )
          } finally {
            await queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'pg', 'vault-secret-names'] })
          }
        }
        throw e
      }
    },
    onSuccess: async () => {
      toast.success(`Added ${draft.server}`)
      await queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'pg'] })
      onClose()
    },
  })

  const visible = type.server.options.filter((o) => !o.hidden)
  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Add a ${type.label} wrapper`}
      description={
        <>
          {type.description}.{' '}
          <a href={type.docsUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-foreground-light hover:text-foreground">
            Supabase&apos;s guide <ExternalLinkIcon size={12} />
          </a>
        </>
      }
      error={create.error ?? (lookupError && new Error(`Couldn't check existing names: ${lookupError.message}`))}
      submitLabel="Add wrapper"
      submitting={create.isPending}
      disabled={problems.length > 0 || lookups.some((q) => q.isPending) || !!lookupError}
      onSubmit={() => create.mutate()}
    >
      <FormField label="Wrapper name" htmlFor="wrapper-name" description="The foreign server's name. Its secrets are saved in Vault as <name>_<option>.">
        <Input id="wrapper-name" autoComplete="off" value={draft.server} onChange={(e) => set({ server: e.target.value.trim() })} />
      </FormField>

      {visible.map((o) => (
        <FormField
          key={o.name}
          label={o.label + (o.required ? '' : ' (optional)')}
          htmlFor={`opt-${o.name}`}
          description={
            <>
              {o.description}
              {o.encrypted && ' Saved in Vault.'}
              {o.urlHelper && (
                <a href={o.urlHelper} target="_blank" rel="noreferrer noopener" className="ml-1 inline-flex items-center gap-1 text-foreground-light hover:text-foreground">
                  Where to find it <ExternalLinkIcon size={12} />
                </a>
              )}
            </>
          }
        >
          {o.isTextArea ? (
            <Textarea
              id={`opt-${o.name}`}
              rows={4}
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
              readOnly={o.readOnly}
              value={draft.values[o.name] ?? ''}
              onChange={(e) => set({ values: { ...draft.values, [o.name]: e.target.value } })}
            />
          ) : (
            <Input
              id={`opt-${o.name}`}
              type={o.secureEntry ? 'password' : 'text'}
              autoComplete={o.secureEntry ? 'new-password' : 'off'}
              readOnly={o.readOnly}
              value={draft.values[o.name] ?? ''}
              onChange={(e) => set({ values: { ...draft.values, [o.name]: e.target.value } })}
            />
          )}
        </FormField>
      ))}

      {canImport && type.tables.length > 0 && (
        <FormField label="Add tables" htmlFor="wrapper-mode">
          <Select value={draft.mode} onValueChange={(v) => set({ mode: v as WrapperDraft['mode'] })}>
            <SelectTrigger id="wrapper-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tables">Choose foreign tables</SelectItem>
              <SelectItem value="schema">Import everything into a new schema</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      )}

      {draft.mode === 'schema' ? (
        <>
          <FormField label="New schema" htmlFor="target-schema" description="Created for the wrapper's tables; it mustn't exist yet.">
            <Input id="target-schema" autoComplete="off" value={draft.targetSchema} onChange={(e) => set({ targetSchema: e.target.value.trim() })} />
          </FormField>
          {type.sourceSchemaOption && !type.sourceSchemaOption.readOnly && (
            <FormField label={type.sourceSchemaOption.label} htmlFor="source-schema" description={type.sourceSchemaOption.description}>
              <Input id="source-schema" autoComplete="off" value={draft.sourceSchema} onChange={(e) => set({ sourceSchema: e.target.value.trim() })} />
            </FormField>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-3">
          {draft.tables.map((t, i) => (
            <TableCard
              key={i}
              type={type}
              table={t}
              schemas={schemaNames}
              onChange={(next) => set({ tables: draft.tables.map((x, j) => (j === i ? next : x)) })}
              onRemove={() => set({ tables: draft.tables.filter((_, j) => j !== i) })}
            />
          ))}
          <Button variant="default" size="tiny" icon={<AddIcon />} className="w-fit" onClick={() => set({ tables: [...draft.tables, tableFromTemplate(type, 0)] })}>
            Add a table
          </Button>
        </div>
      )}

      {problems.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-foreground-lighter">
          {problems.slice(0, 4).map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
    </EditorSheet>
  )
}

function TableCard({
  type,
  table,
  schemas,
  onChange,
  onRemove,
}: {
  type: WrapperType
  table: TableDraft
  schemas: string[]
  onChange: (t: TableDraft) => void
  onRemove: () => void
}) {
  const template = type.tables[table.template]!
  const fixedColumns = !!template.availableColumns
  const set = (patch: Partial<TableDraft>) => onChange({ ...table, ...patch })
  const listId = `schemas-${type.name}`
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-2">
        {type.tables.length > 1 ? (
          <Select value={String(table.template)} onValueChange={(v) => onChange(tableFromTemplate(type, Number(v), table.schema))}>
            <SelectTrigger className="flex-1" aria-label="Table">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {type.tables.map((x, i) => (
                <SelectItem key={i} value={String(i)}>
                  {x.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="flex-1 text-sm text-foreground">{template.label}</span>
        )}
        <Button variant="text" size="tiny" icon={<CloseIcon />} aria-label="Remove table" onClick={onRemove} />
      </div>
      {template.description && <p className="-mt-1 text-xs text-foreground-lighter">{template.description}</p>}
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Schema" description={schemas.includes(table.schema) ? undefined : 'A new schema; it is created first.'}>
          <Input list={listId} autoComplete="off" value={table.schema} onChange={(e) => set({ schema: e.target.value.trim() })} />
          <datalist id={listId}>
            {schemas.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </FormField>
        <FormField label="Table name">
          <Input autoComplete="off" value={table.name} onChange={(e) => set({ name: e.target.value.trim() })} />
        </FormField>
      </div>

      {template.options.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {template.options.map((o) => (
            <FormField key={o.name} label={(o.label ?? o.name) + (o.required ? '' : ' (optional)')}>
              {o.type === 'select' ? (
                <Select value={table.options[o.name] || '__none'} disabled={!o.editable} onValueChange={(v) => set({ options: { ...table.options, [o.name]: v === '__none' ? '' : v } })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {!o.required && <SelectItem value="__none">None</SelectItem>}
                    {o.options.map((x) => (
                      <SelectItem key={x.value} value={x.value}>
                        {x.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  autoComplete="off"
                  readOnly={!o.editable}
                  placeholder={o.placeholder}
                  value={table.options[o.name] ?? ''}
                  onChange={(e) => set({ options: { ...table.options, [o.name]: e.target.value } })}
                />
              )}
            </FormField>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-foreground-lighter">Columns</span>
        {fixedColumns ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {template.availableColumns!.map((c) => {
              const on = table.columns.some((x) => x.name === c.name)
              return (
                <label key={c.name} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={on}
                    onCheckedChange={(v) =>
                      set({
                        // Keep the template's column order.
                        columns: template.availableColumns!.filter((x) => (x.name === c.name ? v === true : table.columns.some((y) => y.name === x.name))),
                      })
                    }
                  />
                  <span className="font-mono text-foreground">{c.name}</span>
                  <span className="font-mono text-foreground-lighter">{c.type}</span>
                </label>
              )
            })}
          </div>
        ) : (
          <>
            {table.columns.map((c, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  aria-label="Column name"
                  placeholder="name"
                  autoComplete="off"
                  value={c.name}
                  onChange={(e) => set({ columns: table.columns.map((x, j) => (j === i ? { ...x, name: e.target.value.trim() } : x)) })}
                />
                <Input
                  aria-label="Column type"
                  placeholder="text"
                  autoComplete="off"
                  value={c.type}
                  onChange={(e) => set({ columns: table.columns.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)) })}
                />
                <Button variant="text" size="tiny" icon={<CloseIcon />} aria-label="Remove column" onClick={() => set({ columns: table.columns.filter((_, j) => j !== i) })} />
              </div>
            ))}
            <Button variant="default" size="tiny" icon={<AddIcon />} className="w-fit" onClick={() => set({ columns: [...table.columns, { name: '', type: 'text' }] })}>
              Add a column
            </Button>
            {table.columns.length === 0 && <Alert title="This table's columns depend on the remote data; add the ones you want, with Postgres types." />}
          </>
        )}
      </div>
    </Card>
  )
}
