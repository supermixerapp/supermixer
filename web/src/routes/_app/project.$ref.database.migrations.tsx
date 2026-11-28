import { createFileRoute } from '@tanstack/react-router'

import { CatalogTable, Code, DatabasePage } from '@/components/database/catalog-page'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { HAS_MIGRATIONS_SQL, MIGRATIONS_SQL, type MigrationRow } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'
import { t, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/database/migrations')({
  component: MigrationsPage,
})

function MigrationsPage() {
  const { ref } = Route.useParams()
  const has = usePg<{ present: boolean }>(ref, ['migrations-present'], HAS_MIGRATIONS_SQL)
  const present = has.data?.[0]?.present
  return (
    <DatabasePage title={t('database:databaseMigrations.migrations')} description={t('database:databaseMigrations.migrationsAppliedWithTheSupabaseCli')}>
      {has.error ? <Alert variant="destructive" title={has.error.message} /> : has.isPending ? <Skeleton className="h-32" /> : present ? <MigrationList projectRef={ref} /> : (
        <Card className="flex flex-col gap-2 p-6 text-sm">
          <p className="text-foreground">{t('database:databaseMigrations.noMigrationHistoryOnThisDatabase')}</p>
          <p className="text-foreground-light">
            <Trans i18nKey="database:databaseMigrations.theSupabaseCliRecordsMigrationsIn" components={{ code: <code className="font-mono text-xs" />, code2: <code className="font-mono text-xs" /> }} />
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
      empty={t('database:databaseMigrations.noMigrationsApplied')}
      columns={[
        { header: t('database:databaseMigrations.version'), cell: (m) => <Code>{m.version}</Code> },
        { header: t('database:databaseMigrations.name'), cell: (m) => m.name ?? '—' },
        { header: t('database:databaseMigrations.statements'), cell: (m) => m.statements, className: 'text-right whitespace-nowrap' },
      ]}
    />
  )
}
