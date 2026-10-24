import type { CSSProperties, FormEvent } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { describeError } from '../api/error'
import tall from '../assets/house-tall.webp'
import wide from '../assets/house-wide.webp'
import { useAuth } from '../auth'
import { ClientGuide } from '../components/client-guide'
import { depart, useCardName } from '../components/vt'
import { useServerName, useTitle } from '../data'
import { Button } from '../ui/button'
import { TextField } from '../ui/field'
import { PasswordField } from '../ui/password-input'

/**
 * Where the blank screen sits in each photograph, as fractions of the image. Measured from
 * the bright rectangle in the generated images; regenerate them and these change too.
 */
const PHOTOS = {
    wide: { src: wide, w: 2048, h: 1152, x0: 0.264, x1: 0.7385, y0: 0.1337, y1: 0.428 },
    tall: { src: tall, w: 1152, h: 2048, x0: 0.208, x1: 0.7912, y0: 0.1221, y1: 0.313 },
}
const PHONE = '(max-width: 767px)'

/** The screen's rectangle on this viewport, following object-fit: cover from the centre. */
function useScreenRect() {
    const [rect, setRect] = useState<CSSProperties | null>(null)
    useLayoutEffect(() => {
        const measure = () => {
            const p = window.matchMedia(PHONE).matches ? PHOTOS.tall : PHOTOS.wide
            const vw = window.innerWidth
            const vh = window.innerHeight
            const scale = Math.max(vw / p.w, vh / p.h)
            const w = p.w * scale
            const h = p.h * scale
            const ox = (vw - w) / 2
            const oy = (vh - h) / 2
            setRect({
                left: ox + p.x0 * w,
                top: oy + p.y0 * h,
                width: (p.x1 - p.x0) * w,
                height: (p.y1 - p.y0) * h,
            })
        }
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
    }, [])
    return rect
}

/**
 * The house before the show: an empty screening room with the projector running and the
 * screen blank. The server's name is on the screen; the sign-in form waits in the seats.
 * Signing in, the screen itself carries over and becomes the home page's screen.
 */
export function Login() {
    const { user, login } = useAuth()
    const location = useLocation()
    const navigate = useNavigate()
    const name = useServerName()
    const rect = useScreenRect()
    useTitle('登录')
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const entering = useRef(false)
    const from = (location.state as { from?: string } | null)?.from
    const dest = from && from !== '/login' ? from : '/'
    const vt = useCardName('login', 'screen', dest)

    if (user && !entering.current) return <Navigate to={dest} replace />

    async function submit(e: FormEvent) {
        e.preventDefault()
        if (!username.trim() || !password) {
            setError('用户名和密码都要填')
            return
        }
        setBusy(true)
        setError(null)
        entering.current = true
        try {
            await login(username.trim(), password)
            depart('login', 'screen', 'home')
            navigate(dest, { replace: true, viewTransition: true })
        } catch (err) {
            entering.current = false
            setError(describeError(err))
            setBusy(false)
        }
    }

    return (
        <main className="relative min-h-svh overflow-hidden bg-house">
            <div className="grain fixed inset-0" aria-hidden>
                <picture>
                    <source media={PHONE} srcSet={tall} />
                    <img src={wide} alt="" fetchPriority="high" className="size-full object-cover" />
                </picture>
            </div>

            {rect && (
                <div
                    className={`fixed grid place-items-center overflow-hidden rounded-[3px] [container-type:size] ${vt ?? ''}`}
                    style={rect}
                >
                    <h1
                        className="m-0 max-w-[88%] truncate px-[4cqw] text-center font-display text-[min(34cqh,12cqw)] leading-none text-[#0c1222]/85 mix-blend-multiply"
                        title={name}
                    >
                        {name}
                    </h1>
                </div>
            )}

            <div className="relative flex min-h-svh flex-col justify-end px-5 pb-[max(20px,env(safe-area-inset-bottom))] md:items-center md:pb-[7vh]">
                <div className="animate-settle w-full md:max-w-[700px]">
                    <form
                        onSubmit={submit}
                        noValidate
                        className="glass-strong grid gap-3.5 rounded-panel p-4.5 md:grid-cols-[1fr_1fr_auto] md:items-end md:gap-3 md:rounded-[26px] md:p-4"
                    >
                        <TextField
                            label="用户名"
                            value={username}
                            onChange={setUsername}
                            autoComplete="username"
                            autoCapitalize="none"
                            autoFocus
                            className="[&_input]:h-12"
                        />
                        <PasswordField
                            label="密码"
                            value={password}
                            onChange={setPassword}
                            autoComplete="current-password"
                            className="[&_input]:h-12"
                        />
                        <Button type="submit" variant="bright" size="lg" loading={busy} className="h-12 md:px-8">
                            入场
                        </Button>
                        {error && <p className="text-[13.5px] text-danger md:col-span-3">{error}</p>}
                    </form>
                    <div className="mt-3.5 flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-1.5 text-[13px] text-(--text-3)">
                        <p className="m-0">和 Emby App 用同一个账号。没有账号的话，找管理员要一个。</p>
                        <details className="group">
                            <summary className="cursor-pointer list-none select-none hover:text-(--text-2) [&::-webkit-details-marker]:hidden">
                                在电视或手机上看
                                <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
                            </summary>
                            <div className="glass-strong mt-3 max-w-[440px] rounded-panel p-4 text-left">
                                <ClientGuide compact />
                            </div>
                        </details>
                    </div>
                </div>
            </div>
        </main>
    )
}
