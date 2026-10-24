import type { Item } from '../api/types'

/** Where a card for this item leads, and which item that page is about. */
export function itemLink(it: Item): { to: string; target: string } {
    if (it.Type === 'Episode' && it.SeriesId)
        return { to: `/item/${it.SeriesId}?episode=${it.Id}`, target: it.SeriesId }
    if (it.Type === 'Season' && it.SeriesId) return { to: `/item/${it.SeriesId}?season=${it.Id}`, target: it.SeriesId }
    if (it.Type === 'Person') return { to: `/person/${it.Id}`, target: it.Id }
    if (it.Type === 'CollectionFolder' || it.Type === 'UserView') return { to: `/library/${it.Id}`, target: it.Id }
    return { to: `/item/${it.Id}`, target: it.Id }
}

/** The series a card stands for, or the item itself. */
export function titleOf(it: Item): string {
    return it.Type === 'Episode' ? (it.SeriesName ?? it.Name) : it.Name
}
