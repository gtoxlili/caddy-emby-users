import { Clapperboard, House as HouseIcon, Search, SlidersHorizontal, UserRound } from 'lucide-react'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router'
import { useUser } from '../auth'
import { cn } from '../cn'
import { useServerName } from '../data'
import { House } from '../light/room'
import { spring } from '../motion'
import { Avatar } from '../ui/avatar'

const tabs = [
    { to: '/', label: '今晚', icon: HouseIcon, match: (p: string) => p === '/' },
    { to: '/library', label: '片库', icon: Clapperboard, match: (p: string) => p.startsWith('/library') },
    { to: '/search', label: '搜索', icon: Search, match: (p: string) => p.startsWith('/search') },
    { to: '/me', label: '我的', icon: UserRound, match: (p: string) => p.startsWith('/me') },
]

/**
 * The frame around every page but the player: the house light underneath, and the
 * navigation as one pill of glass, at the top on desktop and at the bottom on phones. The
 * selection is one block that slides between tabs.
 */
function useScrolled(): boolean {
    const [scrolled, setScrolled] = useState(false)
    useEffect(() => {
        const on = () => setScrolled(window.scrollY > 24)
        on()
        window.addEventListener('scroll', on, { passive: true })
        return () => window.removeEventListener('scroll', on)
    }, [])
    return scrolled
}

export function Shell() {
    const user = useUser()
    const name = useServerName()
    const { pathname } = useLocation()
    const scrolled = useScrolled()
    return (
        <div className="min-h-svh">
            <House />
            <ScrollRestoration getKey={l => l.pathname} />

            <header className="pointer-events-none fixed inset-x-0 top-0 z-40 hidden h-[68px] items-center justify-between px-(--gutter) md:flex">
                {/* Once the page moves, a band of the house's dark keeps the header legible over it. */}
                <span
                    aria-hidden
                    className={cn(
                        'absolute inset-x-0 top-0 -z-10 h-[96px] bg-gradient-to-b from-house via-house/80 to-transparent transition-opacity duration-300',
                        scrolled ? 'opacity-100' : 'opacity-0',
                    )}
                />
                <Link
                    to="/"
                    viewTransition
                    className="pointer-events-auto max-w-[24vw] truncate font-display text-[19px] text-white/88 hover:text-white"
                >
                    {name}
                </Link>
                <nav
                    aria-label="主导航"
                    className="glass pointer-events-auto absolute left-1/2 flex h-11 -translate-x-1/2 items-center gap-1 rounded-full px-1.5"
                >
                    {tabs.slice(0, 3).map(t => {
                        const active = t.match(pathname)
                        return (
                            <NavLink
                                key={t.to}
                                to={t.to}
                                viewTransition
                                className={cn(
                                    'relative grid h-8 place-items-center rounded-full px-4 text-[14px] font-medium transition-colors',
                                    active ? 'text-white' : 'text-(--text-2) hover:text-(--text)',
                                )}
                            >
                                {active && (
                                    <motion.span
                                        layoutId="nav-active"
                                        transition={spring.snappy}
                                        className="absolute inset-0 rounded-full bg-white/13 shadow-[inset_0_1px_0_rgb(255_255_255/.14)]"
                                    />
                                )}
                                <span className="relative">{t.label}</span>
                            </NavLink>
                        )
                    })}
                </nav>
                <div className="pointer-events-auto flex items-center gap-2">
                    {user.Policy.IsAdministrator && (
                        <Link
                            to="/manage"
                            viewTransition
                            title="管理"
                            aria-label="管理"
                            className="glass grid size-9 place-items-center rounded-full text-(--text-2) transition-colors hover:text-white"
                        >
                            <SlidersHorizontal className="size-4" />
                        </Link>
                    )}
                    <NavLink
                        to="/me"
                        viewTransition
                        aria-label="我的"
                        title={user.Name}
                        className={({ isActive }) =>
                            cn(
                                'grid size-9 place-items-center rounded-full transition-[box-shadow]',
                                isActive ? 'shadow-[0_0_0_2px_white]' : 'hover:shadow-[0_0_0_2px_rgb(255_255_255/.35)]',
                            )
                        }
                    >
                        <Avatar name={user.Name} size={34} />
                    </NavLink>
                </div>
            </header>

            <main className="pb-[calc(92px+env(safe-area-inset-bottom))] md:pb-16">
                <Outlet />
            </main>

            <nav
                aria-label="主导航"
                className="glass fixed inset-x-4 bottom-[max(12px,env(safe-area-inset-bottom))] z-40 grid h-16 grid-cols-4 rounded-[26px] p-1.5 md:hidden"
            >
                {tabs.map(t => {
                    const active = t.match(pathname)
                    return (
                        <NavLink
                            key={t.to}
                            to={t.to}
                            viewTransition
                            className={cn(
                                'relative grid place-items-center gap-0.5 rounded-[20px] text-[10.5px] font-medium transition-colors',
                                active ? 'text-white' : 'text-(--text-2)',
                            )}
                        >
                            {active && (
                                <motion.span
                                    layoutId="nav-active-m"
                                    transition={spring.snappy}
                                    className="absolute inset-0 rounded-[20px] bg-white/12 shadow-[inset_0_1px_0_rgb(255_255_255/.14)]"
                                />
                            )}
                            <t.icon className="relative size-[21px]" strokeWidth={active ? 2.2 : 1.9} />
                            <span className="relative">{t.label}</span>
                        </NavLink>
                    )
                })}
            </nav>
        </div>
    )
}

/** A page's content column: gutters on the sides, room for the navigation and status bar on top. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div
            className={cn(
                'mx-auto w-full max-w-[1480px] px-(--gutter) pt-[calc(env(safe-area-inset-top)+22px)] md:pt-[92px]',
                className,
            )}
        >
            {children}
        </div>
    )
}
