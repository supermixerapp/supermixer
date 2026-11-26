/*
 * Organization › Integrations › Chat notifications: the organization's events
 * posted as readable messages to Slack, Microsoft Teams, Discord, Google Chat
 * or Mattermost channels. Each channel is an organization webhook with that
 * chat app's kind; its address is a credential, so after saving only its host
 * is shown. Owners only.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { ArrowBackIcon } from '@/components/icons'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { SettingsSection } from '@/components/layout/section'
import {
  DeliveriesSheet,
  EventsFieldset,
  eventsLabel,
  integrationsQuery,
  type Webhook,
  WebhookStatus,
  webhooksQuery,
} from '@/components/organization/webhook-parts'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '@/components/ui/dialog'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useSelectedOrganization } from '@/lib/api/hooks'

export const Route = createFileRoute('/_app/org/$slug/integrations/chat')({
  component: ChatNotificationsPage,
})

type ChatKind = Exclude<Schemas['WebhookKind'], 'webhook'>

/** The chat apps, and where each one's incoming webhook address comes from. */
const APPS: { kind: ChatKind; label: string; placeholder: string; help: string }[] = [
  {
    kind: 'slack',
    label: 'Slack',
    placeholder: 'https://hooks.slack.com/services/…',
    help: 'Create a Slack app with Incoming Webhooks turned on (api.slack.com/apps), add a webhook for the channel, and copy its URL.',
  },
  {
    kind: 'teams',
    label: 'Microsoft Teams',
    placeholder: 'https://….logic.azure.com/workflows/…',
    help: 'In the channel, open Workflows and choose “Post to a channel when a webhook request is received”. Copy the URL the workflow gives you.',
  },
  {
    kind: 'discord',
    label: 'Discord',
    placeholder: 'https://discord.com/api/webhooks/…',
    help: "In the channel's settings, open Integrations › Webhooks, create a webhook, and copy its URL.",
  },
  {
    kind: 'google_chat',
    label: 'Google Chat',
    placeholder: 'https://chat.googleapis.com/v1/spaces/…',
    help: 'In the space, open Apps & integrations › Webhooks, add a webhook, and copy its URL.',
  },
  {
    kind: 'mattermost',
    label: 'Mattermost',
    placeholder: 'https://mattermost.example.com/hooks/…',
    help: "In Mattermost, open Integrations › Incoming Webhooks, add one for the channel, and copy its URL. A Mattermost server on your own network needs webhooks.allow_private_addresses in Supermixer's config.",
  },
]

const appOf = (kind: string) => APPS.find((a) => a.kind === kind)

/** New channels hear about failures and people coming and going. */
const DEFAULT_EVENTS = ['project.backup_failed', 'project.operation_failed', 'member.']

