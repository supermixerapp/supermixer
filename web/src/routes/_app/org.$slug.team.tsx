import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { AddIcon, SearchIcon, SettingsIcon } from '@/components/icons'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { can, useProfile, useProjects, useSelectedOrganization } from '@/lib/api/hooks'
import { invitationsQuery, membersQuery, uiConfigQuery } from '@/lib/api/queries'
import { ORG_ROLES, PROJECT_ROLES, roleLabel, type OrgRole, type ProjectRole } from '@/lib/roles'

export const Route = createFileRoute('/_app/org/$slug/team')({
  component: TeamPage,
})

type Assignment = { ref: string; role: ProjectRole }

function TeamPage() {
  const { slug } = Route.useParams()
  const org = useSelectedOrganization()
  const { data: me } = useProfile()
  const members = useQuery(membersQuery(slug))
  const canInvite = can(org, 'members:invite')
  const invitations = useQuery({ ...invitationsQuery(slug), enabled: canInvite })
  const [search, setSearch] = useState('')
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<Schemas['Member'] | null>(null)
  const [removing, setRemoving] = useState<Schemas['Member'] | null>(null)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const remove = useMutation({
    mutationFn: (m: Schemas['Member']) =>
      unwrap(api.DELETE('/organizations/{slug}/members/{user_id}', { params: { path: { slug, user_id: m.user_id } } })),
    onSuccess: async (_, m) => {
      setRemoving(null)
      if (m.user_id === me?.id) {
        toast.success(`You left ${org?.name}`)
        await queryClient.invalidateQueries()
        void navigate({ to: '/organizations' })
        return
      }
      toast.success(`Removed ${m.username}`)
      await queryClient.invalidateQueries({ queryKey: ['organizations', slug] })
    },
    onError: (e) => toast.error(e.message),
  })
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE('/organizations/{slug}/invitations/{invitation_id}', {
          params: { path: { slug, invitation_id: id } },
        })
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationsQuery(slug).queryKey }),
    onError: (e) => toast.error(e.message),
  })

  const visible = (members.data ?? []).filter((m) =>
    [m.username, m.display_name, m.email ?? ''].some((v) => v.toLowerCase().includes(search.toLowerCase()))
  )
  const self = members.data?.find((m) => m.user_id === me?.id)
  const canManage = (m: Schemas['Member']) =>
    can(org, 'members:update') && (m.role !== 'owner' || org?.role === 'owner')

  return (
    <>
      <PageHeader title="Team" description="Manage who can access this organization and its projects." size="large" />
      <PageContainer size="large" className="flex flex-col gap-10 pb-16">
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="relative w-full max-w-64">
              <SearchIcon
                size={14}
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-foreground-lighter"
              />
              <Input
                size="tiny"
                className="pl-7"
                placeholder="Filter members"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              {self && (
                <Button variant="default" onClick={() => setRemoving(self)}>
                  Leave organization
                </Button>
              )}
              <PermissionButton
                allowed={canInvite}
                action="invite members"
                variant="primary"
                icon={<AddIcon />}
                onClick={() => setInviting(true)}
              >
                Invite members
              </PermissionButton>
            </div>
          </div>
          <Card>
            {members.isPending ? (
              <div className="flex flex-col gap-2 p-4">
                <Skeleton className="h-6" />
                <Skeleton className="h-6" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Member</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Projects</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((m) => (
                    <TableRow key={m.user_id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar name={m.display_name || m.username} />
                          <div className="flex min-w-0 flex-col">
                            <span className="flex items-center gap-2 truncate text-foreground">
                              {m.display_name || m.username}
                              {m.user_id === me?.id && <Badge>You</Badge>}
                              {m.mfa_enabled ? (
                                <Badge variant="success" title="Signs in with an authenticator app">2FA</Badge>
                              ) : (
                                org?.mfa_required && (
                                  <Badge variant="warning" title="Can't open this organization until they turn on two-factor sign-in">
                                    No 2FA
                                  </Badge>
                                )
                              )}
                            </span>
                            <span className="truncate text-xs text-foreground-lighter">
                              {m.username}
                              {m.email ? ` · ${m.email}` : ''}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-foreground-light">{roleLabel(m.role)}</TableCell>
                      <TableCell className="text-foreground-light">
                        {m.role !== 'no_access' ? (
                          'All projects'
                        ) : m.project_roles.length === 0 ? (
                          <span className="text-foreground-lighter">None</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {m.project_roles.map((pr) => (
                              <Badge key={pr.ref}>
                                {pr.name}: {roleLabel(pr.role)}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {(canManage(m) || can(org, 'members:remove')) && m.user_id !== me?.id && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="text" icon={<SettingsIcon />} aria-label={`Manage ${m.username}`} />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              <DropdownMenuItem disabled={!canManage(m)} onSelect={() => setEditing(m)}>
                                Edit access
                              </DropdownMenuItem>
                              <DropdownMenuItem disabled={!canManage(m)} onSelect={() => setRemoving(m)}>
                                Remove from organization
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </section>

        {canInvite && (
          <section className="flex flex-col gap-4">
            <div>
              <h3 className="heading-subSection">Pending invitations</h3>
              <p className="text-sm text-foreground-light">Links stop working after 7 days or once used.</p>
            </div>
            <Card>
              {invitations.data && invitations.data.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>For</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Invited by</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invitations.data.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell>{inv.email || <span className="text-foreground-lighter">Anyone with the link</span>}</TableCell>
                        <TableCell className="text-foreground-light">{roleLabel(inv.role)}</TableCell>
                        <TableCell className="text-foreground-light">{inv.invited_by}</TableCell>
                        <TableCell className="text-foreground-light">{new Date(inv.expires_at).toLocaleDateString()}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="default" loading={revoke.isPending && revoke.variables === inv.id} onClick={() => revoke.mutate(inv.id)}>
                            Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="px-4 py-6 text-center text-sm text-foreground-lighter">No pending invitations</p>
              )}
            </Card>
          </section>
        )}
      </PageContainer>

      <InviteDialog slug={slug} open={inviting} onOpenChange={setInviting} actorRole={org?.role} />
      {editing && <EditAccessDialog slug={slug} member={editing} actorRole={org?.role} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing?.user_id === me?.id ? `Leave ${org?.name}?` : `Remove ${removing?.username}?`}
        description={
          removing?.user_id === me?.id
            ? 'You will lose access to this organization and its projects until someone invites you again.'
            : 'They will lose access to this organization and all of its projects.'
        }
        confirmLabel={removing?.user_id === me?.id ? 'Leave organization' : 'Remove member'}
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </>
  )
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('')
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-surface-300 text-xs text-foreground-light">
      {initials || '?'}
    </span>
  )
}

/** Role picker plus, for No access members, the projects they can use. */
function AccessEditor({
  slug,
  role,
  assignments,
  actorRole,
  onChange,
}: {
  slug: string
  role: OrgRole
  assignments: Assignment[]
  actorRole?: OrgRole
  onChange: (role: OrgRole, assignments: Assignment[]) => void
}) {
  const { data: projects = [] } = useProjects()
  const orgProjects = projects.filter((p) => p.organization_slug === slug)
  const roles = ORG_ROLES.filter((r) => r.value !== 'owner' || actorRole === 'owner')
  const assigned = (ref: string) => assignments.find((a) => a.ref === ref)

  return (
    <div className="flex flex-col gap-4">
      <FormField label="Role" description={ORG_ROLES.find((r) => r.value === role)?.description}>
        <Select value={role} onValueChange={(v) => onChange(v as OrgRole, v === 'no_access' ? assignments : [])}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roles.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      {role === 'no_access' && (
        <FormField label="Project access" description="Choose the projects this member can use, and their role on each.">
          {orgProjects.length === 0 ? (
            <p className="text-sm text-foreground-lighter">This organization has no projects yet.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-md border">
              {orgProjects.map((p) => {
                const a = assigned(p.ref)
                return (
                  <li key={p.ref} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      id={`proj-${p.ref}`}
                      checked={!!a}
                      onCheckedChange={(checked) =>
                        onChange(
                          role,
                          checked
                            ? [...assignments, { ref: p.ref, role: 'developer' }]
                            : assignments.filter((x) => x.ref !== p.ref)
                        )
                      }
                    />
                    <label htmlFor={`proj-${p.ref}`} className="flex-1 truncate text-sm">
                      {p.name}
                    </label>
                    <Select
                      value={a?.role ?? 'developer'}
                      disabled={!a}
                      onValueChange={(v) =>
                        onChange(
                          role,
                          assignments.map((x) => (x.ref === p.ref ? { ...x, role: v as ProjectRole } : x))
                        )
                      }
                    >
                      <SelectTrigger size="tiny" className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROJECT_ROLES.map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </li>
                )
              })}
            </ul>
          )}
        </FormField>
      )}
    </div>
  )
}

function InviteDialog({
  slug,
  open,
  onOpenChange,
  actorRole,
}: {
  slug: string
  open: boolean
  onOpenChange: (o: boolean) => void
  actorRole?: OrgRole
}) {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('developer')
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [link, setLink] = useState<string | null>(null)
  const [emailed, setEmailed] = useState<{ sent: boolean; error?: string | null } | null>(null)
  const emailOn = useQuery(uiConfigQuery).data?.email_enabled ?? false

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/organizations/{slug}/invitations', {
          params: { path: { slug } },
          body: { email: email || undefined, role, project_roles: assignments },
        })
      ),
    onSuccess: (inv) => {
      setLink(inv.url)
      // Only when Supermixer sends email; otherwise there's nothing to report.
      setEmailed(emailOn && inv.email ? { sent: inv.email_sent, error: inv.email_error } : null)
      void queryClient.invalidateQueries({ queryKey: invitationsQuery(slug).queryKey })
    },
  })

  const close = (o: boolean) => {
    if (!o) {
      setEmail('')
      setRole('developer')
      setAssignments([])
      setLink(null)
      setEmailed(null)
      create.reset()
    }
    onOpenChange(o)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="medium">
        <DialogHeader>
          <DialogTitle>{!link ? 'Invite a member' : emailed?.sent ? 'Invitation sent' : 'Share the invitation link'}</DialogTitle>
          <DialogDescription>
            {!link
              ? emailOn
                ? 'Email someone a link to join this organization, creating an account if they need one. Or leave the email empty to share the link yourself.'
                : 'Create a link that lets someone join this organization, creating an account if they need one.'
              : emailed?.sent
                ? `We emailed the link to ${email}. You can also share it yourself: it works once, for 7 days, and won't be shown again.`
                : 'Send this link to the person you are inviting. It works once and expires in 7 days. It will not be shown again.'}
          </DialogDescription>
        </DialogHeader>
        <DialogSection className="flex flex-col gap-4 border-t">
          {link ? (
            <>
              {emailed && !emailed.sent && (
                <Alert variant="warning" title="Couldn't email the invitation">
                  {emailed.error ?? 'The mail server refused it.'} Share the link yourself.
                </Alert>
              )}
              <CopyField value={link} />
            </>
          ) : (
            <>
              <FormField
                label="Email (optional)"
                htmlFor="inv-email"
                description={emailOn ? 'We’ll email them the link; it also pre-fills their sign-up form.' : 'Pre-fills their sign-up form.'}
              >
                <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </FormField>
              <AccessEditor
                slug={slug}
                role={role}
                assignments={assignments}
                actorRole={actorRole}
                onChange={(r, a) => {
                  setRole(r)
                  setAssignments(a)
                }}
              />
              {create.error && <Alert variant="destructive" title={create.error.message} />}
            </>
          )}
        </DialogSection>
        <DialogFooter>
          {link ? (
            <Button variant="primary" onClick={() => close(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="default" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={create.isPending}
                disabled={role === 'no_access' && assignments.length === 0}
                onClick={() => create.mutate()}
              >
                {emailOn && email ? 'Send invitation' : 'Create invitation link'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditAccessDialog({
  slug,
  member,
  actorRole,
  onClose,
}: {
  slug: string
  member: Schemas['Member']
  actorRole?: OrgRole
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [role, setRole] = useState<OrgRole>(member.role)
  const [assignments, setAssignments] = useState<Assignment[]>(
    member.project_roles.map((p) => ({ ref: p.ref, role: p.role }))
  )
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH('/organizations/{slug}/members/{user_id}', {
          params: { path: { slug, user_id: member.user_id } },
          body: { role, project_roles: assignments },
        })
      ),
    onSuccess: async () => {
      toast.success(`Updated access for ${member.username}`)
      await queryClient.invalidateQueries({ queryKey: ['organizations', slug] })
      onClose()
    },
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="medium">
        <DialogHeader>
          <DialogTitle>Edit access for {member.display_name || member.username}</DialogTitle>
        </DialogHeader>
        <DialogSection className="flex flex-col gap-4 border-t">
          <AccessEditor
            slug={slug}
            role={role}
            assignments={assignments}
            actorRole={actorRole}
            onChange={(r, a) => {
              setRole(r)
              setAssignments(a)
            }}
          />
          {save.error && <Alert variant="destructive" title={save.error.message} />}
        </DialogSection>
        <DialogFooter>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={role === 'no_access' && assignments.length === 0}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
