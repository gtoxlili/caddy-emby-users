// The screen and the posters move between pages in view transitions. A transition name may
// be on one element at a time or the browser skips the transition, so a name is only on an
// element taking part in this transition: the card that was clicked (remembered here as the
// intent), the page element it arrives at, and the player's stage. The intent outlives the
// navigation on purpose: going back needs it to find the card again.

import { useViewTransitionState } from 'react-router'

type Kind = 'poster' | 'screen'

interface Intent {
    card: string
    kind: Kind
    /** The item the card leads to. */
    target: string
}

let intent: Intent | null = null

export function depart(card: string, kind: Kind, target: string) {
    intent = { card, kind, target }
}

const NAME: Record<Kind, string> = { poster: 'vt-poster', screen: 'vt-screen' }

/** A card: named while a transition it started, or one returning to it, runs. */
export function useCardName(card: string, kind: Kind, path: string): string | undefined {
    const active = useViewTransitionState(path)
    return active && intent?.card === card && intent.kind === kind ? NAME[kind] : undefined
}

/** A page's poster or screen: named when a card of that kind leads to this item. */
export function useArrivalName(kind: Kind, path: string, target: string): string | undefined {
    const active = useViewTransitionState(path)
    return active && intent?.kind === kind && intent.target === target ? NAME[kind] : undefined
}

/** The player has nothing else to match, so every transition into or out of it uses the stage. */
export function useStageName(id: string): string | undefined {
    return useViewTransitionState(`/play/${id}`) ? NAME.screen : undefined
}
