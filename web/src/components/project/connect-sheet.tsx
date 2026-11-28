import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { CodeBlock } from '@/components/ui/code-block'
import { CopyField } from '@/components/ui/copy'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Schemas } from '@/lib/api/client'
import { apiKeysQuery } from '@/lib/api/queries'
import { ident } from '@/lib/pg/sql'

/** Studio's "Connect" sheet: connection string, app snippets, env vars, psql. */
export function ConnectSheet({ project }: { project: Schemas['Project'] }) {
  const [open, setOpen] = useState(false)
  const keys = useQuery({ ...apiKeysQuery(project.ref), enabled: open })
  const publishable = keys.data?.find((k) => k.id === 'publishable' && k.value)?.value
  const publicKey = publishable ?? keys.data?.find((k) => k.id === 'anon' && k.value)?.value ?? '<your-anon-key>'
  // Name the variable after the kind of key it holds.
  const keyVar = publishable ? 'SUPABASE_PUBLISHABLE_KEY' : 'SUPABASE_ANON_KEY'

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button variant="default" onClick={() => setOpen(true)}>
        Connect
      </Button>
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>Connect to your project</SheetTitle>
          <SheetDescription>Get the connection strings and environment variables for {project.name}.</SheetDescription>
        </SheetHeader>
        <SheetSection>
          <Tabs defaultValue="direct">
            <TabsList>
              <TabsTrigger value="direct">Connection string</TabsTrigger>
              <TabsTrigger value="app">App frameworks</TabsTrigger>
              <TabsTrigger value="env">Environment variables</TabsTrigger>
              <TabsTrigger value="psql">Connect with psql</TabsTrigger>
            </TabsList>
            <TabsContent value="direct" className="flex flex-col gap-4">
              <FormField
                label="URI"
                description={
                  project.database.sslrootcert === 'download' ? (
                    <>
                      Replace [YOUR-PASSWORD] with the database password. Your tools also need{' '}
                      <CACertLink />: add <code className="font-mono">sslrootcert=</code> and where you saved it.
                    </>
                  ) : (
                    'Replace [YOUR-PASSWORD] with the database password.'
                  )
                }
              >
                <CopyField value={project.database.uri} />
              </FormField>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Host">
                  <CopyField value={project.database.host} />
                </FormField>
                <FormField label="Port">
                  <CopyField value={String(project.database.port)} />
                </FormField>
                <FormField label="Database">
                  <CopyField value={project.database.name} />
                </FormField>
                <FormField label="User">
                  <CopyField value={project.database.user} />
                </FormField>
              </div>
            </TabsContent>
            <TabsContent value="app" className="flex flex-col gap-3">
              <p className="text-sm text-foreground-light">Install the client, then create it with your project URL and public key.</p>
              {project.database.sslrootcert === 'download' && <TrustNote />}
              <CodeBlock code="npm install @supabase/supabase-js" />
              <CodeBlock
                code={`import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  '${project.api_url}',
  '${publicKey}'
)`}
              />
            </TabsContent>
            <TabsContent value="env" className="flex flex-col gap-3">
              <p className="text-sm text-foreground-light">
                For your app&apos;s environment file, such as <code className="font-mono text-xs">.env.local</code> in Next.js. The
                key is safe in a browser when Row Level Security is on.
              </p>
              <CodeBlock code={`SUPABASE_URL=${project.api_url}\n${keyVar}=${publicKey}`} />
            </TabsContent>
            <TabsContent value="psql">
              <PsqlSteps project={project} onNavigate={() => setOpen(false)} />
            </TabsContent>
          </Tabs>
        </SheetSection>
      </SheetContent>
    </Sheet>
  )
}

/** Where to download Supermixer's own CA certificate. */
function CACertLink() {
  return (
    <a href="/api/v1/tls/ca.pem" download className="text-foreground underline underline-offset-2">
      Supermixer’s certificate
    </a>
  )
}

/** For a private CA: computers have to trust it before HTTPS works. */
function TrustNote() {
  return (
    <p className="text-sm text-foreground-light">
      This project uses Supermixer’s own certificate, which computers don’t trust until you tell them to. Download{' '}
      <CACertLink /> and add it to your computer’s trusted certificates. For Node.js, set{' '}
      <code className="font-mono text-xs">NODE_EXTRA_CA_CERTS</code> to where you saved it.
    </p>
  )
}

/**
 * Connect with psql: make a login of your own, let it read the tables, and
 * connect. The commands fill in the login's name as it's typed.
 */
