import { ArrowLeft, Check, Heart, MoreHorizontal, Play, RotateCcw, X } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { backdropUrl, lightSource, posterUrl, stillUrl } from '../api/images'
import type { Item } from '../api/types'
import { cn } from '../cn'
import { PosterGrid } from '../components/cards'
import { Cast } from '../components/cast'
import { EpisodeList } from '../components/episodes'
import { Row, SectionTitle } from '../components/rail'
import { Screen, TitleArt } from '../components/screen'
import { Specs } from '../components/specs'
import { depart, useArrivalName, useCardName } from '../components/vt'
import {
    useChildren,
    useEpisodes,
    useFavoriteMutation,
    useHideFromResume,
    useItem,
    useNextFor,
    usePlayedMutation,
    useSeasons,
    useSimilar,
    useTitle,
} from '../data'
import { clock, duration, endsAt, episodeLabel, progressOf, remaining, ticksToSeconds, years } from '../format'
import { useLightOf, useRoomLight } from '../light/room'
import { Button } from '../ui/button'
import { Empty } from '../ui/empty'
import type { MenuEntry } from '../ui/menu'
import { DropMenu } from '../ui/menu'
import { Segmented } from '../ui/segmented'
import { Loading } from '../ui/spinner'
import { toast } from '../ui/toast'
import { useMobile } from '../use-mobile'

/** A title's page. Episodes and seasons open their series, people their own page. */
export default function ItemPage() {
    const { id = '' } = useParams()
    const navigate = useNavigate()
    const item = useItem(id, { fresh: true })
    if (item.isPending) return <Loading className="min-h-[70svh]" />
    if (item.isError || !item.data)
        return (
            <Empty
                className="min-h-[70svh]"
                title="找不到这部片子"
                hint="它可能已经从 Emby 的片库里移走了。"
                action={<Button onClick={() => navigate('/', { viewTransition: true })}>回到今晚</Button>}
            />
        )
    const it = item.data
    if (it.Type === 'Episode' && it.SeriesId) return <Navigate to={`/item/${it.SeriesId}?episode=${it.Id}`} replace />
    if (it.Type === 'Season' && it.SeriesId) return <Navigate to={`/item/${it.SeriesId}?season=${it.Id}`} replace />
    if (it.Type === 'Person') return <Navigate to={`/person/${it.Id}`} replace />
    if (it.Type === 'CollectionFolder' || it.Type === 'UserView') return <Navigate to={`/library/${it.Id}`} replace />
    return <Title key={it.Id} item={it} />
}

interface PlayPlan {
    target: Item
    label: string
    detail: string | null
    resume: boolean
}

/** What the bright button does: resume, continue the series, or start. */
function usePlan(item: Item): { plan: PlayPlan | null; loading: boolean } {
    const series = item.Type === 'Series'
    const next = useNextFor(series ? item.Id : undefined)
    const all = useEpisodes(series && !next.isPending && !next.data ? item.Id : undefined)
    if (!series) {
        if (item.IsFolder) return { plan: null, loading: false }
        const pos = ticksToSeconds(item.UserData?.PlaybackPositionTicks)
        const resume = pos > 0
        return {
            plan: {
                target: item,
                label: resume ? `接着看 ${clock(pos)}` : item.UserData?.Played ? '再看一遍' : '播放',
                detail: resume
                    ? `还剩 ${duration(remaining(item))}，看完是 ${endsAt(remaining(item))}`
                    : item.RunTimeTicks
                      ? `${duration(ticksToSeconds(item.RunTimeTicks))}，看完是 ${endsAt(ticksToSeconds(item.RunTimeTicks))}`
                      : null,
                resume,
            },
            loading: false,
        }
    }
    if (next.isPending) return { plan: null, loading: true }
    if (next.data) {
        const ep = next.data
        const resume = progressOf(ep) > 0
        const watchedAny =
            (item.UserData?.PlayedPercentage ?? 0) > 0 || (ep.IndexNumber ?? 1) > 1 || (ep.ParentIndexNumber ?? 1) > 1
        return {
            plan: {
                target: ep,
                label: resume ? '接着看' : watchedAny ? '看下一集' : '开始看',
                detail: `${episodeLabel(ep)}「${ep.Name}」，${resume ? `还剩 ${duration(remaining(ep))}` : duration(ticksToSeconds(ep.RunTimeTicks))}`,
                resume,
            },
            loading: false,
        }
    }
    if (all.isPending) return { plan: null, loading: true }
    const eps = all.data ?? []
    const first = eps.find(e => (e.ParentIndexNumber ?? 1) > 0) ?? eps[0]
    if (!first) return { plan: null, loading: false }
    return {
        plan: {
            target: first,
            label: item.UserData?.Played ? '再看一遍' : '开始看',
            detail: `${episodeLabel(first)}「${first.Name}」`,
            resume: false,
        },
        loading: false,
    }
}

