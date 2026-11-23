import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'

import { CheckIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-control bg-field focus-ring',
      'hover:border-control-hover disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:border-primary-solid data-[state=checked]:bg-primary-solid data-[state=checked]:text-primary-solid-foreground',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator>
      <CheckIcon size={12} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = 'Checkbox'
