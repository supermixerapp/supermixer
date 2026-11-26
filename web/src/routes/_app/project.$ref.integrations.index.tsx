import { createFileRoute, Link } from '@tanstack/react-router'

import { DatabasePage } from '@/components/database/catalog-page'
import { ApiIcon, BoltIcon, CableIcon, HistoryIcon, KeyIcon, ListIcon, SchemaIcon } from '@/components/icons'
import type { Icon } from '@/components/icon'
import { Badge } from '@/components/ui/badge'
import { usePg } from '@/lib/pg/run'

export const Route = createFileRoute('/_app/project/$ref/integrations/')({
  component: IntegrationsPage,
})

interface Integration {
  key: string
  title: string
  description: string
  icon: Icon
  /** Path under /project/$ref. */
  path: string
  /** Extensions it needs; none means it's built in. */
  extensions: string[]
}

/** Studio's Supabase integrations (Integrations.constants.tsx), the ones a self-hosted stack can run. */
const INTEGRATIONS: Integration[] = [
  {
    key: 'cron',
    title: 'Cron',
    description: 'Schedule recurring jobs in Postgres: SQL, database functions or HTTP requests.',
    icon: HistoryIcon,
    path: 'integrations/cron',
    extensions: ['pg_cron'],
  },
  {
    key: 'queues',
    title: 'Queues',
    description: 'Durable message queues in Postgres with guaranteed delivery, using pgmq.',
    icon: ListIcon,
    path: 'integrations/queues',
    extensions: ['pgmq'],
  },
  {
    key: 'vault',
    title: 'Vault',
    description: 'Store secrets encrypted in the database and read them from SQL.',
    icon: KeyIcon,
    path: 'integrations/vault',
    extensions: ['supabase_vault'],
  },
  {
    key: 'webhooks',
    title: 'Database Webhooks',
    description: 'Send an HTTP request when rows are inserted, updated or deleted.',
    icon: BoltIcon,
    path: 'integrations/webhooks',
    extensions: ['pg_net'],
  },
  {
    key: 'wrappers',
    title: 'Wrappers',
    description: 'Query Stripe, S3, BigQuery, ClickHouse and other services as Postgres tables.',
    icon: CableIcon,
    path: 'integrations/wrappers',
    // Wrappers keep their credentials in Vault.
    extensions: ['wrappers', 'supabase_vault'],
  },
  {
    key: 'graphiql',
    title: 'GraphiQL',
    description: 'Query the database with GraphQL through pg_graphql.',
    icon: SchemaIcon,
    path: 'integrations/graphiql',
    extensions: ['pg_graphql'],
  },
  {
    key: 'data_api',
    title: 'Data API',
    description: 'The REST API PostgREST serves for your tables, views and functions, with generated docs.',
    icon: ApiIcon,
    path: 'integrations/data_api/docs',
    extensions: [],
  },
]

const INSTALLED_SQL = `select extname as name from pg_extension where extname = any($1::text[])`

function IntegrationsPage() {
  const { ref } = Route.useParams()
  const names = INTEGRATIONS.flatMap((i) => i.extensions)
  const installed = usePg<{ name: string }>(ref, ['integrations-installed'], INSTALLED_SQL, [`{${names.join(',')}}`])
  const has = new Set((installed.data ?? []).map((r) => r.name))

  return (
    <DatabasePage title="Project Integrations" description="Extend the database with Supabase's Postgres modules. Each one runs inside this project's stack.">
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {INTEGRATIONS.map((i) => {
          const on = i.extensions.every((e) => has.has(e))
          const IconC = i.icon
          const to: string = `/project/${ref}/${i.path}`
          return (
            <li key={i.key}>
              <Link
                to={to}
                className="flex h-full flex-col gap-3 rounded-lg border bg-surface-100 p-5 transition-colors focus-ring hover:border-strong hover:bg-surface-200"
              >
                <span className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-md border bg-surface-200 text-foreground-light">
                    <IconC size={18} />
                  </span>
                  <span className="text-sm text-foreground">{i.title}</span>
                  {installed.data && (
                    <Badge className="ml-auto" variant={on ? 'success' : 'default'}>
                      {i.extensions.length === 0 ? 'Built in' : on ? 'Installed' : 'Not installed'}
                    </Badge>
                  )}
                </span>
                <span className="text-sm text-foreground-light">{i.description}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </DatabasePage>
  )
}
