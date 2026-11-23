import { createFileRoute } from '@tanstack/react-router'

import { CatalogTable, Code, DatabasePage } from '@/components/database/catalog-page'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { HAS_MIGRATIONS_SQL, MIGRATIONS_SQL, type MigrationRow } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'

export const Route = createFileRoute('/_app/project/$ref/database/migrations')({
  component: MigrationsPage,
})

function MigrationsPage() {
  const { ref } = Route.useParams()
  const has = usePg<{ present: boolean }>(ref, ['migrations-present'], HAS_MIGRATIONS_SQL)
  const present = has.data?.[0]?.present
  return (
    <DatabasePage title="Migrations" description="Migrations applied with the Supabase CLI (supabase db push), newest first.">
      {has.error ? <Alert variant="destructive" title={has.error.message} /> : has.isPending ? <Skeleton className="h-32" /> : present ? <MigrationList projectRef={ref} /> : (
        <Card className="flex flex-col gap-2 p-6 text-sm">
          <p className="text-foreground">No migration history on this database yet.</p>
          <p className="text-foreground-light">
            The Supabase CLI records migrations in <code className="font-mono text-xs">supabase_migrations.schema_migrations</code> the
            first time you run <code className="font-mono text-xs">supabase db push --db-url …</code> against this stack, using the
            connection string from Connect.
          </p>
        </Card>
      )}
    </DatabasePage>
  )
}

function MigrationList({ projectRef }: { projectRef: string }) {
  const migrations = usePg<MigrationRow>(projectRef, ['migrations'], MIGRATIONS_SQL)
  return (
    <CatalogTable
      rows={migrations.data}
      loading={migrations.isPending}
      error={migrations.error}
      rowKey={(m) => m.version}
      empty="No migrations applied"
      columns={[
        { header: 'Version', cell: (m) => <Code>{m.version}</Code> },
        { header: 'Name', cell: (m) => m.name ?? '—' },
        { header: 'Statements', cell: (m) => m.statements, className: 'text-right whitespace-nowrap' },
      ]}
    />
  )
}