function Title({ item }: { item: Item }) {
    const navigate = useNavigate()
    const mobile = useMobile()
    const fav = useFavoriteMutation()
    const played = usePlayedMutation()
    const hide = useHideFromResume()
    const similar = useSimilar(item.IsFolder && item.Type !== 'Series' ? undefined : item.Id, 16)
    const { plan, loading } = usePlan(item)
    const light = useLightOf(lightSource(item))
    useRoomLight(lightSource(item))
    useTitle(item.Name)

    const arriving = useArrivalName('screen', `/item/${item.Id}`, item.Id)
    const leaving = useCardName('title-screen', 'screen', `/play/${plan?.target.Id ?? ''}`)
    const posterName = useArrivalName('poster', `/item/${item.Id}`, item.Id)
    const screenName = arriving ?? leaving

    const play = (fromStart = false) => {
        if (!plan) return
        depart('title-screen', 'screen', plan.target.Id)
        navigate(`/play/${plan.target.Id}${fromStart ? '?start=0' : ''}`, { viewTransition: true })
    }
    const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/', { viewTransition: true }))
    const ud = item.UserData
    const backdrop = backdropUrl(item, mobile ? 1280 : 1920) ?? stillUrl(item, 1920)
    const poster = posterUrl(item, 440)
    const source = item.MediaSources?.[0]

    const entries: MenuEntry[] = [
        {
            label: ud?.Played ? '标为没看过' : '标为看过了',
            icon: <Check />,
            onSelect: () =>
                played.mutate(
                    { id: item.Id, played: !ud?.Played },
                    { onSuccess: () => toast(ud?.Played ? '标为没看过了' : '标为看过了', 'success') },
                ),
        },
    ]
    if (plan?.resume || (item.Type === 'Series' && plan && plan.label !== '开始看')) {
        entries.push({
            label: '不在接着看里显示',
            icon: <X />,
            onSelect: () => hide.mutate(item.Id, { onSuccess: () => toast('不会再出现在接着看里了', 'success') }),
        })
    }

    const facts = <Facts item={item} />
    const actions = (
        <div className="flex flex-wrap items-center gap-2.5">
            {(plan || loading) && (
                <Button
                    variant="bright"
                    size="lg"
                    icon={<Play className="size-5 fill-current" />}
                    loading={loading}
                    onClick={() => play()}
                    className="max-md:flex-1"
                >
                    {plan?.label ?? '播放'}
                </Button>
            )}
            {plan?.resume && (
                <Button size="lg" icon={<RotateCcw className="size-4.5" />} onClick={() => play(true)}>
                    从头看
                </Button>
            )}
            <Button
                size="lg"
                round={mobile}
                aria-label={ud?.IsFavorite ? '取消收藏' : '收藏'}
                icon={<Heart className={cn('size-5', ud?.IsFavorite && 'fill-current')} />}
                loading={fav.isPending}
                className={cn(ud?.IsFavorite && 'text-(--accent)')}
                onClick={() =>
                    fav.mutate(
                        { id: item.Id, favorite: !ud?.IsFavorite },
                        { onSuccess: () => toast(ud?.IsFavorite ? '取消收藏了' : '收藏了', 'success') },
                    )
                }
            >
                {mobile ? null : ud?.IsFavorite ? '已收藏' : '收藏'}
            </Button>
            <DropMenu
                trigger={<Button size="lg" round aria-label="更多" icon={<MoreHorizontal className="size-5" />} />}
                entries={entries}
            />
        </div>
    )
    const overview = <Overview item={item} />
    const detail = plan?.detail && <p className="mt-3 text-[13.5px] text-(--text-2) tabular">{plan.detail}</p>

    const below = (
        <>
            {item.Type === 'Series' && <Seasons series={item} next={plan?.target} />}
            {(item.Type === 'BoxSet' || (item.IsFolder && item.Type !== 'Series')) && <Children item={item} />}
            <Cast people={item.People} />
            {similar.data && similar.data.length > 0 && (
                <Row title="差不多的" items={similar.data} keyPrefix="similar" className="mt-12" />
            )}
        </>
    )

    if (mobile) {
        return (
            <div className="pb-6">
                <div className="fixed top-[max(12px,env(safe-area-inset-top))] left-4 z-30">
                    <Button
                        variant="glass"
                        size="sm"
                        round
                        aria-label="返回"
                        icon={<ArrowLeft className="size-4" />}
                        onClick={back}
                    />
                </div>
                <Screen
                    src={backdrop}
                    light={light}
                    priority
                    position="center 25%"
                    className={cn(
                        'h-[52svh] w-full rounded-none shadow-none [mask-image:linear-gradient(black_60%,transparent)]',
                        screenName,
                    )}
                />
                <div className="relative -mt-[13svh] px-(--gutter)">
                    <TitleArt
                        item={item}
                        height={180}
                        className="max-h-[84px] max-w-[78%]"
                        textClassName="text-[36px]"
                    />
                    <div className="mt-3">{facts}</div>
                    <div className="mt-5">{actions}</div>
                    {detail}
                    <div className="mt-5">{overview}</div>
                    {source && (
                        <details className="group mt-5 rounded-panel bg-white/4 px-4 py-3">
                            <summary className="cursor-pointer list-none text-[13.5px] text-(--text-2) select-none [&::-webkit-details-marker]:hidden">
                                放映规格
                                <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
                            </summary>
                            <Specs source={source} className="mt-3" />
                        </details>
                    )}
                    {below}
                </div>
            </div>
        )
    }

    return (
        <div className="mx-auto w-full max-w-[1480px] px-(--gutter) pt-[72px]">
            <Screen
                src={backdrop}
                light={light}
                floor
                priority
                className={cn('h-[min(60vh,660px)] w-full', screenName)}
            >
                <div className="absolute inset-0 bg-[linear-gradient(0deg,rgb(0_0_0/.7),transparent_50%),linear-gradient(90deg,rgb(0_0_0/.45),transparent_45%)]" />
                <div className="absolute top-5 left-5">
                    <Button
                        variant="glass"
                        size="sm"
                        round
                        aria-label="返回"
                        icon={<ArrowLeft className="size-4" />}
                        onClick={back}
                    />
                </div>
                <div className="absolute bottom-7 left-[calc(clamp(170px,15vw,220px)+64px)] right-8">
                    <TitleArt
                        item={item}
                        height={240}
                        className="max-h-[120px] max-w-[min(480px,70%)]"
                        textClassName="text-[clamp(40px,4.4vw,64px)]"
                    />
                    <div className="mt-4">{facts}</div>
                </div>
            </Screen>
            <div className="relative grid grid-cols-[clamp(170px,15vw,220px)_minmax(0,1fr)_minmax(240px,300px)] gap-x-10 px-8">
                <div className="-mt-[clamp(150px,14vw,210px)]">
                    <div
                        className={cn('lit aspect-[2/3] overflow-hidden rounded-[12px] bg-white/6', posterName)}
                        style={light ? ({ '--pl': light.l1 } as CSSProperties) : undefined}
                    >
                        {poster && <img src={poster} alt="" fetchPriority="high" className="size-full object-cover" />}
                    </div>
                </div>
                <div className="animate-settle min-w-0 pt-7">
                    {actions}
                    {detail}
                    <div className="mt-6">{overview}</div>
                </div>
                <aside className="pt-8">{source && <Specs source={source} />}</aside>
            </div>
            <div className="px-0">{below}</div>
        </div>
    )
}

