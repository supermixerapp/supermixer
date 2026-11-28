/*
 * Instance › Global notice: a message for everyone signed in (planned
 * downtime, say), shown as a band above the header on every page.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { AdminLayout } from '@/components/layout/admin-layout'
import {
  MAX_NOTICE_MESSAGE,
  NOTICE_TYPES,
  NoticeBand,
  noticeLength,
  normalizeNotice,
  noticeQuery,
  noticeTypeOf,
  type NoticeType,
} from '@/components/layout/global-notice'
import { SettingsSection } from '@/components/layout/section'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { FormField } from '@/components/ui/form-field'
import { Textarea } from '@/components/ui/input'
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
import { relativeTime } from '@/lib/auth-users'
import { cn } from '@/lib/utils'
import { t as tr, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/admin/notice')({
  component: NoticePage,
})

function NoticePage() {
  const queryClient = useQueryClient()
  const notice = useQuery(noticeQuery)
  const current = notice.data?.notice ?? undefined
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/admin/notice')),
    onSuccess: () => {
      toast.success(tr('admin:adminNotice.noticeTakenDown'))
      queryClient.setQueryData(noticeQuery.queryKey, { notice: null })
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setConfirmingRemove(false),
  })
  return (
    <AdminLayout
      title={tr('admin:adminNotice.globalNotice')}
      description={tr('admin:adminNotice.aMessageForEveryoneSignedIn')}
    >
      {notice.error ? (
        <Alert variant="destructive" title={notice.error.message} />
      ) : !notice.data ? (
        <Skeleton className="h-64" />
      ) : (
        // Remount when the posted notice changes, so the form starts from it.
        <NoticeForm
          key={current?.posted_at ?? 'none'}
          current={current}
          onTakeDown={() => setConfirmingRemove(true)}
        />
      )}
      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        variant="warning"
        title={tr('admin:adminNotice.takeTheNoticeDown')}
        description={tr('admin:adminNotice.nobodyWillSeeAnyMore', { label: noticeTypeOf(current?.type ?? 'info').label, message: current?.message ?? '' })}
        confirmLabel={tr('admin:adminNotice.takeDown')}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </AdminLayout>
  )
}

function NoticeForm({
  current,
  onTakeDown,
}: {
  current?: Schemas['GlobalNotice']
  onTakeDown: () => void
}) {
  const queryClient = useQueryClient()
  const [type, setType] = useState<NoticeType>(current?.type ?? 'info')
  const [message, setMessage] = useState(current?.message ?? '')
  const length = noticeLength(message)
  const tooLong = length > MAX_NOTICE_MESSAGE
  const empty = message.trim() === ''
  const dirty = !current || type !== current.type || message !== current.message

  const post = useMutation({
    mutationFn: () => unwrap(api.PUT('/admin/notice', { body: { type, message } })),
    onSuccess: (n) => {
      toast.success(
        current ? tr('admin:adminNotice.noticeUpdated') : tr('admin:adminNotice.noticePostedEveryoneSignedInSees')
      )
      queryClient.setQueryData(noticeQuery.queryKey, { notice: n })
    },
  })

  return (
    <>
      <SettingsSection
        title={tr('admin:adminNotice.preview')}
        description={tr('admin:adminNotice.theNoticeAsEveryoneWillSee')}
      >
        {/* As the Showing now card was: the band, then a line about it. */}
        <Card className="overflow-hidden">
          {empty ? (
            <div className="flex h-12 items-center justify-center border-b px-4 text-sm text-foreground-lighter">
              {tr('admin:adminNotice.writeAMessageToSeeThe')}
            </div>
          ) : (
            <NoticeBand type={type} message={normalizeNotice(message)} live={false} />
          )}
          <div className="flex items-center justify-between gap-3 px-card py-3">
            <p className="text-xs text-foreground-lighter">
              {current && !dirty
                ? tr('admin:adminNotice.showingNowPostedBy', { postedBy: current.posted_by, relativeTime: relativeTime(current.posted_at) })
                : current
                  ? tr('admin:adminNotice.notPostedYetSNoticeShows', { postedBy: current.posted_by })
                  : tr('admin:adminNotice.notPostedYetNobodySeesIt')}
            </p>
            {current && (
              <Button variant="danger" onClick={onTakeDown}>
                {tr('admin:adminNotice.takeDown')}
              </Button>
            )}
          </div>
        </Card>
      </SettingsSection>

      <SettingsSection title={current ? tr('admin:adminNotice.changeTheNotice') : tr('admin:adminNotice.postANotice')}>
        <Card>
          <CardContent className="flex flex-col gap-6">
            <FormField
              label={tr('admin:adminNotice.noticeType')}
              htmlFor="notice-type"
              layout="horizontal"
              description={tr('admin:adminNotice.setsTheNoticeSColourAnd')}
            >
              <Select value={type} onValueChange={(v) => setType(v as NoticeType)}>
                <SelectTrigger id="notice-type" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTICE_TYPES().map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      <span className="flex items-center gap-2">
                        <t.icon size={16} className={t.iconClass} />
                        {t.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={tr('admin:adminNotice.message')}
              htmlFor="notice-message"
              layout="horizontal"
              error={tooLong ? tr('admin:adminNotice.charactersTooMany', { length: length - MAX_NOTICE_MESSAGE }) : undefined}
              description={
                <>
                  <Trans i18nKey="admin:adminNotice.shownOnOneLineLineBreaks" components={{ code: <code className="font-mono" />, code2: <code className="font-mono" /> }} />
                </>
              }
            >
              <Textarea
                id="notice-message"
                rows={3}
                value={message}
                aria-invalid={tooLong || undefined}
                placeholder={tr('admin:adminNotice.supermixerWillBeDownForAn')}
                onChange={(e) => setMessage(e.target.value)}
              />
              <p
                className={cn(
                  'self-end text-xs tabular-nums',
                  tooLong ? 'text-destructive' : 'text-foreground-lighter'
                )}
              >
                {length} / {MAX_NOTICE_MESSAGE}
              </p>
            </FormField>
            {post.error && <Alert variant="destructive" title={post.error.message} />}
          </CardContent>
          <CardFooter>
            {current && (
              <Button
                variant="default"
                disabled={!dirty}
                onClick={() => {
                  setType(current.type)
                  setMessage(current.message)
                }}
              >
                {tr('admin:adminNotice.cancel')}
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!dirty || empty || tooLong}
              loading={post.isPending}
              onClick={() => post.mutate()}
            >
              {current ? tr('admin:adminNotice.updateNotice') : tr('admin:adminNotice.postNotice')}
            </Button>
          </CardFooter>
        </Card>
      </SettingsSection>
    </>
  )
}
