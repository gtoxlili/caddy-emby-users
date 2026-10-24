import { Toast } from '@base-ui/react/toast'
import { AlertTriangle, Check, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../cn'

type Kind = 'info' | 'success' | 'error'

interface ToastData {
    kind: Kind
}

export const toaster = Toast.createToastManager()

export function toast(title: string, kind: Kind = 'info', description?: string) {
    toaster.add({ title, description, data: { kind } satisfies ToastData, timeout: kind === 'error' ? 6000 : 3200 })
}

const icons: Record<Kind, ReactNode> = {
    info: <Info className="size-4 text-(--accent)" />,
    success: <Check className="size-4 text-ok" />,
    error: <AlertTriangle className="size-4 text-danger" />,
}

function Toasts() {
    const { toasts } = Toast.useToastManager()
    return toasts.map(t => {
        const kind = (t.data as ToastData | undefined)?.kind ?? 'info'
        return (
            <Toast.Root
                key={t.id}
                toast={t}
                className={cn(
                    'glass-strong pointer-events-auto flex max-w-[min(92vw,420px)] items-start gap-2.5 rounded-2xl py-2.5 pr-4 pl-3.5 text-(--text)',
                    'transition-[opacity,transform] duration-500 ease-(--ease-spring)',
                    'data-[starting-style]:translate-y-3 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                    'data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0 [&[data-limited]]:opacity-0',
                )}
            >
                <span className="mt-0.5">{icons[kind]}</span>
                <Toast.Content className="grid gap-0.5">
                    <Toast.Title className="text-[14px] leading-snug font-medium" />
                    <Toast.Description className="text-[13px] text-(--text-2)" />
                </Toast.Content>
            </Toast.Root>
        )
    })
}

/** Toasts float above the bottom navigation on phones and near the bottom edge on desktop. */
export function ToastHost({ children }: { children: ReactNode }) {
    return (
        <Toast.Provider toastManager={toaster} limit={3}>
            {children}
            <Toast.Viewport className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+88px)] z-50 grid justify-items-center gap-2 px-4 md:bottom-7">
                <Toasts />
            </Toast.Viewport>
        </Toast.Provider>
    )
}
