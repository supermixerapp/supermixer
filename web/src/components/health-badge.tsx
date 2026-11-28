import { Badge } from '@/components/ui/badge'
import { localized, t } from '@/lib/i18n'

const variants = localized(() => ({
  healthy: { label: t('common:healthBadge.healthy'), variant: 'success' },
  degraded: { label: t('common:healthBadge.degraded'), variant: 'warning' },
  unhealthy: { label: t('common:healthBadge.unhealthy'), variant: 'destructive' },
}) as const)

export function HealthBadge({ status, loading }: { status?: keyof ReturnType<typeof variants>; loading?: boolean }) {
  if (loading || !status) return <Badge>{loading ? t('common:healthBadge.checking') : t('common:healthBadge.unknown')}</Badge>
  const v = variants()[status]
  return <Badge variant={v.variant}>{v.label}</Badge>
}
