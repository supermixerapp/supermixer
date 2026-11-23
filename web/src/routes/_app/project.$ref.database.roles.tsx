import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { CatalogTable, DatabasePage, SearchBox } from '@/components/database/catalog-page'
import { Badge } from '@/components/ui/badge'
import { ROLES_SQL, type RoleRow } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'

export const Route = createFileRoute('/_app/project/$ref/database/roles')({
  component: RolesPage,
})

/** Roles Supabase's services sign in as or switch to. */
const SUPABASE_ROLES = new Set([
  'anon', 'authenticated', 'service_role', 'authenticator', 'dashboard_user', 'pgbouncer', 'postgres', 'supabase_admin',
  'supabase_auth_admin', 'supabase_functions_admin', 'supabase_read_only_user', 'supabase_realtime_admin',
  'supabase_replication_admin', 'supabase_storage_admin', 'supabase_etl_admin', 'supabase_privileged_role',
])

function RolesPage() {
  const { ref } = Route.useParams()
  const [search, setSearch] = useState('')
  const roles = usePg<RoleRow>(ref, ['roles'], ROLES_SQL)
  const rows = roles.data?.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))
  const total = (roles.data ?? []).reduce((n, r) => n + r.connections, 0)

  return (
    <DatabasePage
      title="Database Roles"
      description={`Who can connect and what they may do. ${total} connection${total === 1 ? '' : 's'} open right now.`}
      toolbar={<SearchBox value={search} onChange={setSearch} placeholder="Search for a role" />}
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
                {SUPABASE_ROLES.has(r.name) && <Badge>Supabase</Badge>}
                {r.name.startsWith('supermixer_ro_') && <Badge>Supermixer read-only</Badge>}
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
              </span>
            ),
          },
          { header: 'Connections', cell: (r) => `${r.connections}${r.connection_limit >= 0 ? ` / ${r.connection_limit}` : ''}`, className: 'text-right whitespace-nowrap' },
        ]}
      />
    </DatabasePage>
  )
}
