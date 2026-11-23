import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'

import { ErrorIcon, InfoIcon, WarningIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

/** Inline notice, like Studio's Admonition. */
const alertVariants = cva('flex gap-3 rounded-md border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'border-default bg-surface-200 text-foreground-light [&_svg]:text-foreground-lighter',
      warning: 'border-warning-500 bg-warning-200 text-foreground-light [&_svg]:text-warning-600',
      destructive: 'border-destructive-500 bg-destructive-200 text-foreground-light [&_svg]:text-destructive-600',
    },
  },
  defaultVariants: { variant: 'default' },
})

const icons = { default: InfoIcon, warning: WarningIcon, destructive: ErrorIcon }

export function Alert({
  title,
  children,
  actions,
  variant = 'default',
  className,
}: {
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
} & VariantProps<typeof alertVariants> & { className?: string }) {
  const Icon = icons[variant ?? 'default']
  return (
    <div role={variant === 'destructive' ? 'alert' : 'status'} className={cn(alertVariants({ variant }), className)}>
      <Icon size={18} className="mt-px" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title && <p className="text-foreground">{title}</p>}
        {children && <div className="text-foreground-light">{children}</div>}
        {actions && <div className="mt-2 flex gap-2">{actions}</div>}
      </div>
    </div>
  )
}
