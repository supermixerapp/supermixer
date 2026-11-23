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

export const Route = createFileRoute('/_app/project/$ref/database/settings')({
  component: DatabaseSettingsPage,
})

function DatabaseSettingsPage() {
  const { ref } = Route.useParams()
  const project = useSelectedProject()
  const settings = usePg<DatabaseSettings>(ref, ['db-settings'], SETTINGS_SQL)
  const s = settings.data?.[0]
  return (
    <DatabasePage title="Database Settings" description="How this stack's Postgres is reached and configured. Changing these needs the stack's own configuration (Stage 4).">
      <SettingsSection title="Connection">
        <Card className="flex flex-col gap-4 p-5">
          {project && (
            <>
              <Row label="Connection string">
                <CopyField value={project.database.uri} />
              </Row>
              <Row label="Host">{project.database.host}:{project.database.port}</Row>
              <Row label="Database">{project.database.name}</Row>
              <Row label="User">{project.database.user}</Row>
              <Row label="SSL mode">{project.database.sslmode}</Row>
            </>
          )}
        </Card>
      </SettingsSection>
      <SettingsSection title="Server">
        <Card className="p-5">
          {settings.error ? (
            <Alert variant="destructive" title={settings.error.message} />
          ) : settings.isPending || !s ? (
            <Skeleton className="h-32" />
          ) : (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Row label="Postgres version">{s.version}</Row>
              <Row label="Database size">{s.size}</Row>
              <Row label="Connections">{s.connections} of {s.max_connections}</Row>
              <Row label="Statement timeout">{s.statement_timeout === '0' ? 'none' : s.statement_timeout}</Row>
              <Row label="Time zone">{s.timezone}</Row>
              <Row label="SSL">{s.ssl}</Row>
              <Row label="WAL level">{s.wal_level}</Row>
              <Row label="Shared buffers">{s.shared_buffers}</Row>
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
