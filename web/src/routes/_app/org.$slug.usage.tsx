import { useQueries } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'

import { PageContainer, PageHeader } from '@/components/layout/page'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { can, useProjects } from '@/lib/api/hooks'
import { pgQuery } from '@/lib/pg/run'
import { USAGE_SQL, type ProjectUsage } from '@/lib/pg/usage'
import { formatBytes } from '@/lib/storage-api'
import { t, language } from '@/lib/i18n'

export const Route = createFileRoute('/_app/org/$slug/usage')({
  component: UsagePage,
})

function UsagePage() {
  const { slug } = Route.useParams()
  const projects = useProjects()
  const inOrg = (projects.data ?? []).filter((p) => p.organization_slug === slug)
  const readable = inOrg.filter((p) => can(p, 'project:data:read'))
  const usage = useQueries({
    queries: readable.map((p) => ({ ...pgQuery<ProjectUsage>(p.ref, ['usage'], USAGE_SQL), refetchInterval: 60_000 })),
  })
  const byRef = new Map(readable.map((p, i) => [p.ref, usage[i]!]))
  const loaded = usage.map((u) => u.data?.[0]).filter((u): u is ProjectUsage => !!u)
  // Projects without Storage or Auth tables count as zero in the totals.
  const sum = (k: keyof ProjectUsage) => loaded.reduce((n, u) => n + (u[k] ?? 0), 0)

  return (
    <>
      <PageHeader
        title={t('org:usage.usage')}
        description={t('org:usage.whatEachProjectSStackUses')}
        size="large"
      />
      <PageContainer size="large" className="flex flex-col gap-6 pb-16">
        {projects.isPending ? (
          <Skeleton className="h-40" />
        ) : inOrg.length === 0 ? (
          <Card>
            <p className="px-4 py-10 text-center text-sm text-foreground-lighter">{t('org:usage.noProjectsInThisOrganizationYet')}</p>
          </Card>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t('org:usage.databaseSize')} value={formatBytes(sum('db_bytes'))} />
              <Stat label={t('org:usage.storage')} value={formatBytes(sum('storage_bytes'))} hint={t('org:usage.files', { value: sum('storage_objects').toLocaleString(language()) })} />
              <Stat label={t('org:usage.authUsers')} value={sum('users').toLocaleString(language())} />
              <Stat label={t('org:usage.connections')} value={sum('connections').toLocaleString(language())} hint={t('org:usage.ofAllowed', { value: sum('max_connections').toLocaleString(language()) })} />
            </div>
            <Card>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('org:usage.project')}</TableHead>
                    <TableHead className="text-right">{t('org:usage.database')}</TableHead>
                    <TableHead className="text-right">{t('org:usage.storage')}</TableHead>
                    <TableHead className="text-right">{t('org:usage.authUsers')}</TableHead>
                    <TableHead className="text-right">{t('org:usage.connections')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inOrg.map((p) => {
                    const q = byRef.get(p.ref)
                    const u = q?.data?.[0]
                    return (
                      <TableRow key={p.ref}>
                        <TableCell>
                          <Link to="/project/$ref" params={{ ref: p.ref }} className="text-foreground underline-offset-2 hover:underline">
                            {p.name}
                          </Link>
                        </TableCell>
                        {!q ? (
                          <TableCell colSpan={4} className="text-right text-xs text-foreground-lighter">
                            {t('org:usage.youCanTReadThisProject')}
                          </TableCell>
                        ) : q.error ? (
                          <TableCell colSpan={4} className="text-right text-xs text-destructive" title={q.error.message}>
                            {t('org:usage.couldnTReadUsage', { message: q.error.message })}
                          </TableCell>
                        ) : !u ? (
                          <TableCell colSpan={4}>
                            <Skeleton className="ml-auto h-4 w-64" />
                          </TableCell>
                        ) : (
                          <>
                            <TableCell className="text-right tabular-nums text-foreground-light">{formatBytes(u.db_bytes)}</TableCell>
                            <TableCell className="text-right tabular-nums text-foreground-light">
                              {u.storage_bytes === null ? (
                                <span title={t('org:usage.thisStackHasNoStorageTables')}>—</span>
                              ) : (
                                <>
                                  {formatBytes(u.storage_bytes)}
                                  <span className="ml-1 text-xs text-foreground-lighter">{t('org:usage.files2', { value: (u.storage_objects ?? 0).toLocaleString(language()) })}</span>
                                </>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-foreground-light">
                              {u.users === null ? <span title={t('org:usage.thisStackHasNoAuthTables')}>—</span> : u.users.toLocaleString(language())}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-foreground-light">
                              {u.connections} / {u.max_connections}
                            </TableCell>
                          </>
                        )}
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </Card>
            <Alert title={t('org:usage.requestCountsAndEgressNeedLog')}>
              {t('org:usage.theyComeFromTheStackS')}
            </Alert>
          </>
        )}
      </PageContainer>
    </>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-xs text-foreground-lighter">{label}</span>
      <span className="text-2xl text-foreground tabular-nums">{value}</span>
      {hint && <span className="text-xs text-foreground-lighter">{hint}</span>}
    </Card>
  )
}
