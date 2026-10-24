// What this browser can play, said in Emby's DeviceProfile terms. The upstream server reads
// it in PlaybackInfo and decides per file: play the file as it is, remux it into HLS, or
// transcode. The profile only claims what the media element here actually decodes.

const probe = typeof document === 'undefined' ? null : document.createElement('video')

function can(type: string): boolean {
    try {
        return !!probe && probe.canPlayType(type).replace('no', '') !== ''
    } catch {
        return false
    }
}

function mse(type: string): boolean {
    const MS =
        (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ??
        (globalThis as { MediaSource?: typeof MediaSource }).MediaSource
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
    mkv: boolean
    mov: boolean
    mp3: boolean
    opus: boolean
    flac: boolean
    ac3: boolean
    eac3: boolean
    alac: boolean
    nativeHls: boolean
    mseHls: boolean
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
        mkv: can('video/x-matroska') || can('video/mkv'),
        mov: can('video/quicktime'),
        mp3: can('audio/mpeg') || either('audio/mp4; codecs="mp4a.6B"'),
        opus: either('audio/mp4; codecs="opus"') || either('audio/webm; codecs="opus"'),
        flac: either('audio/mp4; codecs="flac"') || can('audio/flac'),
        ac3: either('audio/mp4; codecs="ac-3"'),
        eac3: either('audio/mp4; codecs="ec-3"'),
        alac: can('audio/mp4; codecs="alac"'),
        nativeHls: can('application/vnd.apple.mpegurl'),
        mseHls: either('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
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
    const containers = ['mp4', 'm4v', c.mov && 'mov'].filter(Boolean).join(',')
    const directProfiles = [
        { Container: containers, Type: 'Video', VideoCodec: videoCodecs, AudioCodec: audioCodecs },
        c.webm && {
            Container: 'webm',
            Type: 'Video',
            VideoCodec: ['vp8', 'vp9', c.av1 && 'av1'].filter(Boolean).join(','),
            AudioCodec: 'vorbis,opus',
        },
        c.mkv && { Container: 'mkv', Type: 'Video', VideoCodec: videoCodecs, AudioCodec: audioCodecs },
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
        // Text subtitles arrive as WebVTT (the server converts SRT and ASS); image subtitles
        // match no profile, so the server burns them into a transcode.
        SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }],
        ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }],
    }
}

/** Why a file might not play here, for the error screen. */
export function missingCodecs(): string[] {
    const c = capabilities()
    const out: string[] = []
    if (!c.hevc) out.push('HEVC')
    if (!c.av1) out.push('AV1')
    return out
}
