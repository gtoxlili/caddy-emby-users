import { useEffect, useRef, useState } from 'react'
import { cn } from '../cn'
import type { EmbeddedSubtitles } from './engine'
import type { PgsTrack } from './local/pgs'
import { paint } from './local/pgs'
import { findLocalTrack } from './local-tracks'
import type { TextTrack as SubTrack } from './source'

/**
 * <track> elements for the subtitles the server sends as WebVTT, each with an id so its
 * TextTrack can be found again. A track joins once it is first chosen, so the others are
 * never fetched.
 */
export function Tracks({ tracks, selected }: { tracks: SubTrack[]; selected: number | null }) {
    return tracks.map(t => <ServerTrack key={t.url} track={t} wanted={selected === t.index} />)
}

function ServerTrack({ track: t, wanted }: { track: SubTrack; wanted: boolean }) {
    const [asked, setAsked] = useState(wanted)
    if (wanted && !asked) setAsked(true)
    if (!asked) return null
    return <track id={`sub-${t.index}`} kind="subtitles" src={t.url} label={t.label} srcLang={t.lang || undefined} />
}

/**
 * Subtitles drawn by the page rather than the browser: the same type everywhere, sized to
 * the picture, lifted above the controls when they show. In iPhone's own fullscreen player
 * the page is not visible, so there the browser draws them.
 */
export function Captions({
    video,
    selected,
    raised,
}: {
    video: HTMLVideoElement | null
    selected: number | null
    raised: boolean
}) {
    const box = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!video) return
        let current: TextTrack | null = null
        let nativeFullscreen = false
        const render = () => {
            const el = box.current
            if (!el) return
            const cues = current?.activeCues
            el.replaceChildren()
            if (!cues || nativeFullscreen) return
            for (let i = 0; i < cues.length; i++) {
                const cue = cues[i] as VTTCue
                const line = document.createElement('span')
                line.className = 'cue'
                line.append(cue.getCueAsHTML())
                el.append(line)
            }
        }
        const apply = () => {
            current?.removeEventListener('cuechange', render)
            current = null
            // The server's WebVTT when there is one, else what the page read out of the file.
            const all = Array.from(video.textTracks)
            const chosen =
                selected === null
                    ? null
                    : (all.find(t => t.id === `sub-${selected}`) ?? findLocalTrack(video, selected) ?? null)
            for (const t of all) {
                const on = t === chosen
                t.mode = on ? (nativeFullscreen ? 'showing' : 'hidden') : 'disabled'
                if (on) current = t
            }
            current?.addEventListener('cuechange', render)
            render()
        }
        const begin = () => {
            nativeFullscreen = true
            apply()
        }
        const end = () => {
            nativeFullscreen = false
            apply()
        }
        apply()
        // Tracks are added to the element as React renders them; pick the selected one up when it arrives.
        video.textTracks.addEventListener('addtrack', apply)
        video.addEventListener('webkitbeginfullscreen', begin)
        video.addEventListener('webkitendfullscreen', end)
        return () => {
            current?.removeEventListener('cuechange', render)
            video.textTracks.removeEventListener('addtrack', apply)
            video.removeEventListener('webkitbeginfullscreen', begin)
            video.removeEventListener('webkitendfullscreen', end)
        }
    }, [video, selected])
    return (
        <div
            ref={box}
            aria-live="off"
            className={cn(
                'captions pointer-events-none absolute inset-x-[6%] z-[5] flex flex-col items-center gap-[0.15em] text-center transition-[bottom] duration-300 ease-(--ease-out)',
                raised ? 'bottom-[max(140px,16cqh)]' : 'bottom-[7cqh]',
            )}
        />
    )
}

/**
 * Graphic subtitles (PGS) read out of the file, painted on a canvas laid over the picture.
 * The canvas has the subtitle's own frame size and is fitted like the video, so positions
 * the disc authored land where they were meant to; it moves up with the text captions
 * while the controls show.
 */
export function BitmapCaptions({
    video,
    subtitles,
    selected,
    raised,
}: {
    video: HTMLVideoElement | null
    subtitles: EmbeddedSubtitles | undefined
    selected: number | null
    raised: boolean
}) {
    const canvas = useRef<HTMLCanvasElement>(null)
    const [track, setTrack] = useState<PgsTrack | null>(null)
    useEffect(() => {
        if (!subtitles || selected === null) {
            setTrack(null)
            return
        }
        const find = () => setTrack(subtitles.bitmap(selected))
        find()
        return subtitles.subscribe(find)
    }, [subtitles, selected])
    useEffect(() => {
        const el = canvas.current
        if (!video || !el || !track) return
        let shown: unknown
        let frame = 0
        const draw = () => {
            const e = track.at(video.currentTime)
            if (e === shown) return
            shown = e
            paint(el, e)
        }
        const loop = () => {
            draw()
            frame = video.requestVideoFrameCallback?.(loop) ?? requestAnimationFrame(loop)
        }
        loop()
        const off = track.subscribe(() => {
            shown = undefined
            draw()
        })
        video.addEventListener('seeked', draw)
        return () => {
            off()
            video.removeEventListener('seeked', draw)
            if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frame)
            else cancelAnimationFrame(frame)
            paint(el, null)
        }
    }, [video, track])
    if (!track) return null
    return (
        <canvas
            ref={canvas}
            aria-hidden
            className={cn(
                'pointer-events-none absolute inset-0 z-[5] size-full object-contain transition-transform duration-300 ease-(--ease-out)',
                raised && '-translate-y-[calc(max(140px,16cqh)-7cqh)]',
            )}
        />
    )
}
