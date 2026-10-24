// Blu-ray graphic subtitles (PGS), decoded in the page. A display set says which bitmaps sit
// where from its start time until the next set; bitmaps stay run-length encoded until the
// moment they are drawn, so a long film costs memory in kilobytes per line.

export interface PgsImage {
    x: number
    y: number
    width: number
    height: number
    rle: Uint8Array
    /** 256 colours as RGBA, little-endian, ready for an ImageData's Uint32 view. */
    palette: Uint32Array
    crop: { x: number; y: number; width: number; height: number } | null
}

/** What the screen shows from `start`; null images clear it. */
export interface PgsEvent {
    start: number
    width: number
    height: number
    images: PgsImage[] | null
}

interface PgsObject {
    width: number
    height: number
    parts: Uint8Array[]
    rle: Uint8Array | null
}

/** Studio-range BT.709 for HD, BT.601 below; what Blu-ray authoring tools write. */
function rgba(y: number, cr: number, cb: number, a: number, hd: boolean): number {
    const yy = (y - 16) * 1.164
    const r = yy + (hd ? 1.793 : 1.596) * (cr - 128)
    const g = yy - (hd ? 0.213 : 0.392) * (cb - 128) - (hd ? 0.533 : 0.813) * (cr - 128)
    const b = yy + (hd ? 2.112 : 2.017) * (cb - 128)
    const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
    return ((a << 24) | (c(b) << 16) | (c(g) << 8) | c(r)) >>> 0
}

const u16 = (d: Uint8Array, i: number) => ((d[i] as number) << 8) | (d[i + 1] as number)

export class PgsTrack {
    /** Sorted by start. */
    private events: PgsEvent[] = []
    private objects = new Map<number, PgsObject>()
    private palettes = new Map<number, Uint32Array>()
    private listeners = new Set<() => void>()

    /** One Matroska block: a whole display set, PCS through END. */
    add(time: number, data: Uint8Array, duration: number | null) {
        let width = 0
        let height = 0
        let paletteId = 0
        let placements: { id: number; x: number; y: number; crop: PgsImage['crop'] }[] | null = null
        let i = 0
        while (i + 3 <= data.length) {
            const type = data[i] as number
            const size = u16(data, i + 1)
            const s = data.subarray(i + 3, i + 3 + size)
            i += 3 + size
            if (s.length < size) break
            if (type === 0x16 && s.length >= 11) {
                width = u16(s, 0)
                height = u16(s, 2)
                if ((s[7] as number) & 0x80) {
                    // Epoch start: earlier objects and palettes are gone.
                    this.objects.clear()
                    this.palettes.clear()
                }
                paletteId = s[9] as number
                const count = s[10] as number
                placements = []
                let o = 11
                for (let k = 0; k < count && o + 8 <= s.length; k++) {
                    const id = u16(s, o)
                    const cropped = ((s[o + 3] as number) & 0x80) !== 0
                    const p = { id, x: u16(s, o + 4), y: u16(s, o + 6), crop: null as PgsImage['crop'] }
                    o += 8
                    if (cropped && o + 8 <= s.length) {
                        p.crop = { x: u16(s, o), y: u16(s, o + 2), width: u16(s, o + 4), height: u16(s, o + 6) }
                        o += 8
                    }
                    placements.push(p)
                }
            } else if (type === 0x14 && s.length >= 2) {
                const hd = height > 576 || height === 0
                const prev = this.palettes.get(s[0] as number)
                const pal = prev ? new Uint32Array(prev) : new Uint32Array(256)
                for (let o = 2; o + 5 <= s.length; o += 5) {
                    pal[s[o] as number] = rgba(
                        s[o + 1] as number,
                        s[o + 2] as number,
                        s[o + 3] as number,
                        s[o + 4] as number,
                        hd,
                    )
                }
                this.palettes.set(s[0] as number, pal)
            } else if (type === 0x15 && s.length >= 4) {
                const id = u16(s, 0)
                const seq = s[3] as number
                if (seq & 0x80) {
                    if (s.length < 11) continue
                    this.objects.set(id, { width: u16(s, 7), height: u16(s, 9), parts: [s.slice(11)], rle: null })
                } else {
                    this.objects.get(id)?.parts.push(s.slice(4))
                }
                const obj = this.objects.get(id)
                if (obj && seq & 0x40) obj.rle = join(obj.parts)
            }
        }
        if (!placements || !width || !height) return
        const palette = this.palettes.get(paletteId)
        const images: PgsImage[] = []
        for (const p of placements) {
            const obj = this.objects.get(p.id)
            if (!obj?.rle || !palette) continue
            images.push({ x: p.x, y: p.y, width: obj.width, height: obj.height, rle: obj.rle, palette, crop: p.crop })
        }
        // A set naming objects this stream has not delivered (playback joined mid-epoch) shows nothing.
        if (placements.length && !images.length) return
        this.insert({ start: time, width, height, images: images.length ? images : null })
        if (images.length && duration) this.insert({ start: time + duration, width, height, images: null }, false)
    }

