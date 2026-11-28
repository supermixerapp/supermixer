import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { Alert } from '@/components/ui/alert'

import { AddIcon } from '@/components/icons'
import { CatalogTable, DatabasePage, SearchBox, useCanChange, useDdl } from '@/components/database/catalog-page'
import { PermissionButton } from '@/components/permission-button'
import { EditorSheet, SqlPreview } from '@/components/table-editor/sheets'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { ROLES_SQL, type RoleRow } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'
import {
  alterRole,
  canHashPasswords,
  createRole,
  dateToExpiry,
  dropRole,
  emptyRole,
  expiryToDate,
  parseConnectionLimit,
  roleNameProblem,
  scramVerifier,
  type RoleDef,
} from '@/lib/pg/roles'
import { t, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/database/roles')({
  component: RolesPage,
})

/** Roles Supabase's services sign in as or switch to; changing them breaks the stack. */
const SUPABASE_ROLES = new Set([
  'anon', 'authenticated', 'service_role', 'authenticator', 'dashboard_user', 'pgbouncer', 'postgres', 'supabase_admin',
  'supabase_auth_admin', 'supabase_functions_admin', 'supabase_read_only_user', 'supabase_realtime_admin',
  'supabase_replication_admin', 'supabase_storage_admin', 'supabase_etl_admin', 'supabase_privileged_role',
])

/** Prefixes of roles that Supabase's images and extensions create (pgsodium, pg_tle, …). */
const SUPABASE_PREFIXES = ['supabase_', 'pgsodium_', 'pgtle_']

/** Managed elsewhere: Supabase's roles and Supermixer's read-only login. */
function managedBy(name: string): string | null {
  if (SUPABASE_ROLES.has(name) || SUPABASE_PREFIXES.some((p) => name.startsWith(p))) return 'Supabase'
  if (name.startsWith('supermixer_ro_')) return t('database:databaseRoles.supermixerReadOnly')
  return null
}

/**
 * Roles this page leaves alone: managed ones, superusers, and replication
 * roles (on Postgres 15 only a superuser may alter those).
 */
const lockedReason = (r: RoleRow): string | null =>
  managedBy(r.name) ? 'managed' : r.superuser ? 'superuser' : r.replication ? 'replication' : null

function toDef(r: RoleRow): RoleDef {
  return {
    name: r.name,
    login: r.login,
    inherit: r.inherit,
    createDb: r.create_db,
    createRole: r.create_role,
    replication: r.replication,
    bypassRls: r.bypass_rls,
    connectionLimit: r.connection_limit,
    validUntil: r.valid_until ?? '',
  }
}

