import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import * as emby from '../api/emby'
import { lightSource } from '../api/images'
import { deviceProfile } from '../api/profile'
import type { Item, MediaStream } from '../api/types'
import { useAuth, useUser } from '../auth'
import { EpisodeList } from '../components/episodes'
import { useEpisodes, useItem, useSeasons } from '../data'
import { secondsToTicks, ticksToSeconds } from '../format'
import { useRoomLight } from '../light/room'
import { spring } from '../motion'
import { chooseSource, isTextSubtitle } from '../player/source'
import { QUALITY_KEY, Stage } from '../player/stage'
import { Button } from '../ui/button'
import { Segmented } from '../ui/segmented'
import { Loading } from '../ui/spinner'
import { Toggle } from '../ui/switch'
import { toast } from '../ui/toast'
import { useMobile } from '../use-mobile'

const AUDIO_LANG = 'emby-users.audio-lang'
const SUB_LANG = 'emby-users.sub-lang'

/**
 * The film. The house lights go down when it starts and come back up on leaving; the screen
 * the title page showed grows into this stage.
 */
export default function Player() {
    const { id = '' } = useParams()
    const item = useItem(id, { fresh: true })
    useEffect(() => {
        const root = document.documentElement
        const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        const prev = meta?.content
        root.style.setProperty('--house', '0')
        if (meta) meta.content = '#000000'
        return () => {
            root.style.removeProperty('--house')
            if (meta && prev) meta.content = prev
        }
    }, [])
    if (!item.data) {
        return (
            <div className="fixed inset-0 grid place-items-center bg-black">
                {item.isError ? <p className="text-[15px] text-(--text-2)">找不到这一集。</p> : <Loading />}
            </div>
        )
    }
    return <Room key={id} item={item.data} />
}

function resumeAt(it: Item): number {
    const pos = ticksToSeconds(it.UserData?.PlaybackPositionTicks)
    const total = ticksToSeconds(it.RunTimeTicks)
    return pos > 1 && (!total || pos < total - 10) ? pos : 0
}

/** The stream a remembered language points to, if this file has it. */
function byLanguage(streams: MediaStream[], lang: string | null): MediaStream | undefined {
    if (!lang) return undefined
    return streams.find(s => s.Language === lang && !s.IsForced) ?? streams.find(s => s.Language === lang)
}

interface Request extends emby.PlaybackRequest {
    direct: boolean
    attempt: number
}