function ChatNotificationsPage() {
  const org = useSelectedOrganization()
  const slug = org?.slug ?? ''
  const isOwner = can(org, 'org:update')
  const queryClient = useQueryClient()
  const channels = useQuery({
    ...webhooksQuery(slug),
    enabled: !!org && isOwner,
    select: (all) => all.filter((h) => h.kind !== 'webhook'),
  })
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null)
  const [deliveries, setDeliveries] = useState<Webhook | null>(null)
  const [deleting, setDeleting] = useState<Webhook | null>(null)
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: webhooksQuery(slug).queryKey }),
      queryClient.invalidateQueries({ queryKey: integrationsQuery(slug).queryKey }),
    ])
  const path = (h: Webhook) => ({ params: { path: { slug, webhook_id: h.id } } })

  const toggle = useMutation({
    mutationFn: (h: Webhook) =>
      unwrap(
        api.PATCH('/organizations/{slug}/webhooks/{webhook_id}', {
          ...path(h),
          body: { enabled: !h.enabled },
        })
      ),
    onSuccess: (h) => {
      toast.success(
        h.enabled ? 'Channel turned on: it gets new events from now' : 'Channel turned off'
      )
      void refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const test = useMutation({
    mutationFn: (h: Webhook) =>
      unwrap(api.POST('/organizations/{slug}/webhooks/{webhook_id}/test', path(h))),
    onSuccess: (d) => {
      if (d.error) toast.error(`Test message: ${d.error}`)
      else toast.success('Test message sent: check the channel')
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (h: Webhook) =>
      unwrap(api.DELETE('/organizations/{slug}/webhooks/{webhook_id}', path(h))),
    onSuccess: () => {
      toast.success('Channel removed')
      setDeleting(null)
      void refresh()
    },
    onError: (e) => {
      setDeleting(null)
      toast.error(e.message)
    },
  })

  if (!org) return null
  return (
    <>
      <PageContainer size="small" className="pt-8">
        <Link
          to="/org/$slug/integrations"
          params={{ slug }}
          className="inline-flex items-center gap-1 text-sm text-foreground-light transition-colors hover:text-foreground"
        >
          <ArrowBackIcon size={16} />
          Organization Integrations
        </Link>
      </PageContainer>
      <PageHeader
        title="Chat notifications"
        description="Post this organization's events to Slack, Microsoft Teams, Discord, Google Chat or Mattermost, as messages people can read."
        size="small"
      />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        <SettingsSection
          title="Channels"
          description="Each event goes out as one message, in order. If a channel stops answering, Supermixer keeps trying, holding later messages back, so nothing is skipped."
        >
          {!isOwner ? (
            <Alert title="Only Owners manage chat notifications">
              They send the organization's events outside Supermixer.
            </Alert>
          ) : (
            <>
              <div className="flex justify-end">
                <PermissionButton
                  allowed={isOwner}
                  action="manage chat notifications"
                  variant="primary"
                  onClick={() => setEditing('new')}
                >
                  Add channel
                </PermissionButton>
              </div>
              <Card>
                {channels.isPending ? (
                  <div className="flex flex-col gap-2 p-4">
                    <Skeleton className="h-6" />
                    <Skeleton className="h-6" />
                  </div>
                ) : channels.isError ? (
                  <p className="px-4 py-8 text-center text-sm text-destructive">
                    {channels.error.message}
                  </p>
                ) : channels.data.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-foreground-lighter">
                    No channels yet.
                  </p>
                ) : (
                  <div className="flex flex-col divide-y">
                    {channels.data.map((h) => (
                      <div key={h.id} className="flex flex-col gap-3 px-5 py-4 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <span className="flex min-w-0 flex-col gap-1">
                            <span className="text-foreground">
                              {appOf(h.kind)?.label ?? h.kind}
                              {h.description && (
                                <span className="text-foreground-light"> · {h.description}</span>
                              )}
                            </span>
                            <span className="font-mono text-xs break-all text-foreground-lighter">
                              {h.url}
                            </span>
                            <span className="flex flex-wrap gap-1">
                              {eventsLabel(h.events).map((l) => (
                                <Badge key={l}>{l}</Badge>
                              ))}
                            </span>
                          </span>
                          <WebhookStatus hook={h} />
                        </div>
                        {h.last_error && h.enabled && (
                          <p className="text-xs break-all text-destructive">{h.last_error}</p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="tiny"
                            variant="default"
                            loading={test.isPending && test.variables?.id === h.id}
                            onClick={() => test.mutate(h)}
                          >
                            Send test message
                          </Button>
                          <Button size="tiny" variant="default" onClick={() => setDeliveries(h)}>
                            Deliveries
                          </Button>
                          <Button size="tiny" variant="default" onClick={() => setEditing(h)}>
                            Edit
                          </Button>
                          <Button
                            size="tiny"
                            variant="default"
                            loading={toggle.isPending && toggle.variables?.id === h.id}
                            onClick={() => toggle.mutate(h)}
                          >
                            {h.enabled ? 'Turn off' : 'Turn on'}
                          </Button>
                          <Button size="tiny" variant="danger" onClick={() => setDeleting(h)}>
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
          )}
        </SettingsSection>
      </PageContainer>
      {editing && (
        <ChannelDialog
          slug={slug}
          channel={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void refresh()
          }}
        />
      )}
      {deliveries && (
        <DeliveriesSheet slug={slug} hook={deliveries} onClose={() => setDeliveries(null)} />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        variant="danger"
        title="Remove this channel?"
        description={`Messages stop going to this ${appOf(deleting?.kind ?? '')?.label ?? 'chat'} channel. Its delivery history goes too.`}
        confirmLabel="Remove channel"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  )
}

function ChannelDialog({
  slug,
  channel,
  onClose,
  onSaved,
}: {
  slug: string
  channel: Webhook | null
  onClose: () => void
  onSaved: () => void
}) {
  const [kind, setKind] = useState<ChatKind>((channel?.kind as ChatKind | undefined) ?? 'slack')
  const [url, setUrl] = useState('')
  const [description, setDescription] = useState(channel?.description ?? '')
  const [events, setEvents] = useState<string[]>(channel?.events ?? DEFAULT_EVENTS)
  const app = appOf(kind)
  const save = useMutation({
    mutationFn: async () => {
      if (channel) {
        await unwrap(
          api.PATCH('/organizations/{slug}/webhooks/{webhook_id}', {
            params: { path: { slug, webhook_id: channel.id } },
            // An empty address keeps the one saved.
            body: { description, events, ...(url.trim() ? { url } : {}) },
          })
        )
        return
      }
      await unwrap(
        api.POST('/organizations/{slug}/webhooks', {
          params: { path: { slug } },
          body: { kind, url, description, events },
        })
      )
    },
    onSuccess: () => {
      toast.success(channel ? 'Channel saved' : 'Channel added: send a test message to check it')
      onSaved()
    },
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="medium">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {channel ? `Edit ${app?.label ?? ''} channel` : 'Add a chat channel'}
            </DialogTitle>
            <DialogDescription>
              {channel
                ? 'Changes apply to the next message.'
                : 'It gets events from now on, not ones from before.'}
            </DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-5 border-t">
            {!channel && (
              <FormField label="App" htmlFor="chat-app">
                <Select value={kind} onValueChange={(v) => setKind(v as ChatKind)}>
                  <SelectTrigger id="chat-app">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {APPS.map((a) => (
                      <SelectItem key={a.kind} value={a.kind}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            <FormField
              label="Incoming webhook URL"
              htmlFor="chat-url"
              description={
                channel
                  ? `Leave empty to keep the current address (${channel.url}/…). It's kept encrypted and not shown again.`
                  : `${app?.help ?? ''} Treat it like a password: anyone with it can post to the channel. It's kept encrypted and not shown again.`
              }
            >
              <Input
                id="chat-url"
                required={!channel}
                autoFocus={!channel}
                autoComplete="off"
                spellCheck={false}
                placeholder={channel ? 'Leave empty to keep it' : app?.placeholder}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </FormField>
            <FormField
              label="Description (optional)"
              htmlFor="chat-desc"
              description="Such as the channel's name, to tell channels apart here."
            >
              <Input
                id="chat-desc"
                maxLength={200}
                placeholder="#ops-alerts"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </FormField>
            <EventsFieldset events={events} onChange={setEvents} />
            {save.error && <Alert variant="destructive" title={save.error.message} />}
          </DialogSection>
          <DialogFooter>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending}
              disabled={(!channel && !url.trim()) || events.length === 0}
            >
              {channel ? 'Save' : 'Add channel'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