function RolesPage() {
  const { ref } = Route.useParams()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{ original?: RoleRow } | null>(null)
  const roles = usePg<RoleRow>(ref, ['roles'], ROLES_SQL)
  const canChange = useCanChange()
  const ddl = useDdl(ref)
  const rows = roles.data?.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))
  const total = (roles.data ?? []).reduce((n, r) => n + r.connections, 0)

  return (
    <DatabasePage
      title={t('database:databaseRoles.databaseRoles')}
      description={t('database:databaseRoles.whoCanConnectAndWhatThey', { count: total })}
      toolbar={<SearchBox value={search} onChange={setSearch} placeholder={t('database:databaseRoles.searchForARole')} />}
      actions={
        <PermissionButton allowed={canChange} action={t('database:databaseRoles.manageRoles')} variant="primary" icon={<AddIcon />} onClick={() => setEditing({})}>
          {t('database:databaseRoles.addRole')}
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={rows}
        loading={roles.isPending}
        error={roles.error}
        rowKey={(r) => r.name}
        empty={t('database:databaseRoles.noRolesMatchYourSearch')}
        columns={[
          {
            header: t('database:databaseRoles.role'),
            cell: (r) => (
              <span className="flex items-center gap-2 text-foreground">
                {r.name}
                {managedBy(r.name) && <Badge>{managedBy(r.name)}</Badge>}
              </span>
            ),
          },
          {
            header: t('database:databaseRoles.attributes'),
            cell: (r) => (
              <span className="flex flex-wrap gap-1">
                {r.superuser && <Badge variant="destructive">{t('database:databaseRoles.superuser')}</Badge>}
                {r.login && <Badge>{t('database:databaseRoles.login')}</Badge>}
                {r.bypass_rls && <Badge variant="warning">{t('database:databaseRoles.bypassRls')}</Badge>}
                {r.create_role && <Badge>{t('database:databaseRoles.createRole')}</Badge>}
                {r.create_db && <Badge>{t('database:databaseRoles.createDb')}</Badge>}
                {r.replication && <Badge>{t('database:databaseRoles.replication')}</Badge>}
                {r.valid_until && <Badge>{t('database:databaseRoles.expires', { expiryToDate: expiryToDate(r.valid_until) })}</Badge>}
              </span>
            ),
          },
          {
            header: t('database:databaseRoles.connections'),
            cell: (r) => `${r.connections}${r.connection_limit >= 0 ? ` / ${r.connection_limit}` : ''}`,
            className: 'text-right whitespace-nowrap',
          },
        ]}
        actions={[
          { label: t('database:databaseRoles.editRole'), hidden: (r) => !canChange || !!lockedReason(r), onSelect: (r) => setEditing({ original: r }) },
          {
            label: t('database:databaseRoles.deleteRole'),
            hidden: (r) => !canChange || !!managedBy(r.name) || r.superuser,
            confirm: (r) => ({
              title: t('database:databaseRoles.deleteRole2', { name: r.name }),
              description: t('database:databaseRoles.rolesThatOwnObjectsOrHold'),
              confirmText: r.name,
            }),
            onSelect: (r) => ddl.mutate({ sql: dropRole(r.name), done: t('database:databaseRoles.deleted', { name: r.name }) }),
          },
        ]}
      />
      {editing && <RoleSheet projectRef={ref} original={editing.original} onClose={() => setEditing(null)} />}
    </DatabasePage>
  )
}

