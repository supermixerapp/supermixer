// Styling from Supabase packages/ui shadcn switch.tsx (Apache-2.0; see NOTICE),
// on Radix's Switch primitive.
import { cva, type VariantProps } from 'class-variance-authority'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'

import { cn } from '@/lib/utils'

const rootVariants = cva(
  cn(
    'peer group/switch inline-flex shrink-0 cursor-pointer items-center rounded-full inset-ring inset-ring-black/10 transition-colors focus-ring',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'data-[state=checked]:bg-[var(--primary-bright-hover)] dark:data-[state=checked]:bg-primary-bright',
    'data-[state=unchecked]:bg-border-strong data-[state=unchecked]:inset-ring-border dark:data-[state=unchecked]:bg-border'
  ),
  {
    variants: { size: { small: 'h-4 w-7 p-0.5', medium: 'h-5 w-8.5 p-0.5', large: 'h-6 w-11 p-0.75' } },
    defaultVariants: { size: 'medium' },
  }
)

const thumbVariants = cva(
  'pointer-events-none block shrink-0 rounded-full bg-linear-to-b from-white to-neutral-100 shadow-lg ring-0 inset-ring inset-ring-black/10 transition-[translate,width] duration-150 data-[state=checked]:shadow-sm',
  {
    variants: {
      size: {
        small: 'size-3 data-[state=checked]:translate-x-[calc(--spacing(6)-100%)]',
        medium: 'size-4 data-[state=checked]:translate-x-[calc(--spacing(7.5)-100%)]',
        large: 'size-4.5 data-[state=checked]:translate-x-[calc(--spacing(9.5)-100%)]',
      },
    },
    defaultVariants: { size: 'medium' },
  }
)

export const Switch = forwardRef<
  ElementRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & VariantProps<typeof rootVariants>
>(({ className, size, ...props }, ref) => (
  <SwitchPrimitive.Root ref={ref} className={cn(rootVariants({ size }), className)} {...props}>
    <SwitchPrimitive.Thumb className={thumbVariants({ size })} />
  </SwitchPrimitive.Root>
))
Switch.displayName = 'Switch'
