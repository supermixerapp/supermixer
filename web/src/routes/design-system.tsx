import { createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import * as icons from '@/components/icons'
import { AppShell } from '@/components/layout/app-shell'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetSection,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export const Route = createFileRoute('/design-system')({
  component: DesignSystemPage,
})

const VARIANTS = ['primary', 'default', 'secondary', 'outline', 'dashed', 'text', 'link', 'warning', 'danger'] as const
const SIZES = ['tiny', 'small', 'medium', 'large', 'xlarge'] as const

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="heading-section">{title}</h2>
        {description && <p className="text-sm text-foreground-light">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={`h-12 rounded-md border ${className}`} />
      <span className="font-mono text-[11px] text-foreground-lighter">{name}</span>
    </div>
  )
}

function DesignSystemPage() {
  const allIcons = Object.entries(icons) as [string, icons_t][]

  return (
    <AppShell title="Design system">
      <div className="overflow-y-auto">
        <PageHeader
          title="Design system"
          size="large"
          description="Supermixer's components and tokens, ported from Supabase Studio. See Design.md for the full specification."
        />
        <PageContainer size="large" className="flex flex-col gap-14 pb-24">
          <Section id="colours" title="Colour" description="Neutrals follow Studio's OKLCH system; brand colours come from BRAND_COLOR.">
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              <Swatch name="background" className="bg-background" />
              <Swatch name="surface-100" className="bg-surface-100" />
              <Swatch name="surface-200" className="bg-surface-200" />
              <Swatch name="surface-300" className="bg-surface-300" />
              <Swatch name="overlay" className="bg-overlay" />
              <Swatch name="muted" className="bg-muted" />
              <Swatch name="foreground" className="bg-foreground" />
              <Swatch name="foreground-light" className="bg-foreground-light" />
              <Swatch name="foreground-lighter" className="bg-foreground-lighter" />
              <Swatch name="border" className="bg-border" />
              <Swatch name="border-strong" className="bg-border-strong" />
              <Swatch name="border-stronger" className="bg-border-stronger" />
              <Swatch name="primary-solid" className="bg-primary-solid" />
              <Swatch name="primary" className="bg-primary" />
              <Swatch name="primary-bright" className="bg-primary-bright" />
              <Swatch name="brand-600" className="bg-brand-600" />
              <Swatch name="brand-500" className="bg-brand-500" />
              <Swatch name="brand-400" className="bg-brand-400" />
              <Swatch name="brand-300" className="bg-brand-300" />
              <Swatch name="brand-200" className="bg-brand-200" />
              <Swatch name="warning" className="bg-warning" />
              <Swatch name="destructive" className="bg-destructive" />
              <Swatch name="info" className="bg-info" />
            </div>
          </Section>

          <Section id="type" title="Typography" description="Inter for text, Manrope for headings, Source Code Pro for code.">
            <Card>
              <CardContent className="flex flex-col gap-3">
                <h1>Heading title · 22px Manrope</h1>
                <h2>Heading section · 18px Manrope</h2>
                <h3>Heading sub-section · 15px Manrope</h3>
                <p className="text-base">Body base · 15px Inter, weight 450</p>
                <p className="text-sm text-foreground-light">Body small · 13px Inter (the main UI size)</p>
                <p className="text-xs text-foreground-lighter">Caption · 12px Inter</p>
                <p className="heading-meta text-foreground-lighter">Meta · mono uppercase</p>
                <code className="font-mono text-sm">select * from auth.users limit 10;</code>
              </CardContent>
            </Card>
          </Section>

          <Section id="buttons" title="Button" description="Nine variants, five sizes (26, 34, 38, 42, 50px tall).">
            <div className="flex flex-wrap items-center gap-2">
              {VARIANTS.map((v) => (
                <Button key={v} variant={v}>
                  {v[0].toUpperCase() + v.slice(1)}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              {SIZES.map((s) => (
                <Button key={s} variant="primary" size={s} icon={<icons.AddIcon />}>
                  {s}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button loading>Loading</Button>
              <Button disabled>Disabled</Button>
              <Button variant="default" iconRight={<icons.ChevronDownIcon />}>
                With icon
              </Button>
              <Button variant="text" icon={<icons.SettingsIcon />} aria-label="Settings" />
            </div>
          </Section>

          <Section id="badges" title="Badge">
            <div className="flex flex-wrap gap-2">
              <Badge>Default</Badge>
              <Badge variant="success">Healthy</Badge>
              <Badge variant="warning">Warning</Badge>
              <Badge variant="destructive">Unhealthy</Badge>
              <Badge variant="secondary">Secondary</Badge>
            </div>
          </Section>

          <Section id="forms" title="Form controls">
            <Card>
              <CardContent className="grid gap-5 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ds-name">Project name</Label>
                  <Input id="ds-name" placeholder="my-project" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ds-invalid">Invalid input</Label>
                  <Input id="ds-invalid" aria-invalid defaultValue="not a url" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label>Role</Label>
                  <Select defaultValue="developer">
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="owner">Owner</SelectItem>
                      <SelectItem value="administrator">Administrator</SelectItem>
                      <SelectItem value="developer">Developer</SelectItem>
                      <SelectItem value="read-only">Read-only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-3 self-end pb-2">
                  <Switch id="ds-switch" defaultChecked />
                  <Label htmlFor="ds-switch">Enable feature</Label>
                </div>
                <div className="flex flex-col gap-2 md:col-span-2">
                  <Label htmlFor="ds-notes">Notes</Label>
                  <Textarea id="ds-notes" placeholder="Anything else?" />
                </div>
              </CardContent>
            </Card>
          </Section>

          <Section id="tabs" title="Tabs">
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="definition">Definition</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="text-sm text-foreground-light">Overview content.</TabsContent>
              <TabsContent value="definition" className="text-sm text-foreground-light">Definition content.</TabsContent>
              <TabsContent value="logs" className="text-sm text-foreground-light">Logs content.</TabsContent>
            </Tabs>
          </Section>

          <Section id="overlays" title="Overlays" description="Dialog, sheet, dropdown, popover, tooltip and toast.">
            <div className="flex flex-wrap gap-2">
              <Dialog>
                <DialogTrigger asChild>
                  <Button>Open dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete project</DialogTitle>
                    <DialogDescription>This removes the project from Supermixer.</DialogDescription>
                  </DialogHeader>
                  <DialogSection className="border-t">
                    <p className="text-sm text-foreground-light">The Supabase stack itself keeps running.</p>
                  </DialogSection>
                  <DialogFooter>
                    <Button variant="default">Cancel</Button>
                    <Button variant="danger">Delete</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <Sheet>
                <SheetTrigger asChild>
                  <Button>Open sheet</Button>
                </SheetTrigger>
                <SheetContent>
                  <SheetHeader>
                    <SheetTitle>Connect to your project</SheetTitle>
                    <SheetDescription>Connection strings and API keys.</SheetDescription>
                  </SheetHeader>
                  <SheetSection className="text-sm text-foreground-light">Sheet body.</SheetSection>
                  <SheetFooter>
                    <Button variant="primary">Done</Button>
                  </SheetFooter>
                </SheetContent>
              </Sheet>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button iconRight={<icons.ChevronDownIcon />}>Dropdown</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-48">
                  <DropdownMenuLabel>Project</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>
                    Copy URL <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem>Settings</DropdownMenuItem>
                  <DropdownMenuItem disabled>Pause</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Popover>
                <PopoverTrigger asChild>
                  <Button>Popover</Button>
                </PopoverTrigger>
                <PopoverContent className="text-sm text-foreground-light">Popover content.</PopoverContent>
              </Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button>Tooltip</Button>
                </TooltipTrigger>
                <TooltipContent>Helpful hint</TooltipContent>
              </Tooltip>
              <Button onClick={() => toast.success('Project registered', { description: 'Demo project is healthy.' })}>
                Toast
              </Button>
            </div>
          </Section>

          <Section id="table" title="Card and table">
            <Card>
              <CardHeader>
                <CardTitle>Team members</CardTitle>
                <Button variant="primary">Invite</Button>
              </CardHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    ['admin', 'Owner', 'success', 'Active'],
                    ['dev@example.com', 'Developer', 'default', 'Invited'],
                  ].map(([user, role, variant, status]) => (
                    <TableRow key={user}>
                      <TableCell>{user}</TableCell>
                      <TableCell className="text-foreground-light">{role}</TableCell>
                      <TableCell>
                        <Badge variant={variant as 'success' | 'default'}>{status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <CardFooter>
                <CardDescription className="mr-auto">2 members</CardDescription>
              </CardFooter>
            </Card>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </Section>

          <Section id="icons" title="Icons" description="Material Icons, two-tone style, bundled locally. Sizes 14–24px; colour follows text.">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {allIcons.map(([name, Icon]) => (
                <div key={name} className="flex flex-col items-center gap-2 rounded-md border bg-surface-100 px-2 py-4">
                  <Icon size={24} className="text-foreground-light" />
                  <span className="text-center font-mono text-[10px] text-foreground-lighter">{Icon.materialName}</span>
                </div>
              ))}
            </div>
          </Section>
        </PageContainer>
      </div>
    </AppShell>
  )
}

type icons_t = (typeof icons)[keyof typeof icons]
