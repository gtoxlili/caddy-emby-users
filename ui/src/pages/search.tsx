import { Search as SearchIcon, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { lightSource, personUrl, stillUrl } from '../api/images'
import type { Item } from '../api/types'
import { PosterGrid } from '../components/cards'
import { SectionTitle } from '../components/rail'
import { PageBody } from '../components/shell'
import { useSearch, useTitle } from '../data'
import { episodeLabel } from '../format'
import { useRoomLight } from '../light/room'
import { Empty } from '../ui/empty'
import { Loading } from '../ui/spinner'

const RECENT_KEY = 'emby-users.recent-search'

function readRecent(): string[] {
    try {
        const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
        return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 8) : []
    } catch {
        return []
    }
}

function remember(term: string): string[] {
    const next = [term, ...readRecent().filter(t => t !== term)].slice(0, 8)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    return next
}

export default function Search() {
    const [params, setParams] = useSearchParams()
    const q = params.get('q') ?? ''
    const [draft, setDraft] = useState(q)
    const [recent, setRecent] = useState(readRecent)
    const input = useRef<HTMLInputElement>(null)
    const results = useSearch(q)
    const r = results.data
    const found = r ? r.titles.length + r.episodes.length + r.people.length : 0
    useRoomLight(lightSource(r?.titles[0]))
    useTitle(q ? `搜索「${q}」` : '搜索')

    // Searches as you type once you pause; the address bar follows, so reload and share keep it.
    useEffect(() => {
        const t = setTimeout(() => {
            if (draft.trim() !== q) setParams(draft.trim() ? { q: draft.trim() } : {}, { replace: true })
        }, 320)
        return () => clearTimeout(t)
    }, [draft, q, setParams])

    useEffect(() => {
        if (q && found > 0) setRecent(remember(q))
    }, [q, found])

    return (
        <PageBody>
            <form
                className="relative mx-auto max-w-[720px]"
                onSubmit={e => {
                    e.preventDefault()
                    setParams(draft.trim() ? { q: draft.trim() } : {})
                }}
            >
                <SearchIcon className="pointer-events-none absolute top-1/2 left-5 size-5 -translate-y-1/2 text-(--text-3)" />
                <input
                    ref={input}
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    // biome-ignore lint/a11y/noAutofocus: the page holds one field and exists to type into it
                    autoFocus
                    enterKeyHint="search"
                    placeholder="片名、演员，或记得的几个字"
                    aria-label="搜索"
                    className="glass h-14 w-full rounded-full pr-12 pl-13 text-[17px] text-(--text) outline-none transition-[--glass-fill] duration-300 placeholder:text-(--text-3) focus:[--glass-fill:rgb(255_255_255/.11)]"
                />
                {draft && (
                    <button
                        type="button"
                        aria-label="清空"
                        onClick={() => {
                            setDraft('')
                            input.current?.focus()
                        }}
                        className="absolute top-1/2 right-3 grid size-8 -translate-y-1/2 place-items-center rounded-full text-(--text-3) hover:bg-white/10 hover:text-(--text)"
                    >
                        <X className="size-4" />
                    </button>
                )}
            </form>

            <div className="mt-9">
                {!q && recent.length > 0 && (
                    <div className="mx-auto flex max-w-[720px] flex-wrap items-center gap-2">
                        <span className="mr-1 text-[13px] text-(--text-3)">最近找过</span>
                        {recent.map(t => (
                            <button
                                key={t}
                                type="button"
                                onClick={() => setDraft(t)}
                                className="h-8 rounded-full bg-white/8 px-3.5 text-[13.5px] text-(--text-2) transition-colors hover:bg-white/14 hover:text-(--text)"
                            >
                                {t}
                            </button>
                        ))}
                        <button
                            type="button"
                            onClick={() => {
                                localStorage.removeItem(RECENT_KEY)
                                setRecent([])
                            }}
                            className="h-8 px-2 text-[12.5px] text-(--text-3) hover:text-(--text-2)"
                        >
                            清除
                        </button>
                    </div>
                )}
                {q && results.isPending && <Loading />}
                {q && r && found === 0 && (
                    <Empty title={`没找到「${q}」`} hint="换个说法试试，或者只打片名里最特别的两个字。" />
                )}
                {r && r.titles.length > 0 && (
                    <section>
                        <SectionTitle aside={<Count n={r.titles.length} />}>片子</SectionTitle>
                        <PosterGrid items={r.titles} keyPrefix="search" />
                    </section>
                )}
                {r && r.people.length > 0 && (
                    <section className="mt-12">
                        <SectionTitle aside={<Count n={r.people.length} />}>演职员</SectionTitle>
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-5">
                            {r.people.map(p => (
                                <PersonCard key={p.Id} p={p} />
                            ))}
                        </div>
                    </section>
                )}
                {r && r.episodes.length > 0 && (
                    <section className="mt-12">
                        <SectionTitle aside={<Count n={r.episodes.length} />}>单集</SectionTitle>
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-5 gap-y-6">
                            {r.episodes.map(ep => (
                                <EpisodeCard key={ep.Id} ep={ep} />
                            ))}
                        </div>
                    </section>
                )}
            </div>
        </PageBody>
    )
}

function Count({ n }: { n: number }) {
    return <span className="text-[12.5px] text-(--text-3) tabular">{n} 个</span>
}

function PersonCard({ p }: { p: Item }) {
    const src = personUrl({ Id: p.Id, PrimaryImageTag: p.ImageTags?.Primary }, 240)
    return (
        <Link
            to={`/person/${p.Id}`}
            viewTransition
            className="group grid justify-items-center gap-2 text-center outline-none"
        >
            <span className="grid aspect-square w-full max-w-[110px] place-items-center overflow-hidden rounded-full bg-white/7 transition-transform duration-500 ease-(--ease-spring) group-hover:-translate-y-1">
                {src ? (
                    <img src={src} alt="" loading="lazy" className="size-full object-cover object-top" />
                ) : (
                    <span className="font-display text-[32px] text-(--text-3)">{[...p.Name][0]}</span>
                )}
            </span>
            <span className="w-full truncate text-[13.5px] text-(--text) group-hover:text-white">{p.Name}</span>
        </Link>
    )
}

function EpisodeCard({ ep }: { ep: Item }) {
    const src = stillUrl(ep, 520)
    return (
        <Link
            to={`/item/${ep.SeriesId ?? ep.Id}?episode=${ep.Id}`}
            viewTransition
            className="group grid gap-2.5 outline-none"
        >
            <span className="aspect-video overflow-hidden rounded-[11px] bg-white/6 transition-transform duration-500 ease-(--ease-spring) group-hover:-translate-y-1">
                {src && <img src={src} alt="" loading="lazy" className="size-full object-cover" />}
            </span>
            <span className="grid gap-0.5 px-0.5">
                <span className="truncate text-[14px] font-medium text-(--text) group-hover:text-white">{ep.Name}</span>
                <span className="truncate text-[12px] text-(--text-3)">
                    {ep.SeriesName}　{episodeLabel(ep)}
                </span>
            </span>
        </Link>
    )
}
