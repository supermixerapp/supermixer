/*
 * What Organization Settings › Webhooks and Integrations › Chat notifications
 * share: both are organization webhooks (chat channels have a chat app's
 * kind), sending the organization's audit log events.
 */
import { useQuery } from '@tanstack/react-query'

import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetSection,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { relativeTime } from '@/lib/auth-users'
import { localized, t, Trans, language } from '@/lib/i18n'

export type Webhook = Schemas['Webhook']

/** The kinds of event to choose from: audit log actions, or prefixes of them. */
export const EVENT_GROUPS = localized((): { values: string[]; label: string; hint: string }[] => [
  {
    values: ['project.backup_failed', 'project.operation_failed'],
    label: t('org:webhookParts.failures'),
    hint: t('org:webhookParts.aBackupFailedOrStartingUpgrading'),
  },
  {
    values: ['project.'],
    label: t('org:webhookParts.projects'),
    hint: t('org:webhookParts.createdChangedDeletedKeysRotatedBackups'),
  },
  { values: ['member.'], label: t('org:webhookParts.members'), hint: t('org:webhookParts.joinedRoleChangedRemoved') },
  { values: ['invitation.'], label: t('org:webhookParts.invitations'), hint: t('org:webhookParts.createdRevoked') },
  { values: ['organization.'], label: t('org:webhookParts.organization'), hint: t('org:webhookParts.settingsChanged') },
  { values: ['webhook.'], label: t('org:webhookParts.webhooksAndChatChannels'), hint: t('org:webhookParts.addedChangedDeleted') },
])

export const webhooksQuery = (slug: string) => ({
  queryKey: ['organizations', slug, 'webhooks'],
  queryFn: () => unwrap(api.GET('/organizations/{slug}/webhooks', { params: { path: { slug } } })),
})

export const integrationsQuery = (slug: string) => ({
  queryKey: ['organizations', slug, 'integrations'],
  queryFn: () =>
    unwrap(api.GET('/organizations/{slug}/integrations', { params: { path: { slug } } })),
})

export function eventsLabel(events: string[]) {
  if (events.includes('*')) return [t('org:webhookParts.allEvents')]
  const out: string[] = []
  let rest = events
  for (const g of EVENT_GROUPS()) {
    if (g.values.every((v) => rest.includes(v))) {
      out.push(g.label)
      rest = rest.filter((e) => !g.values.includes(e))
    }
  }
  return [...out, ...rest]
}

export function WebhookStatus({ hook }: { hook: Webhook }) {
  if (!hook.enabled) return <Badge>{t('org:webhookParts.off')}</Badge>
  if (hook.failing_since) {
    return (
      <span className="flex flex-col items-end gap-1">
        <Badge variant="destructive">{t('org:webhookParts.failing')}</Badge>
        <span className="text-xs text-foreground-lighter">
          {t('org:webhookParts.since', { relativeTime: relativeTime(hook.failing_since) })}
        </span>
      </span>
    )
  }
  if (hook.last_success_at) {
    return (
      <span className="flex flex-col items-end gap-1">
        <Badge variant="success">{t('org:webhookParts.delivering')}</Badge>
        <span className="text-xs text-foreground-lighter">
          {t('org:webhookParts.last', { relativeTime: relativeTime(hook.last_success_at) })}
        </span>
      </span>
    )
  }
  return <Badge>{t('org:webhookParts.waitingForEvents')}</Badge>
}

/** Checkboxes for the kinds of event to send. */
export function EventsFieldset({
  events,
  onChange,
}: {
  events: string[]
  onChange: (events: string[]) => void
}) {
  const all = events.includes('*')
  // As the server matches: an event is sent when a chosen value is a prefix of it.
  const covered = (v: string) => events.some((e) => v.startsWith(e))
  const flip = (values: string[], on: boolean) => {
    const rest = events.filter((e) => e !== '*' && !values.includes(e))
    onChange(on ? [...rest, ...values] : rest)
  }
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm text-foreground-light">{t('org:webhookParts.events')}</legend>
      <label className="flex items-center gap-2 text-sm">
        <Trans i18nKey="org:webhookParts.allEvents2" components={{ checkbox: <Checkbox checked={all} onCheckedChange={(c) => onChange(c === true ? ['*'] : [])} /> }} />
      </label>
      {EVENT_GROUPS().map((g) => {
        const own = g.values.every((v) => events.includes(v))
        // Covered by a broader choice (Failures, when Projects is chosen).
        const implied = !own && g.values.every(covered)
        return (
          <label key={g.label} className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={all || own || implied}
              disabled={all || implied}
              onCheckedChange={(c) => flip(g.values, c === true)}
            />
            <span className="flex flex-col">
              <Label className="text-foreground">{g.label}</Label>
              <span className="text-xs text-foreground-lighter">{g.hint}</span>
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}

export function DeliveriesSheet({
  slug,
  hook,
  onClose,
}: {
  slug: string
  hook: Webhook
  onClose: () => void
}) {
  const list = useQuery({
    queryKey: ['organizations', slug, 'webhooks', hook.id, 'deliveries'],
    queryFn: () =>
      unwrap(
        api.GET('/organizations/{slug}/webhooks/{webhook_id}/deliveries', {
          params: { path: { slug, webhook_id: hook.id } },
        })
      ),
    refetchInterval: 10_000,
  })
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="lg" className="flex flex-col">
        <SheetHeader>
          <SheetTitle>{t('org:webhookParts.deliveries')}</SheetTitle>
          <SheetDescription className="break-all">
            {t('org:webhookParts.theLatest100AttemptsToNewest', { url: hook.url })}
          </SheetDescription>
        </SheetHeader>
        <SheetSection className="min-h-0 flex-1 overflow-auto p-0">
          {list.isPending ? (
            <div className="p-4">
              <Skeleton className="h-6" />
            </div>
          ) : list.isError ? (
            <p className="p-4 text-sm text-destructive">{list.error.message}</p>
          ) : list.data.length === 0 ? (
            <p className="p-6 text-center text-sm text-foreground-lighter">{t('org:webhookParts.nothingSentYet')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('org:webhookParts.time')}</TableHead>
                  <TableHead>{t('org:webhookParts.event')}</TableHead>
                  <TableHead>{t('org:webhookParts.result')}</TableHead>
                  <TableHead className="text-right">{t('org:webhookParts.took')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="whitespace-nowrap text-foreground-light">
                      {new Date(d.created_at).toLocaleString(language())}
                    </TableCell>
                    <TableCell>
                      <Badge>{d.event}</Badge>
                    </TableCell>
                    <TableCell>
                      {d.error ? (
                        <span className="text-xs break-all text-destructive">{d.error}</span>
                      ) : (
                        <Badge variant="success">{d.status}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-foreground-light">
                      {t('org:webhookParts.ms', { durationMs: d.duration_ms })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SheetSection>
      </SheetContent>
    </Sheet>
  )
}
