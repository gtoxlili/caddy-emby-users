import type { KeyboardEvent, PointerEvent } from 'react'
import { useMemo, useRef, useState } from 'react'
import { chapterUrl } from '../api/images'
import type { Chapter } from '../api/types'
import { cn } from '../cn'
import { clock, ticksToSeconds } from '../format'

interface Segment {
    start: number
    end: number
    name?: string
    image: string | null
}

/**
 * The timeline. Chapters split it into segments with a hairline gap between them, and
 * pointing at it previews the time, the chapter's name and the chapter's still.
 */
export function SeekBar({
    itemId,
    chapters,
    currentTime,
    duration,
    buffered,
    onSeek,
    onScrub,
}: {
    itemId: string
    chapters: Chapter[] | undefined
    currentTime: number
    duration: number
    buffered: number
    onSeek: (t: number) => void
    onScrub?: (active: boolean) => void
}) {
    const track = useRef<HTMLDivElement>(null)
    const [hover, setHover] = useState<number | null>(null)
    const [drag, setDrag] = useState<number | null>(null)

    const segments = useMemo<Segment[]>(() => {
        const marks = (chapters ?? [])
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => !c.MarkerType || c.MarkerType === 'Chapter')
        if (duration <= 0 || marks.length <= 1) {
            const only = marks[0]
            return [
                {
                    start: 0,
                    end: Math.max(duration, 1),
                    name: undefined,
                    image: only ? chapterUrl(itemId, only.c, only.c.ChapterIndex ?? only.i, 320) : null,
                },
            ]
        }
        return marks.map(({ c, i }, n) => ({
            start: ticksToSeconds(c.StartPositionTicks),
            end: n + 1 < marks.length ? ticksToSeconds(marks[n + 1]?.c.StartPositionTicks) : duration,
            name: c.Name,
            image: chapterUrl(itemId, c, c.ChapterIndex ?? i, 320),
        }))
    }, [chapters, duration, itemId])

    const at = (clientX: number) => {
        const r = track.current?.getBoundingClientRect()
        if (!r || duration <= 0) return 0
        return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration))
    }
    const shown = drag ?? currentTime
    const preview = drag ?? hover
    const seg = preview === null ? null : (segments.find(s => preview >= s.start && preview < s.end) ?? segments.at(-1))
    const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0)

    const down = (e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        e.stopPropagation()
        setDrag(at(e.clientX))
        onScrub?.(true)
    }
    const move = (e: PointerEvent<HTMLDivElement>) => {
        const t = at(e.clientX)
        if (drag !== null) setDrag(t)
        else if (e.pointerType === 'mouse') setHover(t)
    }
    const up = (e: PointerEvent<HTMLDivElement>) => {
        if (drag === null) return
        e.stopPropagation()
        onSeek(at(e.clientX))
        setDrag(null)
        onScrub?.(false)
    }
    const key = (e: KeyboardEvent) => {
        const step = e.shiftKey ? 30 : 5
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onSeek(Math.min(duration, currentTime + step))
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onSeek(Math.max(0, currentTime - step))
        else if (e.key === 'Home') onSeek(0)
        else if (e.key === 'End') onSeek(Math.max(0, duration - 1))
        else return
        e.preventDefault()
        e.stopPropagation()
    }

    return (
        <div
            role="slider"
            tabIndex={0}
            aria-label="进度"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(shown)}
            aria-valuetext={`${clock(shown)} / ${clock(duration)}`}
            onKeyDown={key}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => {
                setDrag(null)
                onScrub?.(false)
            }}
            onPointerLeave={() => setHover(null)}
            className="group/seek relative flex h-8 min-w-0 flex-1 cursor-pointer touch-none items-center outline-none select-none"
        >
            <div ref={track} className="relative flex h-full w-full items-center gap-[3px]">
                {segments.map(s => {
                    const w = Math.max(0, ((s.end - s.start) / Math.max(duration, 1)) * 100)
                    const fill = Math.min(1, Math.max(0, (shown - s.start) / Math.max(0.001, s.end - s.start)))
                    const buf = Math.min(1, Math.max(0, (buffered - s.start) / Math.max(0.001, s.end - s.start)))
                    const lit = preview !== null && seg === s
                    return (
                        <span
                            key={s.start}
                            className={cn(
                                'relative h-[4px] overflow-hidden rounded-full bg-white/22 transition-[height] duration-200 group-hover/seek:h-[6px]',
                                lit && 'h-[7px]! bg-white/30',
                                drag !== null && 'h-[7px]',
                            )}
                            style={{ width: `${w}%` }}
                        >
                            <span
                                className="absolute inset-y-0 left-0 bg-white/30"
                                style={{ width: `${buf * 100}%` }}
                            />
                            <span className="absolute inset-y-0 left-0 bg-white" style={{ width: `${fill * 100}%` }} />
                        </span>
                    )
                })}
            </div>
            <span
                className={cn(
                    'pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_6px_rgb(0_0_0/.5)] transition-transform duration-200',
                    drag !== null
                        ? 'scale-110'
                        : 'scale-0 group-hover/seek:scale-100 group-focus-visible/seek:scale-100',
                )}
                style={{ left: `${pct(shown)}%` }}
            />
            {preview !== null && (
                <span
                    className="glass-strong pointer-events-none absolute bottom-[calc(100%+10px)] grid -translate-x-1/2 justify-items-center gap-1.5 overflow-hidden rounded-xl p-1.5 text-center"
                    style={{ left: `clamp(90px, ${pct(preview)}%, calc(100% - 90px))` }}
                >
                    {seg?.image && (
                        <img src={seg.image} alt="" className="h-[90px] w-[160px] rounded-lg object-cover" />
                    )}
                    <span className="max-w-[160px] px-1 pb-0.5">
                        {seg?.name && <span className="block truncate text-[12px] text-white/80">{seg.name}</span>}
                        <span className="block text-[13px] font-semibold text-white tabular">{clock(preview)}</span>
                    </span>
                </span>
            )}
        </div>
    )
}
