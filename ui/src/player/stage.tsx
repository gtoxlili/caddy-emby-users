// One title on the screen. The <video> element stays for the whole visit; a new source
// (another audio track, a subtitle burned in, a different quality) is attached to the same
// element where the old one left off. A file the page remuxes itself brings its own
// subtitles, painted here as text or, for PGS, as pictures.

import { Play, RotateCcw, X } from 'lucide-react'
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { describeError } from '../api/error'
import { backdropUrl, stillUrl } from '../api/images'
import type { Item } from '../api/types'
import { cn } from '../cn'
import { trackName } from '../components/specs'
import { useStageName } from '../components/vt'
import { episodeLabel, ticksToSeconds, years } from '../format'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import { toast } from '../ui/toast'
import { useMobile } from '../use-mobile'
import { Ambilight } from './ambilight'
import { BitmapCaptions, Captions, Tracks } from './captions'
import { Controls } from './controls'
import type { Engine, FatalKind } from './engine'
import { attach, IOS } from './engine'
import { toggleFullscreen, useMediaState } from './media'
import type { Option } from './menus'
import { usePlaybackReport } from './report'
import type { Source } from './source'
import { describeSource, embyKind, NoStream, streamsOf } from './source'

const RATE_KEY = 'emby-users.rate'
const VOLUME_KEY = 'emby-users.volume'
const AMBILIGHT_KEY = 'emby-users.ambilight'
export const QUALITY_KEY = 'emby-users.quality'

const RATES = ['0.75', '1', '1.25', '1.5', '1.75', '2']
export const QUALITIES: Option[] = [
    { value: '0', label: '原画', hint: '能直接播就不转码' },
    { value: '20000000', label: '1080p 高码率', hint: '20 Mbps' },
    { value: '10000000', label: '1080p', hint: '10 Mbps' },
    { value: '6000000', label: '720p', hint: '6 Mbps' },
    { value: '3000000', label: '480p', hint: '3 Mbps' },
    { value: '1500000', label: '360p', hint: '1.5 Mbps' },
]

const TAP_SLOP = 10
const DOUBLE_TAP = 280
const HOLD_MS = 450
const CONTROLS_STAY = 2800

/** iOS home-screen apps cannot put <video> into picture-in-picture (WebKit 303885). */
const IOS_STANDALONE = IOS && typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches

function saved(key: string, fallback: number): number {
    const n = Number(localStorage.getItem(key))
    return localStorage.getItem(key) !== null && Number.isFinite(n) ? n : fallback
}

export interface StageProps {
    item: Item
    source: Source | undefined
    sourceError: unknown
    /** Where the current source begins, in seconds. */
    start: number
    next: Item | undefined
    autoplay: boolean
    subtitle: number | null
    audio: number | undefined
    quality: number
    canFallback: boolean
    onSubtitle: (index: number | null, at: number) => void
    onAudio: (index: number, at: number) => void
    onQuality: (bps: number, at: number) => void
    onFallback: (at: number) => void
    onRetry: (at: number) => void
    onBack: () => void
    onNext: () => void
    onEpisodes: (() => void) | null
    /** Panels that must stay visible in fullscreen live inside the stage. */
    children?: ReactNode
}