function Room({ item }: { item: Item }) {
    const user = useUser()
    const { refresh } = useAuth()
    const navigate = useNavigate()
    const mobile = useMobile()
    const [params] = useSearchParams()
    const seriesId = item.Type === 'Episode' ? item.SeriesId : undefined
    const all = useEpisodes(seriesId)
    useRoomLight(lightSource(item))

    // The first choice of tracks: the languages this person picked last time, else the file's own defaults.
    const [initial] = useState(() => {
        const streams = item.MediaSources?.[0]?.MediaStreams ?? []
        const audio = byLanguage(
            streams.filter(s => s.Type === 'Audio'),
            localStorage.getItem(AUDIO_LANG),
        )
        const subLang = localStorage.getItem(SUB_LANG)
        const subs = streams.filter(s => s.Type === 'Subtitle')
        const sub =
            subLang === 'off'
                ? undefined
                : (byLanguage(subs.filter(isTextSubtitle), subLang) ??
                  byLanguage(subs, subLang) ??
                  (subLang ? undefined : subs.find(s => s.IsForced || s.IsDefault)))
        return { audio: audio && !audio.IsDefault ? audio : undefined, sub }
    })
    const [req, setReq] = useState<Request>(() => {
        const burn = initial.sub && !isTextSubtitle(initial.sub) ? initial.sub.Index : undefined
        return {
            startTicks: params.get('start') === '0' ? 0 : secondsToTicks(resumeAt(item)),
            // Emby applies stream indexes only to a named media source.
            mediaSourceId:
                params.get('source') ?? (initial.audio || burn !== undefined ? item.MediaSources?.[0]?.Id : undefined),
            audioIndex: initial.audio?.Index,
            subtitleIndex: burn,
            maxBitrate: Number(localStorage.getItem(QUALITY_KEY)) || 0,
            direct: true,
            attempt: 0,
        }
    })
    const info = useQuery({
        queryKey: ['playback', user.Id, item.Id, req],
        queryFn: () => emby.playbackInfo(user.Id, item.Id, deviceProfile(req.maxBitrate ?? 0, req.direct), req),
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: 0,
        retry: 1,
    })
    const [source, sourceError] = useMemo(() => {
        if (!info.data) return [undefined, info.error] as const
        try {
            return [chooseSource(info.data, item.Id, req.subtitleIndex), null] as const
        } catch (e) {
            return [undefined, e] as const
        }
    }, [info.data, info.error, item.Id, req.subtitleIndex])

    const [subtitle, setSubtitle] = useState<number | null>(initial.sub?.Index ?? null)

    const list = all.data ?? []
    const index = list.findIndex(e => e.Id === item.Id)
    const next = index >= 0 ? list[index + 1] : undefined
    const [autoplay, setAutoplayState] = useState(user.Configuration.EnableNextEpisodeAutoPlay)
    const setAutoplay = (v: boolean) => {
        setAutoplayState(v)
        emby.setConfiguration(user.Id, { EnableNextEpisodeAutoPlay: v })
            .then(() => refresh())
            .catch(() => toast('设置没保存上', 'error'))
    }

    const restart = (patch: Partial<Request>, at: number) =>
        setReq(r => ({
            ...r,
            mediaSourceId: r.mediaSourceId ?? source?.media.Id,
            ...patch,
            startTicks: secondsToTicks(at),
            attempt: r.attempt + 1,
        }))

    const goNext = useCallback(() => {
        if (next) navigate(`/play/${next.Id}`, { replace: true })
    }, [next, navigate])
    const back = useCallback(() => {
        const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
        if (idx > 0) navigate(-1)
        else navigate(seriesId ? `/item/${seriesId}?episode=${item.Id}` : `/item/${item.Id}`, { replace: true })
    }, [navigate, seriesId, item.Id])

    useEffect(() => {
        const name = item.Type === 'Episode' ? `${item.SeriesName ?? ''} ${item.Name}` : item.Name
        const prev = document.title
        document.title = name
        return () => {
            document.title = prev
        }
    }, [item])

    const [drawer, setDrawer] = useState(false)
    const subStreams = (source?.media ?? item.MediaSources?.[0])?.MediaStreams.filter(s => s.Type === 'Subtitle') ?? []
    const audioStreams = (source?.media ?? item.MediaSources?.[0])?.MediaStreams.filter(s => s.Type === 'Audio') ?? []

    return (
        <Stage
            item={item}
            source={source}
            sourceError={info.isPending ? null : sourceError}
            start={ticksToSeconds(req.startTicks)}
            next={next}
            autoplay={autoplay}
            subtitle={subtitle}
            audio={req.audioIndex}
            quality={req.maxBitrate ?? 0}
            canFallback={req.direct}
            onSubtitle={(index, at) => {
                if (index === null) {
                    localStorage.setItem(SUB_LANG, 'off')
                    setSubtitle(null)
                    if (source && source.burnedIn !== null) restart({ subtitleIndex: -1 }, at)
                    return
                }
                const stream = subStreams.find(s => s.Index === index)
                if (stream?.Language) localStorage.setItem(SUB_LANG, stream.Language)
                setSubtitle(index)
                if (stream && !isTextSubtitle(stream)) restart({ subtitleIndex: index }, at)
                else if (source && source.burnedIn !== null) restart({ subtitleIndex: -1 }, at)
            }}
            onAudio={(index, at) => {
                const stream = audioStreams.find(s => s.Index === index)
                if (stream?.Language) localStorage.setItem(AUDIO_LANG, stream.Language)
                restart({ audioIndex: index }, at)
            }}
            onQuality={(bps, at) => {
                localStorage.setItem(QUALITY_KEY, String(bps))
                restart({ maxBitrate: bps }, at)
            }}
            onFallback={at => {
                toast('这个文件在浏览器里直接播不了，改由服务器转码')
                restart({ direct: false }, at)
            }}
            onRetry={at => restart({}, at)}
            onBack={back}
            onNext={goNext}
            onEpisodes={seriesId ? () => setDrawer(true) : null}
        >
            {seriesId && (
                <EpisodesPanel
                    open={drawer}
                    onClose={() => setDrawer(false)}
                    mobile={mobile}
                    seriesId={seriesId}
                    seasonId={item.SeasonId}
                    current={item.Id}
                    autoplay={autoplay}
                    onAutoplay={setAutoplay}
                    onPick={ep => {
                        setDrawer(false)
                        if (ep.Id !== item.Id) navigate(`/play/${ep.Id}`, { replace: true })
                    }}
                />
            )}
        </Stage>
    )
}

