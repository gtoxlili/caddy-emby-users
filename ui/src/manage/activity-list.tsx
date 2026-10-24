import { AlertTriangle, LogIn, Play, UserCog } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { Link } from 'react-router'
import type { ActivityEntry } from '../api/types'
import { cn } from '../cn'
import { dateTime, relative } from '../format'

export type Kind = 'play' | 'login' | 'failed' | 'account'

export function kindOf(e: ActivityEntry): Kind {
    if (e.Type === 'playback.start') return 'play'
    if (e.Type === 'user.authenticated') return 'login'
    if (e.Type === 'user.authenticationfailed') return 'failed'
    return 'account'
}

export const kinds: Record<Kind, { label: string; icon: ReactNode; tone: string }> = {
    play: {
        label: '播放',
        icon: <Play className="size-3.5 fill-current" />,
        tone: 'text-(--accent) bg-(--accent-vivid)/22',
    },
    login: { label: '登录', icon: <LogIn className="size-3.5" />, tone: 'text-ok bg-ok/14' },
    failed: { label: '登录失败', icon: <AlertTriangle className="size-3.5" />, tone: 'text-danger bg-danger/14' },
    account: { label: '账号', icon: <UserCog className="size-3.5" />, tone: 'text-(--text-2) bg-white/10' },
}

function Who({ id, name }: { id?: string; name?: string }) {
    if (!name) return <span>某人</span>
    return id ? (
        <Link to={`/manage/users/${id}`} className="font-medium text-(--text) hover:text-white">
            {name}
        </Link>
    ) : (
        <span className="font-medium text-(--text)">{name}</span>
    )
}

const POLICY: Record<string, (user: ReactNode) => ReactNode> = {
    'admin:on': u => <>把 {u} 设为管理员</>,
    'admin:off': u => <>取消了 {u} 的管理员</>,
    'disabled:on': u => <>停用了 {u}</>,
    'disabled:off': u => <>恢复了 {u}</>,
}

/** One entry as a sentence, from the fields rather than Emby's English Name. */
function Sentence({ e }: { e: ActivityEntry }) {
    const user = <Who id={e.UserId} name={e.UserName} />
    const by = e.ByUserName ? <span className="font-medium text-(--text)">{e.ByUserName}</span> : null
    switch (e.Type) {
        case 'playback.start':
            return (
                <>
                    {user} 在看《{e.ItemName}》{e.Detail && <span className="text-(--text-3)">　{e.Detail}</span>}
                </>
            )
        case 'user.authenticated':
            return (
                <>
                    {user} 在 {e.DeviceName || '某台设备'} 上登录了
                </>
            )
        case 'user.authenticationfailed':
            return e.Detail === 'account disabled' ? (
                <>{user} 想登录，但账号已停用</>
            ) : (
                <>
                    有人以 {e.UserId ? user : <span className="font-medium text-(--text)">{e.UserName}</span>}{' '}
                    登录，密码不对
                </>
            )
        case 'user.created':
            return by ? (
                <>
                    {by} 新建了账号 {user}
                </>
            ) : (
                <>在命令行新建了账号 {user}</>
            )
        case 'user.deleted':
            return by ? (
                <>
                    {by} 删除了账号 {user}
                </>
            ) : (
                <>删除了账号 {user}</>
            )
        case 'user.passwordchanged':
            if (!by) return <>{user} 改了密码</>
            return e.Detail === 'cleared' ? (
                <>
                    {by} 清空了 {user} 的密码
                </>
            ) : (
                <>
                    {by} 重设了 {user} 的密码
                </>
            )
        case 'user.policyupdated':
            return (
                <>
                    {by ?? '命令行'}
                    {(e.Detail ?? '')
                        .split(',')
                        .filter(Boolean)
                        .map((t, i) => (
                            <span key={t}>
                                {i > 0 ? '，' : ' '}
                                {POLICY[t]?.(user) ?? t}
                            </span>
                        ))}
                </>
            )
        case 'user.renamed':
            return (
                <>
                    {by ? <>{by} 把</> : '把'} {e.Detail} 改名为 {user}
                </>
            )
    }
    return <>{e.Name}</>
}

