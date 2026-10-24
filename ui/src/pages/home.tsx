import { useQueries } from '@tanstack/react-query'
import { ArrowRight, X } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import * as emby from '../api/emby'
import { backdropUrl, lightSource, stillUrl } from '../api/images'
import type { Item } from '../api/types'
import { useUser } from '../auth'
import { cn } from '../cn'
import { itemLink, titleOf } from '../components/links'
import { Row } from '../components/rail'
import { Screen, TitleArt } from '../components/screen'
import { depart, useArrivalName, useCardName } from '../components/vt'
import { keys, useContinue, useHideFromResume, useSimilar, useTitle, useViews } from '../data'
import { duration, endsAt, episodeLabel, greeting, progressOf, remaining, ticksToSeconds, years } from '../format'
import { useLightOf, useRoomLight } from '../light/room'
import { Button } from '../ui/button'
import { toast } from '../ui/toast'
import { Tip } from '../ui/tooltip'
import { useMobile } from '../use-mobile'

const FOCUS_KEY = 'emby-users.home.focus'
const SCROLL_KEY = 'emby-users.home.scroll'
/** How long the pointer rests on a card before the screen changes to it; sweeping across a row changes nothing. */
const POINT_DELAY = 110

/**
 * Tonight. The screen hangs at the top of the house and shows one title at a time: where
 * this person left off, or whatever they point at below. Its light fills the room. Below
 * the screen are the rows: where they left off, what each library got lately, and what
 * resembles what they are watching. Everything leads to a title's page; playing starts there.
 */
export default function Home() {
    const user = useUser()
    const views = useViews()
    const cont = useContinue()
    const feeds = useQueries({
        queries: (views.data ?? []).map(v => ({
            queryKey: keys.latest(user.Id, v.Id),
            queryFn: () => emby.latest(user.Id, v.Id, 20),
        })),
    })
    const mobile = useMobile()
    const continuing = cont.data ?? []
    const first = continuing[0] ?? feeds.find(f => f.data?.length)?.data?.[0]
    const [focus, point] = useFocus(first, [...continuing, ...feeds.flatMap(f => f.data ?? [])])
    const anchor = continuing[0]
    const anchorSeries = anchor ? (anchor.SeriesId ?? anchor.Id) : undefined
    const similar = useSimilar(anchorSeries, 16)
    useRoomLight(lightSource(focus))
    useTitle(null)

    const rows = (
        <>
            {views.isError && (
                <p className="text-[14px] text-(--text-2)">片库暂时拿不到，Emby 服务器没有响应，稍后刷新试试。</p>
            )}
            <Row
                title="接着看"
                kind="still"
                items={cont.isPending ? undefined : continuing}
                keyPrefix="continue"
                width={mobile ? 248 : 300}
                onPoint={mobile ? undefined : point}
            />
            {(views.data ?? []).map((v, i) => (
                <Row
                    key={v.Id}
                    title={v.Name}
                    to={`/library/${v.Id}`}
                    items={feeds[i]?.data}
                    keyPrefix={`latest:${v.Id}`}
                    width={mobile ? 124 : 156}
                    priority={i === 0}
                    onPoint={mobile ? undefined : point}
                />
            ))}
            {anchor && similar.data && similar.data.length > 0 && (
                <Row
                    title={`因为你在看《${titleOf(anchor)}》`}
                    items={similar.data}
                    keyPrefix="similar"
                    width={mobile ? 124 : 156}
                    onPoint={mobile ? undefined : point}
                />
            )}
        </>
    )

    if (mobile) {
        return (
            <div className="pb-4">
                <MobileScreen item={focus} />
                <div className="mt-8 px-(--gutter)">{rows}</div>
            </div>
        )
    }
    return <Theatre focus={focus}>{rows}</Theatre>
}

/**
 * What the screen shows: the first item until someone points at another. The choice is
 * kept for the session, so coming back from a title finds the same film on the screen.
 */
