// Takes the fragmented MP4 the remuxer writes and appends it to a SourceBuffer at the pace
// playback uses it. The writer is held back while enough lies ahead of the playhead, which
// holds back the conversion and with it the download; what lies far behind is let go.
// iOS has MSE only as ManagedMediaSource, which also says itself when it wants data.

type MSCtor = typeof MediaSource

const Managed = (globalThis as { ManagedMediaSource?: MSCtor }).ManagedMediaSource

export function mediaSourceClass(): MSCtor | null {
    return Managed ?? (typeof MediaSource === 'undefined' ? null : MediaSource)
}

export function mseSupports(type: string): boolean {
    try {
        return !!mediaSourceClass()?.isTypeSupported(type)
    } catch {
        return false
    }
}

const BEHIND = 30
const POLL = 250

export class Feed {
    private readonly ms: MediaSource
    private readonly url: string
    private sb: SourceBuffer | null = null
    private mime = ''
    private gen = 0
    private offset = 0
    private closed = false
    private wanting = true
    private waiters = new Set<() => void>()
    /** End of what the current run has appended, on the element's timeline. */
    private reached = 0
    private readonly video: HTMLVideoElement
    /** Seconds to keep ready ahead of the playhead. */
    private readonly ahead: number

    constructor(video: HTMLVideoElement, ahead: number) {
        this.video = video
        this.ahead = ahead
        const Ctor = mediaSourceClass()
        if (!Ctor) throw new Error('no MediaSource')
        this.ms = new Ctor()
        if (Managed) {
            // ManagedMediaSource opens only with AirPlay off or an AirPlay source next to it.
            video.disableRemotePlayback = true
            this.ms.addEventListener('startstreaming', () => this.setWanting(true))
            this.ms.addEventListener('endstreaming', () => this.setWanting(false))
        }
        this.url = URL.createObjectURL(this.ms)
        for (const ev of ['timeupdate', 'seeking', 'waiting'] as const) video.addEventListener(ev, this.wake)
    }

