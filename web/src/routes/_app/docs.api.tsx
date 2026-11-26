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
const TAGS: { tag: string; title: string }[] = [
  { tag: 'System', title: 'System' },
  { tag: 'Auth', title: 'Signing in' },
  { tag: 'Profile', title: 'Your account' },
  { tag: 'Users', title: 'Instance administration' },
  { tag: 'Organizations', title: 'Organizations' },
  { tag: 'Members', title: 'Members' },
  { tag: 'Invitations', title: 'Invitations' },
  { tag: 'Webhooks', title: 'Webhooks' },
  { tag: 'Audit', title: 'Audit logs' },
  { tag: 'Projects', title: 'Projects' },
  { tag: 'Database', title: 'Database' },
  { tag: 'Advisors', title: 'Advisors' },
  { tag: 'Backups', title: 'Backups' },
  { tag: 'Edge Functions', title: 'Edge Functions' },
]

// Routes the OpenAPI description doesn't cover: redirects, the gateway
// proxy, the Supabase-style /v1 API and metrics.
const EXTRA: Section[] = [
  {
    id: 'outside-spec',
    title: 'Other routes',
    note: 'Under /api/v1, handled outside the OpenAPI description: redirects, and the proxy to each project’s own Supabase API.',
    rows: [
      {
        methods: ['GET'],
        path: '/openapi.json',
        purpose: 'This API’s OpenAPI description, with request and response shapes',
      },
      {
        methods: ['GET'],
        path: '/auth/sso/{provider}/start',
        purpose: 'Begin signing in with a single sign-on provider',
        public: true,
      },
      {
        methods: ['GET'],
        path: '/auth/sso/{provider}/callback',
        purpose: 'Where the sign-on provider sends the person back',
        public: true,
      },
      {
        methods: ['POST'],
        path: '/profile/identities/{provider}/connect',
        purpose: 'Connect a sign-in provider to your account',
      },
      {
        methods: ['ANY'],
        path: '/projects/{ref}/gateway/*',
        purpose:
          'Proxy to the project’s own Supabase API: Auth users and invitations, Storage buckets and files, Realtime, calling Edge Functions. Roles are checked and changes audited.',
      },
    ],
  },
  {
    id: 'management-api',
    title: 'Supabase-style Management API',
    note: 'Under /v1, not /api/v1: a subset of api.supabase.com/v1 with the same paths and response shapes, so scripts written for Supabase work. Any other path answers 404.',
    rows: [
      { methods: ['GET'], path: '/v1/organizations', purpose: 'Your organizations' },
      { methods: ['GET'], path: '/v1/organizations/{slug}', purpose: 'One organization' },
      {
        methods: ['GET'],
        path: '/v1/organizations/{slug}/members',
        purpose: 'An organization’s members',
      },
      { methods: ['GET'], path: '/v1/projects', purpose: 'Your projects' },
      { methods: ['GET'], path: '/v1/projects/{ref}', purpose: 'One project' },
      {
        methods: ['GET'],
        path: '/v1/projects/{ref}/health',
        purpose: 'Health of the project’s services',
      },
      { methods: ['GET'], path: '/v1/projects/{ref}/api-keys', purpose: 'The project’s API keys' },
      { methods: ['POST'], path: '/v1/projects/{ref}/database/query', purpose: 'Run SQL' },
      { methods: ['GET'], path: '/v1/projects/{ref}/database/backups', purpose: 'Backups' },
      { methods: ['GET'], path: '/v1/projects/{ref}/functions', purpose: 'Edge Functions' },
      {
        methods: ['GET', 'DELETE'],
        path: '/v1/projects/{ref}/functions/{slug}',
        purpose: 'One function; delete it',
      },
      {
        methods: ['GET', 'POST', 'DELETE'],
        path: '/v1/projects/{ref}/secrets',
        purpose: 'Edge Function secrets',
      },
      { methods: ['POST'], path: '/v1/projects/{ref}/pause', purpose: 'Pause the stack' },
      {
        methods: ['POST'],
        path: '/v1/projects/{ref}/restore',
        purpose: 'Start a paused stack again',
      },
    ],
  },
  {
    id: 'metrics',
    title: 'Metrics',
    note: 'Served only when [metrics] listen is set, on that separate address, with no sign-in.',
    rows: [
      {
        methods: ['GET'],
        path: '/metrics',
        purpose: 'Prometheus metrics: requests, sign-ins, emails, audit drains, counts, backups',
        public: true,
      },
    ],
  },
]

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
      const tag = op.tags?.[0] ?? 'Other'
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
  const known = TAGS.filter((t) => byTag.has(t.tag))
  const unknown = [...byTag.keys()]
    .filter((t) => !TAGS.some((k) => k.tag === t))
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
      if (!res.ok) throw new Error(`Couldn't load the API description (${res.status})`)
      return (await res.json()) as Spec
    },
    staleTime: Infinity,
  })
  const [query, setQuery] = useState('')

  const all = useMemo(() => (spec.data ? [...sectionsOf(spec.data), ...EXTRA] : []), [spec.data])
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
    <AppShell title="API endpoints">
      <div id="api-docs" className="overflow-y-auto">
        <PageHeader
          title="API endpoints"
          size="large"
          description={
            <>
              The Supermixer app uses this API for everything it does. You can use it from your own
              scripts too. Create a token under{' '}
              <Link
                to="/account/access-tokens"
                className="text-foreground underline underline-offset-2"
              >
                Account › Access Tokens
              </Link>{' '}
              and send it with each request as{' '}
              <code className="text-xs">Authorization: Bearer sbp_…</code>. Paths start with{' '}
              <code className="text-xs">/api/v1</code>, unless a section says otherwise. Endpoints
              marked <span className={badgeVariants({ variant: 'success' })}>public</span> work without signing in. The others
              need you to be signed in or to use a token. The API enforces role-based access
              control.
            </>
          }
          actions={
            <Button asChild variant="default">
              <a href={SPEC_URL} target="_blank" rel="noreferrer">
                OpenAPI description
              </a>
            </Button>
          }
        />
        <div className="sticky top-0 z-10 border-b bg-background">
          <PageContainer size="large" className="flex flex-col gap-3 py-3">
            <div className="flex items-center gap-3">
              <SearchBox value={query} onChange={setQuery} placeholder="Search endpoints" />
              {spec.data && (
                <span className="text-xs text-foreground-lighter tabular-nums">
                  {words.length ? `${matching} of ${total}` : `${total} endpoints`}
                </span>
              )}
            </div>
            <nav aria-label="Sections" className="flex flex-wrap gap-1.5">
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
              No endpoint matches “{query}”.
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
                      {count(s.rows) !== s.total && ` of ${s.total}`}
                    </span>
                  </h2>
                  {s.note && <p className="max-w-3xl text-sm text-foreground-light">{s.note}</p>}
                </div>
                <Card className="overflow-x-auto">
                  <Table className="min-w-[640px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-px">Method</TableHead>
                        <TableHead className="w-[44%]">Path</TableHead>
                        <TableHead>Purpose</TableHead>
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
                                public
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