    private insert(e: PgsEvent, replace = true) {
        const list = this.events
        let lo = 0
        let hi = list.length
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if ((list[mid] as PgsEvent).start < e.start) lo = mid + 1
            else hi = mid
        }
        const same = list[lo]
        if (same && Math.abs(same.start - e.start) < 0.001) {
            // Reading the same part of the file again after a seek brings the same sets back.
            if (replace) list[lo] = e
        } else list.splice(lo, 0, e)
        for (const l of this.listeners) l()
    }

    /** What is on screen at `t`. */
    at(t: number): PgsEvent | null {
        const list = this.events
        let lo = 0
        let hi = list.length
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if ((list[mid] as PgsEvent).start <= t) lo = mid + 1
            else hi = mid
        }
        const e = list[lo - 1]
        return e?.images ? e : null
    }

    /** Lets go of what is far from `t`; it is read again if playback goes back there. */
    trim(t: number) {
        const before = t - 600
        const after = t + 1800
        const keep = this.events.filter((e, k, all) => {
            if (e.start >= before && e.start <= after) return true
            const next = all[k + 1]
            return e.start < before && next !== undefined && next.start >= before
        })
        if (keep.length !== this.events.length) this.events = keep
    }

    subscribe(fn: () => void): () => void {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }
}

function join(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0] as Uint8Array
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of parts) {
        out.set(p, o)
        o += p.length
    }
    return out
}

/** Expands a PGS object into pixels. */
function decode(img: PgsImage): ImageData {
    const out = new ImageData(img.width, img.height)
    const px = new Uint32Array(out.data.buffer)
    const d = img.rle
    const pal = img.palette
    let i = 0
    let x = 0
    let y = 0
    const put = (n: number, colour: number) => {
        const value = pal[colour] ?? 0
        const end = Math.min(x + n, img.width)
        if (y < img.height) px.fill(value, y * img.width + x, y * img.width + end)
        x = end
    }
    while (i < d.length && y < img.height) {
        const b = d[i++] as number
        if (b !== 0) {
            put(1, b)
            continue
        }
        const f = d[i++] as number
        const n = f & 0x40 ? ((f & 0x3f) << 8) | (d[i++] as number) : f & 0x3f
        const colour = f & 0x80 ? (d[i++] as number) : 0
        if (n === 0) {
            // A zero-length run ends the line.
            x = 0
            y++
        } else put(n, colour)
    }
    return out
}

const decoded = new WeakMap<PgsImage, ImageData>()

/** Paints a display set onto a canvas whose size is the set's own video size. */
export function paint(canvas: HTMLCanvasElement, e: PgsEvent | null) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    if (e && (canvas.width !== e.width || canvas.height !== e.height)) {
        canvas.width = e.width
        canvas.height = e.height
    } else ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!e?.images) return
    for (const img of e.images) {
        let data = decoded.get(img)
        if (!data) {
            data = decode(img)
            decoded.set(img, data)
        }
        const c = img.crop
        if (c) ctx.putImageData(data, img.x - c.x, img.y - c.y, c.x, c.y, c.width, c.height)
        else ctx.putImageData(data, img.x, img.y)
    }
}
