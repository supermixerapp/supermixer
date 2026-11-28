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
import { t, Trans } from '@/lib/i18n'

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
        {t('project:connectSheet.connect')}
      </Button>
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>{t('project:connectSheet.connectToYourProject')}</SheetTitle>
          <SheetDescription>{t('project:connectSheet.getTheConnectionStringsAndEnvironment', { name: project.name })}</SheetDescription>
        </SheetHeader>
        <SheetSection>
          <Tabs defaultValue="direct">
            <TabsList>
              <TabsTrigger value="direct">{t('project:connectSheet.connectionString')}</TabsTrigger>
              <TabsTrigger value="app">{t('project:connectSheet.appFrameworks')}</TabsTrigger>
              <TabsTrigger value="env">{t('project:connectSheet.environmentVariables')}</TabsTrigger>
              <TabsTrigger value="psql">{t('project:connectSheet.connectWithPsql')}</TabsTrigger>
            </TabsList>
            <TabsContent value="direct" className="flex flex-col gap-4">
              <FormField
                label={t('project:connectSheet.uri')}
                description={
                  project.database.sslrootcert === 'download' ? (
                    <>
                      <Trans i18nKey="project:connectSheet.replaceYourPasswordWithTheDatabase" components={{ cacertlink: <CACertLink />, code: <code className="font-mono" /> }} />
                    </>
                  ) : (
                    t('project:connectSheet.replaceYourPasswordWithTheDatabase2')
                  )
                }
              >
                <CopyField value={project.database.uri} />
              </FormField>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label={t('project:connectSheet.host')}>
                  <CopyField value={project.database.host} />
                </FormField>
                <FormField label={t('project:connectSheet.port')}>
                  <CopyField value={String(project.database.port)} />
                </FormField>
                <FormField label={t('project:connectSheet.database')}>
                  <CopyField value={project.database.name} />
                </FormField>
                <FormField label={t('project:connectSheet.user')}>
                  <CopyField value={project.database.user} />
                </FormField>
              </div>
            </TabsContent>
            <TabsContent value="app" className="flex flex-col gap-3">
              <p className="text-sm text-foreground-light">{t('project:connectSheet.installTheClientThenCreateIt')}</p>
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
                <Trans i18nKey="project:connectSheet.forYourAppSEnvironmentFile" components={{ code: <code className="font-mono text-xs" /> }} />
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
      {t('project:connectSheet.supermixerSCertificate')}
    </a>
  )
}

/** For a private CA: computers have to trust it before HTTPS works. */
function TrustNote() {
  return (
    <p className="text-sm text-foreground-light">
      <Trans i18nKey="project:connectSheet.thisProjectUsesSupermixerSOwn" components={{ cacertlink: <CACertLink />, code: <code className="font-mono text-xs" /> }} />
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
      <p>{t('project:connectSheet.psqlIsPostgresSOwnCommand')}</p>
      {paused && <p><Trans i18nKey="project:connectSheet.thisProjectIsPausedStartIt" components={{ link: link('/project/$ref/settings/infrastructure', t('project:connectSheet.settingsInfrastructure')) }} /></p>}
      <ol className="flex list-decimal flex-col gap-5 pl-5 marker:text-foreground-lighter">
        <li className={step}>
          <p>
            <Trans i18nKey="project:connectSheet.makeYourLoginInCreateA" components={{ span: <span className={lead} />, link: link('/project/$ref/database/roles', t('project:connectSheet.databaseRoles')), span2: <span className={lead} /> }} />
          </p>
          <FormField label={t('project:connectSheet.yourLoginSName')} htmlFor="psql-login" description={t('project:connectSheet.typeItHereAndTheCommands')}>
            <Input id="psql-login" value={name} onChange={(e) => setName(e.target.value)} placeholder="my_login" autoComplete="off" spellCheck={false} />
          </FormField>
        </li>
        <li className={step}>
          <p>
            <Trans i18nKey="project:connectSheet.letItReadYourTablesA" components={{ span: <span className={lead} />, link: link('/project/$ref/sql', t('project:connectSheet.sqlEditor')) }} />
          </p>
          <CodeBlock code={`grant usage on schema public to ${sqlName};\ngrant select on all tables in schema public to ${sqlName};`} />
        </li>
        {db.sslrootcert === 'download' && (
          <li className={step}>
            <p>
              <Trans i18nKey="project:connectSheet.getTheCertificateYourConnectionIs" components={{ span: <span className={lead} />, cacertlink: <CACertLink />, code: <code className="font-mono text-xs text-foreground" /> }} />
            </p>
          </li>
        )}
        <li className={step}>
          <p>
            <Trans i18nKey="project:connectSheet.connectRunThisInATerminal" components={{ span: <span className={lead} /> }} />
          </p>
          <CodeBlock code={`psql "${url}"`} />
          {db.sslrootcert === 'system' && (
            <p>
              <Trans i18nKey="project:connectSheet.ifPsqlSaysSslrootcertSystemIsn" components={{ code: <code className="font-mono text-xs text-foreground" />, code2: <code className="font-mono text-xs text-foreground" />, code3: <code className="font-mono text-xs text-foreground" />, code4: <code className="font-mono text-xs text-foreground" /> }} />
            </p>
          )}
          {suffix && (
            <p>
              <Trans i18nKey="project:connectSheet.theAfterYourLoginSName" values={{ suffix }} components={{ code: <code className="font-mono text-xs text-foreground" /> }} />
            </p>
          )}
        </li>
        <li className={step}>
          <p>
            <Trans i18nKey="project:connectSheet.checkItWorkedTypeSelectCurrent" components={{ span: <span className={lead} />, code: <code className="font-mono text-xs text-foreground" /> }} />
          </p>
        </li>
      </ol>
      {suffix && <p className="text-xs text-foreground-lighter">{t('project:connectSheet.justChangedYourPasswordAndIt')}</p>}
    </div>
  )
}