function useFocus(fallback: Item | undefined, pool: Item[]): [Item | undefined, (it: Item) => void] {
    const [id, setId] = useState<string | null>(() => sessionStorage.getItem(FOCUS_KEY))
    const [picked, setPicked] = useState<Item | null>(null)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const point = useCallback((it: Item) => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
            setPicked(it)
            setId(it.Id)
            sessionStorage.setItem(FOCUS_KEY, it.Id)
        }, POINT_DELAY)
    }, [])
    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current)
        },
        [],
    )
    const kept = picked?.Id === id ? picked : (pool.find(it => it.Id === id) ?? null)
    return [kept ?? fallback, point]
}

/**
 * Desktop: the house as one room. The screen holds the top of the window and narrows to a
 * letterbox as the rows beneath it scroll, so it stays in view whatever is pointed at.
 */
function Theatre({ focus, children }: { focus: Item | undefined; children: React.ReactNode }) {
    const seats = useRef<HTMLDivElement>(null)
    const room = useRef<HTMLDivElement>(null)
    const raf = useRef(0)

    useLayoutEffect(() => {
        const el = seats.current
        if (!el) return
        const saved = Number(sessionStorage.getItem(SCROLL_KEY) ?? 0)
        if (saved > 0) el.scrollTop = saved
        const apply = () => room.current?.style.setProperty('--c', String(Math.min(1, el.scrollTop / 280)))
        apply()
        const onScroll = () => {
            cancelAnimationFrame(raf.current)
            raf.current = requestAnimationFrame(() => {
                apply()
                sessionStorage.setItem(SCROLL_KEY, String(el.scrollTop))
            })
        }
        el.addEventListener('scroll', onScroll, { passive: true })
        return () => {
            el.removeEventListener('scroll', onScroll)
            cancelAnimationFrame(raf.current)
        }
    }, [])

    return (
        <div ref={room} className="fixed inset-0 flex flex-col pt-[72px]" style={{ '--c': 0 } as CSSProperties}>
            <div className="mx-auto w-full max-w-[1480px] shrink-0 px-(--gutter)">
                <HouseScreen item={focus} />
            </div>
            <div
                ref={seats}
                className="scrollbar-none mt-7 min-h-0 flex-1 overflow-y-auto pt-5 pb-14 [mask-image:linear-gradient(transparent,black_34px)]"
            >
                <div className="mx-auto w-full max-w-[1480px] px-(--gutter)">{children}</div>
            </div>
        </div>
    )
}

/** The screen on the home page, with what is on it written in its lower left. */
function HouseScreen({ item }: { item: Item | undefined }) {
    const user = useUser()
    const navigate = useNavigate()
    const hide = useHideFromResume()
    const target = item ? itemLink(item).target : ''
    const src = item ? (backdropUrl(item, 1920) ?? stillUrl(item, 1920)) : null
    const light = useLightOf(lightSource(item))
    const leaving = useCardName('home-screen', 'screen', `/item/${target}`)
    const arriving = useArrivalName('screen', '/', 'home')
    const vt = leaving ?? arriving
    const go = () => {
        if (!item) return
        depart('home-screen', 'screen', target)
        navigate(itemLink(item).to, { viewTransition: true })
    }
    const resumable = item && (item.Type === 'Episode' || (item.UserData?.PlaybackPositionTicks ?? 0) > 0)
    return (
        <Screen
            src={src}
            light={light}
            priority
            className={cn('w-full', vt)}
            style={{ height: 'calc((1 - var(--c)) * min(54vh, 640px) + var(--c) * min(30vh, 340px))' }}
        >
            <div className="absolute inset-0 bg-[linear-gradient(90deg,rgb(0_0_0/.72),rgb(0_0_0/.35)_38%,transparent_64%),linear-gradient(0deg,rgb(0_0_0/.6),transparent_45%)]" />
            <button
                type="button"
                onClick={go}
                aria-label="打开"
                className="absolute inset-0 cursor-pointer outline-none"
            />
            <p className="pointer-events-none absolute top-5 left-7 text-[13.5px] text-white/72">
                {greeting()}，{user.Name}
            </p>
            {item && (
                <div className="pointer-events-none absolute inset-x-7 bottom-6 flex items-end justify-between gap-8">
                    <div className="min-w-0 max-w-[620px]">
                        <TitleArt
                            item={item}
                            className="max-h-[calc((1-var(--c))*120px+var(--c)*64px)] max-w-[min(440px,60%)]"
                            textClassName="text-[calc((1-var(--c))*56px+var(--c)*36px)]"
                        />
                        <Facts item={item} className="mt-3.5" />
                        <p className="mt-2.5 line-clamp-2 max-w-[56ch] text-[14px] leading-relaxed text-white/72 opacity-[calc(1-var(--c)*2.2)] text-pretty">
                            {item.Type === 'Episode' ? item.Overview || '' : item.Overview}
                        </p>
                    </div>
                    <div className="pointer-events-auto flex shrink-0 items-center gap-2">
                        {resumable && (
                            <Tip label="不再显示在接着看里">
                                <Button
                                    variant="glass"
                                    round
                                    aria-label="从接着看里移除"
                                    icon={<X className="size-4.5" />}
                                    loading={hide.isPending}
                                    onClick={() =>
                                        hide.mutate(target, {
                                            onSuccess: () => toast(`《${titleOf(item)}》不再显示在接着看里`, 'success'),
                                        })
                                    }
                                />
                            </Tip>
                        )}
                        <Button variant="bright" size="lg" icon={<ArrowRight className="size-5" />} onClick={go}>
                            去看
                        </Button>
                    </div>
                </div>
            )}
        </Screen>
    )
}

