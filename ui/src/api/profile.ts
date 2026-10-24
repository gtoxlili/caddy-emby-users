// What this browser can play, said in Emby's DeviceProfile terms. The upstream server reads
// it in PlaybackInfo and decides per file: play the file as it is, remux it into HLS, or
// transcode. With MSE the page can also open a file the media element cannot (MKV, Dolby or
// DTS sound) and remux it itself, so the profile claims those too; the picture codecs it
// claims are only ones this browser actually decodes.

const probe = typeof document === 'undefined' ? null : document.createElement('video')

function can(type: string): boolean {
    try {
        return !!probe && probe.canPlayType(type).replace('no', '') !== ''
    } catch {
        return false
    }
}

const MS =
    (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ??
    (globalThis as { MediaSource?: typeof MediaSource }).MediaSource

function mse(type: string): boolean {
    try {
        return !!MS && MS.isTypeSupported(type)
    } catch {
        return false
    }
}

const either = (type: string) => can(type) || mse(type)

export interface Capabilities {
    h264: boolean
    hevc: boolean
    hevc10: boolean
    av1: boolean
    av1_10: boolean
    vp9: boolean
    webm: boolean
    mov: boolean
    mp3: boolean
    opus: boolean
    flac: boolean
    ac3: boolean
    eac3: boolean
    alac: boolean
    nativeHls: boolean
    mseHls: boolean
    /** MSE (ManagedMediaSource on iOS 17.1+): the page can remux files itself. */
    local: boolean
    /** WebCodecs can decode the common audio codecs, so the page can convert them. */
    audioDecoder: boolean
}

let cached: Capabilities | null = null

export function capabilities(): Capabilities {
    if (cached) return cached
    cached = {
        h264: either('video/mp4; codecs="avc1.640029"'),
        hevc: either('video/mp4; codecs="hvc1.1.6.L120.90"') || either('video/mp4; codecs="hev1.1.6.L120.90"'),
        hevc10: either('video/mp4; codecs="hvc1.2.4.L153.90"') || either('video/mp4; codecs="hev1.2.4.L153.90"'),
        av1: either('video/mp4; codecs="av01.0.08M.08"'),
        av1_10: either('video/mp4; codecs="av01.0.08M.10"'),
        vp9: either('video/webm; codecs="vp9"') || either('video/mp4; codecs="vp09.00.10.08"'),
        webm: can('video/webm'),
        mov: can('video/quicktime'),
        mp3: can('audio/mpeg') || either('audio/mp4; codecs="mp4a.6B"'),
        opus: either('audio/mp4; codecs="opus"') || either('audio/webm; codecs="opus"'),
        flac: either('audio/mp4; codecs="flac"') || can('audio/flac'),
        ac3: either('audio/mp4; codecs="ac-3"'),
        eac3: either('audio/mp4; codecs="ec-3"'),
        alac: can('audio/mp4; codecs="alac"'),
        nativeHls: can('application/vnd.apple.mpegurl'),
        mseHls: either('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
        local: !!MS && mse('video/mp4; codecs="avc1.640029"'),
        audioDecoder: typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder === 'function',
    }
    return cached
}

type Condition = { Condition: string; Property: string; Value: string; IsRequired: boolean }
const cond = (Condition: string, Property: string, Value: string): Condition => ({
    Condition,
    Property,
    Value,
    IsRequired: false,
})

const lower = (s: string | undefined) => (s ?? '').toLowerCase()

/** Audio the media element plays by itself inside an MP4 file. */
export function nativeAudio(codec: string | undefined): boolean {
    const c = capabilities()
    const k = lower(codec)
    return (
        k === 'aac' ||
        (k === 'mp3' && c.mp3) ||
        (k === 'opus' && c.opus) ||
        (k === 'flac' && c.flac) ||
        (k === 'ac3' && c.ac3) ||
        (k === 'eac3' && c.eac3) ||
        (k === 'alac' && c.alac)
    )
}

const MSE_AUDIO: Record<string, string> = {
    aac: 'mp4a.40.2',
    mp3: 'mp3',
    opus: 'opus',
    flac: 'flac',
    ac3: 'ac-3',
    eac3: 'ec-3',
}

/**
 * What the page does with sound in this codec when it remuxes a file: hand it to MSE as it
 * is, decode and convert it, or nothing. Dolby and DTS decode in WebAssembly anywhere;
 * the rest needs WebCodecs. TrueHD has no decoder here.
 */
export function localAudio(codec: string | undefined): 'copy' | 'convert' | null {
    const c = capabilities()
    if (!c.local) return null
    const k = lower(codec)
    const mseCodec = MSE_AUDIO[k]
    if (mseCodec && mse(`audio/mp4; codecs="${mseCodec}"`)) return 'copy'
    if (['ac3', 'eac3', 'dts', 'dca'].includes(k) || k.startsWith('pcm')) return 'convert'
    if (c.audioDecoder && ['aac', 'mp3', 'opus', 'flac', 'vorbis'].includes(k)) return 'convert'
    return null
}

/**
 * Whether MSE here decodes the picture of a stream, judged from what Emby reports of it. The
 * page checks again with the file's exact codec string once it has read the header.
 */
export function localVideo(s: { Codec?: string; Profile?: string; BitDepth?: number; Level?: number; Width?: number }) {
    if (!capabilities().local) return false
    const codec = lower(s.Codec)
    const profile = lower(s.Profile)
    const deep = (s.BitDepth ?? 8) > 8 || profile.includes('10')
    const level = s.Level && s.Level > 0 ? s.Level : 0
    const types: string[] = []
    if (codec === 'h264') {
        if (deep) return false
        const p = profile.includes('high') ? '64' : profile.includes('main') ? '4D' : '42'
        types.push(`avc1.${p}00${(level || 41).toString(16).padStart(2, '0').toUpperCase()}`)
    } else if (codec === 'hevc' || codec === 'h265') {
        const tag = deep ? `2.4.L${level || 153}.B0` : `1.6.L${level || 120}.B0`
        types.push(`hvc1.${tag}`, `hev1.${tag}`)
    } else if (codec === 'av1') {
        types.push(`av01.0.${(s.Width ?? 0) > 2560 ? '12' : '08'}M.${deep ? '10' : '08'}`)
    } else if (codec === 'vp9') {
        types.push(deep ? 'vp09.02.40.10' : 'vp09.00.40.08')
    }
    return types.some(t => mse(`video/mp4; codecs="${t}"`))
}

/**
 * 0 means no limit: the server plays the file as it is whenever the codecs allow. Without
 * `direct` the profile admits no direct play, for a file the browser claimed but failed.
 */
export function deviceProfile(maxBitrate: number, direct = true) {
    const c = capabilities()
    const videoCodecs = ['h264', c.hevc && 'hevc', c.av1 && 'av1', c.vp9 && 'vp9'].filter(Boolean).join(',')
    const audioCodecs = [
        'aac',
        c.mp3 && 'mp3',
        c.opus && 'opus',
        c.flac && 'flac',
        c.ac3 && 'ac3',
        c.eac3 && 'eac3',
        c.alac && 'alac',
    ]
        .filter(Boolean)
        .join(',')
    const localAudioCodecs = [
        'aac',
        'mp3',
        'opus',
        'flac',
        'vorbis',
        'ac3',
        'eac3',
        'dts',
        'dca',
        'pcm_s16le',
        'pcm_s24le',
    ]
        .filter(k => localAudio(k))
        .join(',')
    const containers = ['mp4', 'm4v', c.mov && 'mov'].filter(Boolean).join(',')
    const directProfiles = [
        { Container: containers, Type: 'Video', VideoCodec: videoCodecs, AudioCodec: audioCodecs },
        c.webm && {
            Container: 'webm',
            Type: 'Video',
            VideoCodec: ['vp8', 'vp9', c.av1 && 'av1'].filter(Boolean).join(','),
            AudioCodec: 'vorbis,opus',
        },
        // Opened and remuxed by the page itself.
        c.local && {
            Container: 'mkv,webm,mp4,m4v,mov,ts,mpegts,m2ts',
            Type: 'Video',
            VideoCodec: videoCodecs,
            AudioCodec: localAudioCodecs,
        },
    ].filter(Boolean)
    // Segments are MPEG-TS: hls.js and Safari both take H.264 in it; HEVC in HLS would need
    // fMP4 segments, so an HEVC file this browser cannot play as is becomes H.264.
    const hlsAudio = ['aac', 'mp3', c.nativeHls && c.ac3 && 'ac3', c.nativeHls && c.eac3 && 'eac3'].filter(Boolean)
    const bitrate = maxBitrate > 0 ? maxBitrate : 200_000_000
    return {
        Name: 'Emby Users Web',
        MaxStreamingBitrate: bitrate,
        MaxStaticBitrate: bitrate,
        MusicStreamingTranscodingBitrate: 320_000,
        DirectPlayProfiles: direct ? directProfiles : [],
        TranscodingProfiles: [
            {
                Container: 'ts',
                Type: 'Video',
                VideoCodec: 'h264',
                AudioCodec: hlsAudio.join(','),
                Context: 'Streaming',
                Protocol: 'hls',
                MaxAudioChannels: '2',
                MinSegments: '1',
                BreakOnNonKeyFrames: true,
            },
        ],
        ContainerProfiles: [],
        CodecProfiles: [
            {
                Type: 'Video',
                Codec: 'h264',
                Conditions: [
                    cond('EqualsAny', 'VideoProfile', 'high|main|baseline|constrained baseline'),
                    cond('LessThanEqual', 'VideoLevel', '52'),
                    // High 10 (common in anime releases) decodes nowhere in a browser.
                    cond('LessThanEqual', 'VideoBitDepth', '8'),
                    cond('NotEquals', 'IsInterlaced', 'true'),
                ],
            },
            {
                Type: 'Video',
                Codec: 'hevc',
                Conditions: [
                    cond('EqualsAny', 'VideoProfile', c.hevc10 ? 'main|main 10' : 'main'),
                    cond('LessThanEqual', 'VideoBitDepth', c.hevc10 ? '10' : '8'),
                ],
            },
            {
                Type: 'Video',
                Codec: 'av1',
                Conditions: [cond('LessThanEqual', 'VideoBitDepth', c.av1_10 ? '10' : '8')],
            },
        ],
        // Text subtitles arrive as WebVTT (the server converts SRT and ASS). A file the page
        // remuxes keeps its own subtitles, PGS included; other image subtitles match no
        // profile, so the server burns them into a transcode.
        SubtitleProfiles: [
            { Format: 'vtt', Method: 'External' },
            ...(c.local
                ? ['srt', 'subrip', 'ass', 'ssa', 'webvtt', 'pgssub'].map(Format => ({ Format, Method: 'Embed' }))
                : []),
        ],
        ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }],
    }
}