/** The log: time down the left like a scale, a small tag for the kind, then what happened. */
export function ActivityList({ items, dense }: { items: ActivityEntry[]; dense?: boolean }) {
    if (items.length === 0) return <p className="py-6 text-center text-[13.5px] text-(--text-2)">还没有动态。</p>
    return (
        <ol className={cn('grid', dense ? 'gap-2.5' : 'gap-3.5')}>
            {items.map(e => {
                const k = kinds[kindOf(e)]
                return (
                    <li key={e.Id} className="grid grid-cols-[68px_24px_1fr] items-start gap-3">
                        <span className="pt-0.5 text-[12px] text-(--text-3) tabular" title={dateTime(e.Date)}>
                            {relative(e.Date)}
                        </span>
                        <span className={cn('grid size-6 place-items-center rounded-md', k.tone)} title={k.label}>
                            {k.icon}
                        </span>
                        <p
                            className={cn(
                                'min-w-0 text-(--text-2) text-pretty',
                                dense ? 'text-[13.5px]' : 'text-[14px]',
                            )}
                        >
                            <Sentence e={e} />
                            {!dense && e.Type !== 'playback.start' && e.Overview && (
                                <span className="mt-0.5 block truncate text-[12px] text-(--text-3)">{e.Overview}</span>
                            )}
                        </p>
                    </li>
                )
            })}
        </ol>
    )
}

const HOUR = 3600_000

/**
 * The last 24 hours, an hour per bar: playback in the room's light, sign-ins in grey,
 * failed sign-ins in red. The current hour is on the right.
 */
export function Pulse({ entries }: { entries: ActivityEntry[] }) {
    const [hover, setHover] = useState<number | null>(null)
    const now = Date.now()
    const buckets = Array.from({ length: 24 }, (_, i) => ({ play: 0, login: 0, failed: 0, ago: 23 - i }))
    for (const e of entries) {
        const age = now - new Date(e.Date).getTime()
        if (age < 0 || age >= 24 * HOUR) continue
        const b = buckets[23 - Math.floor(age / HOUR)]
        const k = kindOf(e)
        if (b && k !== 'account') b[k]++
    }
    const max = Math.max(1, ...buckets.map(b => b.play + b.login + b.failed))
    const label = (ago: number) => `${String(new Date(now - ago * HOUR).getHours()).padStart(2, '0')}:00`
    const shown = hover === null ? null : buckets[hover]
    return (
        <div>
            <div className="mb-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-(--text-2)">
                <span className="flex items-center gap-1.5">
                    <i className="size-2 rounded-[2px] bg-(--accent-vivid)" />
                    播放
                </span>
                <span className="flex items-center gap-1.5">
                    <i className="size-2 rounded-[2px] bg-white/35" />
                    登录
                </span>
                <span className="flex items-center gap-1.5">
                    <i className="size-2 rounded-[2px] bg-danger" />
                    登录失败
                </span>
                <span className="ml-auto text-(--text-3) tabular">
                    {shown
                        ? `${label(shown.ago)} 起这一小时：播放 ${shown.play}，登录 ${shown.login}${shown.failed ? `，失败 ${shown.failed}` : ''}`
                        : ''}
                </span>
            </div>
            <ol
                className="grid h-16 grid-cols-[repeat(24,minmax(0,1fr))] items-end gap-[3px]"
                onPointerLeave={() => setHover(null)}
            >
                {buckets.map((b, i) => {
                    const total = b.play + b.login + b.failed
                    return (
                        <li
                            key={b.ago}
                            onPointerEnter={() => setHover(i)}
                            aria-label={`${label(b.ago)}：播放 ${b.play}，登录 ${b.login}，登录失败 ${b.failed}`}
                            className={cn(
                                'flex h-full flex-col justify-end gap-[2px] rounded-sm',
                                hover === i && 'bg-white/5',
                            )}
                        >
                            {total === 0 ? (
                                <span className="block h-[2px] rounded-sm bg-white/10" />
                            ) : (
                                <>
                                    {b.failed > 0 && (
                                        <span
                                            className="block rounded-t-[3px] bg-danger"
                                            style={{ height: `${(b.failed / max) * 100}%` }}
                                        />
                                    )}
                                    {b.login > 0 && (
                                        <span
                                            className="block rounded-t-[3px] bg-white/35"
                                            style={{ height: `${(b.login / max) * 100}%` }}
                                        />
                                    )}
                                    {b.play > 0 && (
                                        <span
                                            className="block rounded-t-[3px] bg-(--accent-vivid)"
                                            style={{ height: `${(b.play / max) * 100}%` }}
                                        />
                                    )}
                                </>
                            )}
                        </li>
                    )
                })}
            </ol>
            <div className="mt-1.5 flex justify-between text-[11px] text-(--text-3) tabular">
                <span>{label(23)}</span>
                <span>{label(12)}</span>
                <span>现在</span>
            </div>
        </div>
    )
}
