// Artwork URLs. Emby serves images without a token, so these URLs carry none: they stay the
// same across sign-ins and the tag in them lets the browser cache each one for good.

import type { Chapter, Item, Person } from './types'

type Kind = 'Primary' | 'Backdrop' | 'Logo' | 'Thumb' | 'Banner'

function url(id: string, kind: Kind, tag: string, size: { maxWidth?: number; maxHeight?: number }, index?: number) {
    const q = new URLSearchParams({ tag, quality: '90' })
    if (size.maxWidth) q.set('maxWidth', String(Math.round(size.maxWidth)))
    if (size.maxHeight) q.set('maxHeight', String(Math.round(size.maxHeight)))
    return `/emby/Items/${id}/Images/${kind}${index === undefined ? '' : `/${index}`}?${q}`
}

/** The 2:3 poster. Episodes and seasons without their own borrow the series'. */
export function posterUrl(it: Item, width: number): string | null {
    if (it.Type !== 'Episode') {
        const tag = it.ImageTags?.Primary
        if (tag) return url(it.Id, 'Primary', tag, { maxWidth: width })
    }
    if (it.SeriesId && it.SeriesPrimaryImageTag) {
        return url(it.SeriesId, 'Primary', it.SeriesPrimaryImageTag, { maxWidth: width })
    }
    return null
}

/** The wide picture an item projects: its own backdrop, or its series'. */
export function backdropUrl(it: Item, width: number): string | null {
    const own = it.BackdropImageTags?.[0]
    if (own) return url(it.Id, 'Backdrop', own, { maxWidth: width }, 0)
    const parent = it.ParentBackdropImageTags?.[0]
    if (parent && it.ParentBackdropItemId)
        return url(it.ParentBackdropItemId, 'Backdrop', parent, { maxWidth: width }, 0)
    return null
}

/** A 16:9 frame for an item: an episode's still, a thumb, or failing those its backdrop. */
export function stillUrl(it: Item, width: number): string | null {
    if (it.Type === 'Episode' && it.ImageTags?.Primary) {
        return url(it.Id, 'Primary', it.ImageTags.Primary, { maxWidth: width })
    }
    if (it.ImageTags?.Thumb) return url(it.Id, 'Thumb', it.ImageTags.Thumb, { maxWidth: width })
    const back = backdropUrl(it, width)
    if (back) return back
    if (it.ParentThumbItemId && it.ParentThumbImageTag) {
        return url(it.ParentThumbItemId, 'Thumb', it.ParentThumbImageTag, { maxWidth: width })
    }
    if (it.SeriesId && it.SeriesThumbImageTag)
        return url(it.SeriesId, 'Thumb', it.SeriesThumbImageTag, { maxWidth: width })
    return null
}

/** The transparent title art (clearlogo), the title as the film itself sets it. */
export function logoUrl(it: Item, height: number): string | null {
    const own = it.ImageTags?.Logo
    if (own) return url(it.Id, 'Logo', own, { maxHeight: height })
    if (it.ParentLogoItemId && it.ParentLogoImageTag) {
        return url(it.ParentLogoItemId, 'Logo', it.ParentLogoImageTag, { maxHeight: height })
    }
    return null
}

export function personUrl(p: Pick<Person, 'Id' | 'PrimaryImageTag'>, width: number): string | null {
    return p.PrimaryImageTag ? url(p.Id, 'Primary', p.PrimaryImageTag, { maxWidth: width }) : null
}

export function chapterUrl(itemId: string, ch: Chapter, index: number, width: number): string | null {
    if (!ch.ImageTag) return null
    const q = new URLSearchParams({ tag: ch.ImageTag, maxWidth: String(width), quality: '80' })
    return `/emby/Items/${itemId}/Images/Chapter/${index}?${q}`
}

/** The image the room takes its light from: the backdrop when there is one, else the poster. */
export function lightSource(it: Item | null | undefined): string | null {
    if (!it) return null
    return backdropUrl(it, 360) ?? posterUrl(it, 240) ?? stillUrl(it, 360)
}
