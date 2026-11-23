// Ported from Supabase packages/ui shadcn select.tsx (Apache-2.0; see NOTICE).
import { Select as SelectPrimitive } from 'radix-ui'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'

import { CheckIcon, ChevronDownIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

import { CONTROL_RADIUS, SIZE_VARIANTS, type ControlSize } from './sizes'

export const Select = SelectPrimitive.Root
export const SelectGroup = SelectPrimitive.Group

// Wrap string placeholders in a span (Radix crash with Google Translate, radix-ui/primitives#2578).
export const SelectValue = forwardRef<
  ElementRef<typeof SelectPrimitive.Value>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Value>
>(({ placeholder, ...props }, ref) => (
  <SelectPrimitive.Value
    ref={ref}
    placeholder={typeof placeholder === 'string' ? <span>{placeholder}</span> : placeholder}
    {...props}
  />
))
SelectValue.displayName = 'SelectValue'

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { size?: ControlSize }
>(({ className, children, size = 'small', ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex w-full items-center justify-between gap-2 border-0 text-left raised-control-surface control-surface-shadows focus-ring',
      'disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-foreground-muted [&>span]:truncate',
      SIZE_VARIANTS[size],
      CONTROL_RADIUS[size],
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDownIcon size={16} className="text-foreground-lighter" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = 'SelectTrigger'

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      className={cn(
        'relative z-50 max-h-96 min-w-32 overflow-x-hidden overflow-y-auto rounded-md bg-overlay text-foreground floating-surface-shadow-md',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        position === 'popper' &&
          'max-h-(--radix-select-content-available-height) data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
        className
      )}
      {...props}
    >
      <SelectPrimitive.Viewport
        className={cn('p-1', position === 'popper' && 'w-full min-w-(--radix-select-trigger-width)')}
      >
        {children}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
))
SelectContent.displayName = 'SelectContent'

export const SelectLabel = forwardRef<
  ElementRef<typeof SelectPrimitive.Label>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn('py-1.5 pr-2 pl-8 font-mono text-xs tracking-wider text-foreground-lighter/75 uppercase', className)}
    {...props}
  />
))
SelectLabel.displayName = 'SelectLabel'

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-default items-center rounded-item py-1.5 pr-2 pl-8 text-sm text-foreground-light outline-hidden select-none',
      'focus:bg-overlay-hover focus:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 data-[state=checked]:text-foreground',
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <CheckIcon size={16} />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
SelectItem.displayName = 'SelectItem'

export const SelectSeparator = forwardRef<
  ElementRef<typeof SelectPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator ref={ref} className={cn('-mx-1 my-1 h-px bg-border-overlay', className)} {...props} />
))
SelectSeparator.displayName = 'SelectSeparator'
