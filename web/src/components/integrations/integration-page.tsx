/*
 * Frame for one integration (Cron, Queues, Vault, …): a back link to the
 * Integrations list, a header, and an "enable the extension" step when the
 * extension it needs isn't installed yet.
 */
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { DatabasePage, useCanChange, useDdl } from '@/components/database/catalog-page'
import { ArrowBackIcon } from '@/components/icons'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { enableExtension } from '@/lib/pg/database'
import { usePg } from '@/lib/pg/run'
import { t, Trans } from '@/lib/i18n'

export interface ExtensionState {
  installed_version: string | null
  default_version: string | null
  schema: string | null
}

export const EXTENSION_SQL = `
select a.default_version, e.extversion as installed_version, n.nspname as schema
from (select $1::text as name) x
left join pg_available_extensions a on a.name = x.name
left join pg_extension e on e.extname = x.name
left join pg_namespace n on n.oid = e.extnamespace`

/** Whether an extension is installed, and where. */
export function useExtension(projectRef: string, name: string) {
  const q = usePg<ExtensionState>(projectRef, ['extension', name], EXTENSION_SQL, [name])
  return { ...q, state: q.data?.[0] }
}

export function IntegrationPage({
  projectRef,
  title,
  description,
  extension,
  about,
  toolbar,
  actions,
  children,
}: {
  projectRef: string
  title: string
  description: ReactNode
  /** The Postgres extension this integration needs, and the schema to install it in (null: its own). */
  extension?: { name: string; schema: string | null }
  /** Shown with the "enable" button: what turning it on does. */
  about?: ReactNode
  toolbar?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  const ext = useExtension(projectRef, extension?.name ?? '')
  const canChange = useCanChange()
  const ddl = useDdl(projectRef)
  const ready = !extension || !!ext.state?.installed_version

  return (
    <DatabasePage
      title={title}
      description={
        <span className="flex flex-col gap-2">
          <Link to="/project/$ref/integrations" params={{ ref: projectRef }} className="flex w-fit items-center gap-1 text-xs text-foreground-lighter hover:text-foreground">
            <Trans i18nKey="integrations:integrationPage.integrations" components={{ arrowbackicon: <ArrowBackIcon size={14} /> }} />
          </Link>
          <span>{description}</span>
        </span>
      }
      toolbar={ready ? toolbar : undefined}
      actions={ready ? actions : undefined}
    >
      {!extension ? (
        children
      ) : ext.error ? (
        <Alert variant="destructive" title={ext.error.message} />
      ) : !ext.state ? (
        <Skeleton className="h-32" />
      ) : ext.state.installed_version ? (
        children
      ) : !ext.state.default_version ? (
        <Alert variant="warning" title={t('integrations:integrationPage.theExtensionIsnTAvailableOn', { name: extension.name })}>
          {t('integrations:integrationPage.theStackSPostgresImageDoesn')}
        </Alert>
      ) : (
        <Card className="flex flex-col items-start gap-3 p-6">
          <p className="text-sm text-foreground">{t('integrations:integrationPage.enableTheExtension', { name: extension.name })}</p>
          {about && <p className="max-w-2xl text-sm text-foreground-light">{about}</p>}
          <PermissionButton
            allowed={canChange}
            action={t('integrations:integrationPage.enableExtensions')}
            variant="primary"
            loading={ddl.isPending}
            onClick={() => ddl.mutate({ sql: enableExtension(extension.name, extension.schema), done: t('integrations:integrationPage.enabled', { name: extension.name }) })}
          >
            {t('integrations:integrationPage.enable', { name: extension.name })}
          </PermissionButton>
        </Card>
      )}
    </DatabasePage>
  )
}