/** One line of facts: which episode, how long is left and when it would end, or when it is from. */
function Facts({ item, className }: { item: Item; className?: string }) {
    const left = remaining(item)
    const started = progressOf(item) > 0
    const parts: string[] = []
    if (item.Type === 'Episode') {
        parts.push(`${episodeLabel(item)}${item.Name ? `「${item.Name}」` : ''}`)
    } else {
        const y = years(item)
        if (y) parts.push(y)
        if (item.Type === 'Series' && item.ChildCount) parts.push(`${item.ChildCount} 季`)
        if (item.CommunityRating) parts.push(`评分 ${item.CommunityRating.toFixed(1)}`)
        parts.push(...(item.Genres ?? []).slice(0, 3))
    }
    const time =
        left > 0 && item.Type !== 'Series'
            ? started
                ? `还剩 ${duration(left)}，看完是 ${endsAt(left)}`
                : `${duration(ticksToSeconds(item.RunTimeTicks))}，看完是 ${endsAt(left)}`
            : null
    return (
        <div className={cn('grid gap-1 text-[14px] text-white/80 tabular', className)}>
            <p className="flex flex-wrap gap-x-3.5 gap-y-1">
                {parts.map(p => (
                    <span key={p}>{p}</span>
                ))}
            </p>
            {time && <p className="text-white/62">{time}</p>}
        </div>
    )
}

/** Phone: the screen fills the top of the phone and fades into the house beneath. */
function MobileScreen({ item }: { item: Item | undefined }) {
    const user = useUser()
    const navigate = useNavigate()
    const target = item ? itemLink(item).target : ''
    const src = item ? (backdropUrl(item, 1280) ?? stillUrl(item, 1280)) : null
    const light = useLightOf(lightSource(item))
    const leaving = useCardName('home-screen', 'screen', `/item/${target}`)
    const arriving = useArrivalName('screen', '/', 'home')
    const vt = leaving ?? arriving
    const go = () => {
        if (!item) return
        depart('home-screen', 'screen', target)
        navigate(itemLink(item).to, { viewTransition: true })
    }
    return (
        <section>
            <Screen
                src={src}
                light={light}
                priority
                position="center 25%"
                className={cn(
                    'h-[64svh] w-full rounded-none shadow-none [mask-image:linear-gradient(black_55%,transparent)]',
                    vt,
                )}
            >
                <button type="button" onClick={go} aria-label="打开" className="absolute inset-0 outline-none" />
            </Screen>
            <div className="relative -mt-[22svh] px-(--gutter)">
                <p className="text-[13px] text-white/70">
                    {greeting()}，{user.Name}
                </p>
                {item && (
                    <>
                        <TitleArt
                            item={item}
                            className="mt-2 max-h-[96px] max-w-[78%]"
                            textClassName="mt-1.5 text-[38px]"
                        />
                        <Facts item={item} className="mt-3 text-[13.5px]" />
                        <Button variant="bright" size="lg" onClick={go} className="mt-5 w-full">
                            去看
                        </Button>
                    </>
                )}
            </div>
        </section>
    )
}
