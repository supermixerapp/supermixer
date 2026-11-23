// Ported from Supabase packages/ui shadcn dialog.tsx (Apache-2.0; see NOTICE).
import { cva, type VariantProps } from 'class-variance-authority'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from 'react'

import { CloseIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

const paddingVariants = cva('', {
  variants: {
    padding: { medium: 'px-4 py-6 md:px-7', small: 'px-4 py-4 md:px-5' },
  },
  defaultVariants: { padding: 'small' },
})

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

const contentVariants = cva(
  cn(
    'relative z-50 w-full max-w-screen bg-dash-sidebar floating-surface-shadow-md sm:rounded-lg md:w-full',
    'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'
  ),
  {
    variants: {
      size: {
        tiny: 'sm:w-full sm:max-w-xs',
        small: 'sm:w-full sm:max-w-sm',
        medium: 'sm:w-full sm:max-w-lg',
        large: 'sm:w-full md:max-w-xl',
        xlarge: 'sm:w-full md:max-w-3xl',
        xxlarge: 'sm:w-full md:max-w-6xl',
      },
    },
    defaultVariants: { size: 'medium' },
  }
)

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> &
    VariantProps<typeof contentVariants> & { hideClose?: boolean }
>(({ className, children, size, hideClose, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 py-8 backdrop-blur-xs data-closed:animate-overlay-hide">
      <DialogPrimitive.Content ref={ref} className={cn(contentVariants({ size }), className)} {...props}>
        {children}
        {!hideClose && (
          <DialogPrimitive.Close className="absolute top-3.5 right-3.5 rounded-xs p-0.5 opacity-20 transition-opacity hit-area-6 hover:opacity-100 focus-ring disabled:pointer-events-none">
            <CloseIcon size={16} />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Overlay>
  </DialogPrimitive.Portal>
))
DialogContent.displayName = 'DialogContent'

type PaddedProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof paddingVariants>

export const DialogHeader = ({ className, padding, ...props }: PaddedProps) => (
  <div className={cn('flex flex-col gap-1.5 text-center sm:text-left', paddingVariants({ padding }), className)} {...props} />
)

export const DialogSection = ({ className, padding, ...props }: PaddedProps) => (
  <div className={cn(paddingVariants({ padding }), 'overflow-hidden', className)} {...props} />
)

export const DialogSectionSeparator = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('h-px w-full bg-border', className)} {...props} />
)

export const DialogFooter = ({ className, padding, ...props }: PaddedProps) => (
  <div
    className={cn(
      'flex flex-col-reverse gap-y-2 border-t sm:flex-row sm:justify-end sm:space-x-2',
      paddingVariants({ padding }),
      className
    )}
    {...props}
  />
)

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('max-w-[calc(100%-1rem)] font-sans text-base leading-none font-normal', className)}
    {...props}
  />
))
DialogTitle.displayName = 'DialogTitle'

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-foreground-lighter', className)} {...props} />
))
DialogDescription.displayName = 'DialogDescription'
