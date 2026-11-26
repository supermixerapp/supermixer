/*
 * Organization Settings › Webhooks: the organization's events (its audit
 * log), POSTed to URLs as they happen, signed. Owners only. Chat channels
 * (Integrations › Chat notifications) are webhooks too, shown there.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  DeliveriesSheet,
  EventsFieldset,
  eventsLabel,
  integrationsQuery,
  type Webhook,
  WebhookStatus,
  webhooksQuery,
} from '@/components/organization/webhook-parts'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
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
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, unwrap } from '@/lib/api/client'
import { can, useSelectedOrganization } from '@/lib/api/hooks'

export const Route = createFileRoute('/_app/org/$slug/webhooks')({
  component: OrgWebhooksPage,
})

function OrgWebhooksPage() {
  const org = useSelectedOrganization()
  const slug = org?.slug ?? ''
  const isOwner = can(org, 'org:update')
  const queryClient = useQueryClient()
  // Chat channels are organization webhooks too; they're on Integrations › Chat notifications.
  const hooks = useQuery({
    ...webhooksQuery(slug),
    enabled: !!org && isOwner,
    select: (all) => all.filter((h) => h.kind === 'webhook'),
  })
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null)
  const [secret, setSecret] = useState<{ hook: Webhook; secret: string } | null>(null)
  const [deliveries, setDeliveries] = useState<Webhook | null>(null)
  const [deleting, setDeleting] = useState<Webhook | null>(null)
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: webhooksQuery(slug).queryKey }),
      queryClient.invalidateQueries({ queryKey: integrationsQuery(slug).queryKey }),
    ])
  const path = (h: Webhook) => ({ params: { path: { slug, webhook_id: h.id } } })

  const toggle = useMutation({
    mutationFn: (h: Webhook) => unwrap(api.PATCH('/organizations/{slug}/webhooks/{webhook_id}', { ...path(h), body: { enabled: !h.enabled } })),
    onSuccess: (h) => {
      toast.success(h.enabled ? 'Webhook turned on: it sends new events from now' : 'Webhook turned off')
      void refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const test = useMutation({
    mutationFn: (h: Webhook) => unwrap(api.POST('/organizations/{slug}/webhooks/{webhook_id}/test', path(h))),
    onSuccess: (d) => {
      if (d.error) toast.error(`Test event: ${d.error}`)
      else toast.success(`Test event delivered (${d.status}, ${d.duration_ms} ms)`)
    },
    onError: (e) => toast.error(e.message),
  })
  const rotate = useMutation({
    mutationFn: (h: Webhook) => unwrap(api.POST('/organizations/{slug}/webhooks/{webhook_id}/secret', path(h))),
    onSuccess: (r, h) => setSecret({ hook: h, secret: r.secret }),
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (h: Webhook) => unwrap(api.DELETE('/organizations/{slug}/webhooks/{webhook_id}', path(h))),
    onSuccess: () => {
      toast.success('Webhook deleted')
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
      <PageHeader title="Webhooks" size="small" />
      <PageContainer size="small" className="flex flex-col gap-10 pb-16">
        <SettingsSection
          title="Webhooks"
          description="Send this organization's events (what its audit log records) to a URL as they happen: one POST per event, in order, signed with the webhook's secret. A receiver that fails is retried, holding later events back."
        >
          {!isOwner ? (
            <Alert title="Only Owners manage webhooks">They send the organization's events outside Supermixer.</Alert>
          ) : (
            <>
              <div className="flex justify-end">
                <PermissionButton allowed={isOwner} action="manage webhooks" variant="primary" onClick={() => setEditing('new')}>
                  Add webhook
                </PermissionButton>
              </div>
              <Card>
                {hooks.isPending ? (
                  <div className="flex flex-col gap-2 p-4">
                    <Skeleton className="h-6" />
                    <Skeleton className="h-6" />
                  </div>
                ) : hooks.isError ? (
                  <p className="px-4 py-8 text-center text-sm text-destructive">{hooks.error.message}</p>
                ) : hooks.data.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-foreground-lighter">No webhooks yet.</p>
                ) : (
                  <div className="flex flex-col divide-y">
                    {hooks.data.map((h) => (
                      <div key={h.id} className="flex flex-col gap-3 px-5 py-4 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <span className="flex min-w-0 flex-col gap-1">
                            <span className="font-mono text-xs break-all text-foreground">{h.url}</span>
                            {h.description && <span className="text-foreground-light">{h.description}</span>}
                            <span className="flex flex-wrap gap-1">
                              {eventsLabel(h.events).map((l) => (
                                <Badge key={l}>{l}</Badge>
                              ))}
                            </span>
                          </span>
                          <WebhookStatus hook={h} />
                        </div>
                        {h.last_error && h.enabled && <p className="text-xs break-all text-destructive">{h.last_error}</p>}
                        <div className="flex flex-wrap gap-2">
                          <Button size="tiny" variant="default" loading={test.isPending && test.variables?.id === h.id} onClick={() => test.mutate(h)}>
                            Send test event
                          </Button>
                          <Button size="tiny" variant="default" onClick={() => setDeliveries(h)}>
                            Deliveries
                          </Button>
                          <Button size="tiny" variant="default" onClick={() => setEditing(h)}>
                            Edit
                          </Button>
                          <Button size="tiny" variant="default" loading={toggle.isPending && toggle.variables?.id === h.id} onClick={() => toggle.mutate(h)}>
                            {h.enabled ? 'Turn off' : 'Turn on'}
                          </Button>
                          <Button size="tiny" variant="default" loading={rotate.isPending && rotate.variables?.id === h.id} onClick={() => rotate.mutate(h)}>
                            New secret
                          </Button>
                          <Button size="tiny" variant="danger" onClick={() => setDeleting(h)}>
                            Delete
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
              <VerifyHelp />
            </>
          )}
        </SettingsSection>
      </PageContainer>
      {editing && (
        <WebhookDialog
          slug={slug}
          hook={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null)
            void refresh()
            if (saved) setSecret(saved)
          }}
        />
      )}
      {secret && <SecretDialog hook={secret.hook} secret={secret.secret} onClose={() => setSecret(null)} />}
      {deliveries && <DeliveriesSheet slug={slug} hook={deliveries} onClose={() => setDeliveries(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        variant="danger"
        title="Delete this webhook?"
        description={`Events stop going to ${deleting?.url}. Its delivery history goes too.`}
        confirmLabel="Delete webhook"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  )
}

function WebhookDialog({
  slug,
  hook,
  onClose,
  onSaved,
}: {
  slug: string
  hook: Webhook | null
  onClose: () => void
  onSaved: (created: { hook: Webhook; secret: string } | null) => void
}) {
  const [url, setUrl] = useState(hook?.url ?? '')
  const [description, setDescription] = useState(hook?.description ?? '')
  const [events, setEvents] = useState<string[]>(hook?.events ?? ['project.', 'member.'])
  const save = useMutation({
    mutationFn: async () => {
      if (hook) {
        await unwrap(
          api.PATCH('/organizations/{slug}/webhooks/{webhook_id}', {
            params: { path: { slug, webhook_id: hook.id } },
            body: { url, description, events },
          })
        )
        return null
      }
      const r = await unwrap(api.POST('/organizations/{slug}/webhooks', { params: { path: { slug } }, body: { url, description, events } }))
      return { hook: r.webhook, secret: r.secret }
    },
    onSuccess: (created) => {
      toast.success(hook ? 'Webhook saved' : 'Webhook added')
      onSaved(created)
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
            <DialogTitle>{hook ? 'Edit webhook' : 'Add a webhook'}</DialogTitle>
            <DialogDescription>
              {hook ? 'Changes apply to the next event.' : 'It sends events from now on, not ones from before.'}
            </DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-5 border-t">
            <FormField label="URL" htmlFor="wh-url" description="Where events are POSTed, as JSON.">
              <Input id="wh-url" required autoFocus placeholder="https://example.com/hooks/supermixer" value={url} onChange={(e) => setUrl(e.target.value)} />
            </FormField>
            <FormField label="Description (optional)" htmlFor="wh-desc">
              <Input id="wh-desc" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
            </FormField>
            <EventsFieldset events={events} onChange={setEvents} />
            {save.error && <Alert variant="destructive" title={save.error.message} />}
          </DialogSection>
          <DialogFooter>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!url.trim() || events.length === 0}>
              {hook ? 'Save' : 'Add webhook'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SecretDialog({ hook, secret, onClose }: { hook: Webhook; secret: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="medium">
        <DialogHeader>
          <DialogTitle>Signing secret</DialogTitle>
          <DialogDescription>
            For {hook.url}. Copy it into the receiver now: it won&apos;t be shown again. Any earlier secret no longer
            works.
          </DialogDescription>
        </DialogHeader>
        <DialogSection className="flex flex-col gap-3 border-t">
          <CopyField value={secret} />
        </DialogSection>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function VerifyHelp() {
  return (
    <details className="text-sm text-foreground-light">
      <summary className="cursor-pointer text-foreground">Checking that a request came from Supermixer</summary>
      <div className="mt-3 flex flex-col gap-2">
        <p>
          Each request has <code className="font-mono text-xs">X-Supermixer-Signature: t=&lt;unix time&gt;,v1=&lt;signature&gt;</code>. The
          signature is the hex HMAC-SHA256 of <code className="font-mono text-xs">&lt;t&gt;.&lt;request body&gt;</code> with the
          webhook&apos;s secret. Compare it in constant time, and refuse old timestamps (say, over 5 minutes).
        </p>
        <p>
          <code className="font-mono text-xs">X-Supermixer-Event</code> is the event, such as{' '}
          <code className="font-mono text-xs">project.created</code>, and{' '}
          <code className="font-mono text-xs">X-Supermixer-Delivery</code> its id, the same when it&apos;s retried: use it to
          ignore repeats. Answer with any 2xx.
        </p>
      </div>
    </details>
  )
}
