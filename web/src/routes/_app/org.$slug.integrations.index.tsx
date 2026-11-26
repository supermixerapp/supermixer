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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function countState(c: Schemas['IntegrationCount'], one: string): State {
  if (c.total === 0) return { label: 'Not set up', variant: 'default' }
  if (c.failing > 0) return { label: `${c.failing} failing`, variant: 'destructive' }
  return { label: plural(c.total, one), variant: 'success' }
}

const INTEGRATIONS: { title: string; items: Integration[] }[] = [
  {
    title: 'Notifications',
    items: [
      {
        key: 'chat',
        title: 'Chat notifications',
        description: 'Post the organization’s events, such as failed backups and new members, to Slack, Microsoft Teams, Discord, Google Chat or Mattermost.',
        icon: ForumIcon,
        path: 'integrations/chat',
        state: (s) => countState(s.chat, 'channel'),
      },
      {
        key: 'webhooks',
        title: 'Webhooks',
        description: 'Send every event to your own service as signed JSON, in order, retried until it answers.',
        icon: WebhookIcon,
        path: 'webhooks',
        state: (s) => countState(s.webhooks, 'webhook'),
      },
    ],
  },
  {
    title: 'Sign-in',
    items: [
      {
        key: 'sso',
        title: 'Single sign-on',
        description: 'Let members sign in through your identity provider, require it, and let people join by themselves.',
        icon: BadgeIcon,
        path: 'sso',
        state: (s) =>
          s.sso.provider ? { label: s.sso.required ? 'Required' : 'On', variant: 'success' } : { label: 'Not set up', variant: 'default' },
        note: (s) => (s.sso.provider ? `Through ${s.sso.provider}` : undefined),
      },
    ],
  },
  {
    title: 'Projects',
    items: [
      {
        key: 'log_drains',
        title: 'Log drains',
        description: 'Send a created project’s logs to Datadog, Loki or any HTTP endpoint as well.',
        icon: LogsIcon,
        state: (s) =>
          s.log_drains.total === 0
            ? { label: 'None', variant: 'default' }
            : { label: plural(s.log_drains.total, 'drain'), variant: 'success' },
        note: (s) =>
          s.log_drains.total > 0
            ? `In ${plural(s.log_drains.projects, 'project')}. Set up in each project’s Settings › Log Drains.`
            : 'Set up in each project’s Settings › Log Drains.',
      },
      {
        key: 'backup_copies',
        title: 'Backup copies in S3',
        description: 'Copy created projects’ backups to an S3-compatible bucket, so they survive losing this server.',
        icon: CloudUploadIcon,
        state: (s) => (s.backup_copies.enabled ? { label: 'On', variant: 'success' } : { label: 'Off', variant: 'default' }),
        note: () => 'Set for the whole instance in Supermixer’s config file, by whoever runs the server.',
      },
    ],
  },
]

function IntegrationsPage() {
  const org = useSelectedOrganization()
  const slug = org?.slug ?? ''
  const summary = useQuery({ ...integrationsQuery(slug), enabled: !!org })
  if (!org) return null
  return (
    <>
      <PageHeader
        title="Integrations"
        description="What this organization is connected to outside Supermixer."
        size="large"
      />
      <PageContainer size="large" className="flex flex-col gap-10 pb-16">
        {summary.isError && <Alert variant="destructive" title={summary.error.message} />}
        {INTEGRATIONS.map((group) => (
          <section key={group.title} className="flex flex-col gap-3">
            <h2 className="heading-section text-foreground-light">{group.title}</h2>
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {group.items.map((i) => (
                <li key={i.key}>
                  <IntegrationCard slug={slug} integration={i} summary={summary.data} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </PageContainer>
    </>
  )
}

function IntegrationCard({ slug, integration: i, summary }: { slug: string; integration: Integration; summary?: Summary }) {
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
    <Link to={to} className={`${box} transition-colors focus-ring hover:border-strong hover:bg-surface-200`}>
      {body}
    </Link>
  )
}