    open(duration: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ms.addEventListener(
                'sourceopen',
                () => {
                    if (duration > 0) this.ms.duration = duration
                    resolve()
                },
                { once: true },
            )
            this.video.addEventListener('error', () => reject(new Error('media element error')), { once: true })
            this.video.src = this.url
        })
    }

    /**
     * A new run of output starting at `offset` seconds of the file. Anything the previous run
     * still writes is dropped, and the buffer starts empty.
     */
    async begin(offset: number): Promise<number> {
        const gen = ++this.gen
        this.offset = offset
        this.reached = offset
        this.wakeAll()
        const sb = this.sb
        if (sb) {
            await this.idle(sb)
            if (gen !== this.gen || this.closed) return gen
            if (this.ms.readyState === 'ended') await this.remove(sb, 0, Number.POSITIVE_INFINITY)
            if (this.ms.readyState === 'open') sb.abort()
            await this.remove(sb, 0, Number.POSITIVE_INFINITY)
            if (gen === this.gen && !this.closed) sb.timestampOffset = offset
        }
        return gen
    }

    /** Where the current run has got to: data up to here is in the buffer or was until evicted. */
    get frontier(): number {
        return this.reached
    }

    writable(gen: number, mime: () => Promise<string>): WritableStream<Uint8Array> {
        let pending = new Uint8Array(0)
        let init: Uint8Array[] = []
        let moof: Uint8Array | null = null
        return new WritableStream<Uint8Array>({
            write: async chunk => {
                if (gen !== this.gen || this.closed) return
                const joined = new Uint8Array(pending.length + chunk.length)
                joined.set(pending)
                joined.set(chunk, pending.length)
                let d = joined
                while (d.length >= 8) {
                    let size = new DataView(d.buffer, d.byteOffset, 8).getUint32(0)
                    let header = 8
                    if (size === 1) {
                        if (d.length < 16) break
                        size = Number(new DataView(d.buffer, d.byteOffset + 8, 8).getBigUint64(0))
                        header = 16
                    }
                    if (size < header) throw new Error('bad MP4 box')
                    if (d.length < size) break
                    const type = String.fromCharCode(d[4] as number, d[5] as number, d[6] as number, d[7] as number)
                    const box = d.slice(0, size)
                    d = d.subarray(size)
                    if (type === 'ftyp') init = [box]
                    else if (type === 'moov') {
                        init.push(box)
                        await this.appendInit(gen, join(init), mime)
                        init = []
                    } else if (type === 'moof') moof = box
                    else if (type === 'mdat' && moof) {
                        await this.appendMedia(gen, join([moof, box]))
                        moof = null
                    }
                    // mfra, free and the rest mean nothing to a SourceBuffer.
                    if (gen !== this.gen || this.closed) return
                }
                pending = d.slice()
            },
        })
    }

    /** The run reached the end of the file. */
    async end(gen: number) {
        const sb = this.sb
        if (!sb || gen !== this.gen || this.closed) return
        await this.idle(sb)
        if (gen === this.gen && !this.closed && this.ms.readyState === 'open') this.ms.endOfStream()
    }

    destroy() {
        this.closed = true
        this.gen++
        this.wakeAll()
        for (const ev of ['timeupdate', 'seeking', 'waiting'] as const) this.video.removeEventListener(ev, this.wake)
        this.video.removeAttribute('src')
        this.video.load()
        URL.revokeObjectURL(this.url)
    }

    // ---- appending ----

    private async appendInit(gen: number, data: Uint8Array, mime: () => Promise<string>) {
        const type = await mime()
        if (gen !== this.gen || this.closed) return
        let sb = this.sb
        if (!sb) {
            sb = this.ms.addSourceBuffer(type)
            sb.mode = 'segments'
            sb.timestampOffset = this.offset
            this.sb = sb
            this.mime = type
        } else if (type !== this.mime && 'changeType' in sb) {
            await this.idle(sb)
            sb.changeType(type)
            this.mime = type
        }
        await this.append(gen, sb, data)
    }

    private async appendMedia(gen: number, data: Uint8Array) {
        const sb = this.sb
        if (!sb) return
        await this.room(gen)
        if (gen !== this.gen || this.closed) return
        await this.evict(sb)
        await this.append(gen, sb, data)
        const end = this.bufferedEnd()
        if (end !== null) this.reached = Math.max(this.reached, end)
    }

    private async append(gen: number, sb: SourceBuffer, data: Uint8Array) {
        for (let attempt = 0; ; attempt++) {
            await this.idle(sb)
            if (gen !== this.gen || this.closed) return
            try {
                await new Promise<void>((resolve, reject) => {
                    const settle = (error?: unknown) => {
                        sb.removeEventListener('updateend', done)
                        sb.removeEventListener('error', fail)
                        if (error) reject(error)
                        else resolve()
                    }
                    const done = () => settle()
                    const fail = () => settle(new Error('SourceBuffer append failed'))
                    sb.addEventListener('updateend', done)
                    sb.addEventListener('error', fail)
                    try {
                        sb.appendBuffer(data as BufferSource)
                    } catch (e) {
                        settle(e)
                    }
                })
                return
            } catch (e) {
                // The buffer is full: drop everything behind the playhead and wait for playback to use some up.
                if (!(e instanceof DOMException && e.name === 'QuotaExceededError') || attempt > 20) throw e
                await this.remove(sb, 0, Math.max(0, this.video.currentTime - 2))
                await this.sleep(gen, 1000)
            }
        }
    }

    private async evict(sb: SourceBuffer) {
        const t = this.video.currentTime
        const b = sb.buffered
        if (b.length && b.start(0) < t - BEHIND - 10) await this.remove(sb, 0, t - BEHIND)
    }

    private async remove(sb: SourceBuffer, from: number, to: number) {
        await this.idle(sb)
        if (this.closed || to <= from || !sb.buffered.length) return
        await new Promise<void>(resolve => {
            sb.addEventListener('updateend', () => resolve(), { once: true })
            try {
                sb.remove(from, to)
            } catch {
                resolve()
            }
        })
    }

    private idle(sb: SourceBuffer): Promise<void> {
        if (!sb.updating) return Promise.resolve()
        return new Promise(resolve => sb.addEventListener('updateend', () => resolve(), { once: true }))
    }

    // ---- pacing ----

    private bufferedEnd(): number | null {
        const sb = this.sb
        if (!sb) return null
        const b = sb.buffered
        return b.length ? b.end(b.length - 1) : null
    }

    /** Seconds ready from the playhead on. */
    private readyAhead(): number {
        const sb = this.sb
        if (!sb) return 0
        const t = this.video.currentTime
        const b = sb.buffered
        for (let i = 0; i < b.length; i++) {
            if (b.start(i) <= t + 0.5 && b.end(i) > t) return b.end(i) - t
        }
        return 0
    }

    private async room(gen: number) {
        while (gen === this.gen && !this.closed) {
            const ready = this.readyAhead()
            if (ready < this.ahead && (this.wanting || ready < 4)) return
            await this.sleep(gen, POLL * 4)
        }
    }

    private setWanting(v: boolean) {
        this.wanting = v
        this.wakeAll()
    }

    private sleep(gen: number, ms: number): Promise<void> {
        return new Promise(resolve => {
            const done = () => {
                clearTimeout(t)
                this.waiters.delete(done)
                resolve()
            }
            const t = setTimeout(done, ms)
            this.waiters.add(done)
            if (gen !== this.gen || this.closed) done()
        })
    }

    private wake = () => this.wakeAll()

    private wakeAll() {
        for (const w of [...this.waiters]) w()
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
