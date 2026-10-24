// Every motion is a spring. snappy answers a control, soft moves panels and pages.

import type { Transition } from 'motion/react'

export const spring = {
    snappy: { type: 'spring', stiffness: 520, damping: 44, mass: 1 } satisfies Transition,
    soft: { type: 'spring', stiffness: 300, damping: 34, mass: 1 } satisfies Transition,
} as const
