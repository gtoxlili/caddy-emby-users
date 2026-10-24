import { Menu } from '@base-ui/react/menu'
import type { ReactNode } from 'react'
import { cn } from '../cn'

export interface MenuEntry {
    label: ReactNode
    icon?: ReactNode
    danger?: boolean
    disabled?: boolean
    onSelect: () => void
}

/** A trigger that opens a list of actions. `trigger` must be a button element; Base UI attaches to it. */
export function DropMenu({
    trigger,
    entries,
    align = 'end',
}: {
    trigger: ReactNode
    entries: MenuEntry[]
    align?: 'start' | 'end'
}) {
    return (
        <Menu.Root>
            <Menu.Trigger render={trigger as React.ReactElement} />
            <Menu.Portal>
                <Menu.Positioner sideOffset={8} align={align} className="z-50 outline-none">
                    <Menu.Popup
                        className={cn(
                            'glass-strong min-w-46 rounded-2xl p-1.5 text-(--text) outline-none',
                            'origin-(--transform-origin) transition-[opacity,transform] duration-300 ease-(--ease-spring)',
                            'data-[starting-style]:scale-90 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
                        )}
                    >
                        {entries.map((e, i) => (
                            <Menu.Item
                                // biome-ignore lint/suspicious/noArrayIndexKey: entries are static; order is identity
                                key={i}
                                disabled={e.disabled}
                                onClick={e.onSelect}
                                className={cn(
                                    'flex cursor-default items-center gap-2.5 rounded-xl px-3 py-2 text-[14px] outline-none select-none',
                                    'data-[highlighted]:bg-white/10 data-[disabled]:opacity-40',
                                    e.danger && 'text-danger',
                                )}
                            >
                                {e.icon && <span className="text-(--text-2) [&>svg]:size-4">{e.icon}</span>}
                                {e.label}
                            </Menu.Item>
                        ))}
                    </Menu.Popup>
                </Menu.Positioner>
            </Menu.Portal>
        </Menu.Root>
    )
}
