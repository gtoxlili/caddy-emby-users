import BoringAvatar from 'boring-avatars'
import { cn } from '../cn'

/** The house's lights: xenon, tungsten, exit-sign red, teal and violet gels. */
const PALETTE = ['#e3eaff', '#8ea9ff', '#f2b45a', '#d9465b', '#3aa5a0']

/** A face generated from the name; the same name always gets the same face. */
export function Avatar({ name, size = 32, className }: { name: string; size?: number; className?: string }) {
    return (
        <span
            className={cn('inline-block shrink-0 overflow-hidden rounded-full leading-none', className)}
            style={{ width: size, height: size }}
            title={name}
        >
            <BoringAvatar name={name} size={size} variant="beam" colors={PALETTE} />
        </span>
    )
}
