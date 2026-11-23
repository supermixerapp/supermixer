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
  if (name.startsWith('supermixer_ro_')) return 'Supermixer read-only'
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
      title="Database Roles"
      description={`Who can connect and what they may do. ${total} connection${total === 1 ? '' : 's'} open right now.`}
      toolbar={<SearchBox value={search} onChange={setSearch} placeholder="Search for a role" />}
      actions={
        <PermissionButton allowed={canChange} action="manage roles" variant="primary" icon={<AddIcon />} onClick={() => setEditing({})}>
          Add role
        </PermissionButton>
      }
    >
      <CatalogTable
        rows={rows}
        loading={roles.isPending}
        error={roles.error}
        rowKey={(r) => r.name}
        empty="No roles match your search"
        columns={[
          {
            header: 'Role',
            cell: (r) => (
              <span className="flex items-center gap-2 text-foreground">
                {r.name}
                {managedBy(r.name) && <Badge>{managedBy(r.name)}</Badge>}
              </span>
            ),
          },
          {
            header: 'Attributes',
            cell: (r) => (
              <span className="flex flex-wrap gap-1">
                {r.superuser && <Badge variant="destructive">superuser</Badge>}
                {r.login && <Badge>login</Badge>}
                {r.bypass_rls && <Badge variant="warning">bypass RLS</Badge>}
                {r.create_role && <Badge>create role</Badge>}
                {r.create_db && <Badge>create db</Badge>}
                {r.replication && <Badge>replication</Badge>}
                {r.valid_until && <Badge>expires {expiryToDate(r.valid_until)}</Badge>}
              </span>
            ),
          },
          {
            header: 'Connections',
            cell: (r) => `${r.connections}${r.connection_limit >= 0 ? ` / ${r.connection_limit}` : ''}`,
            className: 'text-right whitespace-nowrap',
          },
        ]}
        actions={[
          { label: 'Edit role', hidden: (r) => !canChange || !!lockedReason(r), onSelect: (r) => setEditing({ original: r }) },
          {
            label: 'Delete role',
            hidden: (r) => !canChange || !!managedBy(r.name) || r.superuser,
            confirm: (r) => ({
              title: `Delete role ${r.name}?`,
              description: 'Roles that own objects or hold privileges can\'t be dropped until those are reassigned or revoked.',
              confirmText: r.name,
            }),
            onSelect: (r) => ddl.mutate({ sql: dropRole(r.name), done: `Deleted ${r.name}` }),
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
  const nameProblem = renaming ? (roleNameProblem(next.name) ?? (managedBy(next.name) ? "That name is reserved for Supabase's or Supermixer's own roles." : null)) : null
  const noHash = !!password && !canHashPasswords()
  // The preview shows where the password goes without revealing it.
  const mask = password ? 'SCRAM-SHA-256$…' : null
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
    ddl.mutate({ sql, done: base ? `Updated ${next.name}` : `Created ${next.name}` }, { onSuccess: onClose })
  }

  const flags: [keyof RoleDef, string, string][] = [
    ['login', 'Can log in', 'Needed to connect; group roles usually leave it off.'],
    ['inherit', 'Inherit privileges', 'Gets the privileges of roles it is a member of.'],
    ['createDb', 'Create databases', ''],
    ['createRole', 'Create roles', 'Can create, alter and drop other roles.'],
    ['replication', 'Replication', 'Can start streaming replication. On Postgres 15 only a superuser can set this.'],
    ['bypassRls', 'Bypass Row Level Security', 'Ignores every RLS policy. Use with care.'],
  ]

  return (
    <EditorSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={original ? `Edit role ${original.name}` : 'Add a role'}
      description={
        <>
          Passwords are hashed with SCRAM-SHA-256 in your browser; Postgres only receives the hash. Through the pooler,
          sign in as <code className="font-mono">{next.name || 'name'}.&lt;tenant&gt;</code>.
        </>
      }
      error={hashError ?? ddl.error}
      submitLabel={original ? 'Save role' : 'Add role'}
      submitting={busy}
      disabled={!!nameProblem || noHash || (!!base && !preview)}
      onSubmit={() => void save()}
    >
      <FormField
        label="Name"
        htmlFor="role-name"
        description={nameProblem && next.name ? <span className="text-destructive">{nameProblem}</span> : 'Up to 63 bytes; names starting with pg_ are reserved.'}
      >
        <Input id="role-name" autoFocus value={role.name} onChange={(e) => set({ name: e.target.value })} placeholder="reporting" />
      </FormField>
      <FormField
        label={original ? 'New password (optional)' : 'Password (optional)'}
        htmlFor="role-password"
        description={
          original
            ? 'Leave blank to keep the current password. The pooler (Supavisor) caches passwords, so a new one may take a while to work through it; direct connections use it at once.'
            : 'Leave blank for a role that signs in another way, or not at all.'
        }
      >
        <Input id="role-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </FormField>
      {noHash && (
        <Alert
          variant="warning"
          title="Passwords can only be set over HTTPS"
        >
          Browsers only allow password hashing on HTTPS or localhost. Open Supermixer over HTTPS, or leave the password blank.
        </Alert>
      )}
      {base && renaming && !password && original?.login && (
        <Alert
          variant="warning"
          title="Renaming can clear the password"
        >
          If this role's password is stored as MD5 (older stacks), Postgres clears it on rename and the role can no longer sign in. Set a new password here to be safe.
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
        <FormField label="Connection limit" htmlFor="role-limit" description="-1 or blank for no limit; 0 blocks every connection.">
          <Input
            id="role-limit"
            inputMode="numeric"
            value={limitText}
            onChange={(e) => /^-?\d*$/.test(e.target.value) && setLimitText(e.target.value)}
          />
        </FormField>
        <FormField label="Valid until (optional)" htmlFor="role-valid" description="The password works through the end of this day, in your time zone.">
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
