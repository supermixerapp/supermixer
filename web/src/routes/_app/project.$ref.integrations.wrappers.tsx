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
import { t as tr, Trans } from '@/lib/i18n'
import { formatList } from '@/lib/i18n/format'

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
      title={tr('integrations:integrationsWrappers.wrappers')}
      description={tr('integrations:integrationsWrappers.queryStripeS3BigqueryClickhouseAnd')}
      extension={{ name: 'wrappers', schema: 'extensions' }}
      about={tr('integrations:integrationsWrappers.addsSupabaseSForeignDataWrappers')}
      actions={
        <PermissionButton
          allowed={canChange}
          action={tr('integrations:integrationsWrappers.addWrappers')}
          variant="primary"
          icon={<AddIcon />}
          disabled={!vaultReady}
          title={vaultReady ? undefined : tr('integrations:integrationsWrappers.wrappersNeedVaultForTheirCredentials')}
          onClick={() => setChoosing(true)}
        >
          {tr('integrations:integrationsWrappers.addWrapper')}
        </PermissionButton>
      }
    >
      {vault.state && !vaultReady && (
        <Alert variant="warning" title={tr('integrations:integrationsWrappers.wrappersKeepTheirCredentialsInVault')}>
          <span className="flex flex-col items-start gap-2">
            {vault.state.default_version
              ? tr('integrations:integrationsWrappers.enableTheSupabaseVaultExtensionTo')
              : tr('integrations:integrationsWrappers.thisDatabaseDoesnTHaveThe')}
            {vault.state.default_version && (
              <PermissionButton
                allowed={canChange}
                action={tr('integrations:integrationsWrappers.enableExtensions')}
                size="tiny"
                loading={ddl.isPending}
                onClick={() => ddl.mutate({ sql: enableExtension('supabase_vault', 'vault'), done: tr('integrations:integrationsWrappers.enabledSupabaseVault') })}
              >
                {tr('integrations:integrationsWrappers.enableVault')}
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
        empty={tr('integrations:integrationsWrappers.noWrappersYet')}
        columns={[
          {
            header: tr('integrations:integrationsWrappers.name'),
            cell: (s) => <span className="font-mono text-xs text-foreground">{s.server}</span>,
          },
          {
            header: tr('integrations:integrationsWrappers.type'),
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
            header: tr('integrations:integrationsWrappers.foreignTables'),
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
                  {s.tables.length > 4 && <span className="text-xs text-foreground-lighter">{tr('integrations:integrationsWrappers.andMore', { count: s.tables.length - 4 })}</span>}
                </span>
              ),
          },
          {
            header: tr('integrations:integrationsWrappers.settings'),
            cell: (s) => <ServerSettings server={s} />,
          },
        ]}
        actions={[
          {
            label: tr('integrations:integrationsWrappers.deleteWrapper'),
            hidden: () => !canChange,
            confirm: (s) => ({
              title: tr('integrations:integrationsWrappers.delete', { server: s.server }),
              description: deleteDescription(s),
            }),
            onSelect: (s) => ddl.mutate({ sql: dropWrapperSql(s), done: tr('integrations:integrationsWrappers.deleted', { server: s.server }) }),
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
  const tables = s.tables.length === 0 ? tr('integrations:integrationsWrappers.dropsTheWrapper') : s.tables.length === 1 ? tr('integrations:integrationsWrappers.dropsItAndItsForeignTable') : tr('integrations:integrationsWrappers.dropsItAndItsForeignTables', { length: s.tables.length })
  const schema = importedSchema(s)
  const extras = [
    schema && tr('integrations:integrationsWrappers.removesTheSchemaIfNothingElse', { schema }),
    wrapperSecretIds(s).length > 0 && tr('integrations:integrationsWrappers.deletesItsCredentialsFromVaultUnless'),
  ].filter(Boolean)
  const what = formatList([tables, ...(extras as string[])])
  return tr('integrations:integrationsWrappers.theDataStaysInThisCan', { what, label: typeOf(s)?.label ?? tr('integrations:integrationsWrappers.theRemoteService') })
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
            {o.vault ? tr('integrations:integrationsWrappers.inVault') : (o.value ?? '••••••••')}
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
          <DialogTitle>{tr('integrations:integrationsWrappers.addAWrapper')}</DialogTitle>
          <DialogDescription>{tr('integrations:integrationsWrappers.pickTheServiceToQueryFrom')}</DialogDescription>
        </DialogHeader>
        <DialogSection className="flex flex-col gap-3">
          <SearchBox value={q} onChange={setQ} placeholder={tr('integrations:integrationsWrappers.searchWrappers')} />
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
                    {t.handlerName === 'wasm_fdw_handler' && <Badge>{tr('integrations:integrationsWrappers.wasm')}</Badge>}
                  </span>
                  <span className="text-xs text-foreground-lighter">
                    {ok ? t.description : tr('integrations:integrationsWrappers.needsWrappersOrLaterThisDatabase', { minimumExtensionVersion: t.minimumExtensionVersion, installed: installed ?? 'none' })}
                  </span>
                </button>
              )
            })}
            {shown.length === 0 && <p className="py-6 text-center text-sm text-foreground-lighter sm:col-span-2">{tr('integrations:integrationsWrappers.noWrappersMatch')}</p>}
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
          const row = rowsOf<{ id: string }>(await runSql(projectRef, CREATE_WRAPPER_SECRET_SQL, { params: [s.value, s.name, tr('integrations:integrationsWrappers.usedByTheWrapper', { server: draft.server })] }))[0]
          if (!row) throw new Error(tr('integrations:integrationsWrappers.vaultDidnTReturnAnId', { name: s.name }))
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
              tr('integrations:integrationsWrappers.removingTheSecretsItHadSaved', { value: e instanceof Error ? e.message : String(e), value2: cleanup instanceof Error ? cleanup.message : String(cleanup), join: created.join(', ') }),
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
      toast.success(tr('integrations:integrationsWrappers.added', { server: draft.server }))
      await queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'pg'] })
      onClose()
    },
  })

  const visible = type.server.options.filter((o) => !o.hidden)
  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={tr('integrations:integrationsWrappers.addAWrapper2', { label: type.label })}
      description={
        <>
          {type.description}.{' '}
          <a href={type.docsUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-foreground-light hover:text-foreground">
            <Trans i18nKey="integrations:integrationsWrappers.supabaseSGuide" components={{ externallinkicon: <ExternalLinkIcon size={12} /> }} />
          </a>
        </>
      }
      error={create.error ?? (lookupError && new Error(tr('integrations:integrationsWrappers.couldnTCheckExistingNames', { message: lookupError.message })))}
      submitLabel={tr('integrations:integrationsWrappers.addWrapper')}
      submitting={create.isPending}
      disabled={problems.length > 0 || lookups.some((q) => q.isPending) || !!lookupError}
      onSubmit={() => create.mutate()}
    >
      <FormField label={tr('integrations:integrationsWrappers.wrapperName')} htmlFor="wrapper-name" description={tr('integrations:integrationsWrappers.theForeignServerSNameIts')}>
        <Input id="wrapper-name" autoComplete="off" value={draft.server} onChange={(e) => set({ server: e.target.value.trim() })} />
      </FormField>

      {visible.map((o) => (
        <FormField
          key={o.name}
          label={o.required ? o.label : tr('common:optionalLabel', { label: o.label })}
          htmlFor={`opt-${o.name}`}
          description={
            <>
              {o.description}
              {o.encrypted && tr('integrations:integrationsWrappers.savedInVault')}
              {o.urlHelper && (
                <a href={o.urlHelper} target="_blank" rel="noreferrer noopener" className="ml-1 inline-flex items-center gap-1 text-foreground-light hover:text-foreground">
                  <Trans i18nKey="integrations:integrationsWrappers.whereToFindIt" components={{ externallinkicon: <ExternalLinkIcon size={12} /> }} />
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
        <FormField label={tr('integrations:integrationsWrappers.addTables')} htmlFor="wrapper-mode">
          <Select value={draft.mode} onValueChange={(v) => set({ mode: v as WrapperDraft['mode'] })}>
            <SelectTrigger id="wrapper-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tables">{tr('integrations:integrationsWrappers.chooseForeignTables')}</SelectItem>
              <SelectItem value="schema">{tr('integrations:integrationsWrappers.importEverythingIntoANewSchema')}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      )}

      {draft.mode === 'schema' ? (
        <>
          <FormField label={tr('integrations:integrationsWrappers.newSchema')} htmlFor="target-schema" description={tr('integrations:integrationsWrappers.createdForTheWrapperSTables')}>
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
            {tr('integrations:integrationsWrappers.addATable')}
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
            <SelectTrigger className="flex-1" aria-label={tr('integrations:integrationsWrappers.table')}>
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
        <Button variant="text" size="tiny" icon={<CloseIcon />} aria-label={tr('integrations:integrationsWrappers.removeTable')} onClick={onRemove} />
      </div>
      {template.description && <p className="-mt-1 text-xs text-foreground-lighter">{template.description}</p>}
      <div className="grid grid-cols-2 gap-3">
        <FormField label={tr('integrations:integrationsWrappers.schema')} description={schemas.includes(table.schema) ? undefined : tr('integrations:integrationsWrappers.aNewSchemaItIsCreated')}>
          <Input list={listId} autoComplete="off" value={table.schema} onChange={(e) => set({ schema: e.target.value.trim() })} />
          <datalist id={listId}>
            {schemas.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </FormField>
        <FormField label={tr('integrations:integrationsWrappers.tableName')}>
          <Input autoComplete="off" value={table.name} onChange={(e) => set({ name: e.target.value.trim() })} />
        </FormField>
      </div>

      {template.options.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {template.options.map((o) => (
            <FormField key={o.name} label={o.required ? (o.label ?? o.name) : tr('common:optionalLabel', { label: o.label ?? o.name })}>
              {o.type === 'select' ? (
                <Select value={table.options[o.name] || '__none'} disabled={!o.editable} onValueChange={(v) => set({ options: { ...table.options, [o.name]: v === '__none' ? '' : v } })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {!o.required && <SelectItem value="__none">{tr('integrations:integrationsWrappers.none')}</SelectItem>}
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
        <span className="text-xs text-foreground-lighter">{tr('integrations:integrationsWrappers.columns')}</span>
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
                  aria-label={tr('integrations:integrationsWrappers.columnName')}
                  placeholder="name"
                  autoComplete="off"
                  value={c.name}
                  onChange={(e) => set({ columns: table.columns.map((x, j) => (j === i ? { ...x, name: e.target.value.trim() } : x)) })}
                />
                <Input
                  aria-label={tr('integrations:integrationsWrappers.columnType')}
                  placeholder="text"
                  autoComplete="off"
                  value={c.type}
                  onChange={(e) => set({ columns: table.columns.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)) })}
                />
                <Button variant="text" size="tiny" icon={<CloseIcon />} aria-label={tr('integrations:integrationsWrappers.removeColumn')} onClick={() => set({ columns: table.columns.filter((_, j) => j !== i) })} />
              </div>
            ))}
            <Button variant="default" size="tiny" icon={<AddIcon />} className="w-fit" onClick={() => set({ columns: [...table.columns, { name: '', type: 'text' }] })}>
              {tr('integrations:integrationsWrappers.addAColumn')}
            </Button>
            {table.columns.length === 0 && <Alert title={tr('integrations:integrationsWrappers.thisTableSColumnsDependOn')} />}
          </>
        )}
      </div>
    </Card>
  )
}
