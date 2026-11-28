/*
 * Instance › Organizations: every organization on the instance, for reports
 * on how it's used. Read-only, and metadata only: listing an organization
 * gives no access to it, which stays with its members.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { FilterSelect, ReportToolbar, Stat, today } from '@/components/admin/report-parts'
import { AdminLayout } from '@/components/layout/admin-layout'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { relativeTime } from '@/lib/auth-users'
import { inEnglish, language, localized, t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/admin/organizations')({
  component: OrganizationsPage,
})

type Organization = Schemas['InstanceOrganization']

const DAY = 24 * 60 * 60 * 1000

// Single sign-on that's enforced: its provider is still set up here.
const sso = (o: Organization) => !!o.sso_provider && !o.sso_provider_missing
const atLimit = (o: Organization) => o.project_limit !== null && o.projects >= o.project_limit
const quiet = (o: Organization) =>
  !o.last_activity_at || Date.now() - new Date(o.last_activity_at).getTime() > 30 * DAY

const FILTERS = localized((): { value: string; label: string; match: (o: Organization) => boolean }[] => [
  { value: 'all', label: t('admin:adminOrganizations.all'), match: () => true },
  { value: 'projects', label: t('admin:adminOrganizations.withProjects'), match: (o) => o.projects > 0 },
  { value: 'no-projects', label: t('admin:adminOrganizations.withoutProjects'), match: (o) => o.projects === 0 },
  { value: 'limit', label: t('admin:adminOrganizations.atTheirProjectLimit'), match: atLimit },
  { value: 'mfa', label: t('admin:adminOrganizations.twoFactorRequired'), match: (o) => o.mfa_required },
  { value: 'sso', label: t('admin:adminOrganizations.singleSignOn'), match: sso },
  { value: 'sso-missing', label: t('admin:adminOrganizations.signOnProviderMissing'), match: (o) => o.sso_provider_missing },
  { value: 'quiet', label: t('admin:adminOrganizations.nothingIn30Days'), match: quiet },
])

function OrganizationsPage() {
  const { data: me } = useProfile()
  const list = useQuery({
    queryKey: ['admin', 'organizations'],
    queryFn: () => unwrap(api.GET('/admin/organizations')),
    enabled: !!me?.is_instance_admin,
  })
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const all = list.data ?? []
  const needle = search.trim().toLowerCase()
  const match = (FILTERS().find((f) => f.value === filter) ?? FILTERS()[0]).match
  const shown = all.filter(
    (o) =>
      match(o) &&
      (!needle ||
        [o.name, o.slug, o.created_by ?? '', ...o.owners].some((s) => s.toLowerCase().includes(needle)))
  )
  const filtering = needle !== '' || filter !== 'all'
  const withProjects = all.filter((o) => o.projects > 0).length

  return (
    <AdminLayout
      title={t('admin:adminOrganizations.organizations')}
      description={t('admin:adminOrganizations.everyOrganizationOnThisInstanceFor')}
    >
      {list.isError ? (
        <Alert variant="destructive" title={list.error.message} />
      ) : list.isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label={t('admin:adminOrganizations.organizations')} value={all.length} detail={t('admin:adminOrganizations.withProjects2', { withProjects })} />
            <Stat label={t('admin:adminOrganizations.members')} value={all.reduce((n, o) => n + o.members, 0)} detail={t('admin:adminOrganizations.countingEachMembership')} />
            <Stat
              label={t('admin:adminOrganizations.activeIn30Days')}
              value={all.filter((o) => !quiet(o)).length}
              detail={t('admin:adminOrganizations.of', { length: all.length })}
            />
            <Stat label={t('admin:adminOrganizations.twoFactorRequired')} value={all.filter((o) => o.mfa_required).length} />
            <Stat label={t('admin:adminOrganizations.singleSignOn')} value={all.filter(sso).length} />
          </div>
          <ReportToolbar
            search={search}
            onSearch={setSearch}
            placeholder={t('admin:adminOrganizations.searchOrganizations')}
            filters={<FilterSelect label={t('admin:adminOrganizations.show')} value={filter} onChange={setFilter} choices={FILTERS()} />}
            shown={shown.length}
            total={all.length}
            noun="organizations"
            filtering={filtering}
            onClear={() => {
              setSearch('')
              setFilter('all')
            }}
            csv={{
              name: `supermixer-organizations-${today()}.csv`,
              header: inEnglish(() => [
                t('admin:adminOrganizations.organization'),
                t('admin:adminOrganizations.slug'),
                t('admin:adminOrganizations.owners'),
                t('admin:adminOrganizations.members'),
                t('admin:adminOrganizations.projects'),
                t('admin:adminOrganizations.createdBySupermixer'),
                t('admin:adminOrganizations.projectLimit'),
                t('admin:adminOrganizations.twoFactorRequired'),
                t('admin:adminOrganizations.singleSignOn'),
                t('admin:adminOrganizations.singleSignOnRequired'),
                t('admin:adminOrganizations.created'),
                t('admin:adminOrganizations.createdBy'),
                t('admin:adminOrganizations.lastActivity'),
              ]),
              rows: () =>
                inEnglish(() =>
                  shown.map((o) => [
                    o.name,
                    o.slug,
                    o.owners.join('; '),
                    o.members,
                    o.projects,
                    o.managed_projects,
                    o.project_limit ?? '',
                    o.mfa_required ? 'yes' : 'no',
                    o.sso_provider ? `${o.sso_provider}${o.sso_provider_missing ? ' (missing)' : ''}` : '',
                    sso(o) && o.sso_required ? 'yes' : 'no',
                    o.created_at,
                    o.created_by ?? '',
                    o.last_activity_at ?? '',
                  ]),
                ),
            }}
          />
          <Card>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('admin:adminOrganizations.organization')}</TableHead>
                  <TableHead>{t('admin:adminOrganizations.owners')}</TableHead>
                  <TableHead className="text-right">{t('admin:adminOrganizations.members')}</TableHead>
                  <TableHead className="text-right">{t('admin:adminOrganizations.projects')}</TableHead>
                  <TableHead>{t('admin:adminOrganizations.signIn')}</TableHead>
                  <TableHead>{t('admin:adminOrganizations.created')}</TableHead>
                  <TableHead>{t('admin:adminOrganizations.lastActivity')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7} className="py-10 text-center text-foreground-lighter">
                      {all.length === 0 ? t('admin:adminOrganizations.noOrganizationsYet') : t('admin:adminOrganizations.noOrganizationsMatchTheseFilters')}
                    </TableCell>
                  </TableRow>
                )}
                {shown.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>
                      <span className="flex flex-col">
                        <span className="text-foreground">{o.name}</span>
                        <span className="text-xs text-foreground-lighter">{o.slug}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-foreground-light">
                      {o.owners.length > 0 ? o.owners.join(', ') : <span className="text-foreground-lighter">{t('admin:adminOrganizations.none')}</span>}
                    </TableCell>
                    <TableCell className="text-right text-foreground-light tabular-nums">{o.members}</TableCell>
                    <TableCell className="text-right text-foreground-light tabular-nums">
                      <span className="flex flex-col items-end">
                        <span>
                          {o.projects}
                          {o.project_limit !== null && (
                            <span className="text-foreground-lighter"> {t('admin:adminOrganizations.of2', { projectLimit: o.project_limit })}</span>
                          )}
                        </span>
                        {atLimit(o) && <span className="text-xs text-warning">{t('admin:adminOrganizations.atTheLimit')}</span>}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {o.mfa_required && <Badge variant="success">{t('admin:adminOrganizations.n2faRequired')}</Badge>}
                        {o.sso_provider_missing ? (
                          <Badge
                            variant="destructive"
                            title={t('admin:adminOrganizations.isNoLongerSetUpOn', { ssoProvider: o.sso_provider })}
                          >
                            {t('admin:adminOrganizations.missing', { ssoProvider: o.sso_provider })}
                          </Badge>
                        ) : (
                          o.sso_provider && (
                            <Badge variant={o.sso_required ? 'success' : 'default'}>
                              {o.sso_provider}
                              {o.sso_required ? ' required' : ''}
                            </Badge>
                          )
                        )}
                        {!o.mfa_required && !o.sso_provider && <span className="text-foreground-lighter">—</span>}
                      </span>
                    </TableCell>
                    <TableCell className="text-foreground-light">
                      <span className="flex flex-col">
                        <span title={new Date(o.created_at).toLocaleString(language())}>{relativeTime(o.created_at)}</span>
                        {o.created_by && <span className="text-xs text-foreground-lighter">{t('admin:adminOrganizations.by', { createdBy: o.created_by })}</span>}
                      </span>
                    </TableCell>
                    <TableCell className="text-foreground-light">
                      {o.last_activity_at ? (
                        <span title={new Date(o.last_activity_at).toLocaleString(language())}>
                          {relativeTime(o.last_activity_at)}
                        </span>
                      ) : (
                        <span className="text-foreground-lighter">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </AdminLayout>
  )
}
