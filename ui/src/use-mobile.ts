import { useEffect, useState } from 'react'

/** 手机布局的分界与 Tailwind 的 md 一致。 */
export function useMobile(): boolean {
    const [m, setM] = useState(() => window.matchMedia('(max-width: 767px)').matches)
    useEffect(() => {
        const mq = window.matchMedia('(max-width: 767px)')
        const on = () => setM(mq.matches)
        mq.addEventListener('change', on)
        return () => mq.removeEventListener('change', on)
    }, [])
    return m
}
