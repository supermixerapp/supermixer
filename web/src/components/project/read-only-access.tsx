import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can } from '@/lib/api/hooks'
import { projectQuery } from '@/lib/api/queries'

/**
 * Whether Read-only members' queries run as their own database login. Without
 * one they run as the project's admin user inside a read-only transaction:
 * data can't change, but functions such as pg_terminate_backend still work.
 */
export function ReadOnlyAccess({ project }: { project: Schemas['Project'] }) {
  const queryClient = useQueryClient()
  const [removing, setRemoving] = useState(false)
  const user = project.database.read_only_user
  const canUpdate = can(project, 'project:update')
  const done = (p: Schemas['Project']) => {
    queryClient.setQueryData(projectQuery(p.ref).queryKey, p)
    void queryClient.invalidateQueries({ queryKey: ['projects'] })
  }
  const create = useMutation({
    mutationFn: () => unwrap(api.POST('/projects/{ref}/read-only-user', { params: { path: { ref: project.ref } } })),
    onSuccess: (p) => {
      done(p)
      toast.success(`Created ${p.database.read_only_user}`)
    },
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/projects/{ref}/read-only-user', { params: { path: { ref: project.ref } } })),
    onSuccess: (p) => {
      setRemoving(false)
      done(p)
      toast.success('Read-only user removed')
    },
    onError: (e) => {
      setRemoving(false)
      toast.error(e.message)
    },
  })

  return (
    <SettingsSection
      title="Read-only access"
      description="How queries run for members with the Read-only role, in the SQL Editor and every read-only page."
    >
      <Card>
        <CardContent className="flex flex-col gap-4">
          {user ? (
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1 text-sm">
                <span className="flex items-center gap-2 text-foreground">
                  Separate database user <Badge variant="success">On</Badge>
                </span>
                <span className="text-foreground-light">
                  Read-only queries sign in as <code className="font-mono text-xs">{user}</code>, which can read everything but
                  cannot write, switch role or end other connections.
                </span>
              </div>
              <PermissionButton
                allowed={canUpdate}
                action="change project settings"
                variant="default"
                onClick={() => setRemoving(true)}
              >
                Remove
              </PermissionButton>
            </div>
          ) : (
            <>
              <Alert variant="warning" title="Read-only queries share the admin database user">
                They run in a read-only transaction, so data and schema can&apos;t change. Functions that act outside the
                transaction still work, for example ending other connections with pg_terminate_backend.
              </Alert>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-foreground-light">
                  Create a separate login on this database (with pg_read_all_data) for read-only queries.
                </p>
                <PermissionButton
                  allowed={canUpdate}
                  action="change project settings"
                  variant="primary"
                  loading={create.isPending}
                  onClick={() => create.mutate()}
                >
                  Create read-only user
                </PermissionButton>
              </div>
              {create.error && <Alert variant="destructive" title={create.error.message} />}
            </>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove the read-only user?"
        description={`This drops ${user} from the database. Read-only queries go back to running in a read-only transaction as the admin user.`}
        confirmLabel="Remove"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </SettingsSection>
  )
}