function Facts({ item }: { item: Item }) {
    const parts: ReactNode[] = []
    const y = years(item)
    if (y) parts.push(y)
    if (item.Type === 'Series') {
        if (item.ChildCount) parts.push(`${item.ChildCount} 季`)
        if (item.Status === 'Continuing') parts.push('连载中')
        else if (item.Status === 'Ended') parts.push('已完结')
    } else if (item.RunTimeTicks) {
        parts.push(duration(ticksToSeconds(item.RunTimeTicks)))
    }
    if (item.CommunityRating) parts.push(`评分 ${item.CommunityRating.toFixed(1)}`)
    return (
        <p className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[14px] text-white/80 tabular">
            {parts.map(p => (
                <span key={String(p)}>{p}</span>
            ))}
            {item.OfficialRating && (
                <span className="rounded-[5px] px-1.5 py-px text-[12px] text-white/75 shadow-[inset_0_0_0_1px_rgb(255_255_255/.35)]">
                    {item.OfficialRating}
                </span>
            )}
            {(item.Genres ?? []).slice(0, 4).map(g => (
                <span key={g} className="text-white/62">
                    {g}
                </span>
            ))}
        </p>
    )
}

function Overview({ item }: { item: Item }) {
    const [open, setOpen] = useState(false)
    // A tagline is a line; some metadata sources put a whole paragraph there.
    const tagline = item.Taglines?.[0] && [...item.Taglines[0]].length <= 40 ? item.Taglines[0] : undefined
    if (!item.Overview && !tagline) return null
    return (
        <div className="max-w-[62ch]">
            {tagline && <p className="mb-2.5 font-display text-[19px] text-(--text)">{tagline}</p>}
            {item.Overview && (
                <button
                    type="button"
                    onClick={() => setOpen(o => !o)}
                    className={cn(
                        'text-left text-[15px] leading-[1.75] text-(--text-2) text-pretty',
                        !open && 'line-clamp-4',
                    )}
                >
                    {item.Overview}
                </button>
            )}
        </div>
    )
}

