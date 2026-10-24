// The room's light. A page sets the base light (what this screen is about); pointing at
// something sets a passing light on top. Both write --l1/--l2/--l3 on :root, where CSS
// interpolates them, so a change of light re-renders nothing.

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Light } from './palette'
import { lightOf, XENON } from './palette'

interface LightApi {
    setBase: (light: Light | null) => void
    setFocus: (light: Light | null) => void
}

const Ctx = createContext<LightApi | null>(null)

/**
 * A page that leaves gives its light back only if the next page has none of its own by
 * then; going straight from one film's light to the next must not dip through xenon.
 */
const HANDBACK = 500

export function LightProvider({ children }: { children: ReactNode }) {
    const base = useRef<Light | null>(null)
    const focus = useRef<Light | null>(null)
    const handback = useRef<ReturnType<typeof setTimeout> | null>(null)
    const apply = useCallback(() => {
        const l = focus.current ?? base.current ?? XENON
        const s = document.documentElement.style
        s.setProperty('--l1', l.l1)
        s.setProperty('--l2', l.l2)
        s.setProperty('--l3', l.l3)
    }, [])
    const api = useMemo<LightApi>(
        () => ({
            setBase(l) {
                if (handback.current) clearTimeout(handback.current)
                handback.current = null
                if (l) {
                    base.current = l
                    apply()
                    return
                }
                handback.current = setTimeout(() => {
                    base.current = null
                    apply()
                }, HANDBACK)
            },
            setFocus(l) {
                focus.current = l
                apply()
            },
        }),
        [apply],
    )
    useEffect(apply, [apply])
    return <Ctx value={api}>{children}</Ctx>
}

export function useLight(): LightApi {
    const api = useContext(Ctx)
    if (!api) throw new Error('useLight needs a LightProvider')
    return api
}

/** While this page is up, the room takes its light from src; leaving gives it back. */
export function useRoomLight(src: string | null | undefined) {
    const { setBase } = useLight()
    useEffect(() => {
        if (!src) return
        let on = true
        void lightOf(src).then(l => {
            if (on) setBase(l)
        })
        return () => {
            on = false
            setBase(null)
        }
    }, [src, setBase])
}

/** The light of one image, once measured. For elements lit by their own picture. */
export function useLightOf(src: string | null | undefined): Light | null {
    const [light, setLight] = useState<Light | null>(null)
    useEffect(() => {
        if (!src) return
        let on = true
        void lightOf(src).then(l => {
            if (on) setLight(l)
        })
        return () => {
            on = false
        }
    }, [src])
    return light
}

/** The room itself: one per page, beneath everything. */
export function House() {
    return <div className="house" aria-hidden />
}

const canHover = typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches

/** Pointing at something lights the room in its colour for as long as the pointer stays. Touch screens have no hover and keep the page's light. */
export function usePointLight(src: string | null | undefined) {
    const { setFocus } = useLight()
    const seq = useRef(0)
    const enter = useCallback(() => {
        if (!canHover || !src) return
        const id = ++seq.current
        void lightOf(src).then(l => {
            if (seq.current === id) setFocus(l)
        })
    }, [src, setFocus])
    const leave = useCallback(() => {
        if (!canHover) return
        seq.current++
        setFocus(null)
    }, [setFocus])
    return { onPointerEnter: enter, onPointerLeave: leave, onFocus: enter, onBlur: leave }
}

export { canHover }
