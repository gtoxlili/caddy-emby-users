import { motion } from 'motion/react'
import { useId } from 'react'
import { cn } from '../cn'
import { spring } from '../motion'

export interface Segment<T extends string> {
    value: T
    label: string
}

/** A pill of mutually exclusive choices; the selection is one white block that slides. */
export function Segmented<T extends string>({
    value,
    onChange,
    options,
    label,
    size = 'md',
    className,
}: {
    value: T
    onChange: (v: T) => void
    options: Segment<T>[]
    label: string
    size?: 'sm' | 'md'
    className?: string
}) {
    const id = useId()
    return (
        <div
            role="radiogroup"
            aria-label={label}
            className={cn('glass scrollbar-none inline-flex max-w-full overflow-x-auto rounded-full p-1', className)}
        >
            {options.map(o => {
                const active = o.value === value
                return (
                    // biome-ignore lint/a11y/useSemanticElements: a styled radio group, not a form control
                    <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => onChange(o.value)}
                        className={cn(
                            'relative shrink-0 rounded-full font-medium transition-colors',
                            size === 'sm' ? 'h-7 px-3 text-[12.5px]' : 'h-8 px-3.5 text-[13.5px]',
                            active ? 'text-black' : 'text-(--text-2) hover:text-(--text)',
                        )}
                    >
                        {active && (
                            <motion.span
                                layoutId={`seg-${id}`}
                                transition={spring.snappy}
                                className="absolute inset-0 rounded-full bg-white"
                            />
                        )}
                        <span className="relative">{o.label}</span>
                    </button>
                )
            })}
        </div>
    )
}
