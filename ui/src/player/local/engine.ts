// Plays a file the browser cannot open by itself: the page reads it with range requests,
// copies the picture into fragmented MP4 untouched, converts the sound only when MSE cannot
// take it, and feeds the result to the <video> through MSE. A seek outside what is buffered
// starts a new run of the conversion at the key frame before the target.

import type { ConversionAudioOptions, InputVideoTrack } from 'mediabunny'
import {
    AppendOnlyStreamTarget,
    Conversion,
    ConversionCanceledError,
    EncodedPacketSink,
    Input,
    Logging,
    LogLevel,
    MATROSKA,
    MP4,
    MPEG_TS,
    Mp4OutputFormat,
    Output,
    QTFF,
    UrlSource,
} from 'mediabunny'
import { ticksToSeconds } from '../../format'
import type { Engine, FatalKind } from '../engine'
import { seekOnLoad } from '../engine'
import type { Source } from '../source'
import { planAudio } from './audio'
import { Feed, mediaSourceClass, mseSupports } from './feed'
import type { MatroskaFile, MatroskaListener } from './matroska'
import { MatroskaStream } from './matroska'
import { LocalSubtitles } from './subtitles'

// The demuxer warns about every track it skips, the subtitle tracks read here included.
Logging.level = LogLevel.Errors

/** Bytes of media to hold ready ahead of the playhead; the seconds follow from the bitrate. */
const AHEAD_BYTES = 40 * 1024 * 1024
/** A seek this far past what the current run has reached is cheaper to reach by reading on. */
const REACH = 20

class Unsupported extends Error {}

/**
 * The MP4 written here always stores HEVC as an hvc1 sample entry, but the codec string the
 * demuxer reports starts hev1. Safari goes by the string, and hvc1 is what it knows.
 */
const hvc1 = (type: string) => type.replace(/\bhev1\./g, 'hvc1.')

/** A busy or briefly failing server answers 5xx or 429; the demuxer gives up on those at once. */
async function patientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(input, init)
        const transient = res.status >= 500 || res.status === 429 || res.status === 408
        if (res.ok || !transient || attempt >= 4) return res
        void res.body?.cancel().catch(() => {})
        await new Promise<void>((resolve, reject) => {
            const signal = init?.signal
            const t = setTimeout(resolve, 500 * 2 ** attempt)
            signal?.addEventListener('abort', () => {
                clearTimeout(t)
                reject(signal.reason)
            })
        })
    }
}

interface Walker {
    push(chunk: Uint8Array): void
}

/**
 * patientFetch that also shows every response body, from its byte offset, to a walker. A
 * body that ends hands its walker back, so one that picks up at the same offset continues
 * mid-element instead of searching for the next Cluster.
 */
function tapped(walkers: { open(offset: number): Walker; close(w: Walker): void } | null): typeof fetch {
    const tap = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const res = await patientFetch(input, init)
        if (!walkers || !res.body || (res.status !== 200 && res.status !== 206)) return res
        const m = /^bytes (\d+)-/.exec(res.headers.get('Content-Range') ?? '')
        const offset = res.status === 206 ? (m ? Number(m[1]) : null) : 0
        if (offset === null) return res
        let walker: Walker | null = walkers.open(offset)
        const release = () => {
            if (walker) walkers.close(walker)
            walker = null
        }
        const reader = res.body.getReader()
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                const { done, value } = await reader.read().catch(e => {
                    release()
                    throw e
                })
                if (done) {
                    release()
                    controller.close()
                    return
                }
                try {
                    walker?.push(value)
                } catch {
                    // Subtitles are a bonus; a body they cannot follow still plays.
                    walker = null
                }
                controller.enqueue(value)
            },
            cancel: reason => {
                release()
                return reader.cancel(reason)
            },
        })
        const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
        // The demuxer follows redirects by these; a constructed Response would forget them.
        Object.defineProperties(out, {
            url: { value: res.url },
            redirected: { value: res.redirected },
            type: { value: res.type },
        })
        return out
    }
    return tap as typeof fetch
}

function kindOf(e: unknown): FatalKind {
    if (e instanceof Unsupported) return 'unsupported'
    if (e instanceof TypeError || (e instanceof Error && /fetch|network|HTTP/i.test(e.message))) return 'network'
    return 'decode'
}

interface Plan {
    video: InputVideoTrack
    /** The audio track that plays and what to do with it; null plays the picture alone. */
    audio: { id: number; options: ConversionAudioOptions } | null
}