export function Stage(p: StageProps) {
    const stage = useRef<HTMLDivElement>(null)
    const [video, setVideo] = useState<HTMLVideoElement | null>(null)
    const mobile = useMobile()
    const runtime = ticksToSeconds(p.item.RunTimeTicks)
    const media = useMediaState(video, runtime)
    const [error, setError] = useState<FatalKind | null>(null)
    const [engine, setEngine] = useState<Engine | null>(null)
    const [blocked, setBlocked] = useState(false)
    const [ended, setEnded] = useState(false)
    const [ambilight, setAmbilight] = useState(() => saved(AMBILIGHT_KEY, 1) === 1)
    const [boost, setBoost] = useState(false)
    const [flash, setFlash] = useState<{ side: 'left' | 'right'; n: number } | null>(null)
    const position = useRef(p.start)
    const vt = useStageName(p.item.Id)
    const report = usePlaybackReport(p.item.Id, p.source, {
        audio: p.source?.audio ?? p.audio,
        subtitle: p.subtitle ?? -1,
    })
    const at = () => video?.currentTime || position.current

    // ---- the picture leaves the page, the sound stays ----
    // iOS 17's Audio Session API marks this page's sound as media playback, so locking the
    // phone or switching apps does not cut it; home-screen apps cannot use picture-in-picture.
    useEffect(() => {
        // Installed Chrome on Android reads this to float the film when the app is left. React has no prop for it.
        if (video && !IOS_STANDALONE) video.setAttribute('autopictureinpicture', '')
    }, [video])
    useEffect(() => {
        const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
        if (!session) return
        try {
            session.type = 'playback'
        } catch {
            // Not a value this version knows.
        }
    }, [])

    // ---- attach the source ----
    // The start time belongs to the source it came with; a later change alone must not reload.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
    useEffect(() => {
        if (!video || !p.source) return
        setError(null)
        setEnded(false)
        let engine: Engine | null = null
        let gone = false
        video.volume = Math.min(1, Math.max(0, saved(VOLUME_KEY, 1)))
        void attach(video, p.source, p.start, kind => setError(kind)).then(e => {
            if (gone) {
                e.destroy()
                return
            }
            engine = e
            setEngine(e)
            const rate = saved(RATE_KEY, 1)
            video.defaultPlaybackRate = rate
            video.playbackRate = rate
            video.play().then(
                () => setBlocked(false),
                () => setBlocked(true),
            )
        })
        report.switched()
        return () => {
            gone = true
            engine?.destroy()
            setEngine(null)
        }
    }, [video, p.source])

    useEffect(() => {
        if (p.source?.warning) toast(p.source.warning)
    }, [p.source])

    // ---- element events: reports, ending, errors ----
    useEffect(() => {
        if (!video) return
        const onPlaying = () => {
            setEnded(false)
            setBlocked(false)
            report.playing()
        }
        const onPause = () => {
            if (!video.ended) report.paused()
        }
        const onTime = () => {
            position.current = video.currentTime
            report.time(video.currentTime)
        }
        const onEnded = () => {
            report.ended(video.duration || runtime)
            if (p.autoplay && p.next) p.onNext()
            else setEnded(true)
        }
        const onError = () => {
            const code = video.error?.code
            if (!code || !video.getAttribute('src')) return
            setError(code === 2 ? 'network' : code === 4 ? 'unsupported' : 'decode')
        }
        const onVolume = () => localStorage.setItem(VOLUME_KEY, String(video.muted ? 0 : video.volume))
        video.addEventListener('playing', onPlaying)
        video.addEventListener('pause', onPause)
        video.addEventListener('timeupdate', onTime)
        video.addEventListener('ended', onEnded)
        video.addEventListener('error', onError)
        video.addEventListener('volumechange', onVolume)
        return () => {
            video.removeEventListener('playing', onPlaying)
            video.removeEventListener('pause', onPause)
            video.removeEventListener('timeupdate', onTime)
            video.removeEventListener('ended', onEnded)
            video.removeEventListener('error', onError)
            video.removeEventListener('volumechange', onVolume)
        }
    }, [video, report, runtime, p.autoplay, p.next, p.onNext])

    // A file the browser claimed it could play but cannot: once, quietly, ask for a transcode.
    // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to a new error only
    useEffect(() => {
        if (error && error !== 'network' && p.source?.method === 'DirectPlay' && p.canFallback) {
            p.onFallback(at())
        }
    }, [error])

    // ---- controls coming and going ----
    const [visible, setVisible] = useState(true)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const hold = useRef({ hover: false, menu: false, scrub: false })
    const schedule = useCallback(() => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
            const h = hold.current
            if (video && !video.paused && !h.hover && !h.menu && !h.scrub) setVisible(false)
        }, CONTROLS_STAY)
    }, [video])
    const poke = useCallback(() => {
        setVisible(true)
        schedule()
    }, [schedule])
    useEffect(() => {
        if (media.paused) {
            setVisible(true)
            if (timer.current) clearTimeout(timer.current)
        } else schedule()
    }, [media.paused, schedule])
    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current)
        },
        [],
    )

    // ---- actions ----
    const togglePlay = useCallback(() => {
        if (!video) return
        if (video.paused || video.ended) video.play().catch(() => setBlocked(true))
        else video.pause()
    }, [video])
    const seek = useCallback(
        (t: number) => {
            if (!video) return
            const d = Number.isFinite(video.duration) ? video.duration : runtime
            video.currentTime = Math.max(0, Math.min(d - 0.5, t))
            setEnded(false)
        },
        [video, runtime],
    )
    const skip = useCallback(
        (delta: number) => {
            if (!video) return
            seek(video.currentTime + delta)
            const side = delta < 0 ? 'left' : 'right'
            setFlash(f => ({ side, n: f && f.side === side ? f.n + Math.abs(delta) : Math.abs(delta) }))
            setTimeout(() => setFlash(null), 700)
        },
        [video, seek],
    )
    const fullscreen = useCallback(() => toggleFullscreen(stage.current, video), [video])
    const pip = useCallback(() => {
        if (!video) return
        if (document.pictureInPictureElement) void document.exitPictureInPicture()
        else video.requestPictureInPicture?.().catch(() => {})
    }, [video])

    // ---- keyboard ----
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null
            if (t?.closest('input, textarea, [role=menu], [role=dialog], [role=slider]') || e.metaKey || e.ctrlKey)
                return
            let handled = true
            switch (e.key) {
                case ' ':
                case 'k':
                    togglePlay()
                    break
                case 'ArrowLeft':
                case 'j':
                    skip(-10)
                    break
                case 'ArrowRight':
                case 'l':
                    skip(10)
                    break
                case 'ArrowUp':
                    if (video) video.volume = Math.min(1, video.volume + 0.05)
                    break
                case 'ArrowDown':
                    if (video) video.volume = Math.max(0, video.volume - 0.05)
                    break
                case 'f':
                    fullscreen()
                    break
                case 'm':
                    if (video) video.muted = !video.muted
                    break
                case 'c':
                    p.onSubtitle(
                        p.subtitle === null
                            ? (p.source?.tracks[0]?.index ?? p.source?.embedded[0]?.Index ?? null)
                            : null,
                        at(),
                    )
                    break
                case 'N':
                case 'n':
                    if (p.next) p.onNext()
                    break
                case 'Escape':
                    if (!document.fullscreenElement) p.onBack()
                    break
                default:
                    if (/^[0-9]$/.test(e.key) && video) seek((Number(e.key) / 10) * (video.duration || runtime))
                    else handled = false
            }
            if (handled) {
                e.preventDefault()
                poke()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    })

    // ---- lock screen, headphones and car: Media Session ----
    const title = p.item.Type === 'Episode' ? (p.item.SeriesName ?? '') : p.item.Name
    const subtitle =
        p.item.Type === 'Episode'
            ? `${episodeLabel(p.item)}「${p.item.Name}」`
            : [years(p.item), p.item.OriginalTitle !== p.item.Name ? p.item.OriginalTitle : '']
                  .filter(Boolean)
                  .join('　')
    const art = stillUrl(p.item, 1280) ?? backdropUrl(p.item, 1280)
    useEffect(() => {
        const session = navigator.mediaSession
        if (!session || typeof MediaMetadata === 'undefined') return
        session.metadata = new MediaMetadata({
            title: p.item.Type === 'Episode' ? `${episodeLabel(p.item)} ${p.item.Name}` : p.item.Name,
            artist: title,
            artwork: art ? [{ src: new URL(art, location.origin).href, sizes: '1280x720', type: 'image/jpeg' }] : [],
        })
        const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
            try {
                session.setActionHandler(action, handler)
            } catch {
                // This browser does not know the action.
            }
        }
        set('play', () => video?.play())
        set('pause', () => video?.pause())
        set('seekbackward', () => skip(-10))
        set('seekforward', () => skip(10))
        set('seekto', d => d.seekTime !== undefined && seek(d.seekTime))
        set('nexttrack', p.next ? () => p.onNext() : null)
        // Chrome calls this when the tab is left mid-film, with the user activation picture-in-picture needs.
        const pip = 'enterpictureinpicture' as MediaSessionAction
        if (!IOS_STANDALONE) set(pip, () => void video?.requestPictureInPicture?.().catch(() => {}))
        return () => {
            for (const a of [
                'play',
                'pause',
                'seekbackward',
                'seekforward',
                'seekto',
                'nexttrack',
                pip,
            ] as MediaSessionAction[])
                set(a, null)
        }
    }, [p.item, p.next, p.onNext, title, art, video, skip, seek])

    // ---- gestures: tap, double tap, hold for 2× ----
    const down = useRef<{ x: number; y: number; t: number } | null>(null)
    const lastTap = useRef<number>(0)
    const single = useRef<ReturnType<typeof setTimeout> | null>(null)
    const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const held = useRef<number | null>(null)
    const releaseHold = () => {
        if (holdTimer.current) clearTimeout(holdTimer.current)
        holdTimer.current = null
        if (held.current === null || !video) return false
        video.playbackRate = held.current
        held.current = null
        setBoost(false)
        return true
    }
    const onDown = (e: ReactPointerEvent) => {
        down.current = { x: e.clientX, y: e.clientY, t: Date.now() }
        if (video && !video.paused) {
            holdTimer.current = setTimeout(() => {
                holdTimer.current = null
                held.current = video.playbackRate
                video.playbackRate = 2
                setBoost(true)
            }, HOLD_MS)
        }
    }
    const onMove = (e: ReactPointerEvent) => {
        if (e.pointerType === 'mouse') poke()
        const d = down.current
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP && holdTimer.current) {
            clearTimeout(holdTimer.current)
            holdTimer.current = null
        }
    }
    const onUp = (e: ReactPointerEvent) => {
        const d = down.current
        down.current = null
        if (releaseHold()) return
        if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP || Date.now() - d.t > 600) return
        const now = Date.now()
        const double = now - lastTap.current < DOUBLE_TAP
        lastTap.current = double ? 0 : now
        const rect = e.currentTarget.getBoundingClientRect()
        const ratio = (e.clientX - rect.left) / rect.width
        if (e.pointerType !== 'mouse') {
            if (double) {
                if (single.current) clearTimeout(single.current)
                single.current = null
                if (ratio < 0.33) skip(-10)
                else if (ratio > 0.67) skip(10)
                else togglePlay()
                return
            }
            single.current = setTimeout(() => {
                single.current = null
                if (visible) setVisible(false)
                else poke()
            }, DOUBLE_TAP)
            return
        }
        if (double) {
            if (single.current) clearTimeout(single.current)
            single.current = null
            fullscreen()
            return
        }
        single.current = setTimeout(() => {
            single.current = null
            togglePlay()
        }, DOUBLE_TAP)
    }

    // ---- intro and credits ----
    const markers = useMemo(() => {
        const ch = p.item.Chapters ?? []
        const find = (type: string) => {
            const c = ch.find(x => x.MarkerType === type)
            return c ? ticksToSeconds(c.StartPositionTicks) : null
        }
        return { introStart: find('IntroStart'), introEnd: find('IntroEnd'), credits: find('CreditsStart') }
    }, [p.item.Chapters])
    const inIntro =
        markers.introStart !== null &&
        markers.introEnd !== null &&
        media.currentTime >= markers.introStart &&
        media.currentTime < markers.introEnd - 1
    const creditsAt =
        markers.credits ??
        (media.duration > 0 ? media.duration - (media.duration > 600 ? 30 : 12) : Number.POSITIVE_INFINITY)
    const [dismissed, setDismissed] = useState(false)
    const upNext = !!p.next && !dismissed && !ended && media.started && media.currentTime >= creditsAt

    // ---- menus ----
    const audios = streamsOf(p.source?.media ?? p.item.MediaSources?.[0], 'Audio')
    const subs = streamsOf(p.source?.media ?? p.item.MediaSources?.[0], 'Subtitle')
    const local = p.source?.delivery === 'local'
    const chosenSub = subs.find(s => s.Index === p.subtitle)
    // Read out of the file when the page remuxes it, else the server's WebVTT.
    const embedded = local && chosenSub && !chosenSub.IsExternal ? embyKind(chosenSub) : null
    const textTrack =
        p.subtitle !== null && (embedded === 'text' || p.source?.tracks.some(t => t.index === p.subtitle))
            ? p.subtitle
            : null
    const bitmapTrack = embedded === 'bitmap' ? p.subtitle : null
    const subtitleHint = (s: (typeof subs)[number]) => {
        if (local) return s.IsExternal || embyKind(s) ? undefined : '网页里显示不了这种字幕'
        if (s.IsTextSubtitleStream !== false) return undefined
        return p.source?.media.SupportsTranscoding === false ? '服务器不转码，显示不了' : '图形字幕，要转码烧进画面'
    }
    const info = p.source ? describeSource(p.source) : []
    const canTranscode = p.source?.media.SupportsTranscoding !== false

    const nextLabel = p.next ? `${episodeLabel(p.next)}「${p.next.Name}」` : ''
    const loadingSource = !p.source && !p.sourceError
    const fatal = p.sourceError
        ? p.sourceError instanceof NoStream
            ? p.sourceError.code === 'NotAllowed'
                ? '这个账号在 Emby 服务器上没有播放权限。'
                : `${p.sourceError.detail ?? 'Emby 服务器找不到能在这里播放的方式。'}可以用 Emby App 看。`
            : describeError(p.sourceError)
        : error && !(error !== 'network' && p.source?.method === 'DirectPlay' && p.canFallback)
          ? error === 'network'
              ? '连接断了，视频没能继续加载。'
              : canTranscode
                ? '这个浏览器解不了这段视频，服务器转码也没能播出来。换个画质试试，或者在 Emby App 里看。'
                : '这个浏览器解不了这段视频，服务器也不转码。可以用 Emby App 看。'
          : null

    return (
        <div
            ref={stage}
            className={cn(
                'stage fixed inset-0 overflow-hidden bg-black text-(--text) [container-type:size]',
                !visible && !media.paused && 'cursor-none',
                vt,
            )}
            onPointerMove={e => e.pointerType === 'mouse' && poke()}
        >
            <Ambilight video={video} on={ambilight && !mobile} />
            {art && (
                <img
                    src={backdropUrl(p.item, 1920) ?? art}
                    alt=""
                    className={cn(
                        'pointer-events-none absolute inset-0 size-full object-cover transition-opacity duration-700',
                        media.started ? 'opacity-0' : 'opacity-100',
                    )}
                />
            )}
            <video
                ref={setVideo}
                playsInline
                preload="auto"
                x-webkit-airplay="allow"
                className={cn(
                    'absolute inset-0 size-full object-contain transition-opacity duration-500',
                    media.started ? 'opacity-100' : 'opacity-0',
                )}
            >
                {p.source && <Tracks tracks={p.source.tracks} selected={textTrack} />}
            </video>

            <Captions video={video} selected={textTrack} raised={visible || media.paused} />
            <BitmapCaptions
                video={video}
                subtitles={engine?.subtitles}
                selected={bitmapTrack}
                raised={visible || media.paused}
            />

            {/* gestures sit above the picture and below the controls */}
            <div
                className="absolute inset-0 z-[2]"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={() => {
                    down.current = null
                    releaseHold()
                }}
                onPointerLeave={() => {
                    down.current = null
                    releaseHold()
                }}
            />

            {(loadingSource || (!media.started && !blocked && !fatal)) && (
                <div className="pointer-events-none absolute inset-0 z-[7] grid place-items-center">
                    <Spinner className="size-10 text-white/85" />
                </div>
            )}
            {blocked && media.paused && !fatal && (
                <div className="absolute inset-0 z-[7] grid place-items-center">
                    <button
                        type="button"
                        aria-label="播放"
                        onClick={togglePlay}
                        className="glass grid size-[88px] place-items-center rounded-full text-white transition-transform duration-300 ease-(--ease-spring) hover:scale-105 active:scale-95"
                    >
                        <Play className="ml-1 size-9 fill-current" />
                    </button>
                </div>
            )}

            {boost && (
                <div className="pointer-events-none absolute inset-x-0 top-[max(72px,calc(env(safe-area-inset-top)+60px))] z-[8] flex justify-center">
                    <span className="glass rounded-full px-3.5 py-1.5 text-[13.5px] font-semibold text-white tabular">
                        2× 快进中
                    </span>
                </div>
            )}
            {flash && (
                <div
                    className={cn(
                        'pointer-events-none absolute top-1/2 z-[8] -translate-y-1/2',
                        flash.side === 'left' ? 'left-[14%]' : 'right-[14%]',
                    )}
                >
                    <span className="glass rounded-full px-4 py-2 text-[14px] font-semibold text-white tabular">
                        {flash.side === 'left' ? '−' : '+'}
                        {flash.n} 秒
                    </span>
                </div>
            )}

            <Controls
                stage={stage}
                visible={(visible || media.paused) && !fatal}
                mobile={mobile}
                title={title}
                subtitle={subtitle}
                // MSE in Safari plays only with AirPlay off.
                media={local ? { ...media, airplay: false } : media}
                itemId={p.item.Id}
                chapters={p.item.Chapters}
                hasNext={!!p.next}
                hasEpisodes={!!p.onEpisodes}
                canPip={typeof document !== 'undefined' && document.pictureInPictureEnabled && !IOS_STANDALONE}
                audio={{
                    value: String(
                        p.source?.audio ?? p.audio ?? p.source?.media.DefaultAudioStreamIndex ?? audios[0]?.Index ?? '',
                    ),
                    options: audios.map(s => ({ value: String(s.Index), label: trackName(s) })),
                    onChange: v => p.onAudio(Number(v), at()),
                }}
                subtitles={{
                    value: p.subtitle === null ? 'off' : String(p.subtitle),
                    options: [
                        { value: 'off', label: '关闭' },
                        ...subs.map(s => ({
                            value: String(s.Index),
                            label: trackName(s),
                            hint: subtitleHint(s),
                        })),
                    ],
                    onChange: v => p.onSubtitle(v === 'off' ? null : Number(v), at()),
                }}
                quality={
                    // A server that never transcodes has only the original to offer.
                    canTranscode
                        ? { value: String(p.quality), options: QUALITIES, onChange: v => p.onQuality(Number(v), at()) }
                        : null
                }
                rate={{
                    value: String(media.rate),
                    options: RATES.map(r => ({ value: r, label: r === '1' ? '正常' : `${r}×` })),
                    onChange: v => {
                        if (!video) return
                        video.playbackRate = Number(v)
                        video.defaultPlaybackRate = Number(v)
                        localStorage.setItem(RATE_KEY, v)
                    },
                }}
                ambilight={
                    mobile
                        ? null
                        : {
                              on: ambilight,
                              onChange: v => {
                                  setAmbilight(v)
                                  localStorage.setItem(AMBILIGHT_KEY, v ? '1' : '0')
                              },
                          }
                }
                info={info}
                onBack={p.onBack}
                onPlay={togglePlay}
                onSeek={seek}
                onSkip={skip}
                onNext={p.onNext}
                onEpisodes={() => p.onEpisodes?.()}
                onVolume={v => {
                    if (!video) return
                    video.volume = v
                    video.muted = v === 0
                }}
                onMute={() => {
                    if (video) video.muted = !video.muted
                }}
                onFullscreen={fullscreen}
                onPip={pip}
                onAirplay={() =>
                    (
                        video as HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void }
                    )?.webkitShowPlaybackTargetPicker?.()
                }
                onMenu={open => {
                    hold.current.menu = open
                    if (open) setVisible(true)
                    else schedule()
                }}
                onScrub={active => {
                    hold.current.scrub = active
                    if (!active) schedule()
                }}
                onHoverControls={inside => {
                    hold.current.hover = inside
                    if (!inside) schedule()
                }}
            />

            {inIntro && (
                <div
                    className={cn(
                        'absolute right-[max(20px,4cqw)] z-30 transition-[bottom] duration-300',
                        visible ? 'bottom-[150px]' : 'bottom-[48px]',
                    )}
                >
                    <Button
                        variant="glass"
                        size="lg"
                        onClick={() => markers.introEnd !== null && seek(markers.introEnd)}
                    >
                        跳过片头
                    </Button>
                </div>
            )}

            {upNext && p.next && (
                <UpNext
                    next={p.next}
                    label={nextLabel}
                    autoplay={p.autoplay}
                    raised={visible}
                    onGo={p.onNext}
                    onDismiss={() => setDismissed(true)}
                />
            )}

            {ended && !fatal && (
                <div className="absolute inset-0 z-30 grid place-items-center bg-black/55 p-6 text-center backdrop-blur-sm">
                    <div className="glass-strong grid max-w-[30em] gap-5 rounded-panel px-8 py-7">
                        <div>
                            <p className="text-[13px] text-(--text-2)">{p.next ? '看完了，接下来是' : '看完了'}</p>
                            <p className="mt-1.5 font-display text-[26px] text-balance">{p.next ? nextLabel : title}</p>
                        </div>
                        <div className="flex flex-wrap justify-center gap-2">
                            <Button
                                variant="ghost"
                                icon={<RotateCcw className="size-4" />}
                                onClick={() => {
                                    setEnded(false)
                                    seek(0)
                                    video?.play().catch(() => {})
                                }}
                            >
                                重看
                            </Button>
                            {p.next ? (
                                <Button
                                    variant="bright"
                                    icon={<Play className="size-4 fill-current" />}
                                    onClick={p.onNext}
                                >
                                    看下一集
                                </Button>
                            ) : (
                                <Button variant="bright" onClick={p.onBack}>
                                    回到片子
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {p.children}

            {fatal && (
                <div className="absolute inset-0 z-40 grid place-items-center bg-black/70 p-6 text-center backdrop-blur-sm">
                    <div className="grid max-w-[30em] gap-4">
                        <p className="text-[19px] font-semibold">播不出来</p>
                        <p className="text-[14px] text-(--text-2) text-pretty">{fatal}</p>
                        <div className="flex justify-center gap-2">
                            <Button variant="ghost" onClick={p.onBack}>
                                返回
                            </Button>
                            <Button
                                variant="bright"
                                icon={<RotateCcw className="size-4" />}
                                onClick={() => {
                                    setError(null)
                                    p.onRetry(at())
                                }}
                            >
                                重试
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

/** The next episode, waiting in the corner as the credits roll; with autoplay on it counts down. */
function UpNext({
    next,
    label,
    autoplay,
    raised,
    onGo,
    onDismiss,
}: {
    next: Item
    label: string
    autoplay: boolean
    raised: boolean
    onGo: () => void
    onDismiss: () => void
}) {
    const COUNT = 10
    const [left, setLeft] = useState(COUNT)
    useEffect(() => {
        if (!autoplay) return
        const t = setInterval(() => setLeft(n => n - 1), 1000)
        return () => clearInterval(t)
    }, [autoplay])
    useEffect(() => {
        if (autoplay && left <= 0) onGo()
    }, [autoplay, left, onGo])
    const src = stillUrl(next, 480)
    return (
        <div
            className={cn(
                'glass-strong animate-settle absolute right-[max(16px,3cqw)] z-30 flex w-[min(92vw,380px)] gap-3.5 rounded-[20px] p-3 transition-[bottom] duration-300',
                raised ? 'bottom-[150px]' : 'bottom-[40px]',
            )}
        >
            <button
                type="button"
                onClick={onGo}
                className="relative aspect-video w-[136px] shrink-0 overflow-hidden rounded-xl bg-white/8"
            >
                {src && <img src={src} alt="" className="size-full object-cover" />}
                {autoplay && (
                    <svg viewBox="0 0 36 36" className="absolute inset-0 m-auto size-11" aria-hidden>
                        <circle
                            cx="18"
                            cy="18"
                            r="16"
                            fill="rgb(0 0 0 / .45)"
                            stroke="rgb(255 255 255 / .25)"
                            strokeWidth="2.5"
                        />
                        <circle
                            cx="18"
                            cy="18"
                            r="16"
                            fill="none"
                            stroke="white"
                            strokeWidth="2.5"
                            strokeDasharray={100.5}
                            strokeDashoffset={100.5 * (left / COUNT)}
                            transform="rotate(-90 18 18)"
                            style={{ transition: 'stroke-dashoffset 1s linear' }}
                        />
                        <text x="18" y="22.5" textAnchor="middle" fontSize="12" fill="white" fontWeight="600">
                            {Math.max(0, left)}
                        </text>
                    </svg>
                )}
            </button>
            <div className="min-w-0 flex-1 py-0.5">
                <p className="text-[12px] text-(--text-3)">
                    {autoplay ? `${Math.max(0, left)} 秒后播放下一集` : '下一集'}
                </p>
                <p className="mt-0.5 line-clamp-2 text-[14px] leading-snug font-medium">{label}</p>
                <div className="mt-2.5 flex gap-1.5">
                    <Button variant="bright" size="sm" icon={<Play className="size-3.5 fill-current" />} onClick={onGo}>
                        现在看
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        round
                        aria-label="不看了"
                        icon={<X className="size-4" />}
                        onClick={onDismiss}
                    />
                </div>
            </div>
        </div>
    )
}
