import { Field } from '@base-ui/react/field'
import { Switch } from '@base-ui/react/switch'
import type { ReactNode } from 'react'
import { cn } from '../cn'

/** A switch row: the label on the left, the toggle on the right, lit by the room's light when on. */
export function Toggle({
    checked,
    onCheckedChange,
    label,
    hint,
    disabled,
    className,
}: {
    checked: boolean
    onCheckedChange: (v: boolean) => void
    label: ReactNode
    hint?: ReactNode
    disabled?: boolean
    className?: string
}) {
    return (
        <Field.Root
            disabled={disabled}
            className={cn('flex items-center justify-between gap-4 py-1', disabled && 'opacity-50', className)}
        >
            <Field.Label className="grid cursor-pointer gap-0.5">
                <span className="text-[15px] text-(--text)">{label}</span>
                {hint && <span className="text-[13px] text-(--text-2)">{hint}</span>}
            </Field.Label>
            <Switch.Root
                checked={checked}
                onCheckedChange={onCheckedChange}
                className="relative h-7 w-12 shrink-0 cursor-pointer rounded-full bg-white/14 shadow-[inset_0_1px_2px_rgb(0_0_0/.3)] transition-colors duration-300 data-[checked]:bg-(--accent-vivid)"
            >
                <Switch.Thumb className="block size-6 translate-x-0.5 rounded-full bg-white shadow-[0_2px_6px_rgb(0_0_0/.35)] transition-transform duration-400 ease-(--ease-spring) data-[checked]:translate-x-[22px]" />
            </Switch.Root>
        </Field.Root>
    )
}
