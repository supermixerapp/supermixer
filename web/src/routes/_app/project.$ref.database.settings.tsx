import { createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { DatabasePage } from '@/components/database/catalog-page'
import { SettingsSection } from '@/components/layout/section'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
import { Skeleton } from '@/components/ui/skeleton'
import { useSelectedProject } from '@/lib/api/hooks'
import { SETTINGS_SQL, type DatabaseSettings } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'
import { t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/project/$ref/database/settings')({
  component: DatabaseSettingsPage,
})

function DatabaseSettingsPage() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  const settings = usePg<DatabaseSettings>(ref, ['db-settings'], SETTINGS_SQL)
  const s = settings.data?.[0]
  return (
    <DatabasePage title={t('database:databaseSettings.databaseSettings')} description={t('database:databaseSettings.howThisStackSPostgresIs')}>
      <SettingsSection title={t('database:databaseSettings.connection')}>
        <Card className="flex flex-col gap-4 p-5">
          {project && (
            <>
              <Row label={t('database:databaseSettings.connectionString')}>
                <CopyField value={project.database.uri} />
              </Row>
              <Row label={t('database:databaseSettings.host')}>{project.database.host}:{project.database.port}</Row>
              <Row label={t('database:databaseSettings.database')}>{project.database.name}</Row>
              <Row label={t('database:databaseSettings.user')}>{project.database.user}</Row>
              <Row label={t('database:databaseSettings.sslMode')}>{project.database.sslmode}</Row>
            </>
          )}
        </Card>
      </SettingsSection>
      <SettingsSection title={t('database:databaseSettings.server')}>
        <Card className="p-5">
          {settings.error ? (
            <Alert variant="destructive" title={settings.error.message} />
          ) : settings.isPending || !s ? (
            <Skeleton className="h-32" />
          ) : (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Row label={t('database:databaseSettings.postgresVersion')}>{s.version}</Row>
              <Row label={t('database:databaseSettings.databaseSize')}>{s.size}</Row>
              <Row label={t('database:databaseSettings.connections')}>{t('database:databaseSettings.of', { connections: s.connections, maxConnections: s.max_connections })}</Row>
              <Row label={t('database:databaseSettings.statementTimeout')}>{s.statement_timeout === '0' ? 'none' : s.statement_timeout}</Row>
              <Row label={t('database:databaseSettings.timeZone')}>{s.timezone}</Row>
              <Row label={t('database:databaseSettings.ssl')}>{s.ssl}</Row>
              <Row label={t('database:databaseSettings.walLevel')}>{s.wal_level}</Row>
              <Row label={t('database:databaseSettings.sharedBuffers')}>{s.shared_buffers}</Row>
            </dl>
          )}
        </Card>
      </SettingsSection>
    </DatabasePage>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-foreground-lighter">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  )
}
