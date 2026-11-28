/*
 * Organization › Integrations: what the organization is connected to outside
 * Supermixer, one card each, with its state. Each card links to where it's set
 * up; the summary itself (counts and on/off) is for any member.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import type { Icon } from '@/components/icon'
import { BadgeIcon, CloudUploadIcon, ForumIcon, LogsIcon, WebhookIcon } from '@/components/icons'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { integrationsQuery } from '@/components/organization/webhook-parts'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { Schemas } from '@/lib/api/client'
import { useSelectedOrganization } from '@/lib/api/hooks'
import { localized, t } from '@/lib/i18n'

export const Route = createFileRoute('/_app/org/$slug/integrations/')({
  component: IntegrationsPage,
})

type Summary = Schemas['OrganizationIntegrations']

interface State {
  label: string
  variant: 'default' | 'success' | 'destructive'
}

interface Integration {
  key: string
  title: string
  description: string
  icon: Icon
  /** Path under /org/$slug; none when it's set up elsewhere. */
  path?: string
  state: (s: Summary) => State
  /** A line under the description, such as where it's set up. */
  note?: (s: Summary) => ReactNode
}

function countState(c: Schemas['IntegrationCount'], kind: 'channels' | 'webhooks'): State {
  if (c.total === 0) return { label: t('org:integrations.notSetUp'), variant: 'default' }
  if (c.failing > 0) return { label: t('org:integrations.failing', { failing: c.failing }), variant: 'destructive' }
  return { label: kind === 'channels' ? t('org:integrations.channelCount', { count: c.total }) : t('org:integrations.webhookCount', { count: c.total }), variant: 'success' }
}

const INTEGRATIONS = localized((): { title: string; items: Integration[] }[] => [
  {
    title: t('org:integrations.notifications'),
    items: [
      {
        key: 'chat',
        title: t('org:integrations.chatNotifications'),
        description:
          t('org:integrations.postTheOrganizationSEventsSuch'),
        icon: ForumIcon,
        path: 'integrations/chat',
        state: (s) => countState(s.chat, 'channels'),
      },
      {
        key: 'webhooks',
        title: t('org:integrations.webhooks'),
        description:
          t('org:integrations.sendEveryEventToYourOwn'),
        icon: WebhookIcon,
        path: 'webhooks',
        state: (s) => countState(s.webhooks, 'webhooks'),
      },
    ],
  },
  {
    title: t('org:integrations.signIn'),
    items: [
      {
        key: 'sso',
        title: t('org:integrations.singleSignOn'),
        description:
          t('org:integrations.letMembersSignInThroughYour'),
        icon: BadgeIcon,
        path: 'sso',
        state: (s) =>
          !s.sso.provider
            ? { label: t('org:integrations.notSetUp'), variant: 'default' }
            : s.sso.provider_missing
              ? { label: t('org:integrations.providerMissing'), variant: 'destructive' }
              : { label: s.sso.required ? t('org:integrations.required') : t('org:integrations.on'), variant: 'success' },
        note: (s) =>
          s.sso.provider_missing
            ? t('org:integrations.isNoLongerSetUpOn', { provider: s.sso.provider })
            : s.sso.provider
              ? t('org:integrations.through', { provider: s.sso.provider })
              : undefined,
      },
    ],
  },
  {
    title: t('org:integrations.projects'),
    items: [
      {
        key: 'log_drains',
        title: t('org:integrations.logDrains'),
        description: t('org:integrations.sendACreatedProjectSLogs'),
        icon: LogsIcon,
        state: (s) =>
          s.log_drains.total === 0
            ? { label: t('org:integrations.none'), variant: 'default' }
            : { label: t('org:integrations.drainCount', { count: s.log_drains.total }), variant: 'success' },
        note: (s) =>
          s.log_drains.total > 0
            ? t('org:integrations.inSetUpInEachProject', { count: s.log_drains.projects })
            : t('org:integrations.setUpInEachProjectS'),
      },
      {
        key: 'backup_copies',
        title: t('org:integrations.backupCopiesInS3'),
        description:
          t('org:integrationsIndex.copyCreatedProjectsBackupsToAn'),
        icon: CloudUploadIcon,
        state: (s) =>
          s.backup_copies.enabled
            ? { label: t('org:integrations.on'), variant: 'success' }
            : { label: t('org:integrations.off'), variant: 'default' },
        note: () =>
          t('org:integrationsIndex.setForTheWholeInstanceIn'),
      },
    ],
  },
])

function IntegrationsPage() {
  const org = useSelectedOrganization()
  const slug = org?.slug ?? ''
  const summary = useQuery({ ...integrationsQuery(slug), enabled: !!org })
  if (!org) return null
  return (
    <>
      <PageHeader
        title={t('org:integrations.organizationIntegrations')}
        description={t('org:integrations.whatThisOrganizationIsConnectedTo')}
        size="large"
      />
      <PageContainer size="large" className="flex flex-col gap-10 pb-16">
        {summary.isError && <Alert variant="destructive" title={summary.error.message} />}
        {INTEGRATIONS().map((group) => (
          <section key={group.title} className="flex flex-col gap-3">
            <h2 className="heading-section text-foreground-light">{group.title}</h2>
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {group.items.map((i) => (
                <li key={i.key}>
                  <IntegrationCard
                    slug={slug}
                    integration={i}
                    summary={summary.data}
                    failed={summary.isError}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </PageContainer>
    </>
  )
}

function IntegrationCard({
  slug,
  integration: i,
  summary,
  failed,
}: {
  slug: string
  integration: Integration
  summary?: Summary
  /** The summary couldn't be loaded: no state to show, rather than loading. */
  failed: boolean
}) {
  const IconC = i.icon
  const state = summary && i.state(summary)
  const note = summary && i.note?.(summary)
  const body = (
    <>
      <span className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-md border bg-surface-200 text-foreground-light">
          <IconC size={18} />
        </span>
        <span className="text-sm text-foreground">{i.title}</span>
        {state ? (
          <Badge className="ml-auto" variant={state.variant}>
            {state.label}
          </Badge>
        ) : failed ? (
          <Badge className="ml-auto">{t('org:integrations.unavailable')}</Badge>
        ) : (
          <Skeleton className="ml-auto h-4 w-16" />
        )}
      </span>
      <span className="text-sm text-foreground-light">{i.description}</span>
      {note && <span className="mt-auto text-xs text-foreground-lighter">{note}</span>}
    </>
  )
  const box = 'flex h-full flex-col gap-3 rounded-lg border bg-surface-100 p-5'
  if (!i.path) return <div className={box}>{body}</div>
  const to: string = `/org/${slug}/${i.path}`
  return (
    <Link
      to={to}
      className={`${box} focus-ring transition-colors hover:border-strong hover:bg-surface-200`}
    >
      {body}
    </Link>
  )
}
