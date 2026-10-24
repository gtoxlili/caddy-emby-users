import { useQueryClient } from '@tanstack/react-query'
import { Check, Heart } from 'lucide-react'
import type { CSSProperties } from 'react'
import { Link } from 'react-router'
import { lightSource, posterUrl, stillUrl } from '../api/images'
import type { Item } from '../api/types'
import { useUser } from '../auth'
import { cn } from '../cn'
import { keys } from '../data'
import { episodeLabel, progressOf, remaining, shortDuration, years } from '../format'
import { usePointLight } from '../light/room'
import { itemLink, titleOf } from './links'
import { depart, useCardName } from './vt'

/** The line under a card's title: when it is from, or which episode. */
export function cardCaption(it: Item): string {
    if (it.Type === 'Episode') return episodeLabel(it)
    if (it.Type === 'Season') return it.Name
    return years(it)
}

/**
 * A poster, 2:3. Pointing at it lights the room (or, with `onPoint`, projects it on the
 * home screen); clicking it grows it into the title's page. `cardKey` is unique on the page.
 */
export function PosterCard({
    item,
    cardKey,
    width,
    className,
    priority,
    onPoint,
    caption = true,
}: {
    item: Item
    cardKey: string
    width?: number
    className?: string
    priority?: boolean
    onPoint?: (it: Item) => void
    caption?: boolean
}) {
    const { to, target } = itemLink(item)
    const src = posterUrl(item, Math.max(300, (width ?? 200) * 2))
    const light = usePointLight(onPoint ? null : lightSource(item))
    const vt = useCardName(cardKey, 'poster', `/item/${target}`)
    const seed = useSeed(item, target)
    const pct = progressOf(item)
    const point = onPoint ? () => onPoint(item) : undefined
    return (
        <Link
            to={to}
            viewTransition
            onClick={() => {
                depart(cardKey, 'poster', target)
                seed()
            }}
            aria-label={titleOf(item)}
            className={cn('group block outline-none', className)}
            style={width ? { width } : undefined}
            {...light}
            onPointerEnter={point ?? light.onPointerEnter}
            onFocus={point ?? light.onFocus}
        >
            <div
                className={cn(
                    'relative aspect-[2/3] overflow-hidden rounded-poster bg-white/6',
                    'shadow-[0_18px_40px_-22px_rgb(0_0_0/.9),inset_0_0_0_1px_rgb(255_255_255/.06)]',
                    'transition-[transform,box-shadow] duration-500 ease-(--ease-spring) group-hover:-translate-y-1 group-focus-visible:-translate-y-1',
                    'group-hover:shadow-[0_26px_50px_-24px_color-mix(in_oklab,var(--l1)_70%,transparent),inset_0_0_0_1px_rgb(255_255_255/.1)]',
                    vt,
                )}
            >
                {src ? (
                    <img
                        src={src}
                        alt=""
                        loading={priority ? 'eager' : 'lazy'}
                        decoding="async"
                        className="size-full object-cover"
                    />
                ) : (
                    <div className="grid size-full place-items-center p-3 text-center font-display text-[22px] leading-tight text-(--text-2)">
                        {titleOf(item)}
                    </div>
                )}
                <Badges item={item} />
                {pct > 0 && <Progress pct={pct} />}
            </div>
            {caption && (
                <div className="mt-2.5 grid gap-0.5 px-0.5">
                    <span className="truncate text-[14px] leading-snug font-medium text-(--text) group-hover:text-white">
                        {titleOf(item)}
                    </span>
                    <span className="truncate text-[12px] text-(--text-3) tabular">{cardCaption(item)}</span>
                </div>
            )}
        </Link>
    )
}

/**
 * A frame, 16:9: where someone left off. The still, how far in, what is left. Clicking it
 * opens the title, and the frame becomes its screen.
 */
