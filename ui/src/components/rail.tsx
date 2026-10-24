import { ChevronRight } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router'
import type { Item } from '../api/types'
import { cn } from '../cn'
import { PosterCard, StillCard } from './cards'

export function SectionTitle({
    children,
    to,
    aside,
    className,
}: {
    children: ReactNode
    to?: string
    aside?: ReactNode
    className?: string
}) {
    return (
        <div className={cn('mb-3.5 flex items-baseline justify-between gap-4', className)}>
            <h2 className="font-display text-[22px] leading-none text-(--text) md:text-[25px]">{children}</h2>
            {to ? (
                <Link
                    to={to}
                    viewTransition
                    className="inline-flex items-center gap-0.5 text-[13px] text-(--text-2) hover:text-(--text)"
                >
                    全部
                    <ChevronRight className="size-3.5" />
                </Link>
            ) : (
                aside
            )}
        </div>
    )
}

const SKELETON = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

/** A row of cards that scrolls sideways. Empty slots hold the space until the items arrive. */
export function Row({
    title,
    to,
    items,
    keyPrefix,
    kind = 'poster',
    width,
    priority,
    onPoint,
    className,
    aside,
}: {
    title: ReactNode
    to?: string
    items: Item[] | undefined
    keyPrefix: string
    kind?: 'poster' | 'still'
    width?: number
    priority?: boolean
    onPoint?: (it: Item) => void
    className?: string
    aside?: ReactNode
}) {
    if (items && items.length === 0) return null
    const w = width ?? (kind === 'still' ? 300 : 158)
    return (
        <section className={cn('mt-10 first:mt-0', className)}>
            <SectionTitle to={to} aside={aside}>
                {title}
            </SectionTitle>
            <div className="rail" style={{ '--rail-gap': kind === 'still' ? '16px' : '14px' } as CSSProperties}>
                {items
                    ? items.map((it, i) =>
                          kind === 'still' ? (
                              <StillCard
                                  key={it.Id}
                                  item={it}
                                  cardKey={`${keyPrefix}:${it.Id}`}
                                  width={w}
                                  onPoint={onPoint}
                              />
                          ) : (
                              <PosterCard
                                  key={it.Id}
                                  item={it}
                                  cardKey={`${keyPrefix}:${it.Id}`}
                                  width={w}
                                  priority={priority && i < 6}
                                  onPoint={onPoint}
                              />
                          ),
                      )
                    : SKELETON.map(k => (
                          <div
                              key={k}
                              className={cn(
                                  'animate-pulse rounded-poster bg-white/5',
                                  kind === 'still' ? 'aspect-video' : 'aspect-[2/3]',
                              )}
                              style={{ width: w }}
                          />
                      ))}
            </div>
        </section>
    )
}
