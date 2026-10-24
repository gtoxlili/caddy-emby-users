import { Activity, ArrowLeft, MonitorSmartphone, Radio, Users } from 'lucide-react'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { Link, NavLink, ScrollRestoration, useLocation } from 'react-router'
import { useUser } from '../auth'
import { cn } from '../cn'
import { useServerName, useTitle } from '../data'
import { House } from '../light/room'
import { spring } from '../motion'
import { Avatar } from '../ui/avatar'

const nav = [
    { to: '/manage', label: '此刻', icon: Radio, match: (p: string) => p === '/manage' || p === '/manage/' },
    { to: '/manage/users', label: '账号', icon: Users, match: (p: string) => p.startsWith('/manage/users') },
    {
        to: '/manage/devices',
        label: '设备',
        icon: MonitorSmartphone,
        match: (p: string) => p.startsWith('/manage/devices'),
    },
    { to: '/manage/activity', label: '动态', icon: Activity, match: (p: string) => p.startsWith('/manage/activity') },
]

/**
 * The projection booth: the same house, lights a little lower, for whoever runs it. The
 * pages here are the plugin's own accounts on Emby's account endpoints.
 */
export function ManageShell({ children }: { children: ReactNode }) {
    const user = useUser()
    const name = useServerName()
    const { pathname } = useLocation()
    useTitle('管理')
    return (
        <div
            className="min-h-svh [--house:0.6]"
            style={{ '--gutter': 'clamp(16px, 4vw, 48px)' } as React.CSSProperties}
        >
            <House />
            <ScrollRestoration />
            <header className="pointer-events-none fixed inset-x-0 top-[max(12px,env(safe-area-inset-top))] z-40 flex items-center justify-between gap-3 px-(--gutter)">
                <Link
                    to="/"
                    viewTransition
                    className="glass pointer-events-auto flex h-11 items-center gap-2 rounded-full pr-4 pl-3 text-[14px] text-(--text-2) transition-colors hover:text-white"
                >
                    <ArrowLeft className="size-4" />
                    <span className="max-w-[28vw] truncate">{name}</span>
                </Link>
                <nav
                    aria-label="管理"
                    className="glass pointer-events-auto flex h-11 items-center gap-1 rounded-full px-1.5"
                >
                    {nav.map(n => {
                        const active = n.match(pathname)
                        return (
                            <NavLink
                                key={n.to}
                                to={n.to}
                                end={n.to === '/manage'}
                                aria-label={n.label}
                                className={cn(
                                    'relative grid h-8 place-items-center rounded-full px-3 text-[14px] font-medium transition-colors sm:px-4',
                                    active ? 'text-white' : 'text-(--text-2) hover:text-(--text)',
                                )}
                            >
                                {active && (
                                    <motion.span
                                        layoutId="manage-nav"
                                        transition={spring.snappy}
                                        className="absolute inset-0 rounded-full bg-white/13 shadow-[inset_0_1px_0_rgb(255_255_255/.14)]"
                                    />
                                )}
                                <span className="relative flex items-center gap-1.5">
                                    <n.icon className="size-4 sm:hidden" />
                                    <span className="hidden sm:inline">{n.label}</span>
                                </span>
                            </NavLink>
                        )
                    })}
                </nav>
                <span className="pointer-events-auto max-sm:hidden" title={user.Name}>
                    <Avatar name={user.Name} size={36} />
                </span>
            </header>
            <main className="mx-auto w-full max-w-[1240px] px-(--gutter) pt-[calc(env(safe-area-inset-top)+92px)] pb-16">
                {children}
            </main>
        </div>
    )
}

export function PageTitle({ children, aside, hint }: { children: ReactNode; aside?: ReactNode; hint?: ReactNode }) {
    return (
        <div className="mb-7 flex flex-wrap items-end justify-between gap-3">
            <div>
                <h1 className="font-display text-[34px] leading-none lg:text-[40px]">{children}</h1>
                {hint && <p className="mt-3 text-[13.5px] text-(--text-2) text-pretty">{hint}</p>}
            </div>
            {aside}
        </div>
    )
}

/** Side-by-side panels match heights: the grid stretches them, the body fills the panel. */
export function Panel({
    title,
    children,
    className,
    bodyClassName,
    aside,
}: {
    title?: ReactNode
    children: ReactNode
    className?: string
    bodyClassName?: string
    aside?: ReactNode
}) {
    return (
        <section className={cn('glass flex flex-col rounded-panel', className)}>
            {title && (
                <header className="flex items-center justify-between gap-3 border-b border-(--line) px-5 py-3.5">
                    <h2 className="text-[15px] font-semibold">{title}</h2>
                    {aside}
                </header>
            )}
            <div className={cn('flex-1 p-5', bodyClassName)}>{children}</div>
        </section>
    )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'light' | 'danger' }) {
    const tones = {
        neutral: 'bg-white/10 text-(--text-2)',
        light: 'bg-(--accent-vivid)/25 text-(--accent)',
        danger: 'bg-danger/15 text-danger',
    }
    return (
        <span
            className={cn('inline-flex items-center rounded-md px-1.5 py-0.5 text-[11.5px] font-medium', tones[tone])}
        >
            {children}
        </span>
    )
}
