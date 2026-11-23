// Ported from Supabase packages/ui/src/components/Button/Button.tsx (Apache-2.0; see NOTICE).
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
} from 'react'

import { cn } from '@/lib/utils'

import { CONTROL_RADIUS, SIZE_VARIANTS } from './sizes'
import { Spinner } from './spinner'

const sheen = 'bg-[linear-gradient(to_bottom,hsl(var(--colors-white)/0.015),hsl(var(--colors-black)/0.01))]'

export const buttonVariants = cva(
  cn(
    'relative inline-flex cursor-pointer items-center justify-center space-x-2 text-center font-medium',
    'rounded-md border duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
    'transition-[background-color,border-color,color,scale]',
    '[&:not([aria-haspopup])]:motion-safe:active:scale-[0.97]',
    'focus-ring control-surface-shadows'
  ),
  {
    variants: {
      variant: {
        primary: cn(
          'border-0 bg-primary-solid text-primary-solid-foreground shadow-[var(--button-shadow-raised)]',
          sheen,
          'hover:bg-[var(--primary-solid-hover)] data-[state=open]:bg-[var(--primary-solid-hover)]'
        ),
        default: 'raised-control-surface border-0',
        secondary:
          'border-0 bg-foreground text-background shadow-[var(--button-shadow-drop)] hover:bg-foreground/90 data-[state=open]:bg-foreground/90',
        outline:
          'border-strong bg-transparent text-foreground hover:border-foreground-muted data-[state=open]:border-stronger',
        dashed:
          'border border-dashed border-strong bg-transparent text-foreground hover:border-control-hover data-[state=open]:border-control-hover',
        link: 'border border-transparent text-primary shadow-none hover:bg-primary-bright/15 data-[state=open]:bg-primary-bright/15',
        text: 'border-transparent text-foreground shadow-none hover:bg-accent data-[state=open]:bg-accent',
        danger: cn(
          'border-0 bg-destructive text-destructive-foreground shadow-[var(--button-shadow-raised)]',
          sheen,
          'hover:bg-[var(--destructive-hover)] data-[state=open]:bg-[var(--destructive-hover)]'
        ),
        warning: cn(
          'border-0 bg-warning text-warning-foreground shadow-[var(--button-shadow-raised)]',
          sheen,
          'hover:bg-[var(--warning-hover)] data-[state=open]:bg-[var(--warning-hover)]'
        ),
      },
      size: {
        tiny: `${SIZE_VARIANTS.tiny} ${CONTROL_RADIUS.tiny}`,
        small: `${SIZE_VARIANTS.small} ${CONTROL_RADIUS.small}`,
        medium: `${SIZE_VARIANTS.medium} ${CONTROL_RADIUS.medium}`,
        large: `${SIZE_VARIANTS.large} ${CONTROL_RADIUS.large}`,
        xlarge: `${SIZE_VARIANTS.xlarge} ${CONTROL_RADIUS.xlarge}`,
      },
      block: { true: 'flex w-full items-center justify-center' },
      disabled: { true: 'pointer-events-none cursor-not-allowed opacity-50' },
      rounded: { true: 'rounded-full' },
      iconOnly: { true: 'w-6.5 hit-area-1' },
    },
    defaultVariants: { size: 'tiny', variant: 'default' },
  }
)

const iconVariants = cva('inline-flex shrink-0 items-center justify-center', {
  variants: {
    size: {
      tiny: '[&_svg]:h-[14px] [&_svg]:w-[14px]',
      small: '[&_svg]:h-[18px] [&_svg]:w-[18px]',
      medium: '[&_svg]:h-[20px] [&_svg]:w-[20px]',
      large: '[&_svg]:h-[20px] [&_svg]:w-[20px]',
      xlarge: '[&_svg]:h-[24px] [&_svg]:w-[24px]',
    },
    variant: {
      primary: 'text-primary-solid-foreground/60',
      default: 'text-foreground-lighter',
      secondary: 'text-background',
      outline: 'text-foreground-lighter',
      dashed: 'text-foreground-lighter',
      link: 'text-primary',
      text: 'text-foreground-lighter',
      danger: 'text-destructive-foreground/60',
      warning: 'text-warning-foreground/60',
    },
  },
})

type Variants = VariantProps<typeof buttonVariants>

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'>,
    Omit<Variants, 'disabled' | 'iconOnly'> {
  asChild?: boolean
  disabled?: boolean
  loading?: boolean
  icon?: ReactNode
  iconRight?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      asChild = false,
      size = 'tiny',
      variant = 'default',
      children,
      loading = false,
      block,
      rounded,
      icon,
      iconRight,
      disabled: disabledProp,
      type = 'button',
      className,
      onClick,
      ...rest
    },
    ref
  ) => {
    const Comp = asChild ? Slot.Slot : 'button'
    const disabled = loading || disabledProp === true

    const iconBox = (content: ReactNode) => (
      <span aria-hidden className={iconVariants({ size, variant })}>
        {content}
      </span>
    )
    const leading = loading ? iconBox(<Spinner />) : icon ? iconBox(icon) : null
    const trailing = iconRight && !loading ? iconBox(iconRight) : null

    const handle = (e: MouseEvent<HTMLElement>, childOnClick?: MouseEventHandler<HTMLElement>) => {
      if (disabled) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      childOnClick?.(e)
      if (!e.defaultPrevented) onClick?.(e as MouseEvent<HTMLButtonElement>)
    }

    const classes = cn(
      buttonVariants({
        variant,
        size,
        block,
        rounded,
        disabled,
        iconOnly: children == null || children === false,
      }),
      className
    )

    if (asChild && isValidElement<{ children?: ReactNode; onClick?: MouseEventHandler<HTMLElement> }>(children)) {
      return (
        <Comp ref={ref} data-size={size} className={classes} aria-disabled={disabled || undefined} {...rest}>
          {cloneElement(
            children,
            { onClick: (e: MouseEvent<HTMLElement>) => handle(e, children.props.onClick) },
            leading,
            children.props.children != null && <span className="truncate">{children.props.children}</span>,
            trailing
          )}
        </Comp>
      )
    }

    return (
      <button
        ref={ref}
        type={type}
        data-size={size}
        disabled={disabled}
        className={classes}
        onClick={(e) => handle(e)}
        {...rest}
      >
        {leading}
        {children != null && children !== false && <span className="truncate">{children}</span>}
        {trailing}
      </button>
    )
  }
)
Button.displayName = 'Button'