/** A series' seasons as tabs and the chosen season's episodes. */
function Seasons({ series, next }: { series: Item; next: Item | undefined }) {
    const [params, setParams] = useSearchParams()
    const seasons = useSeasons(series.Id)
    const list = seasons.data ?? []
    const wanted = params.get('season')
    const highlight = params.get('episode') ?? undefined
    const fallback =
        (next?.SeasonId && list.find(s => s.Id === next.SeasonId)) ||
        list.find(s => (s.IndexNumber ?? 1) > 0) ||
        list[0]
    const season = list.find(s => s.Id === wanted) ?? fallback
    const episodes = useEpisodes(series.Id, season?.Id)
    if (seasons.isPending) return <Loading className="py-10" />
    if (list.length === 0) return null
    return (
        <section className="mt-12">
            <SectionTitle
                aside={
                    episodes.data && (
                        <span className="text-[12.5px] text-(--text-3) tabular">{episodes.data.length} 集</span>
                    )
                }
            >
                {list.length > 1 ? '分季' : (season?.Name ?? '剧集')}
            </SectionTitle>
            {list.length > 1 && season && (
                <Segmented
                    label="季"
                    value={season.Id}
                    onChange={v =>
                        setParams(
                            p => {
                                p.set('season', v)
                                p.delete('episode')
                                return p
                            },
                            { replace: true, preventScrollReset: true },
                        )
                    }
                    options={list.map(s => ({ value: s.Id, label: s.Name }))}
                    className="mb-5"
                />
            )}
            {episodes.isPending ? (
                <Loading className="py-10" />
            ) : (
                <EpisodeList episodes={episodes.data ?? []} current={next?.Id} highlight={highlight} />
            )}
        </section>
    )
}

/** A collection's films, or a folder's contents. */
function Children({ item }: { item: Item }) {
    const children = useChildren(item.Id)
    if (children.isPending) return <Loading className="py-10" />
    if (!children.data?.length) return null
    return (
        <section className="mt-12">
            <SectionTitle
                aside={<span className="text-[12.5px] text-(--text-3) tabular">{children.data.length} 部</span>}
            >
                {item.Type === 'BoxSet' ? '这个系列' : '里面有'}
            </SectionTitle>
            <PosterGrid items={children.data} keyPrefix={`children:${item.Id}`} />
        </section>
    )
}
