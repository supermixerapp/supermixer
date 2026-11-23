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

/** The functions of a stack Supermixer created. */
export function FunctionList({ project }: { project: Schemas['Project'] }) {
  const fns = useQuery(functionsQuery(project.ref))
  const canDeploy = can(project, 'project:functions:deploy')
  const [creating, setCreating] = useState(false)

  return (
    <DatabasePage
      title="Edge Functions"
      description="Server-side TypeScript functions run by the stack's Edge Runtime, at /functions/v1/<name>."
      actions={
        <PermissionButton
          allowed={canDeploy}
          action="deploy functions"
          variant="primary"
          icon={<AddIcon />}
          onClick={() => setCreating(true)}
        >
          Deploy a new function
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
                <TableHead>Name</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Files</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fns.data.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="py-8 text-center text-foreground-lighter">
                    No functions yet
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
                      {!f.entrypoint && <span className="ml-2 text-xs text-warning">no index.ts</span>}
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
  const problem = functionNameProblem(trimmed) ?? (taken.includes(trimmed) ? 'There is a function of that name' : null)
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
            <DialogTitle>Deploy a new function</DialogTitle>
            <DialogDescription>
              It starts from a small example; edit it, then deploy. The name is part of its URL.
            </DialogDescription>
          </DialogHeader>
          <DialogSection className="border-t">
            <FormField
              label="Name"
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
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!!problem}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
