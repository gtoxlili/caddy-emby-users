import { Link } from 'react-router'
import { personUrl } from '../api/images'
import type { Person } from '../api/types'
import { SectionTitle } from './rail'

const CREW: Record<string, string> = { Director: '导演', Writer: '编剧', Producer: '制片' }

/** The cast as faces in a row, and the people behind the camera as one line under it. */
export function Cast({ people }: { people: Person[] | undefined }) {
    const actors = (people ?? []).filter(p => p.Type === 'Actor' || p.Type === 'GuestStar').slice(0, 24)
    const crew = (people ?? []).filter(p => CREW[p.Type])
    if (actors.length === 0 && crew.length === 0) return null
    const byRole = Object.entries(CREW)
        .map(([type, label]) => [label, crew.filter(p => p.Type === type)] as const)
        .filter(([, list]) => list.length > 0)
    return (
        <section className="mt-12">
            <SectionTitle>演职员</SectionTitle>
            {actors.length > 0 && (
                <div className="rail" style={{ '--rail-gap': '18px' } as React.CSSProperties}>
                    {actors.map(p => (
                        <Face key={`${p.Id}:${p.Role ?? ''}`} p={p} />
                    ))}
                </div>
            )}
            {byRole.length > 0 && (
                <p className="mt-5 flex flex-wrap gap-x-7 gap-y-1.5 text-[13.5px]">
                    {byRole.map(([label, list]) => (
                        <span key={label}>
                            <span className="text-(--text-3)">{label}　</span>
                            {list.map((p, i) => (
                                <span key={p.Id}>
                                    {i > 0 && '、'}
                                    <Link
                                        to={`/person/${p.Id}`}
                                        viewTransition
                                        className="text-(--text-2) hover:text-white"
                                    >
                                        {p.Name}
                                    </Link>
                                </span>
                            ))}
                        </span>
                    ))}
                </p>
            )}
        </section>
    )
}

function Face({ p }: { p: Person }) {
    const src = personUrl(p, 220)
    return (
        <Link
            to={`/person/${p.Id}`}
            viewTransition
            className="group grid w-[96px] justify-items-center gap-2 text-center outline-none"
        >
            <span className="grid size-[84px] place-items-center overflow-hidden rounded-full bg-white/7 shadow-[inset_0_0_0_1px_rgb(255_255_255/.08)] transition-transform duration-500 ease-(--ease-spring) group-hover:-translate-y-1">
                {src ? (
                    <img src={src} alt="" loading="lazy" className="size-full object-cover object-top" />
                ) : (
                    <span className="font-display text-[28px] text-(--text-3)">{[...p.Name][0]}</span>
                )}
            </span>
            <span className="w-full">
                <span className="block truncate text-[13px] text-(--text) group-hover:text-white">{p.Name}</span>
                {p.Role && <span className="block truncate text-[11.5px] text-(--text-3)">{p.Role}</span>}
            </span>
        </Link>
    )
}
