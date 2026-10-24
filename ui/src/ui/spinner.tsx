import { cn } from '../cn'

export function Spinner({ className }: { className?: string }) {
    return (
        <svg
            className={cn('animate-spin text-current', className)}
            viewBox="0 0 24 24"
            fill="none"
            aria-label="加载中"
            role="img"
        >
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".18" strokeWidth="2.5" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
    )
}

/** Loading state for a whole area: a centred spinner that holds the height so nothing jumps. */
export function Loading({ className, label }: { className?: string; label?: string }) {
    return (
        <div className={cn('grid place-items-center gap-3 py-16 text-(--text-3)', className)}>
            <Spinner className="size-6" />
            {label && <span className="text-[13px]">{label}</span>}
        </div>
    )
}
