import { Link } from '@tanstack/react-router'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

/** A stack Supermixer created with its logs off: no Logflare or Vector. */
export function LogsOffAlert({
  projectRef,
  children,
}: {
  projectRef: string
  children?: React.ReactNode
}) {
  return (
    <Alert
      title="Logs are off for this project"
      actions={
        <Button asChild size="tiny" variant="default">
          <Link to="/project/$ref/settings/infrastructure" params={{ ref: projectRef }}>
            Turn logs on
          </Link>
        </Button>
      }
    >
      {children ??
        'Supermixer doesn’t run Logflare and Vector for this project, so nothing is being logged.'}{' '}
      Turn logs on under Settings › Infrastructure.
    </Alert>
  )
}
