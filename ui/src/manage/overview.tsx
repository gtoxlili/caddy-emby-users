import { ChevronRight, Pause, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { backdropUrl, lightSource, posterUrl, stillUrl } from '../api/images'
import type { ActivityEntry, Item, SessionInfo, User } from '../api/types'
import { cn } from '../cn'
import { titleOf } from '../components/links'
import { clock, episodeLabel, relative, ticksToSeconds } from '../format'
import { lightStyle } from '../light/palette'
import { useLightOf, useRoomLight } from '../light/room'
import { Avatar } from '../ui/avatar'
import { Loading } from '../ui/spinner'
import { ActivityList, Pulse } from './activity-list'
import { useCounts, usePulse, useSessions, useUsers, useWatching } from './data'
import { Badge, Panel } from './shell'

const HOUR = 3600_000

const METHOD: Record<string, string> = { DirectPlay: '直接播放', DirectStream: '转封装', Transcode: '转码' }

/** A clock that runs: something on this page moves, so it reads as live. */
function Clock() {
    const [now, setNow] = useState(() => new Date())
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 1000)
        return () => clearInterval(t)
    }, [])
    const pad = (n: number) => String(n).padStart(2, '0')
    return (
        <span className="font-display text-[34px] leading-none text-(--text) tabular">
            {pad(now.getHours())}:{pad(now.getMinutes())}
            <span className="text-(--text-3)">:{pad(now.getSeconds())}</span>
        </span>
    )
}

function Reading({ n, unit, to }: { n: number | string; unit: string; to?: string }) {
    const body = (
        <>
            <span className="font-display text-[26px] leading-none text-(--text) tabular">{n}</span>
            <span className="ml-1.5 text-[13px] text-(--text-2)">{unit}</span>
        </>
    )
    return to ? (
        <Link to={to} className="hover:text-white">
            {body}
        </Link>
    ) : (
        <span>{body}</span>
    )
}

/** Someone watching: a small screen showing what they watch, lit by it, with how far in. */
export function NowPlaying({ s }: { s: SessionInfo }) {
    const it = s.NowPlayingItem
    const light = useLightOf(lightSource(it))
    if (!it) return null
    const src = stillUrl(it, 640) ?? backdropUrl(it, 640)
    const pos = ticksToSeconds(s.PlayState.PositionTicks)
    const total = ticksToSeconds(it.RunTimeTicks)
    const pct = total > 0 ? Math.min(100, (pos / total) * 100) : 0
    return (
        <div className="grid gap-3" style={lightStyle(light)}>
            <div className="screen aspect-video w-full">
                {src && <img src={src} alt="" className="absolute inset-0 size-full object-cover" />}
                <div className="absolute inset-0 bg-[linear-gradient(0deg,rgb(0_0_0/.75),transparent_55%)]" />
                <div className="absolute inset-x-4 bottom-3.5">
                    <p className="truncate text-[15px] font-semibold text-white">{titleOf(it)}</p>
                    <p className="truncate text-[12.5px] text-white/70 tabular">
                        {it.Type === 'Episode' ? `${episodeLabel(it)}　` : ''}
                        {clock(pos)}
                        {total > 0 ? ` / ${clock(total)}` : ''}
                    </p>
                    <div className="mt-2 h-[3px] overflow-hidden rounded bg-white/20">
                        <div className="h-full bg-(--accent-vivid)" style={{ width: `${pct}%` }} />
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-2.5 px-0.5">
                <Avatar name={s.UserName} size={24} />
                <Link to={`/manage/users/${s.UserId}`} className="truncate text-[14px] font-medium hover:text-white">
                    {s.UserName}
                </Link>
                <span
                    className={cn(
                        'flex items-center gap-1 text-[12px]',
                        s.PlayState.IsPaused ? 'text-(--text-3)' : 'text-(--accent)',
                    )}
                >
                    {s.PlayState.IsPaused ? (
                        <Pause className="size-3 fill-current" />
                    ) : (
                        <Play className="live-dot size-3 fill-current" />
                    )}
                    {s.PlayState.IsPaused ? '暂停中' : '在看'}
                </span>
                <span className="ml-auto truncate text-[12px] text-(--text-3)">
                    {[METHOD[s.PlayState.PlayMethod ?? ''], s.DeviceName].filter(Boolean).join('　')}
                </span>
            </div>
        </div>
    )
}

/** When no one is watching: who watched last and when, rather than an empty box. */
function Quiet({ last }: { last: ActivityEntry | undefined }) {
    return (
        <div className="grid flex-1 place-items-center py-10 text-center">
            <p className="text-[14px] text-(--text-2) text-pretty">
                这会儿没人在看。
                {last && (
                    <>
                        <br />
                        <span className="text-(--text-3)">
                            上一个是 {last.UserName}，{relative(last.Date)}看了《{last.ItemName}》。
                        </span>
                    </>
                )}
            </p>
        </div>
    )
}

function LitPoster({ it }: { it: Item }) {
    const src = posterUrl(it, 160)
    const light = useLightOf(lightSource(it))
    return (
        <span
            className="lit block h-[62px] w-[42px] shrink-0 overflow-hidden rounded-[5px] bg-white/8"
            style={lightStyle(light)}
            title={titleOf(it)}
        >
            {src && <img src={src} alt="" loading="lazy" className="size-full object-cover" />}
        </span>
    )
}