/** The series beside the film: seasons, episodes, and whether the next one starts by itself. */
function EpisodesPanel({
    open,
    onClose,
    mobile,
    seriesId,
    seasonId,
    current,
    autoplay,
    onAutoplay,
    onPick,
}: {
    open: boolean
    onClose: () => void
    mobile: boolean
    seriesId: string
    seasonId: string | undefined
    current: string
    autoplay: boolean
    onAutoplay: (v: boolean) => void
    onPick: (ep: Item) => void
}) {
    const series = useItem(seriesId)
    const seasons = useSeasons(open ? seriesId : undefined)
    const [season, setSeason] = useState(seasonId)
    const episodes = useEpisodes(open ? seriesId : undefined, season)
    const panel = mobile
        ? { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' } }
        : { initial: { x: '100%' }, animate: { x: 0 }, exit: { x: '100%' } }
    return (
        <AnimatePresence>
            {open && (
                <>
                    <motion.button
                        type="button"
                        aria-label="关闭选集"
                        className="absolute inset-0 z-40 bg-black/40"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                    />
                    <motion.aside
                        {...panel}
                        transition={spring.soft}
                        className={
                            mobile
                                ? 'glass-strong absolute inset-x-0 bottom-0 z-50 flex max-h-[76%] flex-col rounded-t-[24px] pb-[env(safe-area-inset-bottom)]'
                                : 'glass-strong absolute inset-y-0 right-0 z-50 flex w-[420px] flex-col rounded-none'
                        }
                    >
                        <div className="flex items-start justify-between gap-3 px-5 pt-5">
                            <div className="min-w-0">
                                <p className="truncate font-display text-[22px]">{series.data?.Name ?? '选集'}</p>
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                round
                                aria-label="关闭"
                                icon={<X className="size-4" />}
                                onClick={onClose}
                            />
                        </div>
                        {(seasons.data?.length ?? 0) > 1 && season && (
                            <div className="px-5 pt-3">
                                <Segmented
                                    label="季"
                                    size="sm"
                                    value={season}
                                    onChange={setSeason}
                                    options={(seasons.data ?? []).map(s => ({ value: s.Id, label: s.Name }))}
                                />
                            </div>
                        )}
                        <div className="mx-5 mt-3 border-y border-(--line) py-1.5">
                            <Toggle
                                checked={autoplay}
                                onCheckedChange={onAutoplay}
                                label={<span className="text-[14px]">自动播放下一集</span>}
                            />
                        </div>
                        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto px-3 py-3">
                            {episodes.isPending ? (
                                <Loading className="py-8" />
                            ) : (
                                <EpisodeList
                                    episodes={episodes.data ?? []}
                                    current={current}
                                    highlight={current}
                                    compact
                                    onPick={onPick}
                                />
                            )}
                        </div>
                    </motion.aside>
                </>
            )}
        </AnimatePresence>
    )
}
