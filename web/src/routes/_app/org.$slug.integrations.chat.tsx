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
import { localized, t, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/org/$slug/integrations/chat')({
  component: ChatNotificationsPage,
})

type ChatKind = Exclude<Schemas['WebhookKind'], 'webhook'>

/** The chat apps, and where each one's incoming webhook address comes from. */
const APPS = localized((): { kind: ChatKind; label: string; placeholder: string; help: string }[] => [
  {
    kind: 'slack',
    label: t('org:integrationsChat.slack'),
    placeholder: 'https://hooks.slack.com/services/…',
    help: t('org:integrationsChat.slackHelp'),
  },
  {
    kind: 'teams',
    label: t('org:integrationsChat.microsoftTeams'),
    placeholder: 'https://….logic.azure.com/workflows/…',
    help: t('org:integrationsChat.inTheChannelOpenWorkflowsAnd'),
  },
  {
    kind: 'discord',
    label: t('org:integrationsChat.discord'),
    placeholder: 'https://discord.com/api/webhooks/…',
    help: t('org:integrationsChat.inTheChannelSSettingsOpen'),
  },
  {
    kind: 'google_chat',
    label: t('org:integrationsChat.googleChat'),
    placeholder: 'https://chat.googleapis.com/v1/spaces/…',
    help: t('org:integrationsChat.inTheSpaceOpenAppsIntegrations'),
  },
  {
    kind: 'mattermost',
    label: t('org:integrationsChat.mattermost'),
    placeholder: 'https://mattermost.example.com/hooks/…',
    help: t('org:integrationsChat.inMattermostOpenIntegrationsIncomingWebhooks'),
  },
])

const appOf = (kind: string) => APPS().find((a) => a.kind === kind)

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
        h.enabled ? t('org:integrationsChat.channelTurnedOnItGetsNew') : t('org:integrationsChat.channelTurnedOff')
      )
      void refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const test = useMutation({
    mutationFn: (h: Webhook) =>
      unwrap(api.POST('/organizations/{slug}/webhooks/{webhook_id}/test', path(h))),
    onSuccess: (d) => {
      if (d.error) toast.error(t('org:integrationsChat.testMessage', { error: d.error }))
      else toast.success(t('org:integrationsChat.testMessageSentCheckTheChannel'))
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (h: Webhook) =>
      unwrap(api.DELETE('/organizations/{slug}/webhooks/{webhook_id}', path(h))),
    onSuccess: () => {
      toast.success(t('org:integrationsChat.channelRemoved'))
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
          <Trans i18nKey="org:integrationsChat.organizationIntegrations" components={{ arrowbackicon: <ArrowBackIcon size={16} /> }} />
        </Link>
      </PageContainer>
      <PageHeader
        title={t('org:integrationsChat.chatNotifications')}
        description={t('org:integrationsChat.postThisOrganizationSEventsTo')}
        size="small"
      />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        <SettingsSection
          title={t('org:integrationsChat.channels')}
          description={t('org:integrationsChat.eachEventGoesOutAsOne')}
        >
          {!isOwner ? (
            <Alert title={t('org:integrationsChat.onlyOwnersManageChatNotifications')}>
              {t('org:integrationsChat.theySendTheOrganizationSEvents')}
            </Alert>
          ) : (
            <>
              <div className="flex justify-end">
                <PermissionButton
                  allowed={isOwner}
                  action={t('org:integrationsChat.manageChatNotifications')}
                  variant="primary"
                  onClick={() => setEditing('new')}
                >
                  {t('org:integrationsChat.addChannel')}
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
                    {t('org:integrationsChat.noChannelsYet')}
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
                            {t('org:integrationsChat.sendTestMessage')}
                          </Button>
                          <Button size="tiny" variant="default" onClick={() => setDeliveries(h)}>
                            {t('org:integrationsChat.deliveries')}
                          </Button>
                          <Button size="tiny" variant="default" onClick={() => setEditing(h)}>
                            {t('org:integrationsChat.edit')}
                          </Button>
                          <Button
                            size="tiny"
                            variant="default"
                            loading={toggle.isPending && toggle.variables?.id === h.id}
                            onClick={() => toggle.mutate(h)}
                          >
                            {h.enabled ? t('org:integrationsChat.turnOff') : t('org:integrationsChat.turnOn')}
                          </Button>
                          <Button size="tiny" variant="danger" onClick={() => setDeleting(h)}>
                            {t('org:integrationsChat.remove')}
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
        title={t('org:integrationsChat.removeThisChannel')}
        description={t('org:integrationsChat.messagesStopGoingToThisChannel', { label: appOf(deleting?.kind ?? '')?.label ?? t('org:integrationsChat.chat') })}
        confirmLabel={t('org:integrationsChat.removeChannel')}
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
      toast.success(channel ? t('org:integrationsChat.channelSaved') : t('org:integrationsChat.channelAddedSendATestMessage'))
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
              {channel ? t('org:integrationsChat.editChannel', { label: app?.label ?? '' }) : t('org:integrationsChat.addAChatChannel')}
            </DialogTitle>
            <DialogDescription>
              {channel
                ? t('org:integrationsChat.changesApplyToTheNextMessage')
                : t('org:integrationsChat.itGetsEventsFromNowOn')}
            </DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-5 border-t">
            {!channel && (
              <FormField label={t('org:integrationsChat.app')} htmlFor="chat-app">
                <Select value={kind} onValueChange={(v) => setKind(v as ChatKind)}>
                  <SelectTrigger id="chat-app">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {APPS().map((a) => (
                      <SelectItem key={a.kind} value={a.kind}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            <FormField
              label={t('org:integrationsChat.incomingWebhookUrl')}
              htmlFor="chat-url"
              description={
                channel
                  ? t('org:integrationsChat.leaveEmptyToKeepTheCurrent', { url: channel.url })
                  : t('org:integrationsChat.treatItLikeAPasswordAnyone', { help: app?.help ?? '' })
              }
            >
              <Input
                id="chat-url"
                required={!channel}
                autoFocus={!channel}
                autoComplete="off"
                spellCheck={false}
                placeholder={channel ? t('org:integrationsChat.leaveEmptyToKeepIt') : app?.placeholder}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </FormField>
            <FormField
              label={t('org:integrationsChat.descriptionOptional')}
              htmlFor="chat-desc"
              description={t('org:integrationsChat.suchAsTheChannelSName')}
            >
              <Input
                id="chat-desc"
                maxLength={200}
                placeholder={t('org:integrationsChat.opsAlerts')}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </FormField>
            <EventsFieldset events={events} onChange={setEvents} />
            {save.error && <Alert variant="destructive" title={save.error.message} />}
          </DialogSection>
          <DialogFooter>
            <Button variant="default" onClick={onClose}>
              {t('org:integrationsChat.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending}
              disabled={(!channel && !url.trim()) || events.length === 0}
            >
              {channel ? t('org:integrationsChat.save') : t('org:integrationsChat.addChannel')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
