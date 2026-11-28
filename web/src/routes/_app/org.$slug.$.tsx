import { createFileRoute } from '@tanstack/react-router'

import { ComingSoon } from '@/components/layout/page'
import { orgSettingsMenu } from '@/lib/navigation'

import { NotFoundContent } from '../__root'
import { t } from '@/lib/i18n'

/**
 * Organization pages not built yet show which stage brings them. Anything
 * else renders a not-found message inside the org layout (without this route
 * TanStack's fuzzy not-found would nest a second app shell).
 */
export const Route = createFileRoute('/_app/org/$slug/$')({
  component: OrgPlaceholder,
})

function OrgPlaceholder() {
  const { _splat } = Route.useParams()
  const item = orgSettingsMenu().groups.flatMap((g) => g.items).find((i) => i.path === _splat?.replace(/\/+$/, ''))
  if (!item) return <NotFoundContent />
  return <ComingSoon title={t('org:page.organizationSettings', { label: item.label })} stage={item.stage} soon={item.soon} />
}
