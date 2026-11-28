import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Fragment, useMemo, type ReactNode } from 'react'

import { RefreshIcon } from '@/components/icons'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CodeBlock } from '@/components/ui/code-block'
import { CopyField } from '@/components/ui/copy'
import { FormField } from '@/components/ui/form-field'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { authExamples, functionExample, parseSpec, resourceExamples, type Client, type Example, type PostgrestSpec } from '@/lib/api-docs'
import { gateway } from '@/lib/api/gateway'
import { useSelectedProject } from '@/lib/api/hooks'
import { apiKeysQuery } from '@/lib/api/queries'
import { usePg } from '@/lib/pg/run'
import { useLocalStorage } from '@/lib/storage'
import { cn } from '@/lib/utils'
import { localized, t, Trans } from '@/lib/i18n'

const SECTIONS = ['introduction', 'authentication', 'users', 'tables', 'functions'] as const
type Section = (typeof SECTIONS)[number]

interface Search {
  section?: Section
  resource?: string
  rpc?: string
}

export const Route = createFileRoute('/_app/project/$ref/integrations/data_api/docs')({
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {}
    if (typeof s.section === 'string' && (SECTIONS as readonly string[]).includes(s.section)) out.section = s.section as Section
    if (typeof s.resource === 'string' && s.resource) out.resource = s.resource
    if (typeof s.rpc === 'string' && s.rpc) out.rpc = s.rpc
    return out
  },
  component: DataApiDocsPage,
})

/** PostgREST describes its default schema, which is public on Supabase stacks. */
const DOCS_SCHEMA = 'public'

/** Each relation's kind, and the columns Postgres fills in itself (defaults, identity, generated). */
const RELATION_KINDS_SQL = `
select c.relname as name, c.relkind as kind,
  to_json(array(select a.attname from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        and (a.atthasdef or a.attidentity <> '' or a.attgenerated <> ''))) as filled
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f')`

const KIND_LABEL = localized((): Record<string, string> => ({ v: t('integrations:integrationsDataApiDocs.view'), m: t('integrations:integrationsDataApiDocs.materializedView'), f: t('integrations:integrationsDataApiDocs.foreignTable') }))

const LANGS = ['js', 'bash'] as const
type Lang = (typeof LANGS)[number]

