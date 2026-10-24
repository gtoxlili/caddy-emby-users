// The light an image throws: a main colour, a deep one and a bright one. Each image is
// measured once.

import { Vibrant } from 'node-vibrant/browser'
import type { CSSProperties } from 'react'

export interface Light {
    /** Saturated and recognisable: the spill from the screen and the tint in the glass. */
    l1: string
    /** Deep: the bounce off the walls, the direction the room sinks into. */
    l2: string
    /** Bright: highlights, links and switches once mixed toward white. */
    l3: string
}

/** The projector with no film in it: xenon white. The sign-in page and empty rooms use it. */
export const XENON: Light = { l1: '#8ea9ff', l2: '#141b33', l3: '#e3eaff' }

const cache = new Map<string, Promise<Light>>()
const settled = new Map<string, Light>()

export function lightOf(src: string): Promise<Light> {
    let p = cache.get(src)
    if (!p) {
        p = Vibrant.from(src)
            .quality(3)
            .maxColorCount(48)
            .getPalette()
            .then(pal => {
                const main = pal.Vibrant ?? pal.LightVibrant ?? pal.Muted ?? pal.DarkVibrant ?? pal.DarkMuted
                if (!main) return XENON
                const dark = pal.DarkVibrant ?? pal.DarkMuted ?? main
                const light = pal.LightVibrant ?? pal.LightMuted ?? pal.Muted ?? main
                return { l1: main.hex, l2: dark.hex, l3: light.hex }
            })
            .catch(() => XENON)
            .then(l => {
                settled.set(src, l)
                return l
            })
        cache.set(src, p)
    }
    return p
}

/** The light if it has been measured already, without starting a measurement. */
export function lightNow(src: string | null | undefined): Light | null {
    return src ? (settled.get(src) ?? null) : null
}

/** Gives one element its own light, e.g. a now-playing tile lit by its own film. */
export function lightStyle(light: Light | null | undefined): CSSProperties {
    if (!light) return {}
    return { '--l1': light.l1, '--l2': light.l2, '--l3': light.l3, '--pl': light.l1, '--sl': light.l1 } as CSSProperties
}
