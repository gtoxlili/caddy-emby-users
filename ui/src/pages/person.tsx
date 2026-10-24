import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { lightSource, personUrl } from '../api/images'
import { cn } from '../cn'
import { PosterGrid } from '../components/cards'
import { SectionTitle } from '../components/rail'
import { PageBody } from '../components/shell'
import { useItem, useTitle, useWorks } from '../data'
import { useRoomLight } from '../light/room'
import { Button } from '../ui/button'
import { Empty } from '../ui/empty'
import { Loading } from '../ui/spinner'

/** Someone from the credits, and everything in this library they are in. */
export default function PersonPage() {
    const { id = '' } = useParams()
    const navigate = useNavigate()
    const person = useItem(id)
    const works = useWorks(id)
    const [open, setOpen] = useState(false)
    useRoomLight(lightSource(works.data?.[0]))
    useTitle(person.data?.Name)
    if (person.isPending) return <Loading className="min-h-[60svh]" />
    if (!person.data) return <Empty className="min-h-[60svh]" title="找不到这个人" />
    const p = person.data
    const src = personUrl({ Id: p.Id, PrimaryImageTag: p.ImageTags?.Primary }, 480)
    const born = p.PremiereDate ? new Date(p.PremiereDate) : null
    const facts = [
        born && !Number.isNaN(born.getTime()) ? `${born.getFullYear()} 年生` : '',
        (p as { ProductionLocations?: string[] }).ProductionLocations?.[0] ?? '',
    ].filter(Boolean)
    return (
        <PageBody>
            <Button
                variant="glass"
                size="sm"
                round
                aria-label="返回"
                icon={<ArrowLeft className="size-4" />}
                onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/', { viewTransition: true }))}
            />
            <header className="mt-6 flex flex-col gap-7 sm:flex-row sm:items-end">
                <div className="lit aspect-[3/4] w-[150px] shrink-0 overflow-hidden rounded-[14px] bg-white/6 sm:w-[200px]">
                    {src ? (
                        <img src={src} alt="" className="size-full object-cover object-top" />
                    ) : (
                        <span className="grid size-full place-items-center font-display text-[64px] text-(--text-3)">
                            {[...p.Name][0]}
                        </span>
                    )}
                </div>
                <div className="min-w-0 max-w-[62ch] pb-1">
                    <h1 className="font-display text-[40px] leading-[1.05] text-balance md:text-[52px]">{p.Name}</h1>
                    {facts.length > 0 && (
                        <p className="mt-3 flex flex-wrap gap-x-3.5 text-[14px] text-(--text-2)">
                            {facts.map(f => (
                                <span key={f}>{f}</span>
                            ))}
                        </p>
                    )}
                    {p.Overview && (
                        <button
                            type="button"
                            onClick={() => setOpen(o => !o)}
                            className={cn(
                                'mt-4 text-left text-[14.5px] leading-[1.75] text-(--text-2) text-pretty',
                                !open && 'line-clamp-4',
                            )}
                        >
                            {p.Overview}
                        </button>
                    )}
                </div>
            </header>
            <section className="mt-12">
                <SectionTitle
                    aside={
                        works.data && (
                            <span className="text-[12.5px] text-(--text-3) tabular">{works.data.length} 部</span>
                        )
                    }
                >
                    在这里能看的
                </SectionTitle>
                {works.isPending ? (
                    <Loading />
                ) : works.data?.length ? (
                    <PosterGrid items={works.data} keyPrefix={`person:${id}`} />
                ) : (
                    <p className="text-[14px] text-(--text-2)">片库里还没有这个人的片子。</p>
                )}
            </section>
        </PageBody>
    )
}
