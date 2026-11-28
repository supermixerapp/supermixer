/*
 * The instance-wide notice an instance admin posts (Instance › Global
 * notice): a band above the header on every page, as tall as the header.
 */
import { queryOptions, useQuery } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useMemo, type MouseEvent } from 'react'

import { ErrorIcon, InfoIcon, WarningIcon } from '@/components/icons'
import type { Icon } from '@/components/icon'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { noticePlainText, parseNotice, type NoticeNode } from '@/lib/notice-markdown'
import { cn } from '@/lib/utils'
import { localized, t as tr } from '@/lib/i18n'

export type NoticeType = Schemas['NoticeType']

/** The most characters a message may have (the server's limit too). */
export const MAX_NOTICE_MESSAGE = 256

/** Each type's name, icon and colours, in the order the admin page offers them. */
export const NOTICE_TYPES = localized((): {
  value: NoticeType
  label: string
  icon: Icon
  band: string
  iconClass: string
}[] => [
  {
    value: 'info',
    label: tr('common:globalNotice.info'),
    icon: InfoIcon,
    band: 'border-brand-500 bg-brand-300',
    iconClass: 'text-brand-600',
  },
  {
    value: 'warning',
    label: tr('common:globalNotice.warning'),
    icon: WarningIcon,
    band: 'border-warning-500 bg-warning-300',
    iconClass: 'text-warning-600',
  },
  {
    value: 'critical',
    label: tr('common:globalNotice.critical'),
    icon: ErrorIcon,
    band: 'border-destructive-500 bg-destructive-400',
    iconClass: 'text-destructive-600',
  },
])

export const noticeTypeOf = (t: NoticeType) =>
  NOTICE_TYPES().find((x) => x.value === t) ?? NOTICE_TYPES()[0]!

/** Characters as the server counts them (code points, so an emoji is one). */
export const noticeLength = (message: string) => [...normalizeNotice(message)].length

/**
 * The message as the server keeps it: one line, runs of whitespace as one
 * space. The same characters as Go's unicode.IsSpace (JavaScript's \s also
 * has U+FEFF, which the server keeps).
 */
const SPACES = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/
export const normalizeNotice = (message: string) => message.split(SPACES).filter(Boolean).join(' ')

export const noticeQuery = queryOptions({
  queryKey: ['notice'],
  queryFn: () => unwrap(api.GET('/notice')),
  // A notice posted while people are signed in reaches them within a minute.
  refetchInterval: 60_000,
})

/** The band itself, for a notice's type and message. */
export function NoticeBand({
  type,
  message,
  className,
  live = true,
}: {
  type: NoticeType
  message: string
  className?: string
  /** Announced by screen readers (not for a preview that changes as you type). */
  live?: boolean
}) {
  const t = noticeTypeOf(type)
  const nodes = useMemo(() => parseNotice(message), [message])
  return (
    <div
      role={live ? (type === 'critical' ? 'alert' : 'status') : undefined}
      aria-label={live ? tr('common:globalNotice.notice', { label: t.label }) : undefined}
      className={cn(
        'flex h-12 shrink-0 items-center justify-center gap-2.5 border-b px-4 text-sm text-foreground',
        t.band,
        className
      )}
    >
      <t.icon size={18} className={cn('shrink-0', t.iconClass)} />
      {/* Two lines fit the band; the whole message is in the tooltip. */}
      <p className="line-clamp-2 min-w-0 text-center leading-4" title={noticePlainText(nodes)}>
        <NoticeNodes nodes={nodes} />
      </p>
    </div>
  )
}

/** The posted notice, if any, for the top of every page. */
export function GlobalNotice() {
  const notice = useQuery(noticeQuery).data?.notice
  if (!notice) return null
  return <NoticeBand type={notice.type} message={notice.message} />
}

/** A parsed message: bold, and links (paths in Supermixer open in place). */
function NoticeNodes({ nodes }: { nodes: NoticeNode[] }) {
  const router = useRouter()
  return nodes.map((n, i) =>
    n.kind === 'text' ? (
      n.text
    ) : n.kind === 'bold' ? (
      <strong key={i} className="font-semibold">
        <NoticeNodes nodes={n.children} />
      </strong>
    ) : (
      <a
        key={i}
        href={n.href}
        className="font-medium underline underline-offset-2 hover:opacity-80"
        {...(n.external
          ? { target: '_blank', rel: 'noopener noreferrer' }
          : {
              onClick: (e: MouseEvent<HTMLAnchorElement>) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                e.preventDefault()
                void router.navigate({ href: n.href })
              },
            })}
      >
        <NoticeNodes nodes={n.children} />
      </a>
    )
  )
}
