import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../cn'
import { Spinner } from './spinner'

/**
 * bright: the one brightest action on a screen (play, save), solid white.
 * glass: an ordinary action floating over content. ghost: a quiet secondary action.
 * danger: delete, remove.
 */
type Variant = 'bright' | 'glass' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant
    size?: Size
    loading?: boolean
    icon?: ReactNode
    /** A round icon button: icon only, no text. */
    round?: boolean
}

const variants: Record<Variant, string> = {
    bright: 'bg-white text-black/90 hover:bg-white/88 shadow-[0_10px_30px_-10px_rgb(255_255_255/.35)]',
    glass: 'glass text-(--text) hover:[--glass-fill:rgb(255_255_255/.13)]',
    ghost: 'text-(--text-2) hover:bg-white/8 hover:text-(--text)',
    danger: 'bg-danger/14 text-danger hover:bg-danger/24',
}

const sizes: Record<Size, string> = {
    sm: 'h-8 px-3.5 text-[13px] gap-1.5',
    md: 'h-10 px-4.5 text-[14.5px] gap-2',
    lg: 'h-12 px-6 text-[16px] gap-2.5',
}

const roundSizes: Record<Size, string> = {
    sm: 'size-8',
    md: 'size-10',
    lg: 'size-12',
}

export function Button({
    variant = 'glass',
    size = 'md',
    loading,
    icon,
    round,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
}: ButtonProps) {
    return (
        <button
            type={type}
            disabled={disabled || loading}
            className={cn(
                'inline-flex shrink-0 items-center justify-center rounded-full font-medium whitespace-nowrap select-none',
                'transition-[background-color,transform,opacity,--glass-fill] duration-300 ease-(--ease-spring) active:scale-[.96]',
                'disabled:pointer-events-none disabled:opacity-45',
                variants[variant],
                round ? roundSizes[size] : sizes[size],
                className,
            )}
            {...rest}
        >
            {loading ? <Spinner className="size-4" /> : icon}
            {children}
        </button>
    )
}
