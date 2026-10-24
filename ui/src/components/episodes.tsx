import { Check, Play } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { stillUrl } from '../api/images'
import type { Item } from '../api/types'
import { cn } from '../cn'
import { usePlayedMutation } from '../data'
import { duration, progressOf, remaining, ticksToSeconds } from '../format'
import { Progress } from './cards'
import { depart, useCardName } from './vt'

/**
 * A season's episodes, one per row: the still, its number and name, how long, what it is
 * about. Watched ones dim; the one this person would continue from carries the light.
 * Clicking a row plays it, and the still grows into the player.
 */
export function EpisodeList({
    episodes,
    current,
    highlight,
    compact,
    onPick,
}: {
    episodes: Item[]
    current?: string
    /** Scrolled into view once, e.g. an episode opened from search. */
    highlight?: string
    compact?: boolean
    onPick?: (ep: Item) => void
}) {
    return (
        <ol className={cn('grid', compact ? 'gap-1' : 'gap-2')}>
            {episodes.map(ep => (
                <EpisodeRow
                    key={ep.Id}
                    ep={ep}
                    current={ep.Id === current}
                    highlight={ep.Id === highlight}
                    compact={compact}
                    onPick={onPick}
                />
            ))}
        </ol>
    )
}

function EpisodeRow({
    ep,
    current,
    highlight,
    compact,
    onPick,
}: {
    ep: Item
    current: boolean
    highlight: boolean
    compact?: boolean
    onPick?: (ep: Item) => void
}) {
    const ref = useRef<HTMLLIElement>(null)
    const played = usePlayedMutation()
    const vt = useCardName(`ep:${ep.Id}`, 'screen', `/play/${ep.Id}`)
    const src = stillUrl(ep, compact ? 320 : 480)
    const pct = progressOf(ep)
    const watched = ep.UserData?.Played ?? false
    const runtime = ticksToSeconds(ep.RunTimeTicks)
    useEffect(() => {
        if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, [highlight])

    const body = (
        <>
            <span
                className={cn(
                    'relative shrink-0 overflow-hidden rounded-[9px] bg-white/6 shadow-[inset_0_0_0_1px_rgb(255_255_255/.06)]',
                    compact ? 'w-[132px]' : 'w-[148px] sm:w-[228px]',
                    'aspect-video',
                    vt,
                )}
            >
                {src && (
                    <img
                        src={src}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className={cn('size-full object-cover transition-opacity', watched && !current && 'opacity-55')}
                    />
                )}
                <span className="absolute inset-0 grid place-items-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    <span className="grid size-10 place-items-center rounded-full bg-white/90 text-black">
                        <Play className="ml-0.5 size-4.5 fill-current" />
                    </span>
                </span>
                {pct > 0 && <Progress pct={pct} />}
            </span>
            <span className="min-w-0 flex-1 py-0.5">
                <span className="flex items-baseline gap-2.5">
                    <span
                        className={cn(
                            'shrink-0 font-display tabular',
                            compact ? 'text-[16px]' : 'text-[19px]',
                            current ? 'text-(--accent)' : watched ? 'text-(--text-3)' : 'text-(--text-2)',
                        )}
                    >
                        {ep.IndexNumber ?? '·'}
                    </span>
                    <span
                        className={cn(
                            'truncate font-medium',
                            compact ? 'text-[13.5px]' : 'text-[15px]',
                            watched && !current ? 'text-(--text-2)' : 'text-(--text)',
                        )}
                    >
                        {ep.Name}
                    </span>
                </span>
                <span className="mt-0.5 block text-[12px] text-(--text-3) tabular">
                    {current && pct > 0
                        ? `看到一半，还剩 ${duration(remaining(ep))}`
                        : current
                          ? `接下来看这一集${runtime ? `，${duration(runtime)}` : ''}`
                          : runtime
                            ? duration(runtime)
                            : ''}
                </span>
                {!compact && ep.Overview && (
                    <span className="mt-1.5 line-clamp-2 max-w-[70ch] text-[13px] leading-relaxed text-(--text-2) max-sm:hidden">
                        {ep.Overview}
                    </span>
                )}
            </span>
        </>
    )
    const rowClass = cn(
        'group flex w-full items-start gap-3.5 rounded-[14px] p-2 text-left outline-none transition-colors sm:gap-4.5',
        current
            ? 'bg-white/8 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_40%,transparent)]'
            : 'hover:bg-white/5',
        highlight && !current && 'bg-white/6',
    )
    return (
        <li ref={ref} className="relative">
            {onPick ? (
                <button
                    type="button"
                    className={rowClass}
                    aria-current={current ? 'true' : undefined}
                    onClick={() => {
                        depart(`ep:${ep.Id}`, 'screen', ep.Id)
                        onPick(ep)
                    }}
                >
                    {body}
                </button>
            ) : (
                <Link
                    to={`/play/${ep.Id}`}
                    viewTransition
                    className={rowClass}
                    aria-current={current ? 'true' : undefined}
                    onClick={() => depart(`ep:${ep.Id}`, 'screen', ep.Id)}
                >
                    {body}
                </Link>
            )}
            {!compact && (
                <button
                    type="button"
                    aria-label={watched ? '标为没看过' : '标为看过了'}
                    title={watched ? '标为没看过' : '标为看过了'}
                    onClick={() => played.mutate({ id: ep.Id, played: !watched })}
                    className={cn(
                        'absolute top-3 right-3 grid size-7 place-items-center rounded-full transition-colors',
                        watched
                            ? 'bg-white/14 text-white'
                            : 'text-(--text-3) opacity-0 group-hover:opacity-100 hover:bg-white/10 focus-visible:opacity-100 [li:hover_&]:opacity-100',
                    )}
                >
                    <Check className="size-3.5" strokeWidth={3} />
                </button>
            )}
        </li>
    )
}