/** One person per row: who they are, what they are in the middle of, when they were last here. */
function Person({ u, live }: { u: User; live: SessionInfo | undefined }) {
    const watching = useWatching(u.Id)
    const list = watching.data ?? []
    const now = live?.NowPlayingItem
    return (
        <li>
            <Link
                to={`/manage/users/${u.Id}`}
                className={cn(
                    'grid grid-cols-[minmax(120px,200px)_1fr_auto] items-center gap-5 border-b border-(--line) py-3 transition-colors hover:bg-white/3 max-sm:grid-cols-[1fr_auto]',
                    u.Policy.IsDisabled && 'opacity-50',
                )}
            >
                <span className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={u.Name} size={30} />
                    <span className="truncate text-[15px] font-medium">{u.Name}</span>
                    {u.Policy.IsAdministrator && <Badge tone="light">管理员</Badge>}
                    {u.Policy.IsDisabled && <Badge tone="danger">停用</Badge>}
                </span>
                <span className="flex min-w-0 items-center gap-3 max-sm:hidden">
                    {now && (
                        <span className="flex shrink-0 items-center gap-1.5 text-[13px]">
                            <span className="live-dot size-1.5 rounded-full bg-(--accent)" />
                            在看《{titleOf(now)}》
                        </span>
                    )}
                    <span className="flex gap-1.5 overflow-hidden">
                        {list.slice(0, 8).map(it => (
                            <LitPoster key={it.Id} it={it} />
                        ))}
                    </span>
                    {!now && list.length === 0 && !watching.isPending && (
                        <span className="text-[13px] text-(--text-3)">还没看过什么</span>
                    )}
                </span>
                <span className="text-[12.5px] text-(--text-3) tabular">
                    {u.LastLoginDate ? `${relative(u.LastActivityDate || u.LastLoginDate)}来过` : '还没登录过'}
                </span>
            </Link>
        </li>
    )
}

/** This moment: who is watching, how big the library is, what everyone is in the middle of. */
export default function Overview() {
    const users = useUsers()
    const sessions = useSessions()
    const counts = useCounts()
    const online = (sessions.data ?? []).filter(s => Date.now() - new Date(s.LastActivityDate).getTime() < HOUR)
    const watching = online.filter(s => s.NowPlayingItem)
    const pulse = usePulse()
    const recent = pulse.data ?? []
    const last = recent.find(e => e.Type === 'playback.start')
    useRoomLight(lightSource(watching[0]?.NowPlayingItem))

    return (
        <>
            <header className="mb-9 flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
                <div>
                    <h1 className="font-display text-[40px] leading-none">此刻</h1>
                    <p className="mt-3 text-[13.5px] text-(--text-2)">谁在看、谁来过、片库有多大。每 10 秒刷新一次。</p>
                </div>
                <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
                    <Reading n={watching.length} unit="人在看" />
                    <Reading n={online.length} unit="台设备在线" to="/manage/devices" />
                    <Reading n={users.data?.length ?? '–'} unit="个账号" to="/manage/users" />
                    {counts.data && <Reading n={counts.data.MovieCount} unit="部电影" />}
                    {counts.data && <Reading n={counts.data.SeriesCount} unit="部剧" />}
                    <Clock />
                </div>
            </header>

            <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
                <Panel title="正在放映" bodyClassName="flex flex-col">
                    {sessions.isPending ? (
                        <Loading className="flex-1" />
                    ) : watching.length ? (
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-6">
                            {watching.map(s => (
                                <NowPlaying key={s.Id} s={s} />
                            ))}
                        </div>
                    ) : (
                        <Quiet last={last} />
                    )}
                </Panel>
                <Panel title="过去 24 小时" bodyClassName="flex flex-col">
                    {pulse.isPending ? <Loading className="py-2" /> : <Pulse entries={recent} />}
                    <div className="mt-5 flex flex-1 flex-col border-t border-(--line) pt-4">
                        {pulse.isPending ? null : <ActivityList items={recent.slice(0, 7)} dense />}
                        <Link
                            to="/manage/activity"
                            className="mt-auto inline-flex items-center gap-0.5 pt-4 text-[13px] text-(--text-2) hover:text-(--text)"
                        >
                            全部动态 <ChevronRight className="size-3.5" />
                        </Link>
                    </div>
                </Panel>
            </div>

            <section className="mt-10">
                <div className="mb-1 flex items-baseline justify-between">
                    <h2 className="font-display text-[25px]">朋友们</h2>
                    <Link to="/manage/users" className="text-[13px] text-(--text-2) hover:text-(--text)">
                        管理账号
                    </Link>
                </div>
                {users.isPending ? (
                    <Loading className="py-6" />
                ) : (
                    <ol className="border-t border-(--line)">
                        {(users.data ?? []).map(u => (
                            <Person key={u.Id} u={u} live={online.find(s => s.UserId === u.Id && s.NowPlayingItem)} />
                        ))}
                    </ol>
                )}
            </section>
        </>
    )
}
