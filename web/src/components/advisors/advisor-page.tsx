/*
 * Security and Performance Advisors: findings from Supabase's linter
 * (splinter), which the backend runs read-only on the project's database.
 */
import { useQuery } from '@tanstack/react-query'
import { Fragment, useState, type ReactNode } from 'react'

import { DatabasePage } from '@/components/database/catalog-page'
import { ExternalLinkIcon, RefreshIcon } from '@/components/icons'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { relativeTime } from '@/lib/auth-users'
import { useNow } from '@/lib/use-now'
import { localized, t, Trans } from '@/lib/i18n'

type Lint = Schemas['Lint']
type Level = Lint['level']

const LEVELS = localized((): { level: Level; label: string; none: string }[] => [
  { level: 'ERROR', label: t('observability:advisorPage.errors'), none: t('observability:advisorPage.noErrorsFound') },
  { level: 'WARN', label: t('observability:advisorPage.warnings'), none: t('observability:advisorPage.noWarningsFound') },
  { level: 'INFO', label: t('observability:advisorPage.suggestions'), none: t('observability:advisorPage.noSuggestions') },
])

export const lintsQuery = (ref: string) => ({
  queryKey: ['projects', ref, 'advisors', 'lints'],
  queryFn: () => unwrap(api.GET('/projects/{ref}/advisors/lints', { params: { path: { ref } } })),
  staleTime: 5 * 60_000,
})

/** The object a finding is about, from its metadata. */
export function lintEntity(l: Lint): string {
  const m = l.metadata as Record<string, unknown>
  const schema = typeof m.schema === 'string' ? m.schema : null
  const name = typeof m.name === 'string' ? m.name : null
  return [schema, name].filter(Boolean).join('.') || '—'
}

/** splinter writes details in Markdown with `code`; show those as code. */
export function inlineCode(text: string): ReactNode {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="rounded bg-surface-200 px-1 font-mono text-xs text-foreground">
        {part}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  )
}

export function AdvisorPage({ projectRef, category, title, description }: { projectRef: string; category: 'SECURITY' | 'PERFORMANCE'; title: string; description: string }) {
  const lints = useQuery(lintsQuery(projectRef))
  const now = useNow(30_000)
  const [level, setLevel] = useState<Level>('ERROR')
  const [open, setOpen] = useState<Lint | null>(null)
  const mine = (lints.data?.lints ?? []).filter((l) => l.categories.includes(category))
  const shown = mine.filter((l) => l.level === level)
  const count = (lv: Level) => mine.filter((l) => l.level === lv).length

  return (
    <DatabasePage
      title={title}
      description={
        <>
          {description} {t('observability:advisorPage.checksFromSupabaseSDatabaseLinter')}
          {lints.data && t('observability:advisorPage.lastRun', { relativeTime: relativeTime(lints.data.ran_at, now) })}
        </>
      }
      toolbar={
        <Tabs value={level} onValueChange={(v) => setLevel(v as Level)}>
          <TabsList className="border-b-0">
            {LEVELS().map((l) => (
              <TabsTrigger key={l.level} value={l.level} className="gap-2">
                {l.label}
                {lints.data && <Badge variant={l.level === 'ERROR' && count(l.level) ? 'destructive' : l.level === 'WARN' && count(l.level) ? 'warning' : 'default'}>{count(l.level)}</Badge>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      }
      actions={
        <Button variant="default" size="tiny" icon={<RefreshIcon />} loading={lints.isFetching} onClick={() => void lints.refetch()}>
          {t('observability:advisorPage.rerunLinter')}
        </Button>
      }
    >
      {lints.error ? (
        <Alert variant="destructive" title={t('observability:advisorPage.theLinterFailed', { message: lints.error.message })} />
      ) : (
        <Card>
          {!lints.data ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
            </div>
          ) : shown.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-foreground-lighter">{LEVELS().find((l) => l.level === level)!.none}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('observability:advisorPage.issue')}</TableHead>
                  <TableHead>{t('observability:advisorPage.object')}</TableHead>
                  <TableHead>{t('observability:advisorPage.appliesTo')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((l) => (
                  <TableRow
                    key={l.cache_key}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setOpen(l)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setOpen(l)
                      }
                    }}
                  >
                    <TableCell className="text-foreground">{l.title}</TableCell>
                    <TableCell className="font-mono text-xs text-foreground-light">{lintEntity(l)}</TableCell>
                    <TableCell className="text-xs text-foreground-lighter">{String((l.metadata as Record<string, unknown>).type ?? '')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent size="lg" className="flex flex-col">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle>{open.title}</SheetTitle>
                <SheetDescription className="font-mono text-xs">{lintEntity(open)}</SheetDescription>
                <div>
                  <Badge variant={open.level === 'ERROR' ? 'destructive' : open.level === 'WARN' ? 'warning' : 'default'}>{open.level}</Badge>
                </div>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto">
                <SheetSection className="flex flex-col gap-4 text-sm">
                  <div className="flex flex-col gap-1">
                    <h3 className="text-xs text-foreground-lighter">{t('observability:advisorPage.whatWasFound')}</h3>
                    <p className="text-foreground">{inlineCode(open.detail)}</p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-xs text-foreground-lighter">{t('observability:advisorPage.whyItMatters')}</h3>
                    <p className="text-foreground-light">{inlineCode(open.description)}</p>
                  </div>
                  {open.remediation && !/^https?:\/\//.test(open.remediation) && (
                    <div className="flex flex-col gap-1">
                      <h3 className="text-xs text-foreground-lighter">{t('observability:advisorPage.howToFixIt')}</h3>
                      <p className="text-foreground-light">{inlineCode(open.remediation)}</p>
                    </div>
                  )}
                  {/^https:\/\/supabase\.com\//.test(open.remediation) && (
                    <a
                      href={open.remediation}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex w-fit items-center gap-1 text-foreground underline-offset-2 hover:underline"
                    >
                      <Trans i18nKey="observability:advisorPage.howToFixIt2" components={{ externallinkicon: <ExternalLinkIcon size={14} /> }} />
                    </a>
                  )}
                </SheetSection>
                <SheetSection className="border-t">
                  <h3 className="mb-2 text-xs text-foreground-lighter">{t('observability:advisorPage.details')}</h3>
                  <pre className="overflow-x-auto rounded-md border bg-surface-100 p-3 font-mono text-xs text-foreground">{JSON.stringify(open.metadata, null, 2)}</pre>
                </SheetSection>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </DatabasePage>
  )
}
