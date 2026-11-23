// Ported from Supabase packages/ui shadcn sheet.tsx (Apache-2.0; see NOTICE).
import { cva, type VariantProps } from 'class-variance-authority'
import { Dialog as SheetPrimitive } from 'radix-ui'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from 'react'

import { CloseIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

export const Sheet = SheetPrimitive.Root
export const SheetTrigger = SheetPrimitive.Trigger
export const SheetClose = SheetPrimitive.Close

const sheetVariants = cva(
  cn(
    'fixed z-50 flex flex-col bg-popover shadow-lg',
    'data-[state=open]:animate-in data-[state=open]:duration-300 data-[state=closed]:animate-out data-[state=closed]:duration-300'
  ),
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 w-full border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        bottom: 'inset-x-0 bottom-0 w-full border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        left: 'inset-y-0 left-0 h-full border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
        right: 'inset-y-0 right-0 h-full border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
      },
      size: {
        sm: 'w-full sm:max-w-sm',
        default: 'w-full sm:max-w-lg',
        lg: 'w-full sm:max-w-2xl',
        xl: 'w-full sm:max-w-4xl',
      },
    },
    defaultVariants: { side: 'right', size: 'default' },
  }
)

export const SheetContent = forwardRef<
  ElementRef<typeof SheetPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SheetPrimitive.Content> & VariantProps<typeof sheetVariants>
>(({ side, size, className, children, ...props }, ref) => (
  <SheetPrimitive.Portal>
    <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-alternative/90 backdrop-blur-xs transition-all duration-100 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:fade-in" />
    <SheetPrimitive.Content ref={ref} className={cn(sheetVariants({ side, size }), className)} {...props}>
      {children}
      <SheetPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus-ring disabled:pointer-events-none">
        <CloseIcon size={16} />
        <span className="sr-only">Close</span>
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPrimitive.Portal>
))
SheetContent.displayName = 'SheetContent'

export const SheetHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('border-b bg-popover px-5 py-4 text-center sm:text-left', className)} {...props} />
)
export const SheetSection = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex-1 overflow-y-auto px-5 py-4', className)} {...props} />
)
export const SheetFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex w-full flex-col-reverse gap-2 border-t px-5 py-3 sm:flex-row sm:justify-end', className)} {...props} />
)
export const SheetTitle = forwardRef<
  ElementRef<typeof SheetPrimitive.Title>,
  ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title ref={ref} className={cn('font-sans text-lg font-normal text-foreground', className)} {...props} />
))
SheetTitle.displayName = 'SheetTitle'
export const SheetDescription = forwardRef<
  ElementRef<typeof SheetPrimitive.Description>,
  ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description ref={ref} className={cn('text-sm text-foreground-light', className)} {...props} />
))
SheetDescription.displayName = 'SheetDescription'