function PsqlSteps({ project, onNavigate }: { project: Schemas['Project']; onNavigate: () => void }) {
  const [name, setName] = useState('')
  const login = name.trim() || 'my_login'
  const db = project.database
  // Through Supabase's pooler (Supavisor), logins are written
  // <name>.<tenant>, as the project's own user is: postgres.<tenant>.
  const suffix = db.user.startsWith('postgres.') ? db.user.slice('postgres'.length) : ''
  // Always quoted, so names like user or Reader work as typed.
  const sqlName = ident(login)
  // As the API's connection string: an IPv6 host in brackets, sslmode only when set.
  const host = db.host.includes(':') && !db.host.startsWith('[') ? `[${db.host}]` : db.host
  const root = db.sslrootcert === 'system' ? 'system' : db.sslrootcert === 'download' ? 'supermixer-ca.pem' : null
  const url =
    `postgresql://${encodeURIComponent(login + suffix)}@${host}:${db.port}/${encodeURIComponent(db.name)}` +
    (db.sslmode ? `?sslmode=${encodeURIComponent(db.sslmode)}` : '') +
    (root ? `&sslrootcert=${root}` : '')
  const paused = project.stack?.status === 'paused'

  const link = (to: '/project/$ref/database/roles' | '/project/$ref/sql' | '/project/$ref/settings/infrastructure', label: ReactNode) => (
    <Link to={to} params={{ ref: project.ref }} onClick={onNavigate} className="text-foreground underline underline-offset-2">
      {label}
    </Link>
  )
  const step = 'flex flex-col gap-2'
  const lead = 'text-foreground'

  return (
    <div className="flex flex-col gap-4 text-sm text-foreground-light">
      <p>psql is Postgres&apos;s own command-line tool. To use it, you need a database login of your own.</p>
      {paused && <p>This project is paused. Start it first, under {link('/project/$ref/settings/infrastructure', 'Settings › Infrastructure')}.</p>}
      <ol className="flex list-decimal flex-col gap-5 pl-5 marker:text-foreground-lighter">
        <li className={step}>
          <p>
            <span className={lead}>Make your login.</span> In {link('/project/$ref/database/roles', 'Database › Roles')}, create a role. Give it a
            name and a password, and turn on <span className={lead}>Can log in</span>. If you can&apos;t, ask whoever looks after this project
            to make one for you.
          </p>
          <FormField label="Your login's name" htmlFor="psql-login" description="Type it here and the commands below will use it.">
            <Input id="psql-login" value={name} onChange={(e) => setName(e.target.value)} placeholder="my_login" autoComplete="off" spellCheck={false} />
          </FormField>
        </li>
        <li className={step}>
          <p>
            <span className={lead}>Let it read your tables.</span> A new login can&apos;t see anything yet. Run this in the{' '}
            {link('/project/$ref/sql', 'SQL Editor')}:
          </p>
          <CodeBlock code={`grant usage on schema public to ${sqlName};\ngrant select on all tables in schema public to ${sqlName};`} />
        </li>
        {db.sslrootcert === 'download' && (
          <li className={step}>
            <p>
              <span className={lead}>Get the certificate.</span> Your connection is encrypted with Supermixer&apos;s own certificate.
              Download <CACertLink /> and save it as <code className="font-mono text-xs text-foreground">supermixer-ca.pem</code> in
              the folder you&apos;ll run psql from.
            </p>
          </li>
        )}
        <li className={step}>
          <p>
            <span className={lead}>Connect.</span> Run this in a terminal. psql asks for your password, so it doesn&apos;t end up in your
            terminal&apos;s history.
          </p>
          <CodeBlock code={`psql "${url}"`} />
          {db.sslrootcert === 'system' && (
            <p>
              If psql says <code className="font-mono text-xs text-foreground">sslrootcert=system</code> isn&apos;t valid, it&apos;s older
              than version 16. Update it, or swap <code className="font-mono text-xs text-foreground">system</code> for your
              computer&apos;s list of trusted certificates: <code className="font-mono text-xs text-foreground">/etc/ssl/cert.pem</code> on
              a Mac, <code className="font-mono text-xs text-foreground">/etc/ssl/certs/ca-certificates.crt</code> on Ubuntu or Debian.
            </p>
          )}
          {suffix && (
            <p>
              The <code className="font-mono text-xs text-foreground">{suffix}</code> after your login&apos;s name tells the server which
              project you want, so leave it on.
            </p>
          )}
        </li>
        <li className={step}>
          <p>
            <span className={lead}>Check it worked.</span> Type <code className="font-mono text-xs text-foreground">select current_user;</code>{' '}
            and you should see your login&apos;s name.
          </p>
        </li>
      </ol>
      {suffix && <p className="text-xs text-foreground-lighter">Just changed your password and it isn&apos;t working? Give it a minute or two.</p>}
    </div>
  )
}