function RoleSheet({ projectRef, original, onClose }: { projectRef: string; original?: RoleRow; onClose: () => void }) {
  const [base] = useState<RoleDef | null>(() => (original ? toDef(original) : null))
  const [role, setRole] = useState<RoleDef>(() => base ?? emptyRole())
  const [limitText, setLimitText] = useState(() => String(role.connectionLimit))
  const [password, setPassword] = useState('')
  const [hashing, setHashing] = useState(false)
  const [hashError, setHashError] = useState<Error | null>(null)
  const ddl = useDdl(projectRef)
  const set = (patch: Partial<RoleDef>) => setRole((r) => ({ ...r, ...patch }))
  const next: RoleDef = { ...role, connectionLimit: parseConnectionLimit(limitText) }

  const renaming = !base || next.name !== base.name
  // An existing name is fine as it is; only a new name has to pass the checks.
  const nameProblem = renaming ? (roleNameProblem(next.name) ?? (managedBy(next.name) ? t('database:databaseRoles.thatNameIsReservedForSupabase') : null)) : null
  const noHash = !!password && !canHashPasswords()
  // The preview shows where the password goes without revealing it.
  const mask = password ? t('database:databaseRoles.scramSha256') : null
  const preview = nameProblem ? '' : base ? alterRole(base, next, mask) : createRole(next, mask)
  const busy = hashing || ddl.isPending

  const save = async () => {
    if (busy) return
    setHashError(null)
    setHashing(true)
    let verifier: string | null
    try {
      verifier = password ? await scramVerifier(password) : null
    } catch (e) {
      setHashError(e instanceof Error ? e : new Error(String(e)))
      return
    } finally {
      setHashing(false)
    }
    const sql = base ? alterRole(base, next, verifier) : createRole(next, verifier)
    ddl.mutate({ sql, done: base ? t('database:databaseRoles.updated', { name: next.name }) : t('database:databaseRoles.created', { name: next.name }) }, { onSuccess: onClose })
  }

  const flags: [keyof RoleDef, string, string][] = [
    ['login', t('database:databaseRoles.canLogIn'), t('database:databaseRoles.neededToConnectGroupRolesUsually')],
    ['inherit', t('database:databaseRoles.inheritPrivileges'), t('database:databaseRoles.getsThePrivilegesOfRolesIt')],
    ['createDb', t('database:databaseRoles.createDatabases'), ''],
    ['createRole', t('database:databaseRoles.createRoles'), t('database:databaseRoles.canCreateAlterAndDropOther')],
    ['replication', t('database:databaseRoles.replication2'), t('database:databaseRoles.canStartStreamingReplicationOnPostgres')],
    ['bypassRls', t('database:databaseRoles.bypassRowLevelSecurity'), t('database:databaseRoles.ignoresEveryRlsPolicyUseWith')],
  ]

  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={original ? t('database:databaseRoles.editRole2', { name: original.name }) : t('database:databaseRoles.addARole')}
      description={
        <>
          <Trans i18nKey="database:databaseRoles.passwordsAreHashedWithScramSha" values={{ user: `${next.name || 'name'}.<tenant>` }} components={{ code: <code className="font-mono" /> }} />
        </>
      }
      error={hashError ?? ddl.error}
      submitLabel={original ? t('database:databaseRoles.saveRole') : t('database:databaseRoles.addRole')}
      submitting={busy}
      disabled={!!nameProblem || noHash || (!!base && !preview)}
      onSubmit={() => void save()}
    >
      <FormField
        label={t('database:databaseRoles.name')}
        htmlFor="role-name"
        description={nameProblem && next.name ? <span className="text-destructive">{nameProblem}</span> : t('database:databaseRoles.upTo63Bytes')}
      >
        <Input id="role-name" autoFocus value={role.name} onChange={(e) => set({ name: e.target.value })} placeholder="reporting" />
      </FormField>
      <FormField
        label={original ? t('database:databaseRoles.newPasswordOptional') : t('database:databaseRoles.passwordOptional')}
        htmlFor="role-password"
        description={
          original
            ? t('database:databaseRoles.leaveBlankToKeepTheCurrent')
            : t('database:databaseRoles.leaveBlankForARoleThat')
        }
      >
        <Input id="role-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </FormField>
      {noHash && (
        <Alert
          variant="warning"
          title={t('database:databaseRoles.passwordsCanOnlyBeSetOver')}
        >
          {t('database:databaseRoles.browsersOnlyAllowPasswordHashingOn')}
        </Alert>
      )}
      {base && renaming && !password && original?.login && (
        <Alert
          variant="warning"
          title={t('database:databaseRoles.renamingCanClearThePassword')}
        >
          {t('database:databaseRoles.ifThisRoleSPasswordIs')}
        </Alert>
      )}
      <div className="flex flex-col gap-2.5 text-sm">
        {flags.map(([key, label, hint]) => (
          <label key={key} className="flex items-start gap-2">
            <Checkbox checked={role[key] as boolean} onCheckedChange={(c) => set({ [key]: c === true })} className="mt-0.5" />
            <span>
              {label}
              {hint && <span className="block text-xs text-foreground-lighter">{hint}</span>}
            </span>
          </label>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('database:databaseRoles.connectionLimit')} htmlFor="role-limit" description={t('database:databaseRoles.n1OrBlankForNoLimit')}>
          <Input
            id="role-limit"
            inputMode="numeric"
            value={limitText}
            onChange={(e) => /^-?\d*$/.test(e.target.value) && setLimitText(e.target.value)}
          />
        </FormField>
        <FormField label={t('database:databaseRoles.validUntilOptional')} htmlFor="role-valid" description={t('database:databaseRoles.thePasswordWorksThroughTheEnd')}>
          <Input
            id="role-valid"
            type="date"
            value={expiryToDate(role.validUntil)}
            onChange={(e) => {
              const date = e.target.value
              // Re-picking the stored date keeps the exact stored time.
              set({ validUntil: base && date === expiryToDate(base.validUntil) ? base.validUntil : dateToExpiry(date) })
            }}
          />
        </FormField>
      </div>
      {preview && <SqlPreview sql={preview} />}
    </EditorSheet>
  )
}
