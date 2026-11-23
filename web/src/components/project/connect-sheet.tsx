import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { CopyButton, CopyField } from '@/components/ui/copy'
import { FormField } from '@/components/ui/form-field'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetSection, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Schemas } from '@/lib/api/client'
import { apiKeysQuery } from '@/lib/api/queries'

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-surface-100 p-4 font-mono text-xs leading-5 text-foreground">
        {code}
      </pre>
      <CopyButton value={code} className="absolute top-2 right-2" />
    </div>
  )
}

/** Studio's "Connect" sheet: connection string, app snippets, env vars. */
export function ConnectSheet({ project }: { project: Schemas['Project'] }) {
  const [open, setOpen] = useState(false)
  const keys = useQuery({ ...apiKeysQuery(project.ref), enabled: open })
  const publicKey =
    keys.data?.find((k) => k.id === 'publishable' && k.value)?.value ??
    keys.data?.find((k) => k.id === 'anon' && k.value)?.value ??
    '<your-anon-key>'

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
            </TabsList>
            <TabsContent value="direct" className="flex flex-col gap-4">
              <FormField label="URI" description="Replace [YOUR-PASSWORD] with the database password.">
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
              <p className="text-sm text-foreground-light">For .env.local in your app. The key is safe in a browser when Row Level Security is on.</p>
              <CodeBlock code={`SUPABASE_URL=${project.api_url}\nSUPABASE_ANON_KEY=${publicKey}`} />
            </TabsContent>
          </Tabs>
        </SheetSection>
      </SheetContent>
    </Sheet>
  )
}
