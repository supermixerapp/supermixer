// Ported from Supabase packages/ui shadcn badge.tsx (Apache-2.0; see NOTICE).
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

export const badgeVariants = cva(
  'inline-flex items-center justify-center gap-1 rounded-full px-[5.5px] py-[3px] text-[9px] leading-none font-medium tracking-[0.07em] whitespace-nowrap uppercase',
  {
    variants: {
      variant: {
        default: 'border border-strong bg-surface-75 text-foreground-light',
        warning: 'border border-warning-500 bg-warning/10 text-warning-600',
        success: 'border border-brand-500 bg-brand-default/10 text-brand-600',
        // Always green, unlike success, which follows the brand colour.
        green: 'border border-green-500 bg-green/10 text-green-600',
        destructive: 'border border-border-destructive bg-destructive/10 text-destructive',
        secondary: 'border-transparent bg-secondary/50 text-secondary-foreground hover:bg-secondary/80',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export interface BadgeProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLDivElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
))
Badge.displayName = 'Badge'
