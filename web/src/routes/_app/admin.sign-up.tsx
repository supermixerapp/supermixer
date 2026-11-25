/*
 * Instance › Sign-up: whether people can create their own accounts, which
 * addresses may, and whether new accounts wait for an instance admin's
 * approval (on Instance › Users).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'

import { AdminLayout } from '@/components/layout/admin-layout'
import { SettingsSection } from '@/components/layout/section'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { api, unwrap, type Schemas } from '@/lib/api/client'
import { useProfile } from '@/lib/api/hooks'
import { resourceLimitsQuery, signUpSettingsQuery, uiConfigQuery } from '@/lib/api/queries'

export const Route = createFileRoute('/_app/admin/sign-up')({
  component: SignUpSettingsPage,
})

function SignUpSettingsPage() {
  const { data: me } = useProfile()
  const settings = useQuery({ ...signUpSettingsQuery, enabled: !!me?.is_instance_admin })
  const saved = settings.data
  return (
    <AdminLayout
      title="Sign-up"
      description="Whether people can create their own accounts here. Accounts made by an instance admin or through an invitation link work either way."
    >
      {settings.error ? (
        <Alert variant="destructive" title={settings.error.message} />
      ) : !saved ? (
        <Skeleton className="h-80" />
      ) : (
        // Remount after saving, so the form starts from what's saved.
        <SignUpForm key={JSON.stringify(saved)} saved={saved} />
      )}
    </AdminLayout>
  )
}

const domainsText = (d: string[]) => d.join(', ')
const parseDomains = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean)

function SignUpForm({ saved }: { saved: Schemas['SignUpSettings'] }) {
  const queryClient = useQueryClient()
  const ui = useQuery(uiConfigQuery).data
  const limits = useQuery(resourceLimitsQuery).data
  const emailOn = ui?.email_enabled ?? true
  const [enabled, setEnabled] = useState(saved.enabled)
  const [domains, setDomains] = useState(domainsText(saved.allowed_domains))
  const [notify, setNotify] = useState(saved.notify_admins)
  const [approval, setApproval] = useState(saved.require_approval)
  const body: Schemas['SignUpSettings'] = {
    enabled,
    allowed_domains: parseDomains(domains),
    notify_admins: notify,
    require_approval: approval,
  }
  const dirty =
    enabled !== saved.enabled ||
    domainsText(body.allowed_domains) !== domainsText(saved.allowed_domains) ||
    notify !== saved.notify_admins ||
    approval !== saved.require_approval
  const reset = () => {
    setEnabled(saved.enabled)
    setDomains(domainsText(saved.allowed_domains))
    setNotify(saved.notify_admins)
    setApproval(saved.require_approval)
  }
  const save = useMutation({
    mutationFn: () => unwrap(api.PUT('/admin/sign-up', { body })),
    onSuccess: (s) => {
      toast.success('Sign-up settings saved')
      queryClient.setQueryData(signUpSettingsQuery.queryKey, s)
      void queryClient.invalidateQueries({ queryKey: uiConfigQuery.queryKey })
    },
  })
  // Stacks on this server, and no limit on how many organizations each new
  // person can create (and so add projects to).
  const unlimited = ui?.provisioning.enabled && limits && limits.max_organizations_per_user == null

  return (
    <>
      {!emailOn && (
        <Alert variant="warning" title="This Supermixer can't send email">
          Sign-up sends each person a link by email, so it can&apos;t be turned on until email is
          set up in the server&apos;s configuration (
          <code className="font-mono text-xs">[email]</code> in{' '}
          <code className="font-mono text-xs">.env.toml</code>).
        </Alert>
      )}
      <SettingsSection title="Sign-up">
        <Card>
          <CardContent className="flex flex-col gap-8">
            <FormField
              label="Allow people to create accounts"
              htmlFor="su-enabled"
              layout="horizontal"
              description="The sign-in page offers “Create one”. People enter their email address and get a link to choose a username and password."
            >
              <div className="flex min-h-9 items-center">
                <Switch
                  id="su-enabled"
                  checked={enabled}
                  disabled={!emailOn && !enabled}
                  onCheckedChange={setEnabled}
                />
              </div>
            </FormField>
            <FormField
              label="Allowed email domains"
              htmlFor="su-domains"
              layout="horizontal"
              description="Only addresses at these domains can sign up, such as example.com. Separate them with commas. Leave it empty to allow any address."
            >
              <Input
                id="su-domains"
                placeholder="Any domain"
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
              />
            </FormField>
            <FormField
              label="New accounts need approval"
              htmlFor="su-approval"
              layout="horizontal"
              description="New accounts can't sign in until an instance admin approves them under Instance › Users."
            >
              <div className="flex min-h-9 items-center">
                <Switch id="su-approval" checked={approval} onCheckedChange={setApproval} />
              </div>
            </FormField>
            <FormField
              label="Email instance admins about new accounts"
              htmlFor="su-notify"
              layout="horizontal"
              description="Each instance admin with an email address gets an email when someone signs up."
            >
              <div className="flex min-h-9 items-center">
                <Switch id="su-notify" checked={notify} onCheckedChange={setNotify} />
              </div>
            </FormField>
            {enabled && unlimited && (
              <Alert
                variant="warning"
                title="New accounts can create as many projects as they like"
              >
                Anyone who signs up can create organizations and start new Supabase stacks on this
                server. Set limits under{' '}
                <Link to="/admin/limits" className="text-link">
                  Instance › Resource limits
                </Link>{' '}
                first.
              </Alert>
            )}
            {save.error && <Alert variant="destructive" title={save.error.message} />}
          </CardContent>
          <CardFooter>
            <Button variant="default" disabled={!dirty} onClick={reset}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          </CardFooter>
        </Card>
      </SettingsSection>
    </>
  )
}
