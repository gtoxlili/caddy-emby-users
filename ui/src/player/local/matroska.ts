// Reads the subtitle tracks of a Matroska file out of the bytes the demuxer fetches anyway.
// It never asks for data itself: each response the player reads is also run through one of
// these, which walks the EBML structure, skips video and audio blocks without keeping them,
// and hands on the few blocks that belong to a subtitle track.

const EBML = 0x1a45dfa3
const SEGMENT = 0x18538067
const INFO = 0x1549a966
const TRACKS = 0x1654ae6b
const CLUSTER = 0x1f43b675
const TIMESTAMP = 0xe7
const SIMPLE_BLOCK = 0xa3
const BLOCK_GROUP = 0xa0
const BLOCK = 0xa1
const BLOCK_DURATION = 0x9b

/** Elements that only live directly in a Segment; one of them ends a Cluster of unknown size. */
const SEGMENT_LEVEL = new Set([CLUSTER, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469, 0x114d9b74, INFO, TRACKS])
/** What may open a Cluster, to tell a real one from four bytes that happen to spell its ID. */
const CLUSTER_OPENERS = new Set([TIMESTAMP, 0xbf, 0xa7, 0xab])

/** Larger than any subtitle block or header element a sane file carries. */
const MAX_KEEP = 4 * 1024 * 1024

export interface SubtitleTrackInfo {
    number: number
    codec: string
    language: string
    name: string
    forced: boolean
    privateData: Uint8Array | null
    /** ContentCompAlgo: 0 zlib, 3 header stripping. */
    compression: { algo: number; settings: Uint8Array | null } | null
}

export interface SubtitleBlock {
    track: number
    /** Seconds on the file's own timeline, the one the player's clock runs on. */
    time: number
    duration: number | null
    data: Uint8Array
}

export interface MatroskaHeader {
    timestampScale: number
    subtitles: SubtitleTrackInfo[]
}

// ---- EBML primitives ----

/** An element ID keeps its length marker; returns null when the bytes are not there yet. */
function readId(d: Uint8Array, i: number): { id: number; len: number } | null {
    if (i >= d.length) return null
    const first = d[i] as number
    const len = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0
    if (len === 0) return { id: -1, len: 1 }
    if (i + len > d.length) return null
    let id = 0
    for (let k = 0; k < len; k++) id = id * 256 + (d[i + k] as number)
    return { id, len }
}

/** A size drops its marker. `value` is Infinity for the reserved "unknown size". */
function readSize(d: Uint8Array, i: number): { value: number; len: number } | null {
    if (i >= d.length) return null
    const first = d[i] as number
    let len = 1
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
    if (len > 8) return { value: -1, len: 1 }
    if (i + len > d.length) return null
    let value = first & (0xff >> len)
    let allOnes = value === 0xff >> len
    for (let k = 1; k < len; k++) {
        const b = d[i + k] as number
        value = value * 256 + b
        allOnes &&= b === 0xff
    }
    return { value: allOnes ? Number.POSITIVE_INFINITY : value, len }
}

function uint(d: Uint8Array): number {
    let v = 0
    for (const b of d) v = v * 256 + b
    return v
}

const utf8 = new TextDecoder()

/** Children of a master element already in memory. */
function* children(d: Uint8Array): Generator<{ id: number; data: Uint8Array }> {
    let i = 0
    while (i < d.length) {
        const id = readId(d, i)
        if (!id || id.id < 0) return
        const size = readSize(d, i + id.len)
        if (!size || size.value < 0 || !Number.isFinite(size.value)) return
        const start = i + id.len + size.len
        const end = start + size.value
        if (end > d.length) return
        yield { id: id.id, data: d.subarray(start, end) }
        i = end
    }
}

function parseTracks(d: Uint8Array): SubtitleTrackInfo[] {
    const out: SubtitleTrackInfo[] = []
    for (const entry of children(d)) {
        if (entry.id !== 0xae) continue
        const t: SubtitleTrackInfo & { type: number } = {
            type: 0,
            number: 0,
            codec: '',
            language: 'eng',
            name: '',
            forced: false,
            privateData: null,
            compression: null,
        }
        let bcp47 = ''
        for (const f of children(entry.data)) {
            if (f.id === 0xd7) t.number = uint(f.data)
            else if (f.id === 0x83) t.type = uint(f.data)
            else if (f.id === 0x86) t.codec = utf8.decode(f.data).replace(/\0+$/, '')
            else if (f.id === 0x63a2) t.privateData = f.data.slice()
            else if (f.id === 0x22b59c) t.language = utf8.decode(f.data).replace(/\0+$/, '')
            else if (f.id === 0x22b59d) bcp47 = utf8.decode(f.data).replace(/\0+$/, '')
            else if (f.id === 0x536e) t.name = utf8.decode(f.data)
            else if (f.id === 0x55aa) t.forced = uint(f.data) === 1
            else if (f.id === 0x6d80) {
                for (const enc of children(f.data)) {
                    if (enc.id !== 0x6240) continue
                    let type = 0
                    let comp: SubtitleTrackInfo['compression'] = null
                    for (const e of children(enc.data)) {
                        if (e.id === 0x5033) type = uint(e.data)
                        else if (e.id === 0x5034) {
                            comp = { algo: 0, settings: null }
                            for (const c of children(e.data)) {
                                if (c.id === 0x4254) comp.algo = uint(c.data)
                                else if (c.id === 0x4255) comp.settings = c.data.slice()
                            }
                        }
                    }
                    if (type === 0) t.compression = comp ?? { algo: 0, settings: null }
                }
            }
        }
        if (bcp47) t.language = bcp47
        if (t.type === 0x11 && t.number > 0) {
            const { type: _type, ...info } = t
            out.push(info)
        }
    }
    return out
}

