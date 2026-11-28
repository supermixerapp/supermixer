import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { SearchBox } from '@/components/database/catalog-page'
import { AppShell } from '@/components/layout/app-shell'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { Alert } from '@/components/ui/alert'
import { Badge, badgeVariants, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { localized, t as tr, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/docs/api')({
  component: ApiDocsPage,
})

const SPEC_URL = '/api/v1/openapi.json'

type Endpoint = { methods: string[]; path: string; purpose: string; public?: boolean }
type Section = { id: string; title: string; note?: string; rows: Endpoint[] }

type Spec = {
  tags?: { name: string; description?: string }[]
  paths: Record<string, Record<string, { tags?: string[]; summary?: string; security?: unknown[] }>>
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete']

// Sections in reading order, named for people rather than by tag.
const TAGS = localized((): { tag: string; title: string }[] => [
  { tag: 'System', title: tr('docs:docsApi.system') },
  { tag: 'Auth', title: tr('docs:docsApi.signingIn') },
  { tag: 'Profile', title: tr('docs:docsApi.yourAccount') },
  { tag: 'Users', title: tr('docs:docsApi.instanceAdministration') },
  { tag: 'Organizations', title: tr('docs:docsApi.organizations') },
  { tag: 'Members', title: tr('docs:docsApi.members') },
  { tag: 'Invitations', title: tr('docs:docsApi.invitations') },
  { tag: 'Webhooks', title: tr('docs:docsApi.webhooks') },
  { tag: 'Audit', title: tr('docs:docsApi.auditLogs') },
  { tag: 'Projects', title: tr('docs:docsApi.projects') },
  { tag: 'Database', title: tr('docs:docsApi.database') },
  { tag: 'Advisors', title: tr('docs:docsApi.advisors') },
  { tag: 'Backups', title: tr('docs:docsApi.backups') },
  { tag: 'Edge Functions', title: tr('docs:docsApi.edgeFunctions') },
])

// Routes the OpenAPI description doesn't cover: redirects, the gateway
// proxy, the Supabase-style /v1 API and metrics.
const EXTRA = localized((): Section[] => [
  {
    id: 'outside-spec',
    title: tr('docs:docsApi.otherRoutes'),
    note: tr('docs:docsApi.underApiV1HandledOutsideThe'),
    rows: [
      {
        methods: ['GET'],
        path: '/openapi.json',
        purpose: tr('docs:docsApi.thisApiSOpenapiDescriptionWith'),
      },
      {
        methods: ['GET'],
        path: '/auth/sso/{provider}/start',
        purpose: tr('docs:docsApi.beginSigningInWithASingle'),
        public: true,
      },
      {
        methods: ['GET'],
        path: '/auth/sso/{provider}/callback',
        purpose: tr('docs:docsApi.whereTheSignOnProviderSends'),
        public: true,
      },
      {
        methods: ['GET'],
        path: '/tls/ca.pem',
        purpose: tr('docs:docsApi.supermixerSOwnCaCertificateTo'),
        public: true,
      },
      {
        methods: ['POST'],
        path: '/profile/identities/{provider}/connect',
        purpose: tr('docs:docsApi.connectASignInProviderTo'),
      },
      {
        methods: ['ANY'],
        path: '/projects/{ref}/gateway/*',
        purpose:
          tr('docs:docsApi.proxyToTheProjectSOwn'),
      },
    ],
  },
  {
    id: 'management-api',
    title: tr('docs:docsApi.supabaseStyleManagementApi'),
    note: tr('docs:docsApi.underV1NotApiV1A'),
    rows: [
      { methods: ['GET'], path: '/v1/organizations', purpose: tr('docs:docsApi.yourOrganizations') },
      { methods: ['GET'], path: '/v1/organizations/{slug}', purpose: tr('docs:docsApi.oneOrganization') },
      {
        methods: ['GET'],
        path: '/v1/organizations/{slug}/members',
        purpose: tr('docs:docsApi.anOrganizationSMembers'),
      },
      { methods: ['GET'], path: '/v1/projects', purpose: tr('docs:docsApi.yourProjects') },
      { methods: ['GET'], path: '/v1/projects/{ref}', purpose: tr('docs:docsApi.oneProject') },
      {
        methods: ['GET'],
        path: '/v1/projects/{ref}/health',
        purpose: tr('docs:docsApi.healthOfTheProjectSServices'),
      },
      { methods: ['GET'], path: '/v1/projects/{ref}/api-keys', purpose: tr('docs:docsApi.theProjectSApiKeys') },
      { methods: ['POST'], path: '/v1/projects/{ref}/database/query', purpose: tr('docs:docsApi.runSql') },
      { methods: ['GET'], path: '/v1/projects/{ref}/database/backups', purpose: tr('docs:docsApi.backups') },
      { methods: ['GET'], path: '/v1/projects/{ref}/functions', purpose: tr('docs:docsApi.edgeFunctions') },
      {
        methods: ['GET', 'DELETE'],
        path: '/v1/projects/{ref}/functions/{slug}',
        purpose: tr('docs:docsApi.oneFunctionDeleteIt'),
      },
      {
        methods: ['GET', 'POST', 'DELETE'],
        path: '/v1/projects/{ref}/secrets',
        purpose: tr('docs:docsApi.edgeFunctionSecrets'),
      },
      { methods: ['POST'], path: '/v1/projects/{ref}/pause', purpose: tr('docs:docsApi.pauseTheStack') },
      {
        methods: ['POST'],
        path: '/v1/projects/{ref}/restore',
        purpose: tr('docs:docsApi.startAPausedStackAgain'),
      },
    ],
  },
  {
    id: 'metrics',
    title: tr('docs:docsApi.metrics'),
    note: tr('docs:docsApi.servedOnlyWhenMetricsListenIs'),
    rows: [
      {
        methods: ['GET'],
        path: '/metrics',
        purpose: tr('docs:docsApi.prometheusMetricsRequestsSignInsEmails'),
        public: true,
      },
    ],
  },
])

const METHOD_VARIANT: Record<string, BadgeProps['variant']> = {
  GET: 'default',
  POST: 'success',
  PUT: 'warning',
  PATCH: 'warning',
  DELETE: 'destructive',
  ANY: 'secondary',
}

/** The spec's operations, one row each, grouped into sections. */
function sectionsOf(spec: Spec): Section[] {
  const byTag = new Map<string, Endpoint[]>()
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      const tag = op.tags?.[0] ?? tr('docs:docsApi.other')
      const rows = byTag.get(tag) ?? []
      rows.push({
        methods: [method.toUpperCase()],
        path,
        purpose: op.summary ?? '',
        public: Array.isArray(op.security) && op.security.length === 0,
      })
      byTag.set(tag, rows)
    }
  }
  const notes = new Map((spec.tags ?? []).map((t) => [t.name, t.description]))
  const known = TAGS().filter((t) => byTag.has(t.tag))
  const unknown = [...byTag.keys()]
    .filter((t) => !TAGS().some((k) => k.tag === t))
    .map((tag) => ({ tag, title: tag }))
  return [...known, ...unknown].map(({ tag, title }) => ({
    id: tag.toLowerCase().replace(/\W+/g, '-'),
    title,
    note: notes.get(tag),
    rows: byTag
      .get(tag)!
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          METHODS.indexOf(a.methods[0]!.toLowerCase()) -
            METHODS.indexOf(b.methods[0]!.toLowerCase())
      ),
  }))
}

