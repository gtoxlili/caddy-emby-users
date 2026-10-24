import { motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { Navigate, NavLink, useParams, useSearchParams } from 'react-router'
import { lightSource } from '../api/images'
import { cn } from '../cn'
import { PosterGrid } from '../components/cards'
import { PageBody } from '../components/shell'
import type { LibraryFilter, LibrarySort } from '../data'
import { useLibrary, useTitle, useViews } from '../data'
import { useRoomLight } from '../light/room'
import { spring } from '../motion'
import { Button } from '../ui/button'
import { Empty } from '../ui/empty'
import { Segmented } from '../ui/segmented'
import { Loading } from '../ui/spinner'

const SORTS: { value: LibrarySort; label: string }[] = [
    { value: 'added', label: '最近加入' },
    { value: 'name', label: '片名' },
    { value: 'year', label: '年份' },
    { value: 'rating', label: '评分' },
]
const FILTERS: { value: LibraryFilter; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'unplayed', label: '没看过' },
    { value: 'favorite', label: '收藏' },
]

/** A whole library, as a wall of posters that keeps going as you scroll. */
export default function Library() {
    const { id } = useParams()
    const views = useViews()
    const [params, setParams] = useSearchParams()
    const sort = (SORTS.find(s => s.value === params.get('sort'))?.value ?? 'added') as LibrarySort
    const filter = (FILTERS.find(f => f.value === params.get('filter'))?.value ?? 'all') as LibraryFilter
    const view = views.data?.find(v => v.Id === id)
    const lib = useLibrary(view, sort, filter)
    const sentinel = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const el = sentinel.current
        if (!el) return
        const io = new IntersectionObserver(
            entries => {
                if (entries.some(e => e.isIntersecting) && lib.hasNextPage && !lib.isFetchingNextPage)
                    void lib.fetchNextPage()
            },
            { rootMargin: '1200px 0px' },
        )
        io.observe(el)
        return () => io.disconnect()
    }, [lib.hasNextPage, lib.isFetchingNextPage, lib.fetchNextPage])

    const items = lib.data?.pages.flatMap(p => p.Items) ?? []
    const total = lib.data?.pages[0]?.TotalRecordCount ?? 0
    useRoomLight(lightSource(items[0]))
    useTitle(view?.Name ?? '片库')

    if (!id && views.data?.[0]) return <Navigate to={`/library/${views.data[0].Id}`} replace />
    if (views.isPending) return <Loading className="min-h-[60svh]" />
    if (views.data && views.data.length === 0) {
        return (
            <Empty className="min-h-[60svh]" title="还没有片库" hint="Emby 服务器上还没有能在这里看的电影或剧集库。" />
        )
    }

    const set = (key: string, value: string, fallback: string) =>
        setParams(
            p => {
                if (value === fallback) p.delete(key)
                else p.set(key, value)
                return p
            },
            { replace: true },
        )

    return (
        <PageBody>
            {(views.data?.length ?? 0) > 1 && (
                <nav
                    aria-label="片库"
                    className="glass scrollbar-none mx-auto flex w-fit max-w-full overflow-x-auto rounded-full p-1"
                >
                    {views.data?.map(v => {
                        const active = v.Id === id
                        return (
                            <NavLink
                                key={v.Id}
                                to={`/library/${v.Id}`}
                                viewTransition
                                className={cn(
                                    'relative grid h-9 shrink-0 place-items-center rounded-full px-4 text-[14px] font-medium transition-colors',
                                    active ? 'text-black' : 'text-(--text-2) hover:text-(--text)',
                                )}
                            >
                                {active && (
                                    <motion.span
                                        layoutId="library-tab"
                                        transition={spring.snappy}
                                        className="absolute inset-0 rounded-full bg-white"
                                    />
                                )}
                                <span className="relative">{v.Name}</span>
                            </NavLink>
                        )
                    })}
                </nav>
            )}
            <div className="mt-8 mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
                <div className="flex items-baseline gap-3">
                    <h1 className="font-display text-[34px] leading-none md:text-[44px]">{view?.Name ?? '片库'}</h1>
                    {total > 0 && <span className="text-[13px] text-(--text-3) tabular">{total} 部</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                    <Segmented
                        label="排序"
                        size="sm"
                        value={sort}
                        onChange={v => set('sort', v, 'added')}
                        options={SORTS}
                    />
                    <Segmented
                        label="筛选"
                        size="sm"
                        value={filter}
                        onChange={v => set('filter', v, 'all')}
                        options={FILTERS}
                    />
                </div>
            </div>
            {lib.isPending && <Loading />}
            {lib.isError && (
                <Empty
                    title="这个片库暂时打不开"
                    hint="Emby 服务器没有响应，稍后再试。"
                    action={<Button onClick={() => lib.refetch()}>重试</Button>}
                />
            )}
            {!lib.isPending && !lib.isError && items.length === 0 && (
                <Empty
                    title={
                        filter === 'favorite' ? '这里还没有收藏' : filter === 'unplayed' ? '都看过了' : '这个片库是空的'
                    }
                    hint={filter === 'favorite' ? '在片子的页面点收藏，它就会出现在这里。' : undefined}
                />
            )}
            {items.length > 0 && <PosterGrid items={items} keyPrefix={`lib:${id}`} />}
            <div ref={sentinel} className="h-px" />
            {lib.isFetchingNextPage && <Loading className="py-8" />}
        </PageBody>
    )
}