export function attachLocal(
    video: HTMLVideoElement,
    source: Source,
    start: number,
    onFatal: (kind: FatalKind) => void,
): Engine {
    const media = source.media
    const container = (media.Container ?? '').split(',')[0]?.toLowerCase() ?? ''
    const subtitles = new LocalSubtitles(video, source.embedded)
    const file: MatroskaFile = {
        header: null,
        wanted: n => subtitles.wanted(n),
    }
    const listener: MatroskaListener = {
        header: h => {
            file.header = h
            subtitles.header(h)
        },
        block: b => subtitles.block(b),
    }
    const matroska = container === 'mkv' || container === 'webm' || container === 'matroska'
    const parked = new Map<number, MatroskaStream>()
    const walkers = {
        open: (offset: number) => {
            const w = parked.get(offset)
            parked.delete(offset)
            return w ?? new MatroskaStream(offset, file, listener)
        },
        close: (w: Walker) => {
            if (!(w instanceof MatroskaStream)) return
            parked.set(w.position, w)
            if (parked.size > 8) parked.delete(parked.keys().next().value as number)
        },
    }
    const input = new Input({
        formats: [MATROSKA, MP4, QTFF, MPEG_TS],
        source: new UrlSource(source.url, {
            fetchFn: tapped(matroska ? walkers : null),
            maxCacheSize: 32 * 1024 * 1024,
            getRetryDelay: attempts => (attempts < 5 ? Math.min(8, 2 ** attempts) : null),
        }),
    })
    const managed = mediaSourceClass() !== (typeof MediaSource === 'undefined' ? null : MediaSource)

    let disposed = false
    let plan: Plan | null = null
    let feed: Feed | null = null
    let current: Conversion | null = null
    let runs = 0
    let runStart = 0
    let seekTimer: ReturnType<typeof setTimeout> | undefined

    const fail = (e: unknown) => {
        if (disposed || e instanceof ConversionCanceledError) return
        console.warn('local playback failed', e)
        onFatal(kindOf(e))
    }

    const prepare = async (): Promise<Plan> => {
        const videoTrack = await input.getPrimaryVideoTrack()
        if (!videoTrack) throw new Unsupported('no video track')
        const vcodec = await videoTrack.getCodecParameterString()
        if (!vcodec || !mseSupports(`video/mp4; codecs="${hvc1(vcodec)}"`)) throw new Unsupported(`video ${vcodec}`)

        // Emby lists a file's audio streams in the order the file stores them.
        const embyAudio = media.MediaStreams.filter(s => s.Type === 'Audio' && !s.IsExternal)
        const audioTracks = await input.getAudioTracks()
        const k = embyAudio.findIndex(s => s.Index === source.audio)
        const audioTrack = audioTracks[k] ?? (await input.getPrimaryAudioTrack())
        if (!audioTrack) return { video: videoTrack, audio: null }
        const copyable = new Mp4OutputFormat({ fastStart: 'fragmented' }).getSupportedAudioCodecs()
        const a = await planAudio(audioTrack, mseSupports, copyable)
        if (a.mode === 'none') return { video: videoTrack, audio: null }
        return { video: videoTrack, audio: { id: audioTrack.id, options: a.mode === 'convert' ? a.options : {} } }
    }

    const run = async (t: number) => {
        const id = ++runs
        const previous = current
        current = null
        if (previous) await previous.cancel().catch(() => {})
        const p = plan
        const f = feed
        if (id !== runs || disposed || !p || !f) return
        const sink = new EncodedPacketSink(p.video)
        const key =
            (await sink.getKeyPacket(t, { verifyKeyPackets: true })) ??
            (await sink.getFirstKeyPacket({ verifyKeyPackets: true }))
        if (id !== runs || disposed) return
        const from = Math.max(0, key?.timestamp ?? 0)
        runStart = from
        const gen = await f.begin(from)
        if (id !== runs || disposed) return
        const output: Output = new Output({
            format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 }),
            target: new AppendOnlyStreamTarget(f.writable(gen, (): Promise<string> => output.getMimeType().then(hvc1))),
        })
        const conversion = await Conversion.init({
            input,
            output,
            video: v => (v.id === p.video.id ? {} : { discard: true }),
            audio: a => (p.audio && a.id === p.audio.id ? p.audio.options : { discard: true }),
            // The run starts on a key frame; the output's zero is that frame, placed back at
            // its own time by the SourceBuffer's timestampOffset.
            trim: { start: from },
            copy: { boundaryPolicy: 'shrink' },
            tags: {},
            showWarnings: false,
        })
        if (id !== runs || disposed) {
            await conversion.cancel()
            return
        }
        if (!conversion.isValid) throw new Unsupported(conversion.discardedTracks.map(d => d.reason).join(', '))
        current = conversion
        await conversion.execute()
        if (id === runs) await f.end(gen)
    }

    const inBuffer = (t: number) => {
        const b = video.buffered
        for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.1 && b.end(i) > t) return true
        return false
    }

    const onSeeking = () => {
        const t = video.currentTime
        if (!feed || inBuffer(t)) return
        if (t >= runStart - 0.05 && t <= Math.max(feed.frontier, runStart) + REACH) return
        clearTimeout(seekTimer)
        seekTimer = setTimeout(() => void run(video.currentTime).catch(fail), 120)
    }

    const setup = async () => {
        plan = await prepare()
        if (disposed) return
        const duration = (await input.getDurationFromMetadata()) ?? ticksToSeconds(media.RunTimeTicks)
        const bytesPerSecond = media.Size && duration ? media.Size / duration : (media.Bitrate || 8_000_000) / 8
        feed = new Feed(video, Math.min(60, Math.max(12, AHEAD_BYTES / bytesPerSecond)))
        await feed.open(duration)
        if (disposed) return
        seekOnLoad(video, start)
        video.addEventListener('seeking', onSeeking)
        await run(start)
    }

    setup().catch(fail)

    return {
        subtitles,
        destroy() {
            disposed = true
            runs++
            clearTimeout(seekTimer)
            video.removeEventListener('seeking', onSeeking)
            void current?.cancel().catch(() => {})
            input.dispose()
            feed?.destroy()
            if (managed) video.disableRemotePlayback = false
        },
    }
}
