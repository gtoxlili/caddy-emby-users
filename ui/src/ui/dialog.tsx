import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../cn'
import { Button } from './button'

const backdrop =
    'fixed inset-0 bg-black/50 backdrop-blur-[3px] transition-opacity duration-300 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0'
/** Desktop: a pane of glass in the middle. Phone: a sheet rising from the bottom. */
const viewport = 'fixed inset-0 grid place-items-center p-4 max-sm:place-items-end max-sm:p-2'
const popup = cn(
    'glass-strong w-[min(92vw,460px)] rounded-panel p-6 text-(--text) outline-none max-sm:w-full max-sm:p-5 max-sm:pb-[max(20px,env(safe-area-inset-bottom))]',
    'transition-[opacity,transform] duration-500 ease-(--ease-spring)',
    'data-[starting-style]:scale-[.94] data-[starting-style]:opacity-0 data-[ending-style]:scale-[.97] data-[ending-style]:opacity-0',
    'max-sm:data-[starting-style]:translate-y-8 max-sm:data-[ending-style]:translate-y-6',
)

export interface ModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: ReactNode
    description?: ReactNode
    children?: ReactNode
    footer?: ReactNode
    className?: string
}

export function Modal({ open, onOpenChange, title, description, children, footer, className }: ModalProps) {
    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Backdrop className={backdrop} />
                <Dialog.Viewport className={viewport}>
                    <Dialog.Popup className={cn(popup, className)}>
                        <div className="flex items-start justify-between gap-4">
                            <div className="grid gap-1">
                                <Dialog.Title className="text-[19px] leading-tight font-semibold">{title}</Dialog.Title>
                                {description && (
                                    <Dialog.Description className="text-[13.5px] text-(--text-2) text-pretty">
                                        {description}
                                    </Dialog.Description>
                                )}
                            </div>
                            <Dialog.Close
                                render={
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        round
                                        aria-label="关闭"
                                        icon={<X className="size-4" />}
                                    />
                                }
                            />
                        </div>
                        {children && <div className="mt-5 grid gap-4">{children}</div>}
                        {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
                    </Dialog.Popup>
                </Dialog.Viewport>
            </Dialog.Portal>
        </Dialog.Root>
    )
}

export interface ConfirmProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: ReactNode
    description?: ReactNode
    confirmText?: string
    danger?: boolean
    loading?: boolean
    onConfirm: () => void
}

export function Confirm({
    open,
    onOpenChange,
    title,
    description,
    confirmText = '确定',
    danger,
    loading,
    onConfirm,
}: ConfirmProps) {
    return (
        <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
            <AlertDialog.Portal>
                <AlertDialog.Backdrop className={backdrop} />
                <AlertDialog.Viewport className={viewport}>
                    <AlertDialog.Popup className={cn(popup, 'w-[min(92vw,400px)]')}>
                        <AlertDialog.Title className="text-[19px] leading-tight font-semibold">
                            {title}
                        </AlertDialog.Title>
                        {description && (
                            <AlertDialog.Description className="mt-2 text-[13.5px] text-(--text-2) text-pretty">
                                {description}
                            </AlertDialog.Description>
                        )}
                        <div className="mt-6 flex justify-end gap-2">
                            <AlertDialog.Close render={<Button variant="ghost">取消</Button>} />
                            <Button variant={danger ? 'danger' : 'bright'} loading={loading} onClick={onConfirm}>
                                {confirmText}
                            </Button>
                        </div>
                    </AlertDialog.Popup>
                </AlertDialog.Viewport>
            </AlertDialog.Portal>
        </AlertDialog.Root>
    )
}
