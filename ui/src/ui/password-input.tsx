import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { Button } from './button'
import type { TextFieldProps } from './field'
import { TextField } from './field'

/** A password field with a show toggle: on a phone, a glance is cheaper than typing it again. */
export function PasswordField(props: Omit<TextFieldProps, 'type' | 'trailing'>) {
    const [shown, setShown] = useState(false)
    return (
        <TextField
            {...props}
            type={shown ? 'text' : 'password'}
            trailing={
                <Button
                    variant="ghost"
                    size="sm"
                    round
                    aria-label={shown ? '隐藏密码' : '显示密码'}
                    onClick={() => setShown(s => !s)}
                    icon={shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                />
            }
        />
    )
}