const count = (rows: Endpoint[]) => rows.reduce((n, r) => n + r.methods.length, 0)

function ApiDocsPage() {
  const spec = useQuery({
    queryKey: ['openapi'],
    queryFn: async (): Promise<Spec> => {
      const res = await fetch(SPEC_URL, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(tr('docs:docsApi.couldnTLoadTheApiDescription', { status: res.status }))
      return (await res.json()) as Spec
    },
    staleTime: Infinity,
  })
  const [query, setQuery] = useState('')

  const all = useMemo(() => (spec.data ? [...sectionsOf(spec.data), ...EXTRA()] : []), [spec.data])
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = all
    .map((s) => ({
      ...s,
      total: count(s.rows),
      rows: s.rows.filter((r) => {
        const hay =
          `${r.methods.join(' ')} ${r.path} ${r.purpose} ${r.public ? 'public' : ''} ${s.title}`.toLowerCase()
        return words.every((w) => hay.includes(w))
      }),
    }))
    .filter((s) => s.rows.length > 0)
  const total = all.reduce((n, s) => n + count(s.rows), 0)
  const matching = shown.reduce((n, s) => n + count(s.rows), 0)

  return (
    <AppShell title={tr('docs:docsApi.apiEndpoints')}>
      <div id="api-docs" className="overflow-y-auto">
        <PageHeader
          title={tr('docs:docsApi.apiEndpoints')}
          size="large"
          description={
            <>
              <Trans i18nKey="docs:docsApi.theSupermixerAppUsesThisApi" components={{ link: <Link
                to="/account/access-tokens"
                className="text-foreground underline underline-offset-2" />, code: <code className="text-xs" />, code2: <code className="text-xs" />, span: <span className={badgeVariants({ variant: 'success' })} /> }} />
            </>
          }
          actions={
            <Button asChild variant="default">
              <a href={SPEC_URL} target="_blank" rel="noreferrer">
                {tr('docs:docsApi.openapiDescription')}
              </a>
            </Button>
          }
        />
        <div className="sticky top-0 z-10 border-b bg-background">
          <PageContainer size="large" className="flex flex-col gap-3 py-3">
            <div className="flex items-center gap-3">
              <SearchBox value={query} onChange={setQuery} placeholder={tr('docs:docsApi.searchEndpoints')} />
              {spec.data && (
                <span className="text-xs text-foreground-lighter tabular-nums">
                  {words.length ? tr('docs:docsApi.of', { matching, tal: total }) : tr('docs:docsApi.endpoints', { tal: total })}
                </span>
              )}
            </div>
            <nav aria-label={tr('docs:docsApi.sections')} className="flex flex-wrap gap-1.5">
              {shown.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  onClick={(e) => {
                    e.preventDefault()
                    document
                      .getElementById(s.id)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                  className="rounded-full border bg-surface-100 px-2.5 py-0.5 text-xs text-foreground-light focus-ring hover:border-strong hover:text-foreground"
                >
                  {s.title}
                  <span className="ml-1 text-foreground-lighter tabular-nums">{count(s.rows)}</span>
                </a>
              ))}
            </nav>
          </PageContainer>
        </div>
        <PageContainer size="large" className="flex flex-col gap-10 pt-6 pb-24">
          {spec.error ? (
            <Alert variant="destructive" title={spec.error.message} />
          ) : !spec.data ? (
            <Skeleton className="h-96" />
          ) : shown.length === 0 ? (
            <p className="py-12 text-center text-sm text-foreground-lighter">
              {tr('docs:docsApi.noEndpointMatches', { query })}
            </p>
          ) : (
            shown.map((s) => (
              // Clear of the sticky search when jumped to.
              <section
                key={s.id}
                id={s.id}
                aria-labelledby={`${s.id}-h`}
                className="flex scroll-mt-28 flex-col gap-3"
              >
                <div className="flex flex-col gap-1">
                  <h2 id={`${s.id}-h`} className="flex heading-section items-baseline gap-2">
                    {s.title}
                    <span className="text-xs font-normal text-foreground-lighter tabular-nums">
                      {count(s.rows)}
                      {count(s.rows) !== s.total && tr('docs:docsApi.of2', { tal: s.total })}
                    </span>
                  </h2>
                  {s.note && <p className="max-w-3xl text-sm text-foreground-light">{s.note}</p>}
                </div>
                <Card className="overflow-x-auto">
                  <Table className="min-w-[640px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-px">{tr('docs:docsApi.method')}</TableHead>
                        <TableHead className="w-[44%]">{tr('docs:docsApi.path')}</TableHead>
                        <TableHead>{tr('docs:docsApi.purpose')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.rows.map((r) => (
                        <TableRow
                          key={`${r.methods.join(',')} ${r.path}`}
                          className="hover:bg-transparent"
                        >
                          <TableCell className="align-top whitespace-nowrap">
                            <span className="flex gap-1">
                              {r.methods.map((m) => (
                                <Badge
                                  key={m}
                                  variant={METHOD_VARIANT[m] ?? 'default'}
                                  className="font-mono"
                                >
                                  {m}
                                </Badge>
                              ))}
                            </span>
                          </TableCell>
                          <TableCell className="align-top font-mono text-xs break-words text-foreground">
                            {r.path}
                          </TableCell>
                          <TableCell className="align-top text-foreground-light">
                            {r.purpose}
                            {r.public && (
                              <Badge variant="success" className="ml-2">
                                {tr('docs:docsApi.public')}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              </section>
            ))
          )}
        </PageContainer>
      </div>
    </AppShell>
  )
}
