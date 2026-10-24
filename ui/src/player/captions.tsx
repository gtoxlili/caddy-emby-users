import { useEffect, useRef } from 'react'
import { cn } from '../cn'
import type { TextTrack as SubTrack } from './source'

/** <track> elements for the WebVTT subtitles; each gets an id so its TextTrack can be found again. */
export function Tracks({ tracks }: { tracks: SubTrack[] }) {
    return tracks.map(t => (
        <track
            key={t.url}
            id={`sub-${t.index}`}
            kind="subtitles"
            src={t.url}
            label={t.label}
            srcLang={t.lang || undefined}
        />
    ))
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
            for (const t of Array.from(video.textTracks)) {
                const on = selected !== null && t.id === `sub-${selected}`
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
