// Ported from Supabase packages/ui shadcn tabs.tsx (Apache-2.0; see NOTICE).
// Uses the underline style without Studio's animated indicator.
import { Tabs as TabsPrimitive } from 'radix-ui'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'

import { cn } from '@/lib/utils'

export const Tabs = TabsPrimitive.Root

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn('relative flex items-center gap-x-4 border-b', className)} {...props} />
))
TabsList.displayName = 'TabsList'

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      '-mb-px inline-flex cursor-pointer items-center justify-center border-b border-b-transparent py-1.5 text-sm whitespace-nowrap text-foreground-lighter transition-colors hover:text-foreground',
      'focus-inset disabled:pointer-events-none disabled:opacity-50',
      'data-[state=active]:border-b-foreground data-[state=active]:text-foreground',
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = 'TabsTrigger'

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn('mt-4 focus-ring', className)} {...props} />
))
TabsContent.displayName = 'TabsContent'
