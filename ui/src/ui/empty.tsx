import type { ReactNode } from 'react'
import { cn } from '../cn'

export function Empty({
    title,
    hint,
    action,
    className,
}: {
    title: string
    hint?: string
    action?: ReactNode
    className?: string
}) {
    return (
        <div className={cn('grid place-items-center gap-2 py-16 text-center', className)}>
            <p className="text-[18px] font-semibold text-(--text)">{title}</p>
            {hint && <p className="max-w-[28em] text-[14px] text-(--text-2) text-pretty">{hint}</p>}
            {action && <div className="mt-3">{action}</div>}
        </div>
    )
}
