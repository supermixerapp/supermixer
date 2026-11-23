// Ported from Supabase packages/ui shadcn input.tsx (Apache-2.0; see NOTICE).
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

import { SIZE_VARIANTS } from './sizes'

export const inputVariants = cva(
  cn(
    'flex h-10 w-full rounded-md border border-control bg-field px-3 py-2 text-sm hover:border-control-hover',
    'read-only:border-button read-only:text-foreground-light placeholder:text-foreground-muted',
    'file:border-0 file:bg-transparent file:text-sm file:font-medium',
    'focus-ring transition-colors duration-200 focus:border-control-hover disabled:cursor-not-allowed disabled:text-foreground-muted',
    'aria-[invalid=true]:border-destructive-400 aria-[invalid=true]:bg-destructive-200 aria-[invalid=true]:hover:border-destructive aria-[invalid=true]:focus:border-destructive'
  ),
  {
    variants: { size: SIZE_VARIANTS },
    defaultVariants: { size: 'small' },
  }
)

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, size, ...props }, ref) => (
  <input ref={ref} className={cn(inputVariants({ size }), className)} {...props} />
))
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(inputVariants({ size: 'small' }), 'min-h-[80px] h-auto py-2 leading-5', className)}
      {...props}
    />
  )
)
Textarea.displayName = 'Textarea'