// ---- the walker ----

interface Open {
    id: number
    /** Absolute offset where it ends; Infinity when the file did not say. */
    end: number
}

/** What every response body of one file shares: the header once read, and which tracks matter. */
export interface MatroskaFile {
    header: MatroskaHeader | null
    wanted: (track: number) => boolean
}

export interface MatroskaListener {
    header(h: MatroskaHeader): void
    block(b: SubtitleBlock): void
}

/**
 * Follows one response body from the byte offset it starts at. A body from the start of the
 * file reads the header; one from elsewhere first looks for the next Cluster.
 */
export class MatroskaStream {
    private pos: number
    private pending: Uint8Array = new Uint8Array(0)
    private skip = 0
    private keep: { left: number; parts: Uint8Array[]; done: (d: Uint8Array) => void } | null = null
    private peek: { size: number } | null = null
    private synced: boolean
    private stack: Open[] = []
    private clusterTime = 0
    private group: { block: SubtitleBlock | null; duration: number | null } | null = null
    private readonly file: MatroskaFile
    private readonly listener: MatroskaListener

    constructor(offset: number, file: MatroskaFile, listener: MatroskaListener) {
        this.file = file
        this.listener = listener
        this.pos = offset
        this.synced = offset === 0
    }

    /** The file offset of the next byte this walker expects. */
    get position(): number {
        return this.pos
    }

    push(chunk: Uint8Array) {
        let d = chunk
        if (this.pending.length) {
            const joined = new Uint8Array(this.pending.length + chunk.length)
            joined.set(this.pending)
            joined.set(chunk, this.pending.length)
            d = joined
            this.pos -= this.pending.length
            this.pending = new Uint8Array(0)
        }
        let i = 0
        while (i < d.length) {
            if (this.skip > 0) {
                const n = Math.min(this.skip, d.length - i)
                this.skip -= n
                i += n
                this.pos += n
                continue
            }
            if (this.keep) {
                const n = Math.min(this.keep.left, d.length - i)
                this.keep.parts.push(d.slice(i, i + n))
                this.keep.left -= n
                i += n
                this.pos += n
                if (this.keep.left === 0) {
                    const { parts, done } = this.keep
                    this.keep = null
                    done(concat(parts))
                }
                continue
            }
            if (!this.synced) {
                const found = this.findCluster(d, i)
                if (!found.at) {
                    // A candidate cut off by the end of the chunk waits for the next one.
                    this.pos += found.from - i
                    this.hold(d, found.from)
                    return
                }
                this.pos += found.from - i
                i = found.from
                this.synced = true
                this.stack = [{ id: SEGMENT, end: Number.POSITIVE_INFINITY }]
            }
            if (this.peek) {
                const head = blockHead(d, i)
                if (!head) {
                    this.hold(d, i)
                    return
                }
                const { size } = this.peek
                this.peek = null
                if (this.file.header && this.file.wanted(head.track) && size <= MAX_KEEP) {
                    this.keepBytes(size, data => this.onBlock(data))
                } else {
                    this.skip = size
                }
                continue
            }
            this.close()
            const id = readId(d, i)
            const size = id && id.id >= 0 ? readSize(d, i + id.len) : null
            if (!id || (id.id >= 0 && !size)) {
                this.hold(d, i)
                return
            }
            if (id.id < 0 || !size || size.value < 0) {
                this.lose()
                continue
            }
            const top = this.stack.at(-1)
            if (top?.id === CLUSTER && top.end === Number.POSITIVE_INFINITY && SEGMENT_LEVEL.has(id.id)) {
                this.stack.pop()
            }
            const headerLen = id.len + size.len
            i += headerLen
            this.pos += headerLen
            if (!this.enter(id.id, size.value)) this.lose()
        }
    }

    private hold(d: Uint8Array, from: number) {
        this.pending = d.slice(from)
        this.pos += d.length - from
    }

    /** Ends every master the position has walked past. */
    private close() {
        let top = this.stack.at(-1)
        while (top && this.pos >= top.end) {
            this.stack.pop()
            if (top.id === BLOCK_GROUP) this.endGroup()
            top = this.stack.at(-1)
        }
    }

    /** Lost the structure (or never had it): look for the next Cluster again. */
    private lose() {
        this.synced = false
        this.stack = []
        this.group = null
    }

