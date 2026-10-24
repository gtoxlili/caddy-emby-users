// Turns the server's PlaybackInfo answer into something the media element can load, and
// says honestly how it will play: the file itself, remuxed, or transcoded and why.

import { getToken, serverUrl } from '../api/client'
import type { PlayMethod } from '../api/emby'
import type { MediaSource, MediaStream, PlaybackInfo } from '../api/types'

export interface TextTrack {
    index: number
    label: string
    lang: string
    url: string
}

export interface Source {
    url: string
    hls: boolean
    method: PlayMethod
    media: MediaSource
    playSessionId: string
    /** Subtitles the browser renders from WebVTT; the others need burning in. */
    tracks: TextTrack[]
    /** The subtitle the server burns into the picture, if any. */
    burnedIn: number | null
    reasons: string[]
}

export class NoStream extends Error {
    readonly code: string
    constructor(code: string) {
        super(code)
        this.code = code
    }
}

export function chooseSource(info: PlaybackInfo, itemId: string, wantedSubtitle: number | undefined): Source {
    if (info.ErrorCode) throw new NoStream(info.ErrorCode)
    const media = info.MediaSources[0]
    if (!media) throw new NoStream('NoCompatibleStream')
    // Every text subtitle comes as WebVTT from Emby's converter, whatever PlaybackInfo
    // decided: left to itself, Emby 4.10 burns embedded ASS into a full transcode.
    const token = encodeURIComponent(getToken() ?? '')
    const tracks: TextTrack[] = media.MediaStreams.filter(s => s.Type === 'Subtitle' && isTextSubtitle(s)).map(s => ({
        index: s.Index,
        label: s.Title || s.DisplayLanguage || s.DisplayTitle || `字幕 ${s.Index}`,
        lang: s.Language ?? '',
        url:
            s.DeliveryMethod === 'External' && s.DeliveryUrl
                ? serverUrl(s.DeliveryUrl)
                : `/emby/Videos/${itemId}/${encodeURIComponent(media.Id)}/Subtitles/${s.Index}/0/Stream.vtt?api_key=${token}`,
    }))
    const transcoding = media.TranscodingUrl ? serverUrl(media.TranscodingUrl) : null
    const burnedIn = transcoding ? subtitleInUrl(transcoding) : null
    if (media.SupportsDirectPlay && !(wantedSubtitle !== undefined && burnedIn === wantedSubtitle)) {
        const q = new URLSearchParams({
            Static: 'true',
            MediaSourceId: media.Id,
            PlaySessionId: info.PlaySessionId,
            api_key: getToken() ?? '',
        })
        return {
            url: `/emby/Videos/${itemId}/stream.${(media.Container ?? 'mp4').split(',')[0]}?${q}`,
            hls: false,
            method: 'DirectPlay',
            media,
            playSessionId: info.PlaySessionId,
            tracks,
            burnedIn: null,
            reasons: [],
        }
    }
    if (!transcoding) throw new NoStream('NoCompatibleStream')
    const reasons = transcodeReasons(transcoding)
    // Only the container in the way: the server copies picture and sound into HLS segments.
    const remux = reasons.length > 0 && reasons.every(r => r === 'ContainerNotSupported')
    return {
        url: transcoding,
        hls: media.TranscodingSubProtocol === 'hls' || /\.m3u8/i.test(transcoding),
        method: remux ? 'DirectStream' : 'Transcode',
        media,
        playSessionId: info.PlaySessionId,
        tracks,
        burnedIn,
        reasons,
    }
}

function param(url: string, key: string): string | null {
    const q = url.split('?')[1] ?? ''
    for (const [k, v] of new URLSearchParams(q)) if (k.toLowerCase() === key) return v
    return null
}

function subtitleInUrl(url: string): number | null {
    const v = param(url, 'subtitlestreamindex')
    const method = param(url, 'subtitlemethod')
    if (v === null || Number(v) < 0 || (method && method.toLowerCase() !== 'encode')) return null
    return Number(v)
}

function transcodeReasons(url: string): string[] {
    return (param(url, 'transcodereasons') ?? '').split(',').filter(Boolean)
}

const REASONS: Record<string, string> = {
    ContainerNotSupported: '这个浏览器不支持文件的封装格式',
    VideoCodecNotSupported: '这个浏览器解不了画面的编码',
    AudioCodecNotSupported: '这个浏览器解不了声音的编码',
    VideoProfileNotSupported: '画面编码的规格这里解不了',
    VideoBitDepthNotSupported: '画面是 10 bit，这里解不了',
    VideoLevelNotSupported: '画面编码的级别太高',
    VideoRangeTypeNotSupported: '这里显示不了这种 HDR',
    InterlacedVideoNotSupported: '画面是隔行扫描的，需要去隔行',
    AudioChannelsNotSupported: '声道太多，混成立体声',
    SubtitleCodecNotSupported: '字幕要烧进画面',
    ContainerBitrateExceedsLimit: '码率超过了选的画质',
    VideoBitrateNotSupported: '码率超过了选的画质',
    AudioBitrateNotSupported: '声音码率超过了上限',
    DirectPlayError: '直接播放出错了',
}

/** Why the server is not sending the file as it is, in words. */
export function describeReasons(source: Source): string[] {
    return source.reasons.map(r => REASONS[r] ?? r)
}

export function methodLabel(source: Source): string {
    if (source.method === 'DirectPlay') return '直接播放原文件'
    if (source.method === 'DirectStream') return '转封装，画面和声音不重新编码'
    return '服务器转码中'
}

const TEXT_CODECS = new Set(['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'text', 'smi', 'sami', 'ttml'])

/** Text subtitles can be drawn by the page; image ones (PGS, VobSub) have to be burned in. */
export function isTextSubtitle(s: MediaStream): boolean {
    return s.IsTextSubtitleStream ?? TEXT_CODECS.has((s.Codec ?? '').toLowerCase())
}

/** The audio and subtitle streams a person can choose from. */
export function streamsOf(media: MediaSource | undefined, type: 'Audio' | 'Subtitle'): MediaStream[] {
    return (media?.MediaStreams ?? []).filter(s => s.Type === type)
}
