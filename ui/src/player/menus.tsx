import { Menu } from '@base-ui/react/menu'
import { Check } from 'lucide-react'
import type { ReactElement, ReactNode, RefObject } from 'react'
import { cn } from '../cn'

/**
 * A menu that opens upward from the control bar. It renders inside the stage, so it stays
 * visible when the stage is fullscreen (anything portalled to <body> would not be).
 */
export function PlayerMenu({
    container,
    trigger,
    children,
    onOpenChange,
    className,
}: {
    container: RefObject<HTMLElement | null>
    trigger: ReactElement
    children: ReactNode
    onOpenChange?: (open: boolean) => void
    className?: string
}) {
    return (
        <Menu.Root modal={false} onOpenChange={o => onOpenChange?.(o)}>
            <Menu.Trigger render={trigger} />
            <Menu.Portal container={container}>
                <Menu.Positioner
                    side="top"
                    align="end"
                    sideOffset={14}
                    collisionPadding={12}
                    className="z-40 outline-none"
                >
                    <Menu.Popup
                        className={cn(
                            'glass-strong scrollbar-none max-h-[min(62vh,440px)] min-w-[232px] overflow-y-auto rounded-[18px] p-1.5 text-(--text) outline-none',
                            'origin-(--transform-origin) transition-[opacity,transform] duration-300 ease-(--ease-spring)',
                            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
                            className,
                        )}
                    >
                        {children}
                    </Menu.Popup>
                </Menu.Positioner>
            </Menu.Portal>
        </Menu.Root>
    )
}

export interface Option {
    value: string
    label: string
    hint?: string
}

/** One group of mutually exclusive choices, with a check on the current one. */
export function Choices({
    label,
    value,
    options,
    onChange,
}: {
    label?: string
    value: string
    options: Option[]
    onChange: (v: string) => void
}) {
    return (
        <Menu.Group>
            {label && <Menu.GroupLabel className="px-3 pt-2 pb-1 text-[12px] text-(--text-3)">{label}</Menu.GroupLabel>}
            <Menu.RadioGroup value={value} onValueChange={v => onChange(String(v))}>
                {options.map(o => (
                    <Menu.RadioItem
                        key={o.value}
                        value={o.value}
                        closeOnClick
                        className="flex cursor-default items-center justify-between gap-6 rounded-xl px-3 py-2 text-[14px] outline-none select-none data-[checked]:text-(--accent) data-[highlighted]:bg-white/10"
                    >
                        <span className="min-w-0">
                            <span className="block truncate">{o.label}</span>
                            {o.hint && <span className="block truncate text-[11.5px] text-(--text-3)">{o.hint}</span>}
                        </span>
                        <Menu.RadioItemIndicator keepMounted className="shrink-0 opacity-0 data-[checked]:opacity-100">
                            <Check className="size-4" />
                        </Menu.RadioItemIndicator>
                    </Menu.RadioItem>
                ))}
            </Menu.RadioGroup>
        </Menu.Group>
    )
}

export function MenuSeparator() {
    return <Menu.Separator className="mx-2 my-1.5 h-px bg-white/10" />
}

export function MenuNote({ children }: { children: ReactNode }) {
    return <p className="px-3 pt-1 pb-2 text-[12px] leading-relaxed text-(--text-3) text-pretty">{children}</p>
}

export function MenuToggle({
    label,
    checked,
    onChange,
}: {
    label: string
    checked: boolean
    onChange: (v: boolean) => void
}) {
    return (
        <Menu.CheckboxItem
            checked={checked}
            onCheckedChange={v => onChange(v)}
            closeOnClick={false}
            className="flex cursor-default items-center justify-between gap-6 rounded-xl px-3 py-2 text-[14px] outline-none select-none data-[highlighted]:bg-white/10"
        >
            {label}
            <span
                className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-300',
                    checked ? 'bg-(--accent-vivid)' : 'bg-white/16',
                )}
            >
                <span
                    className={cn(
                        'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-300 ease-(--ease-spring)',
                        checked && 'translate-x-4',
                    )}
                />
            </span>
        </Menu.CheckboxItem>
    )
}