    /** `at` when a Cluster starts at `from`; otherwise `from` is where to resume once more bytes arrive. */
    private findCluster(d: Uint8Array, start: number): { at: boolean; from: number } {
        for (let i = start; i < d.length; i++) {
            if (i + 4 > d.length) return { at: false, from: i }
            if (d[i] !== 0x1f || d[i + 1] !== 0x43 || d[i + 2] !== 0xb6 || d[i + 3] !== 0x75) continue
            const size = readSize(d, i + 4)
            const child = size ? readId(d, i + 4 + size.len) : null
            if (!size || !child) return { at: false, from: i }
            if (size.value > 0 && CLUSTER_OPENERS.has(child.id)) return { at: true, from: i }
        }
        return { at: false, from: d.length }
    }

    private keepBytes(size: number, done: (d: Uint8Array) => void) {
        if (size === 0) done(new Uint8Array(0))
        else this.keep = { left: size, parts: [], done }
    }

    /** Decides what to do with an element whose header was just read. */
    private enter(id: number, size: number): boolean {
        const parent = this.stack.at(-1)?.id
        const known = Number.isFinite(size)
        const end = this.pos + size
        if (parent === undefined) {
            if (id === SEGMENT) this.stack.push({ id, end })
            else if (id === EBML && known) this.skip = size
            else return false
            return true
        }
        if (parent === SEGMENT) {
            if (id === CLUSTER) {
                this.stack.push({ id, end })
                this.clusterTime = 0
            } else if (!known) {
                return false
            } else if (id === INFO && size <= MAX_KEEP) {
                this.keepBytes(size, d => this.onInfo(d))
            } else if (id === TRACKS && size <= MAX_KEEP) {
                this.keepBytes(size, d => this.onTracks(d))
            } else {
                this.skip = size
            }
            return true
        }
        if (!known) return false
        if (parent === CLUSTER) {
            if (id === TIMESTAMP)
                this.keepBytes(size, d => {
                    this.clusterTime = uint(d)
                })
            else if (id === SIMPLE_BLOCK) this.peek = { size }
            else if (id === BLOCK_GROUP) {
                this.stack.push({ id, end })
                this.group = { block: null, duration: null }
            } else this.skip = size
            return true
        }
        if (parent === BLOCK_GROUP) {
            if (id === BLOCK) this.peek = { size }
            else if (id === BLOCK_DURATION)
                this.keepBytes(size, d => {
                    if (this.group) this.group.duration = uint(d)
                })
            else this.skip = size
            return true
        }
        this.skip = size
        return true
    }

    private onInfo(d: Uint8Array) {
        let scale = 1_000_000
        for (const c of children(d)) if (c.id === 0x2ad7b1) scale = uint(c.data) || scale
        const h = this.file.header
        if (h) h.timestampScale = scale
        else this.listener.header({ timestampScale: scale, subtitles: [] })
    }

    private onTracks(d: Uint8Array) {
        const subtitles = parseTracks(d)
        const h = this.file.header
        if (h) {
            h.subtitles = subtitles
            this.listener.header(h)
        } else this.listener.header({ timestampScale: 1_000_000, subtitles })
    }

    private onBlock(d: Uint8Array) {
        const head = blockHead(d, 0)
        const h = this.file.header
        if (!head || !h) return
        // Laced subtitle blocks do not occur in practice; leave them out rather than misread them.
        if (head.lacing) return
        const scale = h.timestampScale / 1e9
        const block: SubtitleBlock = {
            track: head.track,
            time: (this.clusterTime + head.timecode) * scale,
            duration: null,
            data: d.subarray(head.length),
        }
        if (this.stack.at(-1)?.id === BLOCK_GROUP && this.group) this.group.block = block
        else this.listener.block(block)
    }

    private endGroup() {
        const g = this.group
        this.group = null
        const h = this.file.header
        if (!g?.block || !h) return
        if (g.duration !== null) g.block.duration = (g.duration * h.timestampScale) / 1e9
        this.listener.block(g.block)
    }
}

/** Track number, timecode and flags at the start of a (Simple)Block. */
function blockHead(
    d: Uint8Array,
    i: number,
): { track: number; timecode: number; lacing: boolean; length: number } | null {
    const track = readSize(d, i)
    if (!track || i + track.len + 3 > d.length) return null
    const raw = ((d[i + track.len] as number) << 8) | (d[i + track.len + 1] as number)
    const flags = d[i + track.len + 2] as number
    return {
        track: track.value,
        timecode: raw > 0x7fff ? raw - 0x10000 : raw,
        lacing: (flags & 0x06) !== 0,
        length: track.len + 3,
    }
}

function concat(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0] as Uint8Array
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of parts) {
        out.set(p, o)
        o += p.length
    }
    return out
}

/** Undoes the track's ContentEncoding, if it has one. */
export async function decodeContent(
    data: Uint8Array,
    compression: SubtitleTrackInfo['compression'],
): Promise<Uint8Array> {
    if (!compression) return data
    if (compression.algo === 3) {
        const s = compression.settings
        return s ? concat([s, data]) : data
    }
    if (compression.algo === 0) {
        const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
        return new Uint8Array(await new Response(stream).arrayBuffer())
    }
    throw new Error(`unsupported content compression ${compression.algo}`)
}
