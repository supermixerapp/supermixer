import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { DatabasePage } from '@/components/database/catalog-page'
import { AddIcon } from '@/components/icons'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '@/components/ui/dialog'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Schemas } from '@/lib/api/client'
import { can } from '@/lib/api/hooks'
import { relativeTime } from '@/lib/auth-users'

import { formatBytes, functionNameProblem, functionsQuery } from './api'
import { t } from '@/lib/i18n'

/** The functions of a stack Supermixer created. */
export function FunctionList({ project }: { project: Schemas['Project'] }) {
  const fns = useQuery(functionsQuery(project.ref))
  const canDeploy = can(project, 'project:functions:deploy')
  const [creating, setCreating] = useState(false)

  return (
    <DatabasePage
      title={t('functions:functionList.edgeFunctions')}
      description={t('functions:functionList.serverSideTypescriptFunctionsRunBy')}
      actions={
        <PermissionButton
          allowed={canDeploy}
          action={t('functions:functionList.deployFunctions')}
          variant="primary"
          icon={<AddIcon />}
          onClick={() => setCreating(true)}
        >
          {t('functions:functionList.deployANewFunction')}
        </PermissionButton>
      }
    >
      {fns.error ? (
        <Alert variant="destructive" title={fns.error.message} />
      ) : !fns.data ? (
        <Skeleton className="h-40" />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('functions:functionList.name')}</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>{t('functions:functionList.updated')}</TableHead>
                <TableHead className="text-right">{t('functions:functionList.files')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fns.data.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="py-8 text-center text-foreground-lighter">
                    {t('functions:functionList.noFunctionsYet')}
                  </TableCell>
                </TableRow>
              ) : (
                fns.data.map((f) => (
                  <TableRow key={f.name}>
                    <TableCell>
                      <Link
                        to="/project/$ref/functions/$name"
                        params={{ ref: project.ref, name: f.name }}
                        className="font-mono text-xs text-foreground hover:underline"
                      >
                        {f.name}
                      </Link>
                      {!f.entrypoint && <span className="ml-2 text-xs text-warning">{t('functions:functionList.noIndexTs')}</span>}
                    </TableCell>
                    <TableCell className="max-w-80">
                      <CopyField value={f.url} />
                    </TableCell>
                    <TableCell className="text-xs text-foreground-lighter">{relativeTime(f.updated_at)}</TableCell>
                    <TableCell className="text-right text-xs text-foreground-lighter">
                      {f.files} · {formatBytes(f.size)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      )}
      {creating && (
        <NewFunctionDialog
          projectRef={project.ref}
          taken={(fns.data ?? []).map((f) => f.name)}
          onClose={() => setCreating(false)}
        />
      )}
    </DatabasePage>
  )
}

function NewFunctionDialog({ projectRef, taken, onClose }: { projectRef: string; taken: string[]; onClose: () => void }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const problem = functionNameProblem(trimmed) ?? (taken.includes(trimmed) ? t('functions:functionList.thereIsAFunctionOfThat') : null)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="small">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (problem) return
            void navigate({
              to: '/project/$ref/functions/$name',
              params: { ref: projectRef, name: trimmed },
              search: { new: true },
            })
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('functions:functionList.deployANewFunction')}</DialogTitle>
            <DialogDescription>
              {t('functions:functionList.itStartsFromASmallExample')}
            </DialogDescription>
          </DialogHeader>
          <DialogSection className="border-t">
            <FormField
              label={t('functions:functionList.name')}
              htmlFor="fn-new-name"
              description={problem && name ? <span className="text-destructive">{problem}</span> : undefined}
            >
              <Input
                id="fn-new-name"
                autoFocus
                autoComplete="off"
                className="font-mono"
                placeholder="hello-world"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </FormField>
          </DialogSection>
          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>
              {t('functions:functionList.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={!!problem}>
              {t('functions:functionList.continue')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
