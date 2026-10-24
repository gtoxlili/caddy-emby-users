// The subtitle streams of a file played in the page. Emby lists a file's embedded subtitles
// in the order Matroska stores them, so the n-th subtitle stream Emby names is the n-th
// subtitle track of the file. Text goes into TextTracks the captions layer already reads;
// PGS into a PgsTrack drawn on a canvas.

import type { MediaStream } from '../../api/types'
import { trackName } from '../../components/specs'
import { localTrack } from '../local-tracks'
import type { MatroskaHeader, SubtitleBlock, SubtitleTrackInfo } from './matroska'
import { decodeContent } from './matroska'
import { PgsTrack } from './pgs'
import { assCue, subripCue } from './text'

export type LocalKind = 'text' | 'bitmap'

type Format = 'subrip' | 'ass' | 'webvtt' | 'pgs'

function formatOf(codec: string): Format | null {
    if (codec === 'S_TEXT/UTF8' || codec === 'S_TEXT/ASCII') return 'subrip'
    if (codec === 'S_TEXT/ASS' || codec === 'S_TEXT/SSA' || codec === 'S_ASS' || codec === 'S_SSA') return 'ass'
    if (codec === 'S_TEXT/WEBVTT') return 'webvtt'
    if (codec === 'S_HDMV/PGS') return 'pgs'
    return null
}

interface Bound {
    info: SubtitleTrackInfo
    format: Format
    index: number
    pgs: PgsTrack | null
}

const utf8 = new TextDecoder()

export class LocalSubtitles {
    private bound = new Map<number, Bound>()
    private listeners = new Set<() => void>()
    private added = 0

    private readonly video: HTMLVideoElement
    private readonly streams: MediaStream[]

    /** `streams`: the embedded subtitle streams Emby lists for this file, in its order. */
    constructor(video: HTMLVideoElement, streams: MediaStream[]) {
        this.video = video
        this.streams = streams
    }

    header(h: MatroskaHeader) {
        this.bound.clear()
        const tracks = h.subtitles
        tracks.forEach((info, k) => {
            const format = formatOf(info.codec)
            const stream = this.streams[k]
            if (!format || !stream) return
            const b: Bound = { info, format, index: stream.Index, pgs: null }
            if (format === 'pgs') b.pgs = new PgsTrack()
            else localTrack(this.video, stream.Index, trackName(stream), stream.Language ?? info.language)
            this.bound.set(info.number, b)
        })
        for (const l of this.listeners) l()
    }

    wanted(track: number): boolean {
        return this.bound.has(track)
    }

    block(block: SubtitleBlock) {
        const b = this.bound.get(block.track)
        if (!b) return
        decodeContent(block.data, b.info.compression).then(
            data => this.add(b, block, data),
            () => {},
        )
    }

    private add(b: Bound, block: SubtitleBlock, data: Uint8Array) {
        if (b.pgs) {
            b.pgs.add(block.time, data, block.duration)
            if (++this.added % 64 === 0) b.pgs.trim(this.video.currentTime)
            return
        }
        const raw = utf8.decode(data)
        const text = b.format === 'ass' ? assCue(raw) : b.format === 'webvtt' ? raw.trim() : subripCue(raw)
        if (!text) return
        const stream = this.streams.find(s => s.Index === b.index)
        const t = localTrack(this.video, b.index, stream ? trackName(stream) : '', stream?.Language ?? '')
        const key = `${block.time.toFixed(2)}|${text}`
        if (t.seen.has(key)) return
        t.seen.add(key)
        const end = block.time + (block.duration && block.duration > 0 ? block.duration : 4)
        t.track.addCue(new VTTCue(block.time, end, text))
    }

    /** How the page shows this stream, once the file's own header has been read. */
    kind(index: number): LocalKind | null {
        for (const b of this.bound.values()) if (b.index === index) return b.pgs ? 'bitmap' : 'text'
        return null
    }

    bitmap(index: number): PgsTrack | null {
        for (const b of this.bound.values()) if (b.index === index) return b.pgs
        return null
    }

    subscribe(fn: () => void): () => void {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }
}
