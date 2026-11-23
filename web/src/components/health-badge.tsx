import { Badge } from '@/components/ui/badge'

const variants = {
  healthy: { label: 'Healthy', variant: 'success' },
  degraded: { label: 'Degraded', variant: 'warning' },
  unhealthy: { label: 'Unhealthy', variant: 'destructive' },
} as const

export function HealthBadge({ status, loading }: { status?: keyof typeof variants; loading?: boolean }) {
  if (loading || !status) return <Badge>{loading ? 'Checking…' : 'Unknown'}</Badge>
  const v = variants[status]
  return <Badge variant={v.variant}>{v.label}</Badge>
}
