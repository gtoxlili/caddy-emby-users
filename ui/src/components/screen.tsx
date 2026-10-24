import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { logoUrl } from '../api/images'
import type { Item } from '../api/types'
import { cn } from '../cn'
import type { Light } from '../light/palette'

/**
 * The screen: a backdrop projected on the wall of the house. It glows in the light of what
 * it shows and, with `floor`, reflects on the stage floor. A new picture cuts in the way a
 * projector changes reels: a brief overexposure that settles.
 */
export function Screen({
    src,
    light,
    floor,
    className,
    style,
    position = 'center 30%',
    children,
    priority,
}: {
    src: string | null
    light?: Light | null
    floor?: boolean
    className?: string
    style?: CSSProperties
    position?: string
    children?: ReactNode
    priority?: boolean
}) {
    const lit = light ? ({ '--sl': light.l1 } as CSSProperties) : null
    const screen = (
        <div className={cn('screen', className)} style={{ ...lit, ...style }}>
            <Projection src={src} position={position} priority={priority} />
            {children}
        </div>
    )
    if (!floor) return screen
    // The floor mirrors the picture only, not the words written over it.
    return (
        <div className="relative w-full">
            {screen}
            {src && (
                <div
                    aria-hidden
                    className="screen-reflection"
                    style={{ backgroundImage: `url("${src}")`, backgroundPosition: position }}
                />
            )}
        </div>
    )
}

function Projection({ src, position, priority }: { src: string | null; position: string; priority?: boolean }) {
    // The previous picture stays underneath until the next one has loaded and faded in.
    const [reels, setReels] = useState<string[]>(src ? [src] : [])
    const [loaded, setLoaded] = useState<Record<string, boolean>>({})
    useEffect(() => {
        if (src) setReels(r => (r.at(-1) === src ? r : [...r.slice(-1), src]))
    }, [src])
    return (
        <>
            {reels.map((s, i) => (
                <img
                    key={s}
                    src={s}
                    alt=""
                    decoding="async"
                    fetchPriority={priority && i === reels.length - 1 ? 'high' : undefined}
                    onLoad={() => setLoaded(l => (l[s] ? l : { ...l, [s]: true }))}
                    className={cn(
                        'absolute inset-0 size-full object-cover transition-[opacity,filter] duration-700 ease-(--ease-out)',
                        loaded[s] ? 'opacity-100 brightness-100' : 'opacity-0 brightness-150',
                    )}
                    style={{ objectPosition: position }}
                />
            ))}
        </>
    )
}

const tones = new Map<string, boolean>()

/** Whether a logo is mostly dark ink, measured once from its opaque pixels. */
function isDark(img: HTMLImageElement): boolean {
    const hit = tones.get(img.src)
    if (hit !== undefined) return hit
    let dark = false
    try {
        const w = 48
        const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w))
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const ctx = c.getContext('2d', { willReadFrequently: true })
        if (ctx) {
            ctx.drawImage(img, 0, 0, w, h)
            const px = ctx.getImageData(0, 0, w, h).data
            let sum = 0
            let n = 0
            for (let i = 0; i < px.length; i += 4) {
                if ((px[i + 3] ?? 0) < 128) continue
                sum += 0.2126 * (px[i] ?? 0) + 0.7152 * (px[i + 1] ?? 0) + 0.0722 * (px[i + 2] ?? 0)
                n++
            }
            dark = n > 0 && sum / n < 70
        }
    } catch {
        // A tainted canvas cannot be read; keep the logo as it is.
    }
    tones.set(img.src, dark)
    return dark
}

/**
 * The title as the film sets it (its clearlogo), or set in the display face when there is
 * none. A logo printed in dark ink would vanish on the screen, so it is shown as a white
 * silhouette instead.
 */
export function TitleArt({
    item,
    className,
    textClassName,
    height = 220,
}: {
    item: Item
    className?: string
    textClassName?: string
    height?: number
}) {
    const logo = logoUrl(item, height)
    const name = item.Type === 'Episode' ? (item.SeriesName ?? item.Name) : item.Name
    const [broken, setBroken] = useState(false)
    const [tone, setTone] = useState<{ src: string; dark: boolean } | null>(null)
    const dark = tone?.src === logo && tone.dark
    if (logo && !broken) {
        return (
            <img
                src={logo}
                alt={name}
                onError={() => setBroken(true)}
                onLoad={e => setTone({ src: logo, dark: isDark(e.currentTarget) })}
                className={cn(
                    'block object-contain object-left-bottom drop-shadow-[0_4px_24px_rgb(0_0_0/.55)]',
                    dark && 'brightness-0 invert',
                    className,
                )}
            />
        )
    }
    return <h1 className={cn('font-display leading-[1.05] text-balance text-white', textClassName)}>{name}</h1>
}
