import { Link } from '@tanstack/react-router'

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { t } from '@/lib/i18n'

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
      title={t('observability:logsOff.logsAreOffForThisProject')}
      actions={
        <Button asChild size="tiny" variant="default">
          <Link to="/project/$ref/settings/infrastructure" params={{ ref: projectRef }}>
            {t('observability:logsOff.turnLogsOn')}
          </Link>
        </Button>
      }
    >
      {children ?? t('observability:logsOff.notLogged')} {t('observability:logsOff.turnLogsOnUnder')}
    </Alert>
  )
}