function DataApiDocsPage() {
  const { ref } = Route.useParams()
  const search = Route.useSearch()
  const project = useSelectedProject()
  const keys = useQuery(apiKeysQuery(ref))
  const spec = useQuery({
    queryKey: ['projects', ref, 'gateway', 'rest-spec'],
    queryFn: ({ signal }) => gateway<PostgrestSpec>(ref, 'rest/v1/', { signal }),
    staleTime: 60_000,
  })
  const docs = useMemo(() => (spec.data?.paths ? parseSpec(spec.data) : null), [spec.data])
  // The description doesn't say which are views; Realtime only streams tables.
  const kinds = usePg<{ name: string; kind: string; filled: string[] }>(ref, ['relation-kinds', DOCS_SCHEMA], RELATION_KINDS_SQL, [DOCS_SCHEMA])
  const [lang, setLang] = useLocalStorage<Lang>('supermixer.api-docs.lang', 'js', LANGS)

  const publicKey =
    keys.data?.find((k) => k.id === 'publishable' && k.value)?.value ?? keys.data?.find((k) => k.id === 'anon' && k.value)?.value ?? '<your-anon-key>'
  const client: Client = { url: project?.api_url ?? 'http://localhost:8000', key: publicKey }
  const section: Section = search.resource ? 'tables' : search.rpc ? 'functions' : (search.section ?? 'introduction')
  const described = search.resource ? docs?.resources.find((r) => r.name === search.resource) : undefined
  // PostgREST lists identity columns as required with no default; the catalog knows better.
  const filled = described && kinds.data?.find((k) => k.name === described.name)?.filled
  const resource =
    described && filled ? { ...described, columns: described.columns.map((c) => (filled.includes(c.name) ? { ...c, hasDefault: true } : c)) } : described
  const fn = search.rpc ? docs?.functions.find((f) => f.name === search.rpc) : undefined

  const nav: { title: string; links: { label: string; search: Search; active: boolean }[] }[] = [
    {
      title: t('integrations:integrationsDataApiDocs.gettingStarted'),
      links: [
        { label: t('integrations:integrationsDataApiDocs.introduction'), search: {}, active: section === 'introduction' },
        { label: t('integrations:integrationsDataApiDocs.authentication'), search: { section: 'authentication' }, active: section === 'authentication' },
        { label: t('integrations:integrationsDataApiDocs.userManagement'), search: { section: 'users' }, active: section === 'users' },
      ],
    },
    {
      title: t('integrations:integrationsDataApiDocs.tablesAndViews'),
      links: [
        { label: t('integrations:integrationsDataApiDocs.introduction'), search: { section: 'tables' }, active: section === 'tables' && !search.resource },
        ...(docs?.resources ?? []).map((r) => ({ label: r.name, search: { resource: r.name }, active: search.resource === r.name })),
      ],
    },
    {
      title: t('integrations:integrationsDataApiDocs.storedProcedures'),
      links: [
        { label: t('integrations:integrationsDataApiDocs.introduction'), search: { section: 'functions' }, active: section === 'functions' && !search.rpc },
        ...(docs?.functions ?? []).map((f) => ({ label: f.name, search: { rpc: f.name }, active: search.rpc === f.name })),
      ],
    },
  ]

  let body: ReactNode
  // The Getting started pages don't need the description, so only the
  // table and function pages show its error.
  const needsSpec = section === 'tables' || section === 'functions'
  if (needsSpec && spec.error) {
    body = (
      <Alert variant="destructive" title={t('integrations:integrationsDataApiDocs.couldnTReadTheDataApi', { message: spec.error.message })}>
        {t('integrations:integrationsDataApiDocs.postgrestMayHaveItsOpenapiOutput')}
      </Alert>
    )
  } else if (needsSpec && !docs) {
    body = <Skeleton className="h-64" />
  } else if (section === 'introduction') {
    body = <Introduction client={client} dbUri={project?.database.uri} lang={lang} />
  } else if (section === 'authentication') {
    body = <Authentication client={client} lang={lang} />
  } else if (section === 'users') {
    body = (
      <Page title={t('integrations:integrationsDataApiDocs.userManagement')} lead={t('integrations:integrationsDataApiDocs.signUsersUpAndInAnd')}>
        {authExamples(client).map((e) => (
          <ExampleSection key={e.title} example={e} lang={lang} />
        ))}
      </Page>
    )
  } else if (search.resource && !resource) {
    body = <Alert title={t('integrations:integrationsDataApiDocs.isnTInTheDataApi', { resource: search.resource })}>{t('integrations:integrationsDataApiDocs.itMayHaveBeenRenamedOr')}</Alert>
  } else if (resource) {
    const readOnly = !resource.insert && !resource.update && !resource.delete
    const kind = kinds.data?.find((k) => k.name === resource.name)?.kind
    const lead = [resource.description, kind && KIND_LABEL()[kind], readOnly && t('integrations:integrationsDataApiDocs.readOnlyThroughTheDataApi')].filter(Boolean).join(' · ')
    body = (
      <Page title={resource.name} lead={lead || undefined}>
        <Section title={t('integrations:integrationsDataApiDocs.columns')}>
          <Card>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('integrations:integrationsDataApiDocs.name')}</TableHead>
                  <TableHead>{t('integrations:integrationsDataApiDocs.type')}</TableHead>
                  <TableHead>{t('integrations:integrationsDataApiDocs.description')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resource.columns.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell className="align-top">
                      <span className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-foreground">
                        {c.name}
                        {c.primaryKey && <Badge>{t('integrations:integrationsDataApiDocs.primaryKey')}</Badge>}
                        {c.required && !c.hasDefault && <Badge variant="warning">{t('integrations:integrationsDataApiDocs.required')}</Badge>}
                      </span>
                    </TableCell>
                    <TableCell className="align-top font-mono text-xs text-foreground-light">{c.format}</TableCell>
                    <TableCell className="align-top text-foreground-light">
                      {c.description}
                      {c.references && (
                        <span className="block text-xs text-foreground-lighter">
                          <Trans i18nKey="integrations:integrationsDataApiDocs.references" values={{ references: c.references }} components={{ link: <Link to="." search={{ resource: c.references.split('.')[0] }} className="font-mono text-foreground-light underline-offset-2 hover:underline" /> }} />
                        </span>
                      )}
                      {!c.description && !c.references && '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </Section>
        {resourceExamples(resource, client, kind ? { schema: DOCS_SCHEMA, kind } : { schema: DOCS_SCHEMA }).map((e) => (
          <ExampleSection key={e.title} example={e} lang={lang} />
        ))}
      </Page>
    )
  } else if (section === 'tables') {
    body = (
      <Page
        title={t('integrations:integrationsDataApiDocs.tablesAndViews')}
        lead={t('integrations:integrationsDataApiDocs.everyTableAndViewInThe')}
      >
        <IndexList
          empty={t('integrations:integrationsDataApiDocs.noTablesOrViewsAreExposed')}
          items={(docs?.resources ?? []).map((r) => ({ name: r.name, description: r.description, search: { resource: r.name } }))}
        />
      </Page>
    )
  } else if (search.rpc && !fn) {
    body = <Alert title={t('integrations:integrationsDataApiDocs.isnTInTheDataApi2', { rpc: search.rpc })}>{t('integrations:integrationsDataApiDocs.itMayHaveBeenRenamedOr')}</Alert>
  } else if (fn) {
    body = (
      <Page title={fn.name} lead={fn.description ?? undefined}>
        <Section title={t('integrations:integrationsDataApiDocs.arguments')}>
          {fn.params.length === 0 ? (
            <p className="text-sm text-foreground-light">{t('integrations:integrationsDataApiDocs.none')}</p>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('integrations:integrationsDataApiDocs.name')}</TableHead>
                    <TableHead>{t('integrations:integrationsDataApiDocs.type')}</TableHead>
                    <TableHead>{t('integrations:integrationsDataApiDocs.required2')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fn.params.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell className="font-mono text-xs text-foreground">{p.name}</TableCell>
                      <TableCell className="font-mono text-xs text-foreground-light">{p.format}</TableCell>
                      <TableCell className="text-foreground-light">{p.required ? t('integrations:integrationsDataApiDocs.yes') : t('integrations:integrationsDataApiDocs.noItHasADefault')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </Section>
        <ExampleSection
          example={{
            ...functionExample(fn, client),
            description: fn.get ? t('integrations:integrationsDataApiDocs.stableFunctionsCanAlsoBeCalled') : t('integrations:integrationsDataApiDocs.volatileFunctionsCanOnlyBeCalled'),
          }}
          lang={lang}
        />
      </Page>
    )
  } else {
    body = (
      <Page title={t('integrations:integrationsDataApiDocs.storedProcedures')} lead={t('integrations:integrationsDataApiDocs.postgresFunctionsInTheExposedSchema')}>
        <IndexList
          empty={t('integrations:integrationsDataApiDocs.noFunctionsAreExposed')}
          items={(docs?.functions ?? []).map((f) => ({ name: f.name, description: f.description, search: { rpc: f.name } }))}
        />
      </Page>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label={t('integrations:integrationsDataApiDocs.apiDocs')} className="hidden w-56 shrink-0 overflow-y-auto border-r py-2 md:block">
        {nav.map((group, i) => (
          <Fragment key={group.title}>
            {i > 0 && <div className="h-px bg-border" />}
            <div className="py-3">
              <p className="mb-1 px-5 text-xs text-foreground-lighter">{group.title}</p>
              <ul className="px-2">
                {group.links.map((l) => (
                  <li key={`${group.title}-${l.label}`}>
                    <Link
                      to="."
                      search={l.search}
                      aria-current={l.active ? 'page' : undefined}
                      className={cn(
                        'block truncate rounded-md px-3 py-1 text-sm focus-ring',
                        l.active ? 'bg-sidebar-accent font-semibold text-foreground' : 'text-foreground-light hover:bg-sidebar-accent/50 hover:text-foreground'
                      )}
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
                {group.links.length === 1 && group.title !== t('integrations:integrationsDataApiDocs.gettingStarted') && spec.isPending && (
                  <li className="px-3 py-1">
                    <Skeleton className="h-4" />
                  </li>
                )}
              </ul>
            </div>
          </Fragment>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-dash-sidebar px-6 py-2">
          <h1 className="text-sm text-foreground">{t('integrations:integrationsDataApiDocs.apiDocs2')}</h1>
          <span className="text-xs text-foreground-lighter">{t('integrations:integrationsDataApiDocs.fromTheDataApiSOwn')}</span>
          <div className="ml-auto flex items-center gap-3">
            <Tabs value={lang} onValueChange={(v) => setLang(v as Lang)}>
              <TabsList className="border-b-0">
                <TabsTrigger value="js">{t('integrations:integrationsDataApiDocs.javascript')}</TabsTrigger>
                <TabsTrigger value="bash">{t('integrations:integrationsDataApiDocs.bash')}</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={spec.isFetching && !spec.isPending} onClick={() => void spec.refetch()}>
              {t('integrations:integrationsDataApiDocs.refresh')}
            </Button>
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-6 pb-16">{body}</div>
      </div>
    </div>
  )
}

function Page({ title, lead, children }: { title: string; lead?: string | undefined; children: ReactNode }) {
  return (
    <article>
      <header className="border-b py-8">
        <h2 className="text-2xl text-foreground">{title}</h2>
        {lead && <p className="mt-2 max-w-2xl text-sm text-foreground-light">{lead}</p>}
      </header>
      {children}
    </article>
  )
}

/** Prose on the left, code on the right, like Studio's docs. */
function Section({ title, children, code }: { title: string; children?: ReactNode; code?: ReactNode }) {
  return (
    <section className="grid gap-6 border-b py-8 xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="text-base text-foreground">{title}</h3>
        {children}
      </div>
      {code && <div className="min-w-0">{code}</div>}
    </section>
  )
}

function ExampleSection({ example, lang }: { example: Example; lang: Lang }) {
  return (
    <Section title={example.title} code={<CodeBlock code={lang === 'js' ? example.js : example.bash} />}>
      {example.description && <p className="text-sm text-foreground-light">{example.description}</p>}
    </Section>
  )
}

function IndexList({ items, empty }: { items: { name: string; description: string | null; search: Search }[]; empty: string }) {
  if (!items.length) return <p className="py-8 text-sm text-foreground-lighter">{empty}</p>
  return (
    <ul className="grid gap-2 py-8 sm:grid-cols-2">
      {items.map((i) => (
        <li key={i.name}>
          <Link to="." search={i.search} className="block rounded-md border bg-surface-100 px-4 py-3 focus-ring hover:border-strong">
            <span className="block font-mono text-sm text-foreground">{i.name}</span>
            <span className="block truncate text-xs text-foreground-lighter">{i.description ?? t('integrations:integrationsDataApiDocs.noDescription')}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function Introduction({ client, dbUri, lang }: { client: Client; dbUri: string | undefined; lang: Lang }) {
  return (
    <Page
      title={t('integrations:integrationsDataApiDocs.introduction')}
      lead={t('integrations:integrationsDataApiDocs.theDataApiTurnsTheExposed')}
    >
      <Section
        title={t('integrations:integrationsDataApiDocs.connect')}
        code={
          <CodeBlock
            code={
              lang === 'js'
                ? `import { createClient } from '@supabase/supabase-js'\n\nconst supabase = createClient(\n  '${client.url}',\n  '${client.key}'\n)`
                : `# Every request sends the key twice:\ncurl '${client.url.replace(/\/+$/, '')}/rest/v1/TABLE' \\\n  -H 'apikey: ${client.key}' \\\n  -H 'Authorization: Bearer ${client.key}'`
            }
          />
        }
      >
        <p className="text-sm text-foreground-light">{t('integrations:integrationsDataApiDocs.installSupabaseJsAndCreateA')}</p>
        <FormField label={t('integrations:integrationsDataApiDocs.projectUrl')}>
          <CopyField value={client.url} />
        </FormField>
        <FormField label={t('integrations:integrationsDataApiDocs.publicKey')} description={t('integrations:integrationsDataApiDocs.safeInABrowserWhenRow')}>
          <CopyField value={client.key} />
        </FormField>
      </Section>
      <Section
        title={t('integrations:integrationsDataApiDocs.generateTypes')}
        code={<CodeBlock code={`npx supabase gen types typescript \\\n  --db-url '${dbUri ?? 'postgresql://postgres:[YOUR-PASSWORD]@host:5432/postgres'}' \\\n  > database.types.ts`} />}
      >
        <p className="text-sm text-foreground-light">
          <Trans i18nKey="integrations:integrationsDataApiDocs.theSupabaseCliCanWriteTypescript" values={{ call: 'createClient<Database>()' }} components={{ code: <code className="font-mono text-xs" /> }} />
        </p>
      </Section>
      <Section title={t('integrations:integrationsDataApiDocs.whatSListed')}>
        <p className="text-sm text-foreground-light">
          {t('integrations:integrationsDataApiDocs.supermixerReadsTheDescriptionWithThe')}
        </p>
      </Section>
    </Page>
  )
}

function Authentication({ client, lang }: { client: Client; lang: Lang }) {
  const url = client.url.replace(/\/+$/, '')
  return (
    <Page title={t('integrations:integrationsDataApiDocs.authentication')} lead={t('integrations:integrationsDataApiDocs.everyRequestNamesAKeyWhich')}>
      <Section
        title={t('integrations:integrationsDataApiDocs.publicKey')}
        code={
          <CodeBlock
            code={
              lang === 'js'
                ? `const supabase = createClient(\n  '${client.url}',\n  '${client.key}'\n)`
                : `curl '${url}/rest/v1/TABLE' \\\n  -H 'apikey: ${client.key}' \\\n  -H 'Authorization: Bearer ${client.key}'`
            }
          />
        }
      >
        <p className="text-sm text-foreground-light">
          <Trans i18nKey="integrations:integrationsDataApiDocs.theAnonOrPublishableKeyIs" components={{ code: <code className="font-mono text-xs" />, code2: <code className="font-mono text-xs" /> }} />
        </p>
      </Section>
      <Section
        title={t('integrations:integrationsDataApiDocs.signedInUsers')}
        code={
          <CodeBlock
            code={
              lang === 'js'
                ? `// supabase-js sends the user's token for you once they sign in.\nconst { data, error } = await supabase.auth.signInWithPassword({\n  email: 'someone@email.com',\n  password: 'a-strong-password',\n})`
                : `curl '${url}/rest/v1/TABLE' \\\n  -H 'apikey: ${client.key}' \\\n  -H 'Authorization: Bearer USER_TOKEN'`
            }
          />
        }
      >
        <p className="text-sm text-foreground-light">
          <Trans i18nKey="integrations:integrationsDataApiDocs.aSignedInUserSAccess" components={{ code: <code className="font-mono text-xs" /> }} />
        </p>
      </Section>
      <Section
        title={t('integrations:integrationsDataApiDocs.serviceRoleKey')}
        code={
          <CodeBlock
            code={
              lang === 'js'
                ? `// On a server only.\nconst supabase = createClient(\n  '${client.url}',\n  process.env.SUPABASE_SERVICE_ROLE_KEY\n)`
                : `curl '${url}/rest/v1/TABLE' \\\n  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \\\n  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"`
            }
          />
        }
      >
        <p className="text-sm text-foreground-light">
          <Trans i18nKey="integrations:integrationsDataApiDocs.theServiceRoleBypassesRowLevel" components={{ link: <Link to="/project/$ref/settings/api-keys" from="/project/$ref" className="text-foreground underline-offset-2 hover:underline" /> }} />
        </p>
      </Section>
    </Page>
  )
}
