import { Field } from '@base-ui/react/field'
import type { InputHTMLAttributes, ReactNode } from 'react'
import { cn } from '../cn'

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
    label: ReactNode
    value: string
    onChange: (value: string) => void
    error?: string | null
    hint?: ReactNode
    /** Something at the right end of the input, such as a show-password toggle. */
    trailing?: ReactNode
}

export function TextField({ label, value, onChange, error, hint, trailing, className, ...input }: TextFieldProps) {
    return (
        <Field.Root invalid={!!error} className={cn('grid gap-1.5', className)}>
            <Field.Label className="text-[13px] font-medium text-(--text-2)">{label}</Field.Label>
            <div className="relative">
                <Field.Control
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    className={cn(
                        'h-11 w-full rounded-xl border border-(--line) bg-(--field) px-3.5 text-[15px] text-(--text) outline-none',
                        'transition-[border-color,background-color] duration-200',
                        'placeholder:text-(--text-3) focus:border-(--line-strong) focus:bg-white/9 data-[invalid]:border-danger/60',
                        trailing && 'pr-11',
                    )}
                    {...input}
                />
                {trailing && <div className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</div>}
            </div>
            {error ? (
                <p className="text-[13px] text-danger">{error}</p>
            ) : hint ? (
                <Field.Description className="text-[13px] text-(--text-3)">{hint}</Field.Description>
            ) : null}
        </Field.Root>
    )
}