export function StillCard({
    item,
    cardKey,
    width,
    onPoint,
    className,
}: {
    item: Item
    cardKey: string
    width?: number
    onPoint?: (it: Item) => void
    className?: string
}) {
    const { to, target } = itemLink(item)
    const src = stillUrl(item, Math.max(480, (width ?? 300) * 2))
    const light = usePointLight(onPoint ? null : lightSource(item))
    const vt = useCardName(cardKey, 'screen', `/item/${target}`)
    const seed = useSeed(item, target)
    const pct = progressOf(item)
    const left = remaining(item)
    const point = onPoint ? () => onPoint(item) : undefined
    return (
        <Link
            to={to}
            viewTransition
            onClick={() => {
                depart(cardKey, 'screen', target)
                seed()
            }}
            aria-label={titleOf(item)}
            className={cn('group block outline-none', className)}
            style={width ? { width } : undefined}
            {...light}
            onPointerEnter={point ?? light.onPointerEnter}
            onFocus={point ?? light.onFocus}
        >
            <div
                className={cn(
                    'relative aspect-video overflow-hidden rounded-[11px] bg-white/6',
                    'shadow-[0_18px_40px_-22px_rgb(0_0_0/.9),inset_0_0_0_1px_rgb(255_255_255/.06)]',
                    'transition-[transform,box-shadow] duration-500 ease-(--ease-spring) group-hover:-translate-y-1 group-focus-visible:-translate-y-1',
                    vt,
                )}
            >
                {src && <img src={src} alt="" loading="lazy" decoding="async" className="size-full object-cover" />}
                <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 to-transparent" />
                {left > 0 && (
                    <span className="absolute right-2.5 bottom-2.5 text-[12px] font-medium text-white/90 tabular">
                        还剩 {shortDuration(left)}
                    </span>
                )}
                {pct > 0 && <Progress pct={pct} />}
            </div>
            <div className="mt-2.5 grid gap-0.5 px-0.5">
                <span className="truncate text-[14px] leading-snug font-medium text-(--text) group-hover:text-white">
                    {titleOf(item)}
                </span>
                <span className="truncate text-[12px] text-(--text-3) tabular">
                    {item.Type === 'Episode' ? `${episodeLabel(item)}　${item.Name}` : years(item)}
                </span>
            </div>
        </Link>
    )
}

function Badges({ item }: { item: Item }) {
    const ud = item.UserData
    if (!ud) return null
    return (
        <span className="absolute top-2 right-2 flex gap-1">
            {ud.IsFavorite && (
                <span className="glass grid size-6 place-items-center rounded-full text-white">
                    <Heart className="size-3 fill-current" />
                </span>
            )}
            {ud.Played && (
                <span className="glass grid size-6 place-items-center rounded-full text-white" title="看过了">
                    <Check className="size-3.5" strokeWidth={3} />
                </span>
            )}
        </span>
    )
}

export function Progress({ pct, className }: { pct: number; className?: string }) {
    return (
        <div className={cn('absolute inset-x-0 bottom-0 h-[3px] bg-black/45', className)}>
            <div className="h-full bg-(--accent-vivid)" style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
    )
}

/**
 * A clicked card already knows a good deal about its title. Putting that in the cache lets
 * the title's page draw its poster and screen in the very frame the transition captures.
 */
function useSeed(item: Item, target: string) {
    const qc = useQueryClient()
    const user = useUser()
    return () => {
        if (item.Id === target) qc.setQueryData(keys.item(user.Id, target), (old?: Item) => old ?? item)
    }
}

/** As many posters as fit across. */
export function PosterGrid({
    items,
    keyPrefix,
    className,
    style,
}: {
    items: Item[]
    keyPrefix: string
    className?: string
    style?: CSSProperties
}) {
    return (
        <div
            className={cn(
                'grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-3.5 gap-y-7 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(168px,1fr))] lg:gap-x-5',
                className,
            )}
            style={style}
        >
            {items.map(it => (
                <PosterCard key={it.Id} item={it} cardKey={`${keyPrefix}:${it.Id}`} />
            ))}
        </div>
    )
}
