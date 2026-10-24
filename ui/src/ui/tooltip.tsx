import { Tooltip } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'

export function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
    return (
        <Tooltip.Root>
            <Tooltip.Trigger render={children} />
            <Tooltip.Portal>
                <Tooltip.Positioner sideOffset={7} className="z-50">
                    <Tooltip.Popup className="glass-strong rounded-lg px-2.5 py-1.5 text-[12px] text-(--text) transition-[opacity,transform] duration-200 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
                        {label}
                    </Tooltip.Popup>
                </Tooltip.Positioner>
            </Tooltip.Portal>
        </Tooltip.Root>
    )
}
